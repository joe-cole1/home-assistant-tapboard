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
