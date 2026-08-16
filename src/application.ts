import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type ApplicationConfig, type LoadConfigOptions } from "./config.ts";
import {
  openDatabase,
  type DatabaseConnection,
  type DatabaseExecutor,
} from "./infrastructure/database/connection.ts";
import { APPLICATION_SCHEMA_VERSION } from "./infrastructure/database/migrations.ts";
import { sendJson } from "./infrastructure/http/error-mapper.ts";
import {
  HttpServer,
  type HttpServerAddress,
  type HttpServerOptions,
} from "./infrastructure/http/server.ts";
import { Router } from "./infrastructure/http/router.ts";
import { registerStaticAssets } from "./infrastructure/http/static-assets.ts";
import {
  createRenderer,
  type CreateRendererOptions,
  type Renderer,
} from "./infrastructure/rendering/renderer.ts";
import { createAuthService } from "./features/auth/service.ts";
import { createSecretsService } from "./features/secrets/service.ts";
import { createKegService } from "./features/kegs/service.ts";
import { registerKegRoutes } from "./features/kegs/routes.ts";
import { createBeverageService, type BeverageService } from "./features/beverages/service.ts";
import { registerBeverageRoutes } from "./features/beverages/routes.ts";
import { createFillService } from "./features/fills/service.ts";
import { registerFillRoutes } from "./features/fills/routes.ts";
import { createTapService } from "./features/taps/service.ts";
import type {
  AssignmentClosedContext,
  AssignmentOpenedContext,
  TapAssignmentExtensionPort,
} from "./features/taps/types.ts";
import { registerTapRoutes } from "./features/taps/routes.ts";
import { createMachineKeyService } from "./features/machine-keys/service.ts";
import { TelemetryService, registerTelemetryRoutes } from "./features/telemetry/index.ts";
import { DetectorService } from "./features/telemetry/detector-service.ts";
import {
  createHealthService,
  registerHealthRoutes,
  type HealthService,
} from "./features/health/index.ts";
import { createForecastService, registerForecastRoutes } from "./features/forecasting/index.ts";
import { createDisplaySettingsService } from "./features/display/index.ts";
import { createDashboardService } from "./features/dashboard/index.ts";
import { createPublicStoryService } from "./features/story/index.ts";
import { LiveUpdateService, observeCommittedCalls } from "./features/live/index.ts";
import { registerWebRoutes } from "./features/web/index.ts";
import { createLogger, type Logger } from "./shared/logging.ts";

type ApplicationState = "new" | "starting" | "ready" | "stopping" | "stopped" | "failed";
type DatabaseOpener = (path: string) => DatabaseConnection;
type RendererFactory = (options?: CreateRendererOptions) => Renderer;

export interface HttpServerLifecycle {
  start(host: string, port: number): Promise<HttpServerAddress>;
  stop(): Promise<void>;
}

type HttpServerFactory = (options: HttpServerOptions) => HttpServerLifecycle;

export interface CreateApplicationOptions {
  readonly config?: ApplicationConfig;
  readonly configOptions?: LoadConfigOptions;
  readonly logger?: Logger;
  readonly openDatabase?: DatabaseOpener;
  readonly createRenderer?: RendererFactory;
  readonly createHttpServer?: HttpServerFactory;
}

export interface Application {
  start(): Promise<HttpServerAddress>;
  stop(): Promise<void>;
  address(): HttpServerAddress | undefined;
  isReady(): boolean;
  renderer(): Renderer | undefined;
}

class FoundationApplication implements Application {
  readonly #config: ApplicationConfig;
  readonly #logger: Logger;
  readonly #openDatabase: DatabaseOpener;
  readonly #createRenderer: RendererFactory;
  readonly #createHttpServer: HttpServerFactory;
  #state: ApplicationState = "new";
  #database: DatabaseConnection | undefined;
  #renderer: Renderer | undefined;
  #httpServer: HttpServerLifecycle | undefined;
  #beverageService: BeverageService | undefined;
  #detectorService: DetectorService | undefined;
  #healthService: HealthService | undefined;
  #liveUpdates: LiveUpdateService | undefined;
  #address: HttpServerAddress | undefined;
  #starting: Promise<HttpServerAddress> | undefined;
  #stopping: Promise<void> | undefined;
  #stopRequested = false;

  constructor(options: CreateApplicationOptions) {
    this.#config = options.config ?? loadConfig(options.configOptions);
    this.#logger = options.logger ?? createLogger();
    this.#openDatabase = options.openDatabase ?? openDatabase;
    this.#createRenderer = options.createRenderer ?? createRenderer;
    this.#createHttpServer =
      options.createHttpServer ?? ((serverOptions) => new HttpServer(serverOptions));
  }

  start(): Promise<HttpServerAddress> {
    if (this.#starting !== undefined) return this.#starting;
    if (this.#state === "ready" && this.#address !== undefined) {
      return Promise.resolve(this.#address);
    }
    if (this.#state !== "new") {
      return Promise.reject(new Error(`Application cannot start from state: ${this.#state}`));
    }

    this.#state = "starting";
    this.#starting = this.#start();
    return this.#starting;
  }

  async #start(): Promise<HttpServerAddress> {
    try {
      await mkdir(dirname(this.#config.databasePath), { recursive: true });
      this.#database = this.#openDatabase(this.#config.databasePath);
      this.#renderer = this.#createRenderer();

      const authService = createAuthService(this.#database, {
        ...(this.#config.canonicalExternalOrigin !== undefined
          ? { canonicalOrigin: this.#config.canonicalExternalOrigin }
          : {}),
        ...(this.#config.sessionInactivityMs !== undefined ||
        this.#config.sessionAbsoluteMs !== undefined
          ? {
              session: {
                ...(this.#config.sessionInactivityMs !== undefined
                  ? { inactivityMs: this.#config.sessionInactivityMs }
                  : {}),
                ...(this.#config.sessionAbsoluteMs !== undefined
                  ? { absoluteMs: this.#config.sessionAbsoluteMs }
                  : {}),
              },
            }
          : {}),
      });
      const secretsService = createSecretsService(this.#database, {
        ...(this.#config.secretKey ? { rootKey: this.#config.secretKey } : {}),
      });
      const liveUpdates = new LiveUpdateService(authService);
      this.#liveUpdates = liveUpdates;
      const rawDetectorService = new DetectorService(this.#database);
      this.#detectorService = rawDetectorService;
      const healthService = createHealthService(this.#database, {
        onError: () => this.#logger.error("Health maintenance failed"),
        onTargetedUpdate: (update) => {
          liveUpdates.publish({ name: "health.updated", tapId: update.tapId });
        },
      });
      this.#healthService = healthService;

      const publishAllTaps = (name: "tap.updated" | "fill.updated"): void => {
        for (const tap of rawTapService.listTaps()) {
          liveUpdates.publish({ name, tapId: tap.id });
        }
      };
      const publishTapByNumber = (tapNumber: unknown): void => {
        if (typeof tapNumber !== "number") return;
        const tap = rawTapService.listTaps().find((candidate) => candidate.tapNumber === tapNumber);
        if (tap !== undefined) {
          liveUpdates.publish({ name: "telemetry.updated", tapId: tap.id });
        }
      };

      const tapExtensionPort: TapAssignmentExtensionPort = {
        onAssignmentOpened: (
          database: DatabaseExecutor,
          context: AssignmentOpenedContext,
        ): void => {
          rawDetectorService.onAssignmentOpened(database, context);
          healthService.onAssignmentOpened(database, context);
        },
        onAssignmentClosed: (
          database: DatabaseExecutor,
          context: AssignmentClosedContext,
        ): void => {
          rawDetectorService.onAssignmentClosed(database, context);
          healthService.onAssignmentClosed(database, context);
        },
        onTapCreated: (database: DatabaseExecutor, tapId: string, occurredAt: string): void => {
          healthService.onTapCreated(database, tapId, occurredAt);
        },
        onTapRetired: (database: DatabaseExecutor, tapId: string, occurredAt: string): void => {
          healthService.onTapRetired(database, tapId, occurredAt);
        },
      };
      const rawTapService = createTapService(this.#database, { extensionPort: tapExtensionPort });
      const rawKegService = createKegService(this.#database, {
        onKegCorrection: (database, event) => {
          rawDetectorService.onKegCorrection(database, event);
          healthService.onKegCorrection(database, event);
        },
      });
      const kegService = observeCommittedCalls(rawKegService, {
        createKeg: () => publishAllTaps("fill.updated"),
        updateKeg: () => publishAllTaps("fill.updated"),
        deleteKeg: () => publishAllTaps("fill.updated"),
      });
      const rawBeverageService = createBeverageService(this.#database, {
        secretsService,
        densityExtensionPort: {
          onEffectiveDensityChanged: (database, event) => {
            rawDetectorService.onEffectiveDensityChanged(database, event);
            healthService.onEffectiveDensityChanged(database, event);
          },
        },
        onSyncCompleted: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
        },
      });
      this.#beverageService = rawBeverageService;
      const beverageService = observeCommittedCalls(rawBeverageService, {
        createCustomBeverage: () => publishAllTaps("fill.updated"),
        linkBrewfatherCandidate: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
        },
        updateCustomBeverage: () => publishAllTaps("fill.updated"),
        updateSensoryOverrides: (result, args) => {
          const changed =
            typeof result === "object" &&
            result !== null &&
            "changed" in result &&
            result.changed === true;
          if (!changed || typeof args[0] !== "string") return;
          for (const tap of rawTapService.listTaps()) {
            if (tap.activeAssignment?.beverageId !== args[0]) continue;
            liveUpdates.publish({ name: "fill.updated", tapId: tap.id });
          }
        },
        updatePresentationOverrides: () => publishAllTaps("fill.updated"),
        unlinkBeverage: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
        },
        deleteBeverage: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
        },
        configureBrewfatherAccount: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
        },
        removeBrewfatherApiKey: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
        },
      });
      const tapService = observeCommittedCalls(rawTapService, {
        createTap: () => publishAllTaps("tap.updated"),
        updateTap: () => publishAllTaps("tap.updated"),
        updateAssignmentMystery: (result, args) => {
          const changed =
            typeof result === "object" &&
            result !== null &&
            "changed" in result &&
            result.changed === true;
          if (changed && typeof args[0] === "string") {
            liveUpdates.publish({ name: "tap.updated", tapId: args[0] });
          }
        },
        assignFill: () => {
          publishAllTaps("tap.updated");
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
        },
        unassign: () => {
          publishAllTaps("tap.updated");
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
        },
        moveFill: () => publishAllTaps("tap.updated"),
        retireTap: () => publishAllTaps("tap.updated"),
        deleteTap: () => publishAllTaps("tap.updated"),
      });
      const rawFillService = createFillService(this.#database, {
        beverageService,
        assignmentPort: rawTapService.asFillAssignmentPort(),
      });
      const fillService = observeCommittedCalls(rawFillService, {
        createFill: () => {
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
        },
        markOnDeck: () => liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" }),
        removeFromOnDeck: () => liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" }),
        reorderOnDeck: () => liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" }),
        kickFill: () => {
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
          publishAllTaps("fill.updated");
        },
        deleteFill: () => {
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
          publishAllTaps("fill.updated");
        },
      });
      const machineKeyService = createMachineKeyService(this.#database);
      const rawTelemetryService = new TelemetryService({
        database: this.#database,
        machineKeyService,
        authorityExtensionPort: {
          onAuthorityChanged: (database, event) => {
            rawDetectorService.onAuthorityChanged(database, event);
            healthService.onAuthorityChanged(database, event);
          },
        },
        acceptedExtensionPort: {
          onAcceptedSample: (database, event) => {
            rawDetectorService.onAcceptedSample(database, event);
            healthService.onAcceptedSample(database, event);
          },
        },
      });
      const telemetryService = observeCommittedCalls(rawTelemetryService, {
        ingestSingle: (result, args) => {
          const outcome = result as { readonly outcome?: string; readonly duplicate?: boolean };
          if (outcome.outcome === "accepted" && outcome.duplicate !== true)
            publishTapByNumber(args[1]);
        },
        ingestBatch: (result) => {
          const batch = result as {
            readonly results?: readonly {
              readonly tapNumber?: number;
              readonly outcome?: string;
              readonly duplicate?: boolean;
            }[];
          };
          const dirty = new Set(
            (batch.results ?? [])
              .filter((item) => item.outcome === "accepted" && item.duplicate !== true)
              .map((item) => item.tapNumber),
          );
          for (const tapNumber of dirty) publishTapByNumber(tapNumber);
        },
        setTapAuthority: (_result, args) => {
          if (typeof args[0] === "string") {
            liveUpdates.publish({ name: "telemetry.updated", tapId: args[0] });
          }
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
        },
        createSource: () =>
          liveUpdates.publish({ name: "integration_status.updated", target: "header" }),
        rotateSourceKey: () =>
          liveUpdates.publish({ name: "integration_status.updated", target: "header" }),
      });
      const detectorService = observeCommittedCalls(rawDetectorService, {
        manualRebaseline: (_result, args) => {
          if (typeof args[0] === "string")
            liveUpdates.publish({ name: "telemetry.updated", tapId: args[0] });
        },
        setTapOverride: (_result, args) => {
          if (typeof args[0] === "string")
            liveUpdates.publish({ name: "telemetry.updated", tapId: args[0] });
        },
        clearTapOverride: (_result, args) => {
          if (typeof args[0] === "string")
            liveUpdates.publish({ name: "telemetry.updated", tapId: args[0] });
        },
      });
      const forecastService = createForecastService(this.#database);
      const rawDisplayService = createDisplaySettingsService(this.#database);
      const displayService = observeCommittedCalls(rawDisplayService, {
        updateSettings: () => liveUpdates.publish({ name: "display.updated", target: "display" }),
      });
      const storyService = createPublicStoryService({
        tapService,
        beverageService,
        fillService,
        detectorService,
        forecastService,
        healthService,
      });
      const dashboardService = createDashboardService({
        displayService,
        tapService,
        beverageService,
        fillService,
        detectorService,
        forecastService,
        healthService,
        telemetryService,
        storyService,
      });

      const router = new Router(this.#logger);
      router.get("/healthz", (_request, response) => {
        if (!this.isReady()) {
          sendJson(response, 503, { status: "unavailable" });
          return;
        }
        sendJson(response, 200, {
          status: "ok",
          schemaVersion: APPLICATION_SCHEMA_VERSION,
        });
      });

      registerKegRoutes({ router, kegService, authService });
      registerBeverageRoutes({ router, beverageService, authService });
      registerFillRoutes({ router, fillService, authService });
      registerTapRoutes({ router, tapService, authService, storyService });
      registerHealthRoutes({ router, healthService, authService });
      registerTelemetryRoutes({ router, telemetryService, detectorService, authService });
      registerForecastRoutes({ router, forecastService, authService });
      registerWebRoutes({
        router,
        renderer: this.#renderer,
        ...(this.#config.canonicalExternalOrigin === undefined
          ? {}
          : { canonicalOrigin: this.#config.canonicalExternalOrigin }),
        authService,
        dashboardService,
        storyService,
        displayService,
        beverageService,
        kegService,
        fillService,
        tapService,
        telemetryService,
        detectorService,
        healthService,
        liveUpdates,
      });
      registerStaticAssets(router, {
        root: fileURLToPath(new URL("../public/", import.meta.url)),
        cacheControl: "public, max-age=300",
        assets: [
          { kind: "css", file: "tokens.css", path: "css/tokens.css" },
          { kind: "css", file: "components.css", path: "css/components.css" },
          { kind: "css", file: "dashboard.css", path: "css/dashboard.css" },
          { kind: "css", file: "admin.css", path: "css/admin.css" },
          { kind: "js", file: "preference-bootstrap.js", path: "js/preference-bootstrap.js" },
          { kind: "js", file: "display-preferences.js", path: "js/display-preferences.js" },
          { kind: "js", file: "dirty-targets.js", path: "js/dirty-targets.js" },
          { kind: "js", file: "sse.js", path: "js/sse.js" },
          { kind: "js", file: "dashboard.js", path: "js/dashboard.js" },
          { kind: "js", file: "admin-display.js", path: "js/admin-display.js" },
        ],
      });

      this.#httpServer = this.#createHttpServer({
        router,
        logger: this.#logger,
        shutdownGraceMs: this.#config.shutdownGraceMs,
      });
      const address = await this.#httpServer.start(this.#config.host, this.#config.port);
      if (this.#stopRequested) {
        throw new Error("Application startup was interrupted by shutdown");
      }
      detectorService.startMaintenance({
        onError: () => this.#logger.error("Detector maintenance failed"),
      });
      healthService.startMaintenance();
      this.#address = address;
      this.#state = "ready";
      beverageService.startPeriodicSync();
      return address;
    } catch (error) {
      this.#state = "failed";
      this.#address = undefined;
      await this.#closeResourcesAfterFailure();
      throw error;
    } finally {
      this.#starting = undefined;
    }
  }

  stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    if (this.#state === "stopped") return Promise.resolve();

    this.#stopRequested = true;
    if (this.#state !== "failed") this.#state = "stopping";
    this.#address = undefined;
    this.#stopping = this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    let failure: unknown;
    try {
      this.#liveUpdates?.stop();
      this.#liveUpdates = undefined;
    } catch {
      // Ignored
    }
    try {
      this.#beverageService?.stopPeriodicSync();
      this.#beverageService = undefined;
    } catch {
      // Ignored
    }

    try {
      this.#healthService?.stopMaintenance();
      this.#healthService = undefined;
    } catch {
      // Ignored
    }

    try {
      this.#detectorService?.stopMaintenance();
      this.#detectorService = undefined;
    } catch {
      // Ignored
    }

    try {
      if (this.#starting !== undefined) {
        await this.#starting.catch(() => undefined);
      }
      await this.#httpServer?.stop();
    } catch (error) {
      failure = error;
    }

    try {
      this.#closeDatabase();
    } catch (error) {
      this.#logger.error("Database close failed", { error });
      failure ??= error;
    } finally {
      this.#renderer = undefined;
      this.#state = "stopped";
    }

    if (failure !== undefined) {
      throw failure instanceof Error ? failure : new Error("Application shutdown failed");
    }
  }

  address(): HttpServerAddress | undefined {
    return this.#address;
  }

  isReady(): boolean {
    return this.#state === "ready" && this.#database?.isOpen === true;
  }

  renderer(): Renderer | undefined {
    return this.#renderer;
  }

  async #closeResourcesAfterFailure(): Promise<void> {
    try {
      this.#liveUpdates?.stop();
      this.#liveUpdates = undefined;
    } catch {
      // Ignored
    }
    try {
      this.#beverageService?.stopPeriodicSync();
      this.#beverageService = undefined;
    } catch {
      // Ignored
    }

    try {
      this.#healthService?.stopMaintenance();
      this.#healthService = undefined;
    } catch {
      // Ignored
    }

    try {
      this.#detectorService?.stopMaintenance();
      this.#detectorService = undefined;
    } catch {
      // Ignored
    }

    try {
      await this.#httpServer?.stop();
    } catch (closeError) {
      this.#logger.error("HTTP cleanup after startup failure failed", { error: closeError });
    } finally {
      try {
        this.#closeDatabase();
      } catch (closeError) {
        this.#logger.error("Database cleanup after startup failure failed", { error: closeError });
      }
      this.#renderer = undefined;
    }
  }

  #closeDatabase(): void {
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }
}

export function createApplication(options: CreateApplicationOptions = {}): Application {
  return new FoundationApplication(options);
}
