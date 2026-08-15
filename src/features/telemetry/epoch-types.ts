import type { DetectorConfig, DetectorConfigOverride } from "./detector-config.ts";
import type { DetectorRuntimeState } from "./detector.ts";
import type { TelemetryPrimaryKind } from "./types.ts";

export interface DetectorGlobalConfig {
  readonly revision: number;
  readonly config: DetectorConfig;
  readonly updatedAt: string;
}
export interface DetectorTapOverride {
  readonly tapId: string;
  readonly revision: number;
  readonly override: DetectorConfigOverride;
  readonly updatedAt: string;
}
export interface DetectorArbitrationGroup {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface DetectorArbitrationMember {
  readonly tapId: string;
  readonly groupId: string;
  readonly joinedAt: string;
}
export type TelemetryEpochCloseReason =
  | "assignment_unassigned"
  | "assignment_moved"
  | "fill_ended"
  | "source_changed"
  | "capacity_changed"
  | "tare_changed"
  | "density_changed"
  | "detector_config_changed"
  | "manual_rebaseline"
  | "arbitration_changed";
export interface TelemetryEpoch {
  readonly id: string;
  readonly tapId: string;
  readonly sourceId: string | null;
  readonly fillId: string;
  readonly assignmentId: string;
  readonly kegId: string;
  readonly capacityMl: number;
  readonly tareG: number;
  readonly densityGPerMl: number;
  readonly densitySource: "manual_override" | "fg_derived" | "fallback_fg";
  readonly normalizationVersion: number;
  readonly detectorConfigVersion: string;
  readonly globalConfigRevision: number;
  readonly tapOverrideRevision: number | null;
  readonly arbitrationGroupId: string | null;
  readonly config: DetectorConfig;
  readonly startedAt: string;
  readonly startedAtEpochMs: number;
  readonly endedAt: string | null;
  readonly endedAtEpochMs: number | null;
  readonly closeReason: TelemetryEpochCloseReason | null;
}
export type CreateTelemetryEpoch = Omit<
  TelemetryEpoch,
  "endedAt" | "endedAtEpochMs" | "closeReason"
>;
export interface TelemetryEpochState extends DetectorRuntimeState {
  readonly epochId: string;
  readonly lastMeasurementId: string | null;
  readonly lastPrimaryKind: TelemetryPrimaryKind | null;
  readonly lastPrimaryValue: number | null;
  readonly lastTemperatureC: number | null;
  readonly lastPublicVolumeMl: number | null;
  readonly lastDiagnosticCode:
    "ok" | "below_tare" | "negative_volume" | "above_capacity" | "implausible_jump" | null;
  readonly updatedAt: string;
}
export interface TelemetryEpochSample {
  readonly epochId: string;
  readonly measurementId: string;
  readonly measuredAtEpochMs: number;
  readonly interpretedVolumeMl: number;
}
export interface CompletedPour {
  readonly id: string;
  readonly effectKey: string;
  readonly fillId: string;
  readonly tapId: string;
  readonly assignmentId: string;
  readonly epochId: string;
  readonly detectorSessionId: string;
  readonly canonicalVolumeMl: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly createdAt: string;
}
export type CreateCompletedPour = CompletedPour;
export interface EffectiveDetectorConfig {
  readonly config: DetectorConfig;
  readonly globalConfigRevision: number;
  readonly tapOverrideRevision: number | null;
}
export interface DueDetectorState {
  readonly epoch: TelemetryEpoch;
  readonly state: TelemetryEpochState;
  readonly group: DetectorArbitrationGroup | null;
}
