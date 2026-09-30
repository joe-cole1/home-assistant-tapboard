import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { Application, CreateApplicationOptions } from "../../application.ts";
import { loadConfig, type ApplicationConfig } from "../../config.ts";
import { createRenderer, type Renderer } from "../../infrastructure/rendering/renderer.ts";
import { Router } from "../../infrastructure/http/router.ts";
import { HttpServer, type HttpServerAddress } from "../../infrastructure/http/server.ts";
import { sendHttpError, sendJson } from "../../infrastructure/http/error-mapper.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { createLogger, type Logger } from "../../shared/logging.ts";
import type { SessionMaterial } from "../auth/service.ts";
import { readSettings, setEnabled, bumpRevision } from "./repository.ts";
import { seedSimulation } from "./seed.ts";
import { SimulationRunner } from "./runner.ts";
import { registerSimulationRoutes } from "./routes.ts";
import type { SimulationController, SimulationStatus } from "./ui-types.ts";
import type { SimulationRuntimeServices, WorkspaceRuntimeHooks } from "./runtime-types.ts";

type RuntimeFactory = (
  options: CreateApplicationOptions,
  hooks: WorkspaceRuntimeHooks,
) => Application;

function unavailable(message: string): ApplicationError {
  return new ApplicationError({
    category: "conflict",
    code: "simulation.unavailable",
    clientMessage: message,
  });
}

/** A single HTTP listener chooses one complete v2 runtime. Domain objects never cross databases. */
export class WorkspaceApplication implements Application, SimulationController {
  readonly #options: CreateApplicationOptions;
  readonly #config: ApplicationConfig;
  readonly #logger: Logger;
  readonly #factory: RuntimeFactory;
  readonly #primary: Application;
  readonly #controls: Router;
  readonly #context = new AsyncLocalStorage<{ revision: number }>();
  readonly #requests = new Set<Promise<void>>();
  #live: SimulationRuntimeServices | undefined;
  #simulation: SimulationRuntimeServices | undefined;
  #simulationApp: Application | undefined;
  #liveRouter: Pick<Router, "handle"> | undefined;
  #simulationRouter: Pick<Router, "handle"> | undefined;
  #runner: SimulationRunner | undefined;
  #enabled = false;
  #revision = 0;
  #changing = false;
  #stopping = false;
  #starting: Promise<HttpServerAddress> | undefined;
  #opening: Promise<void> | undefined;
  #transitionWork: Promise<SessionMaterial> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(options: CreateApplicationOptions, factory: RuntimeFactory) {
    this.#config = options.config ?? loadConfig(options.configOptions);
    this.#logger = options.logger ?? createLogger();
    this.#options = { ...options, config: this.#config, logger: this.#logger };
    this.#factory = factory;
    this.#controls = new Router(this.#logger);
    this.#controls.get("/api/public/workspace", (_request, response) => {
      sendJson(response, 200, { enabled: this.#enabled, revision: this.#revision });
    });
    this.#primary = factory(
      {
        ...this.#options,
        createRenderer: () => this.#renderer(false),
        createHttpServer: (serverOptions) => {
          this.#liveRouter = serverOptions.router;
          const wrapped = {
            ...serverOptions,
            router: {
              handle: (request: IncomingMessage, response: ServerResponse) =>
                this.#handle(request, response),
            },
          };
          return options.createHttpServer?.(wrapped) ?? new HttpServer(wrapped);
        },
      },
      {
        onComposed: (services) => {
          this.#live = services;
          const settings = readSettings(services.database);
          this.#revision = settings.revision;
          registerSimulationRoutes({
            router: this.#controls,
            renderer: this.#renderer(),
            authService: services.authService,
            ...(this.#config.canonicalExternalOrigin
              ? { canonicalOrigin: this.#config.canonicalExternalOrigin }
              : {}),
            controller: this,
            logger: this.#logger,
          });
        },
      },
    );
  }

  #renderer(simulation?: boolean): Renderer {
    const renderer = this.#options.createRenderer?.() ?? createRenderer();
    return {
      render: (view, data) => {
        const enabled = simulation ?? this.#enabled;
        const workspace = {
          enabled,
          revision: this.#context.getStore()?.revision ?? this.#revision,
          changing: this.#changing,
        };
        const service = enabled ? this.#simulation : this.#live;
        const display = service?.displayService.getSettings();
        const page = typeof data.page === "object" && data.page !== null ? data.page : {};
        return renderer.render(view, {
          ...data,
          workspace,
          page: {
            ...(display
              ? {
                  siteName: display.tapboardName,
                  adminAccent: display.accent,
                  displayStylesheetHref: `/assets/css/display.css?v=1&theme=${encodeURIComponent(display.theme)}&accent=${encodeURIComponent(display.accent)}&font=${encodeURIComponent(display.font)}`,
                }
              : {}),
            ...page,
            workspace,
          },
        });
      },
    };
  }

  start(): Promise<HttpServerAddress> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<HttpServerAddress> {
    try {
      const address = await this.#primary.start();
      if (this.#stopping) throw unavailable("Tapboard is stopping.");
      if (this.#live && readSettings(this.#live.database).enabled) {
        this.#changing = true;
        try {
          await this.#openSimulation();
          this.#enabled = true;
        } catch (error) {
          if (this.#stopping) throw error;
          setEnabled(this.#live.database, false);
          this.#revision = readSettings(this.#live.database).revision;
          this.#live.authService.revokeAll();
          this.#logger.error(
            "Simulation could not be restored; normal workspace remains available",
          );
        } finally {
          this.#changing = false;
        }
      }
      return address;
    } catch (error) {
      await this.stop().catch(() => this.#reportCleanupFailure("workspace"));
      throw error;
    }
  }

  status(): SimulationStatus {
    return {
      enabled: this.#enabled,
      revision: this.#revision,
      changing: this.#changing,
      sensors: (this.#runner?.listSensors() ?? []).map((sensor) => ({
        ...sensor,
        error: sensor.error ?? null,
      })),
    };
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const revision = this.#revision;
    return this.#context.run({ revision }, async () => {
      try {
        if (this.#stopping) throw unavailable("Tapboard is stopping.");
        const path =
          "/" +
          new URL(request.url ?? "/", "http://tapboard.local").pathname
            .split("/")
            .filter(Boolean)
            .join("/");
        if (
          path === "/api/public/workspace" ||
          path === "/api/admin/simulation" ||
          path === "/admin/simulator" ||
          path.startsWith("/admin/simulation/")
        ) {
          await this.#controls.handle(request, response);
          return;
        }
        // External devices always remain attached to the real installation.
        const machine =
          path === "/api/v1/telemetry/batch" || path.startsWith("/api/v1/telemetry/taps/");
        if (this.#changing && !machine && path !== "/healthz")
          throw unavailable("The workspace is changing. Please try again.");
        const simulation = this.#enabled && !machine && path !== "/healthz";
        if (
          simulation &&
          (path.startsWith("/admin/integrations") ||
            path.includes("/brewfather") ||
            path.startsWith("/api/admin/outbound"))
        ) {
          throw unavailable(
            "External integrations are unavailable in simulation. Return to normal mode to manage them.",
          );
        }
        const router = simulation ? this.#simulationRouter : this.#liveRouter;
        if (!router) throw unavailable("The workspace is unavailable.");
        const work = router.handle(request, response);
        if (simulation) this.#requests.add(work);
        try {
          await work;
        } finally {
          this.#requests.delete(work);
        }
      } catch (error) {
        sendHttpError(error, response, this.#logger);
      }
    });
  }

  async setEnabled(enabled: boolean, sessionToken: string): Promise<SessionMaterial> {
    return this.#transition(sessionToken, async () => {
      if (enabled && !this.#simulationApp) await this.#openSimulation();
      if (!enabled) {
        this.#runner?.stop();
        await this.#drain();
      }
      const live = this.#requireLive();
      const material = live.database.withTransaction(() => {
        if (this.#stopping) throw unavailable("Tapboard is stopping.");
        const renewed = live.authService.rotateForWorkspace(sessionToken);
        if (!renewed) throw unavailable("Sign in again before changing workspaces.");
        setEnabled(live.database, enabled);
        return renewed;
      });
      this.#enabled = enabled;
      this.#revision = readSettings(live.database).revision;
      live.liveUpdates.disconnectAll();
      this.#simulation?.liveUpdates.disconnectAll();
      if (!enabled) await this.#closeSimulation();
      return material;
    });
  }

  async reset(sessionToken: string): Promise<SessionMaterial> {
    return this.#transition(sessionToken, async () => {
      if (!this.#enabled) throw unavailable("Enable simulation before resetting its data.");
      this.#runner?.stop();
      await this.#drain();
      await this.#assertFileSafety();
      if (this.#stopping) throw unavailable("Tapboard is stopping.");
      try {
        await this.#closeSimulation();
        // Only the fixed, validated simulation file and its SQLite sidecars are disposable.
        for (const suffix of ["", "-wal", "-shm"])
          await rm(this.#simulationPath() + suffix, { force: true });
        await this.#openSimulation();
        const live = this.#requireLive();
        const material = live.database.withTransaction(() => {
          if (this.#stopping) throw unavailable("Tapboard is stopping.");
          const renewed = live.authService.rotateForWorkspace(sessionToken);
          if (!renewed) throw unavailable("Sign in again before resetting simulation.");
          bumpRevision(live.database);
          return renewed;
        });
        this.#revision = readSettings(live.database).revision;
        live.liveUpdates.disconnectAll();
        return material;
      } catch (error) {
        // Once replacement begins, every failure invalidates pages for the discarded dataset,
        // including session expiration between authorization and the final mode transaction.
        const live = this.#requireLive();
        live.database.withTransaction(() => {
          setEnabled(live.database, false);
          live.authService.revokeAll();
        });
        this.#enabled = false;
        this.#revision = readSettings(live.database).revision;
        live.liveUpdates.disconnectAll();
        await this.#closeSimulation();
        throw error;
      }
    });
  }

  async #transition(
    token: string,
    operation: () => Promise<SessionMaterial>,
  ): Promise<SessionMaterial> {
    if (this.#changing || this.#stopping)
      throw unavailable("Another workspace change is in progress.");
    if (!this.#requireLive().authService.validateSession(token))
      throw unavailable("Sign in again before changing workspaces.");
    this.#changing = true;
    this.#transitionWork = this.#performTransition(operation);
    try {
      return await this.#transitionWork;
    } finally {
      this.#transitionWork = undefined;
    }
  }

  async #performTransition(operation: () => Promise<SessionMaterial>): Promise<SessionMaterial> {
    try {
      return await operation();
    } catch (error) {
      if (!this.#enabled) await this.#closeSimulation();
      else if (!this.#simulationApp) {
        const live = this.#requireLive();
        setEnabled(live.database, false);
        this.#enabled = false;
        this.#revision = readSettings(live.database).revision;
        live.authService.revokeAll();
      } else if (!this.#stopping) this.#runner?.start();
      throw error;
    } finally {
      this.#changing = false;
    }
  }

  #requireLive(): SimulationRuntimeServices {
    if (!this.#live) throw unavailable("Tapboard is not ready.");
    return this.#live;
  }

  #requireRunner(): SimulationRunner {
    if (!this.#enabled || this.#changing || this.#stopping || !this.#runner)
      throw unavailable("Enable simulation before using these controls.");
    return this.#runner;
  }
  pour(tapId: string, ounces: number): void {
    this.#requireRunner().pour(tapId, ounces);
  }
  setOnline(tapId: string, online: boolean): void {
    this.#requireRunner().setOnline(tapId, online);
  }
  setNoise(tapId: string, enabled: boolean): void {
    this.#requireRunner().setNoise(tapId, enabled);
  }

  #simulationPath(): string {
    return resolve(this.#config.databasePath) + ".simulation.sqlite3";
  }

  async #assertFileSafety(): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const info = await lstat(this.#simulationPath() + suffix);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw unavailable("The simulation data path is not a private regular file.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }

  #openSimulation(): Promise<void> {
    if (this.#opening) return this.#opening;
    this.#opening = this.#doOpenSimulation().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  async #doOpenSimulation(): Promise<void> {
    await this.#assertFileSafety();
    if (this.#stopping) throw unavailable("Tapboard is stopping.");
    const live = this.#requireLive();
    // Credentials and network destinations are never copied from the normal database.
    const config: ApplicationConfig = { ...this.#config, databasePath: this.#simulationPath() };
    delete (config as { secretKey?: string }).secretKey;
    const app = this.#factory(
      {
        ...this.#options,
        config,
        createRenderer: () => this.#renderer(true),
        createHttpServer: (serverOptions) => {
          this.#simulationRouter = serverOptions.router;
          return {
            start: () =>
              Promise.resolve(
                this.#primary.address() ?? { address: "127.0.0.1", family: "IPv4", port: 0 },
              ),
            stop: async () => {},
          };
        },
      },
      {
        simulation: true,
        authService: live.authService,
        onComposed: (services) => {
          this.#simulation = services;
          seedSimulation(services);
          this.#runner = new SimulationRunner(services, {
            onSampleCommitted: (tapId) =>
              services.liveUpdates.publish({ name: "telemetry.updated", tapId }),
            onError: () => this.#logger.error("Simulation sensor failed"),
          });
        },
      },
    );
    try {
      await app.start();
      if (this.#stopping) throw unavailable("Tapboard is stopping.");
      this.#simulationApp = app;
      this.#runner?.start();
    } catch (error) {
      const runner = this.#runner;
      this.#simulation = undefined;
      this.#simulationApp = undefined;
      this.#simulationRouter = undefined;
      this.#runner = undefined;
      try {
        runner?.stop();
      } catch {
        this.#reportCleanupFailure("simulation-runner");
      }
      await app.stop().catch(() => this.#reportCleanupFailure("simulation"));
      throw error;
    }
  }

  #reportCleanupFailure(resource: "workspace" | "simulation-runner" | "simulation"): void {
    try {
      this.#logger.error("Workspace cleanup failed", { resource });
    } catch {
      // Reporting cannot replace the original failure or skip another disposer.
    }
  }

  async #drain(): Promise<void> {
    if (!this.#requests.size) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#requests]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(unavailable("A request is still finishing. Try changing workspaces again.")),
            this.#config.shutdownGraceMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #closeSimulation(): Promise<void> {
    const runner = this.#runner;
    const app = this.#simulationApp;
    this.#simulationApp = undefined;
    this.#simulation = undefined;
    this.#simulationRouter = undefined;
    this.#runner = undefined;
    let failure: { readonly error: unknown } | undefined;
    try {
      runner?.stop();
    } catch (error) {
      failure = { error };
    }
    try {
      await app?.stop();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= (async () => {
      this.#stopping = true;
      const runner = this.#runner;
      this.#runner = undefined;
      let failure: { readonly error: unknown } | undefined;
      try {
        runner?.stop();
      } catch (error) {
        failure = { error };
      }
      try {
        this.#simulation?.liveUpdates.disconnectAll();
      } catch (error) {
        failure ??= { error };
      }
      // Embedded composition can still be opening when a host shutdown arrives.
      if (this.#opening) await this.#opening.catch(() => undefined);
      if (this.#transitionWork) await this.#transitionWork.catch(() => undefined);
      try {
        await this.#primary.stop();
      } catch (error) {
        failure ??= { error };
      }
      try {
        await this.#closeSimulation();
      } catch (error) {
        failure ??= { error };
      }
      if (failure) throw failure.error;
    })();
    return this.#stopPromise;
  }
  address(): HttpServerAddress | undefined {
    return this.#primary.address();
  }
  isReady(): boolean {
    return this.#primary.isReady() && (!this.#enabled || this.#simulationApp?.isReady() === true);
  }
  renderer(): Renderer | undefined {
    return this.#enabled ? this.#simulationApp?.renderer() : this.#primary.renderer();
  }
}
