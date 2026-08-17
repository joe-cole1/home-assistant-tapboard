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
import type {
  FillAssignmentClosedContext,
  FillAssignmentLifecyclePort,
  FillEndedContext,
} from "./features/fills/types.ts";
import { registerFillRoutes } from "./features/fills/routes.ts";
import { createTapService } from "./features/taps/service.ts";
import { findActiveAssignmentByFillId } from "./features/taps/repository.ts";
import type {
  AssignmentClosedContext,
  AssignmentMysteryChangedContext,
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
import {
  DISPLAY_STYLESHEET_VERSION,
  generateDisplayStylesheet,
  validateStylesheetParams,
} from "./features/display/palette.ts";
import { createDashboardService } from "./features/dashboard/index.ts";
import { createPublicStoryService } from "./features/story/index.ts";
import {
  createPublicTapWarsService,
  TapWarService,
  type PublicTapWarsService,
} from "./features/tap-wars/index.ts";
import { LiveUpdateService, observeCommittedCalls } from "./features/live/index.ts";
import { registerWebRoutes } from "./features/web/index.ts";
import { createLogger, type Logger } from "./shared/logging.ts";
import { createEventEnvelope } from "./features/events/envelope.ts";
import type { EventEnvelope, EventIdentifiers } from "./features/events/types.ts";
import {
  OutboundService,
  OutboundWorker,
  type OutboundTransportRouter,
  type OutboundWorkerOptions,
} from "./features/outbound/index.ts";
import {
  HomeAssistantConnectionManager,
  type HomeAssistantDestination,
} from "./features/outbound/transports/home-assistant.ts";
import {
  WebhookTransport,
  type WebhookDestination,
} from "./features/outbound/transports/webhook.ts";
import type { PublicEventContextResolver } from "./features/outbound/transport-types.ts";
import type { SecretsService } from "./features/secrets/service.ts";

type ApplicationState = "new" | "starting" | "ready" | "stopping" | "stopped" | "failed";
type DatabaseOpener = (path: string) => DatabaseConnection;
type RendererFactory = (options?: CreateRendererOptions) => Renderer;

export interface OutboundRuntimeFactoryOptions {
  readonly database: DatabaseExecutor;
  readonly secrets: SecretsService;
  readonly outboundService: OutboundService;
  readonly publicContextResolver: PublicEventContextResolver;
  readonly transportRouter?: OutboundTransportRouter;
  readonly onError?: (error: unknown) => void;
}

export interface OutboundRuntime {
  readonly worker: Pick<OutboundWorker, "start" | "stop"> &
    Partial<
      Pick<
        OutboundWorker,
        "onDestinationEnabled" | "onDestinationDisabled" | "onDestinationCredentialsChanged"
      >
    >;
  readonly start?: () => void;
  readonly stop?: () => void;
}

type OutboundRuntimeFactory = (options: OutboundRuntimeFactoryOptions) => OutboundRuntime;

function createDefaultOutboundRuntime(options: OutboundRuntimeFactoryOptions): OutboundRuntime {
  const homeAssistant = new HomeAssistantConnectionManager();
  const webhook = new WebhookTransport({
    publicContextResolver: options.publicContextResolver,
  });
  const router: OutboundTransportRouter = options.transportRouter ?? {
    send(input) {
      if (input.destination.transport === "home_assistant") {
        const config = input.version.config;
        const destination: HomeAssistantDestination = {
          destinationId: input.destination.id,
          baseUrl: input.endpoint ?? (config.transport === "home_assistant" ? config.baseUrl : ""),
          token: input.token ?? "",
        };
        return homeAssistant.sendEvent(destination, input.envelope);
      }
      const destination: WebhookDestination = {
        endpoint: input.endpoint ?? "",
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        payloadFormat: input.payloadFormat ?? "standard",
        publicContextResolver: options.publicContextResolver,
      };
      return webhook.sendEvent(destination, input.envelope);
    },
    ensureHealthy(input) {
      const config = input.version.config;
      const destination: HomeAssistantDestination = {
        destinationId: input.destination.id,
        baseUrl: input.endpoint ?? (config.transport === "home_assistant" ? config.baseUrl : ""),
        token: input.token ?? "",
      };
      return homeAssistant.ensureAuthenticated(destination);
    },
    closeDestination(destinationId) {
      homeAssistant.closeDestination(destinationId);
    },
    stop() {
      homeAssistant.stop();
      webhook.stop();
    },
  };
  const workerOptions: OutboundWorkerOptions = {
    database: options.database,
    transports: router,
    secrets: options.secrets,
    onStatusChanged: (database, context) =>
      options.outboundService.integrationStatusChanged(database, context),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };
  const worker = new OutboundWorker(workerOptions);
  return {
    worker,
    start: () => worker.start(),
    stop: () => worker.stop(),
  };
}

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
  /** Inject a fake outbound runtime for deterministic tests/E2E. */
  readonly createOutboundRuntime?: OutboundRuntimeFactory;
  /** Inject only the transport router while retaining the real worker. */
  readonly outboundTransportRouter?: OutboundTransportRouter;
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
  readonly #createOutboundRuntime: OutboundRuntimeFactory;
  readonly #outboundTransportRouter: OutboundTransportRouter | undefined;
  #state: ApplicationState = "new";
  #database: DatabaseConnection | undefined;
  #renderer: Renderer | undefined;
  #httpServer: HttpServerLifecycle | undefined;
  #beverageService: BeverageService | undefined;
  #detectorService: DetectorService | undefined;
  #healthService: HealthService | undefined;
  #outboundRuntime: OutboundRuntime | undefined;
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
    this.#createOutboundRuntime = options.createOutboundRuntime ?? createDefaultOutboundRuntime;
    this.#outboundTransportRouter = options.outboundTransportRouter;
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
      const storyServiceRef: { current?: ReturnType<typeof createPublicStoryService> } = {};
      const publicContextResolver: PublicEventContextResolver = (identifiers) => {
        if (identifiers.tap_id === undefined || identifiers.tap_id === null) return undefined;
        const card = storyServiceRef.current?.getCard(identifiers.tap_id);
        if (card === undefined) return undefined;
        return {
          tapNumber: card.tapNumber,
          ...(card.title === undefined ? {} : { title: card.title }),
        };
      };
      const outboundService = new OutboundService(this.#database, {
        secrets: secretsService,
        lifecycle: {
          onDisabled: (destinationId) =>
            this.#outboundRuntime?.worker.onDestinationDisabled?.(destinationId),
          onEnabled: (destinationId) =>
            this.#outboundRuntime?.worker.onDestinationEnabled?.(destinationId),
          onCredentialsChanged: (destinationId) =>
            this.#outboundRuntime?.worker.onDestinationCredentialsChanged?.(destinationId),
          onRetired: (destinationId) =>
            this.#outboundRuntime?.worker.onDestinationDisabled?.(destinationId),
        },
      });
      const liveUpdates = new LiveUpdateService(authService);
      this.#liveUpdates = liveUpdates;
      const rawDetectorService = new DetectorService(this.#database, {
        onPourCompleted: (database, pour) => outboundService.pourCompleted(database, pour),
      });
      this.#detectorService = rawDetectorService;
      const healthService = createHealthService(this.#database, {
        onError: () => this.#logger.error("Health maintenance failed"),
        onHealthTransition: (database, context) =>
          outboundService.healthTransitioned(database, {
            tapId: context.tapId,
            checkId: context.checkId,
            previousState: context.previousState,
            previousSeverity: context.previousSeverity,
            current: {
              state: context.current.state,
              severity: context.current.severity,
              evidence: context.current.evidence,
              ...(context.current.reason === null ? {} : { reason: context.current.reason }),
            },
            occurredAt: context.occurredAt,
          }),
        onTargetedUpdate: (update) => {
          liveUpdates.publish({ name: "health.updated", tapId: update.tapId });
        },
      });
      this.#healthService = healthService;
      const rawTapWarsService = new TapWarService(this.#database, {
        // Deliberately lazy: the lifecycle port is composed before both the
        // tap and public-story services exist, while completion is later.
        publicTitleResolver: (tapId, assignmentId) => {
          try {
            return storyServiceRef.current?.getTitleForAssignment(tapId, assignmentId) ?? null;
          } catch {
            return null;
          }
        },
      });
      const publishTapWars = (): void => {
        liveUpdates.publish({ name: "tap_wars.updated", target: "tap-wars" });
      };

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
          outboundService.assignmentOpened(database, context);
        },
        onAssignmentClosed: (
          database: DatabaseExecutor,
          context: AssignmentClosedContext,
        ): void => {
          rawDetectorService.onAssignmentClosed(database, context);
          healthService.onAssignmentClosed(database, context);
          rawTapWarsService.pauseForAssignmentClose(
            database,
            context.assignmentId,
            context.occurredAt,
          );
        },
        onAssignmentMysteryChanged: (
          database: DatabaseExecutor,
          context: AssignmentMysteryChangedContext,
        ): void => {
          rawTapWarsService.refreshPublicTitleFallback(
            database,
            context.tapId,
            context.assignmentId,
          );
        },
        onTapCreated: (database: DatabaseExecutor, tapId: string, occurredAt: string): void => {
          healthService.onTapCreated(database, tapId, occurredAt);
        },
        onTapRetired: (database: DatabaseExecutor, tapId: string, occurredAt: string): void => {
          healthService.onTapRetired(database, tapId, occurredAt);
        },
        onTapBecameUnavailable: (
          database: DatabaseExecutor,
          tapId: string,
          occurredAt: string,
        ): void => {
          rawTapWarsService.pauseForTapUnavailable(database, tapId, occurredAt);
        },
      };
      const rawTapService = createTapService(this.#database, { extensionPort: tapExtensionPort });
      const publishFillUpdatesForBeverage = (beverageId: unknown): void => {
        if (typeof beverageId !== "string") return;
        for (const tap of rawTapService.listTaps()) {
          if (tap.activeAssignment?.beverageId !== beverageId) continue;
          liveUpdates.publish({ name: "fill.updated", tapId: tap.id });
        }
      };
      const rawKegService = createKegService(this.#database, {
        onKegCorrection: (database, event) => {
          rawDetectorService.onKegCorrection(database, event);
          healthService.onKegCorrection(database, event);
        },
      });
      const kegService = observeCommittedCalls(rawKegService, {
        createKeg: () => publishAllTaps("fill.updated"),
        updateKeg: () => publishAllTaps("fill.updated"),
        deleteKeg: () => {
          publishAllTaps("fill.updated");
          rawTapWarsService.reconcileEligibility();
          publishTapWars();
        },
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
          publishTapWars();
        },
      });
      this.#beverageService = rawBeverageService;
      const beverageService = observeCommittedCalls(rawBeverageService, {
        createCustomBeverage: () => publishAllTaps("fill.updated"),
        linkBrewfatherCandidate: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
          publishTapWars();
        },
        updateCustomBeverage: () => {
          publishAllTaps("fill.updated");
          publishTapWars();
        },
        autosaveCustomPresentation: (result, args) => {
          if (typeof args[1] !== "string") return;
          const beverage =
            typeof result === "object" &&
            result !== null &&
            "beverage" in result &&
            typeof result.beverage === "object" &&
            result.beverage !== null
              ? result.beverage
              : undefined;
          if (
            beverage === undefined ||
            !("updatedAt" in beverage) ||
            beverage.updatedAt === args[1]
          )
            return;
          publishFillUpdatesForBeverage(args[0]);
          publishTapWars();
        },
        updateSensoryOverrides: (result, args) => {
          const changed =
            typeof result === "object" &&
            result !== null &&
            "changed" in result &&
            result.changed === true;
          if (!changed || typeof args[0] !== "string") return;
          publishFillUpdatesForBeverage(args[0]);
        },
        updatePresentationOverrides: () => {
          publishAllTaps("fill.updated");
          publishTapWars();
        },
        unlinkBeverage: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
          publishTapWars();
        },
        deleteBeverage: () => {
          liveUpdates.publish({ name: "integration_status.updated", target: "header" });
          publishAllTaps("fill.updated");
          rawTapWarsService.reconcileEligibility();
          publishTapWars();
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
        updateTap: () => {
          publishAllTaps("tap.updated");
          publishTapWars();
        },
        updateAssignmentMystery: (result, args) => {
          const changed =
            typeof result === "object" &&
            result !== null &&
            "changed" in result &&
            result.changed === true;
          if (changed && typeof args[0] === "string") {
            liveUpdates.publish({ name: "tap.updated", tapId: args[0] });
            publishTapWars();
          }
        },
        autosaveName: (result, args) => {
          if (
            typeof args[0] !== "string" ||
            typeof args[1] !== "string" ||
            typeof result !== "object" ||
            result === null ||
            !("updatedAt" in result) ||
            result.updatedAt === args[1]
          )
            return;
          liveUpdates.publish({ name: "tap.updated", tapId: args[0] });
        },
        assignFill: () => {
          publishAllTaps("tap.updated");
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
          publishTapWars();
        },
        unassign: () => {
          publishAllTaps("tap.updated");
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
          publishTapWars();
        },
        moveFill: () => {
          publishAllTaps("tap.updated");
          publishTapWars();
        },
        retireTap: () => {
          publishAllTaps("tap.updated");
          publishTapWars();
        },
        deleteTap: () => {
          publishAllTaps("tap.updated");
          publishTapWars();
        },
      });
      const tapFillAssignmentPort = rawTapService.asFillAssignmentPort();
      const fillAssignmentPort: FillAssignmentLifecyclePort = {
        hasActiveAssignment: (fillId) => tapFillAssignmentPort.hasActiveAssignment(fillId),
        closeForFillEnd: (database, fillId, endedAt): FillAssignmentClosedContext | undefined => {
          // Capture before closing because the Tap adapter's legacy return
          // shape is intentionally void-compatible during migration.
          const active = findActiveAssignmentByFillId(database, fillId);
          const closed = tapFillAssignmentPort.closeForFillEnd(database, fillId, endedAt);
          if (active !== undefined) {
            return {
              assignmentId: active.id,
              tapId: active.tapId,
              fillId: active.fillId,
              endedAt,
            };
          }
          return typeof closed === "object" && closed !== null ? closed : undefined;
        },
      };
      const rawFillService = createFillService(this.#database, {
        beverageService,
        assignmentPort: fillAssignmentPort,
        onFillEnded: (database, context: FillEndedContext) => {
          if (context.assignmentId !== null && context.tapId !== null) {
            outboundService.assignmentClosed(
              database,
              {
                assignmentId: context.assignmentId,
                tapId: context.tapId,
                fillId: context.fillId,
                occurredAt: context.occurredAt,
                reason: "fill_ended",
              },
              context.reason,
            );
            return;
          }
          const identifiers: EventIdentifiers = {
            fill_id: context.fillId,
            keg_id: context.kegId,
            beverage_id: context.beverageId,
          };
          const event: EventEnvelope = createEventEnvelope(
            {
              event_type: "fill.ended",
              identifiers,
              data: { reason: context.reason },
              occurred_at: context.occurredAt,
            },
            { now: () => new Date(context.occurredAt) },
          );
          outboundService.admit(database, event);
        },
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
          rawTapWarsService.reconcileEligibility();
          publishTapWars();
        },
        deleteFill: () => {
          liveUpdates.publish({ name: "ondeck.updated", target: "ondeck" });
          publishAllTaps("fill.updated");
          rawTapWarsService.reconcileEligibility();
          publishTapWars();
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
        disableSource: () =>
          liveUpdates.publish({ name: "integration_status.updated", target: "header" }),
        revokeSource: () =>
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
        updateTapCardSettings: () =>
          liveUpdates.publish({ name: "display.updated", target: "cards" }),
        setTapCardOverride: (_result, args) => {
          if (typeof args[0] === "string")
            liveUpdates.publish({ name: "tap.updated", tapId: args[0] });
        },
        clearTapCardOverride: (result, args) => {
          if (result === true && typeof args[0] === "string")
            liveUpdates.publish({ name: "tap.updated", tapId: args[0] });
        },
      });
      const storyService = createPublicStoryService({
        tapService,
        beverageService,
        fillService,
        detectorService,
        forecastService,
        healthService,
        displayService,
      });
      storyServiceRef.current = storyService;
      const publicTapWarsService: PublicTapWarsService = createPublicTapWarsService({
        tapWarsService: rawTapWarsService,
        tapService,
        storyService,
      });
      const tapWarsService = observeCommittedCalls(rawTapWarsService, {
        start: publishTapWars,
        vote: publishTapWars,
        resume: publishTapWars,
        stop: publishTapWars,
        dismissPublicResult: publishTapWars,
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
        tapWarsService: publicTapWarsService,
        outboundService,
      });
      this.#outboundRuntime = this.#createOutboundRuntime({
        database: this.#database,
        secrets: secretsService,
        outboundService,
        publicContextResolver,
        ...(this.#outboundTransportRouter === undefined
          ? {}
          : { transportRouter: this.#outboundTransportRouter }),
        onError: () => this.#logger.error("Outbound worker failed"),
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
        tapWarsService,
        publicTapWarsService,
        outboundService,
      });
      // This route intentionally precedes the generic static-asset route. It
      // emits only validated, same-origin CSS so custom accents and selected
      // fonts never require inline style or a CDN request.
      router.get("/assets/css/display.css", (request, response) => {
        const url = new URL(request.url ?? "/assets/css/display.css", "http://tapboard.local");
        const queryNames = [...url.searchParams.keys()];
        if (
          queryNames.length !== 4 ||
          new Set(queryNames).size !== 4 ||
          !queryNames.every(
            (name) => name === "v" || name === "theme" || name === "accent" || name === "font",
          ) ||
          url.searchParams.get("v") !== DISPLAY_STYLESHEET_VERSION
        ) {
          response.writeHead(400, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const params = validateStylesheetParams(
          url.searchParams.get("theme"),
          url.searchParams.get("accent"),
          url.searchParams.get("font"),
        );
        if (params === undefined) {
          response.writeHead(400, { "cache-control": "no-store" });
          response.end();
          return;
        }
        const generated = generateDisplayStylesheet(params.theme, params.accent, params.font);
        const headers = {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=300, must-revalidate",
          "x-content-type-options": "nosniff",
          etag: generated.etag,
        };
        if (request.headers["if-none-match"] === generated.etag) {
          response.writeHead(304, headers);
          response.end();
          return;
        }
        response.writeHead(200, headers);
        response.end(generated.css);
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
          { kind: "js", file: "story.js", path: "js/story.js" },
          { kind: "js", file: "admin-display.js", path: "js/admin-display.js" },
          { kind: "js", file: "admin-shell.js", path: "js/admin-shell.js" },
          { kind: "js", file: "admin-autosave.js", path: "js/admin-autosave.js" },
          { kind: "js", file: "admin-tap-wars.js", path: "js/admin-tap-wars.js" },
          { kind: "font", file: "outfit-6c18d579.woff2", path: "fonts/outfit-6c18d579.woff2" },
          { kind: "font", file: "inter-3100e775.woff2", path: "fonts/inter-3100e775.woff2" },
          { kind: "font", file: "roboto-1404ca34.woff2", path: "fonts/roboto-1404ca34.woff2" },
          { kind: "font", file: "fredoka-99d6c78e.woff2", path: "fonts/fredoka-99d6c78e.woff2" },
          {
            kind: "font",
            file: "montserrat-06b16db7.woff2",
            path: "fonts/montserrat-06b16db7.woff2",
          },
          {
            kind: "font",
            file: "barlow_condensed-7fff1bb2.woff2",
            path: "fonts/barlow_condensed-7fff1bb2.woff2",
          },
          {
            kind: "font",
            file: "bree_serif-ca092b41.woff2",
            path: "fonts/bree_serif-ca092b41.woff2",
          },
          { kind: "font", file: "bungee-126eec70.woff2", path: "fonts/bungee-126eec70.woff2" },
          { kind: "font", file: "rye-00de26ff.woff2", path: "fonts/rye-00de26ff.woff2" },
          {
            kind: "font",
            file: "special_elite-770493d8.woff2",
            path: "fonts/special_elite-770493d8.woff2",
          },
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
      if (this.#outboundRuntime !== undefined) {
        if (this.#outboundRuntime.start !== undefined) this.#outboundRuntime.start();
        else this.#outboundRuntime.worker.start();
      }
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
    const outboundRuntime = this.#outboundRuntime;
    this.#outboundRuntime = undefined;
    try {
      if (outboundRuntime !== undefined) {
        if (outboundRuntime.stop !== undefined) outboundRuntime.stop();
        else outboundRuntime.worker.stop();
      }
    } catch (error) {
      failure = error;
    }
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
    const outboundRuntime = this.#outboundRuntime;
    this.#outboundRuntime = undefined;
    try {
      if (outboundRuntime !== undefined) {
        if (outboundRuntime.stop !== undefined) outboundRuntime.stop();
        else outboundRuntime.worker.stop();
      }
    } catch (error) {
      this.#logger.error("Outbound cleanup after startup failure failed", { error });
    }
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
