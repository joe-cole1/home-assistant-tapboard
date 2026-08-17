export type ForecastStatus = "available" | "unavailable" | "depleted" | "anomaly" | "stale";

export type ForecastReason =
  | "sufficient_fill_history"
  | "insufficient_fill_history"
  | "no_assignment_history"
  | "no_active_assignment"
  | "waiting_for_measurement"
  | "fill_ended"
  | "current_volume_unavailable"
  | "current_volume_depleted"
  | "invalid_current_volume"
  | "capacity_inconsistency"
  | "future_pour_timestamp"
  | "invalid_pour_timestamp"
  | "invalid_pour_observation"
  | "stale_current_volume"
  | "no_consumption_samples"
  | "invalid_observation_range";

export type ForecastConfidenceLevel = "high" | "medium" | "low";
export type ForecastMethodId = "circular_moving_block_bootstrap_7d" | "fallback_24oz_per_4d";

export interface ForecastConfidence {
  readonly level: ForecastConfidenceLevel;
  readonly status: ForecastStatus;
  readonly reason: ForecastReason;
}

export interface BeveragePourSetting {
  readonly beverageId: string;
  readonly pourSizeMl: number;
  readonly updatedAt: string;
}

export interface EffectiveServingSize {
  readonly fillId: string;
  readonly beverageId: string;
  readonly servingSizeMl: number;
  readonly source: "beverage" | "global";
}

export interface ForecastMethod {
  readonly id: ForecastMethodId;
  readonly bootstrapSamples: number;
  readonly validBootstrapSamples: number;
  readonly fallback: boolean;
}

export type PublicForecastMethod = Pick<ForecastMethod, "id" | "fallback">;

export interface ForecastFillInput {
  readonly id: string;
  readonly endedAt: string | null;
  /** The first observation after this Fill became assigned; null means none exists. */
  readonly observationStart: string | null;
}

export interface ForecastPourInput {
  readonly id: string;
  readonly fillId: string | null;
  readonly attributed: boolean;
  readonly volumeMl: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface CurrentVolumeProvenance {
  readonly identifier: "telemetry_epoch_stabilized";
  readonly epochId: string;
  readonly tapId: string;
  readonly assignmentId: string;
  readonly measuredAt: string;
  readonly asOf: string;
}

export type ForecastCurrentVolumeDiagnosticCode =
  "ok" | "below_tare" | "negative_volume" | "above_capacity" | "implausible_jump" | null;

export type CurrentVolumeInput =
  | {
      readonly kind: "available";
      readonly volumeMl: number;
      readonly capacityMl: number | null;
      readonly diagnosticCode: "ok";
      readonly provenance: CurrentVolumeProvenance;
    }
  | {
      readonly kind: "stale";
      readonly volumeMl: number;
      readonly capacityMl: number | null;
      readonly diagnosticCode: "ok";
      readonly provenance: CurrentVolumeProvenance;
    }
  | {
      readonly kind: "unavailable";
      readonly reason?:
        | "no_assignment_history"
        | "no_active_assignment"
        | "waiting_for_measurement"
        | "current_volume_unavailable";
    }
  | {
      readonly kind: "anomaly";
      readonly reason: "invalid_current_volume" | "capacity_inconsistency";
      readonly volumeMl?: number;
      readonly capacityMl?: number;
      readonly diagnosticCode?: ForecastCurrentVolumeDiagnosticCode;
      readonly provenance?: CurrentVolumeProvenance;
    };

export interface ForecastInput {
  readonly fill: ForecastFillInput;
  readonly pours: readonly ForecastPourInput[];
  readonly currentVolume: CurrentVolumeInput;
  readonly servingSizeMl: number;
  readonly now: string | Date | number;
}

export interface ForecastRange {
  readonly earliestDays: number;
  readonly medianDays: number;
  readonly latestDays: number;
  readonly p10Days: number;
  readonly p50Days: number;
  readonly p90Days: number;
  readonly earliestDepletionAt: string;
  readonly medianDepletionAt: string;
  readonly latestDepletionAt: string;
}

export interface PublicForecastProjection {
  readonly status: ForecastStatus;
  readonly reason: ForecastReason;
  readonly days: ForecastRange | null;
  readonly servingsRemaining: number | null;
  readonly servingSizeMl: number;
  readonly confidence: ForecastConfidence;
  readonly method: PublicForecastMethod | null;
}

export interface ForecastAnomalyCounts {
  readonly invalidTimestamp: number;
  readonly futureTimestamp: number;
  readonly beforeObservationRange: number;
  readonly fillMismatch: number;
  readonly invalidVolume: number;
}

export interface AdminForecastProjection extends PublicForecastProjection {
  readonly method: ForecastMethod | null;
  readonly observationStart: string | null;
  readonly observationEnd: string | null;
  readonly dailyConsumptionMl: readonly number[];
  readonly qualifyingPours: number;
  readonly anomalies: ForecastAnomalyCounts;
  readonly totalVolumeMl: number | null;
  readonly currentVolume: CurrentVolumeInput;
}
