import type { AuthService } from "../auth/service.ts";
import type { BeverageService } from "../beverages/service.ts";
import type { KegService } from "../kegs/service.ts";
import type { FillService } from "../fills/service.ts";
import type { TapService } from "../taps/service.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import type { LiveUpdateService } from "../live/service.ts";
import type { DatabaseConnection } from "../../infrastructure/database/connection.ts";

/** Composition-only seam; each workspace owns its domain services and connection. */
export interface SimulationRuntimeServices {
  readonly database: DatabaseConnection;
  readonly authService: AuthService;
  readonly beverageService: BeverageService;
  readonly kegService: KegService;
  readonly fillService: FillService;
  readonly tapService: TapService;
  readonly telemetryService: TelemetryService;
  readonly detectorService: DetectorService;
  readonly displayService: DisplaySettingsService;
  readonly liveUpdates: LiveUpdateService;
}

export interface WorkspaceRuntimeHooks {
  readonly authService?: AuthService;
  readonly simulation?: boolean;
  readonly onComposed: (services: SimulationRuntimeServices) => void;
}
