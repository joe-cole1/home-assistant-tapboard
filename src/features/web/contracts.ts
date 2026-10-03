import type { Router } from "../../infrastructure/http/router.ts";
import type { Renderer } from "../../infrastructure/rendering/renderer.ts";
import type { Logger } from "../../shared/logging.ts";
import type { AuthService } from "../auth/service.ts";
import type { DashboardService } from "../dashboard/service.ts";
import type { PublicStoryService } from "../story/service.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import type { BeverageService } from "../beverages/service.ts";
import type { KegService } from "../kegs/service.ts";
import type { FillService } from "../fills/service.ts";
import type { TapService } from "../taps/service.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import type { HealthService } from "../health/service.ts";
import type { LiveUpdateService } from "../live/service.ts";
import type { TapWarService } from "../tap-wars/service.ts";
import type { PublicTapWarsService } from "../tap-wars/public.ts";
import type { OutboundService } from "../outbound/service.ts";
import type { SystemService } from "../system/index.ts";

export interface WebRouteDependencies {
  readonly logger?: Logger;
  readonly router: Router;
  readonly renderer: Renderer;
  readonly canonicalOrigin?: string;
  readonly authService: AuthService;
  readonly dashboardService: DashboardService;
  readonly storyService: PublicStoryService;
  readonly displayService: DisplaySettingsService;
  readonly beverageService: BeverageService;
  readonly kegService: KegService;
  readonly fillService: FillService;
  readonly tapService: TapService;
  readonly telemetryService: TelemetryService;
  readonly detectorService: DetectorService;
  readonly healthService: HealthService;
  readonly liveUpdates: LiveUpdateService;
  readonly tapWarsService: TapWarService;
  readonly publicTapWarsService: PublicTapWarsService;
  /** Optional until the application composition wires Issue 79 outbound UI. */
  readonly outboundService?: OutboundService;
  readonly systemService?: SystemService;
  readonly isReady?: () => boolean;
}

export type RegisterPublicRoutesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "canonicalOrigin"
  | "dashboardService"
  | "liveUpdates"
  | "logger"
  | "publicTapWarsService"
  | "renderer"
  | "router"
  | "storyService"
  | "tapWarsService"
>;
export type RegisterAuthenticationRoutesDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "displayService" | "logger" | "renderer" | "router"
>;
export type RegisterOverviewPagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "beverageService"
  | "dashboardService"
  | "displayService"
  | "fillService"
  | "healthService"
  | "kegService"
  | "logger"
  | "renderer"
  | "router"
  | "tapService"
  | "telemetryService"
>;
export type RegisterIntegrationPagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "beverageService"
  | "displayService"
  | "logger"
  | "outboundService"
  | "renderer"
  | "router"
  | "telemetryService"
>;
export type RegisterBeveragePagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "beverageService"
  | "displayService"
  | "fillService"
  | "kegService"
  | "logger"
  | "renderer"
  | "router"
  | "storyService"
>;
export type RegisterKegRoomPagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "beverageService"
  | "dashboardService"
  | "displayService"
  | "fillService"
  | "kegService"
  | "logger"
  | "renderer"
  | "router"
  | "tapService"
>;
export type RegisterTapPagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "dashboardService"
  | "detectorService"
  | "displayService"
  | "fillService"
  | "healthService"
  | "logger"
  | "renderer"
  | "router"
  | "tapService"
  | "telemetryService"
>;
export type RegisterTapWarsPagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "displayService"
  | "logger"
  | "publicTapWarsService"
  | "renderer"
  | "router"
  | "tapWarsService"
>;
export type RegisterDisplayPagesDependencies = Pick<
  WebRouteDependencies,
  "authService" | "displayService" | "logger" | "renderer" | "router"
>;
export type RegisterSystemPagesDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "dashboardService"
  | "displayService"
  | "isReady"
  | "liveUpdates"
  | "logger"
  | "renderer"
  | "router"
  | "systemService"
>;
export type RegisterAdminEventRoutesDependencies = Pick<
  WebRouteDependencies,
  "authService" | "liveUpdates" | "router"
>;
export type RegisterAdminTapWarsApiDependencies = Pick<
  WebRouteDependencies,
  "authService" | "publicTapWarsService" | "router" | "tapWarsService"
>;
export type RegisterSystemMutationsDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "logger" | "router" | "systemService"
>;
export type RegisterOutboundMutationsDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "logger" | "outboundService" | "router"
>;
export type RegisterDisplayMutationsDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "displayService" | "logger" | "router"
>;
export type RegisterBeverageMutationsDependencies = Pick<
  WebRouteDependencies,
  "authService" | "beverageService" | "canonicalOrigin" | "fillService" | "logger" | "router"
>;
export type RegisterKegRoomMutationsDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "fillService" | "kegService" | "logger" | "router"
>;
export type RegisterTapMutationsDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "canonicalOrigin"
  | "detectorService"
  | "displayService"
  | "healthService"
  | "logger"
  | "router"
  | "tapService"
  | "telemetryService"
>;
export type RegisterIntegrationMutationsDependencies = Pick<
  WebRouteDependencies,
  | "authService"
  | "beverageService"
  | "canonicalOrigin"
  | "displayService"
  | "logger"
  | "renderer"
  | "router"
  | "telemetryService"
>;
export type RegisterTapWarsMutationsDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "logger" | "router" | "tapWarsService"
>;
export type RenderTapDetailDependencies = Pick<
  WebRouteDependencies,
  | "dashboardService"
  | "detectorService"
  | "displayService"
  | "fillService"
  | "healthService"
  | "logger"
  | "renderer"
  | "tapService"
  | "telemetryService"
>;
export type RequireSystemServiceDependencies = Pick<WebRouteDependencies, "systemService">;
export type RequireOutboundServiceDependencies = Pick<WebRouteDependencies, "outboundService">;
export type RenderAdminDependencies = Pick<WebRouteDependencies, "displayService" | "renderer">;
export type RegisterAdminGetDependencies = Pick<
  WebRouteDependencies,
  "authService" | "displayService" | "logger" | "renderer" | "router"
>;
export type RenderAdminNotFoundDependencies = Pick<
  WebRouteDependencies,
  "displayService" | "renderer"
>;
export type RunAdminAutosaveDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "logger"
>;
export type RegisterAdminActionDependencies = Pick<
  WebRouteDependencies,
  "authService" | "canonicalOrigin" | "logger" | "router"
>;
export type RegisterAdminNotFoundDependencies = Pick<
  WebRouteDependencies,
  "authService" | "displayService" | "renderer" | "router"
>;
export type SendTapWarsVoteErrorDependencies = Pick<WebRouteDependencies, "publicTapWarsService">;
export type AdminTapWarsPageDataDependencies = Pick<
  WebRouteDependencies,
  "publicTapWarsService" | "tapWarsService"
>;
export type MachineKeyPageDataDependencies = Pick<
  WebRouteDependencies,
  "canonicalOrigin" | "displayService"
>;
