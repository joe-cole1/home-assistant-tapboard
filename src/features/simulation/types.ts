import type { DatabaseConnection } from "../../infrastructure/database/connection.ts";
import type { BeverageService } from "../beverages/service.ts";
import type { FillService } from "../fills/service.ts";
import type { KegService } from "../kegs/service.ts";
import type { TapService } from "../taps/service.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import type { TelemetryService } from "../telemetry/service.ts";

export interface SimulationSettings {
  readonly enabled: boolean;
  readonly revision: number;
  readonly seeded: boolean;
}

export interface SimulationSensor {
  readonly tapId: string;
  readonly sourceId: string;
  /** Last accepted value at this sensor; assigned Fill volume is stored separately. */
  readonly remainingMl: number;
  readonly temperatureC: number;
  readonly online: boolean;
  readonly noiseEnabled: boolean;
  readonly sequence: number;
}

export type SimulationSensorStatus =
  | "stopped"
  | "offline"
  | "unassigned"
  | "unavailable"
  | "settling"
  | "ready"
  | "pouring"
  | "empty"
  | "error";

export interface SimulationSensorView extends SimulationSensor {
  /** The assigned Fill's current physical volume, or the last delivered value if unassigned. */
  readonly remainingMl: number;
  readonly tapNumber: number;
  readonly label: string;
  readonly beverageName: string | null;
  readonly status: SimulationSensorStatus;
  readonly error: string | null;
  readonly pouring: boolean;
}

export interface SimulationDependencies {
  readonly database: DatabaseConnection;
  readonly telemetryService: TelemetryService;
  readonly detectorService: DetectorService;
  readonly tapService: TapService;
  readonly kegService: KegService;
  readonly fillService: FillService;
  readonly beverageService: BeverageService;
}

export interface SimulationRunnerOptions {
  readonly clock?: () => Date;
  /** Disable the sole timer when advancing an injected clock through tick(). */
  readonly autoSchedule?: boolean;
  readonly onSampleCommitted?: (tapId: string) => void;
  readonly onError?: (error: unknown) => void;
}
