/**
 * Stable machine identifiers for the health checks in the v2 contract.
 *
 * These values are deliberately not derived from display names.  They are
 * persisted by the health tables and are used by events and targeted updates.
 */
export const HEALTH_CHECK_IDS = [
  "low_keg",
  "scale_availability",
  "suspected_leak",
  "serving_temperature",
  "line_cleaning_due",
] as const;

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

export const HEALTH_IDS = HEALTH_CHECK_IDS;
export const DRAFT_HEALTH_CHECKS = HEALTH_CHECK_IDS;

export type HealthState = "not_configured" | "healthy" | "degraded" | "active";
export type HealthSeverity = "none" | "info" | "warning" | "critical";

export const HEALTH_STATES = ["not_configured", "healthy", "degraded", "active"] as const;
export const HEALTH_SEVERITIES = ["none", "info", "warning", "critical"] as const;

export type HealthDiagnosticCode =
  "ok" | "below_tare" | "negative_volume" | "above_capacity" | "implausible_jump" | null;

export type HealthEpochPhase =
  "waiting_for_measurement" | "ready" | "candidate" | "pouring" | "cooldown" | "warning" | "closed";

export interface LowKegHealthConfig {
  readonly enabled: boolean;
  readonly thresholdPercent: number;
  readonly criticalPercent: number;
  readonly fixedThresholdMl: number;
  readonly settlingMs: number;
}
export type LowKegConfig = LowKegHealthConfig;

export interface ScaleAvailabilityHealthConfig {
  readonly enabled: boolean;
  readonly degradedAfterMs: number;
  readonly activeAfterMs: number;
}
export type ScaleAvailabilityConfig = ScaleAvailabilityHealthConfig;

export interface SuspectedLeakHealthConfig {
  readonly enabled: boolean;
  readonly lossThresholdMl: number;
  readonly windowMs: number;
  readonly pourGraceMs: number;
  readonly settlingMs: number;
  readonly resetMovementMl: number;
  readonly maxSamples: number;
}
export type SuspectedLeakConfig = SuspectedLeakHealthConfig;

export interface ServingTemperatureHealthConfig {
  readonly enabled: boolean;
  readonly normalMinC: number;
  readonly normalMaxC: number;
  readonly criticalMinC: number;
  readonly criticalMaxC: number;
  readonly durationMs: number;
}
export type ServingTemperatureConfig = ServingTemperatureHealthConfig;

export interface LineCleaningDueHealthConfig {
  readonly enabled: boolean;
  readonly intervalDays: number;
  readonly criticalGraceDays: number;
}
export type LineCleaningDueConfig = LineCleaningDueHealthConfig;

export interface HealthConfig {
  readonly low_keg: LowKegHealthConfig;
  readonly scale_availability: ScaleAvailabilityHealthConfig;
  readonly suspected_leak: SuspectedLeakHealthConfig;
  readonly serving_temperature: ServingTemperatureHealthConfig;
  readonly line_cleaning_due: LineCleaningDueHealthConfig;
}

/** A null value explicitly clears a per-Tap field back to its inherited value. */
export type NullableOverride<T> = {
  readonly [K in keyof T]?: T[K] | null;
};

export interface HealthConfigOverride {
  readonly low_keg?: NullableOverride<LowKegHealthConfig> | null;
  readonly scale_availability?: NullableOverride<ScaleAvailabilityHealthConfig> | null;
  readonly suspected_leak?: NullableOverride<SuspectedLeakHealthConfig> | null;
  readonly serving_temperature?: NullableOverride<ServingTemperatureHealthConfig> | null;
  readonly line_cleaning_due?: NullableOverride<LineCleaningDueHealthConfig> | null;
}

export type HealthConfigSource = "default" | "override";

export type HealthConfigInheritance = {
  readonly [K in HealthCheckId]: {
    readonly [F in keyof HealthConfig[K]]: HealthConfigSource;
  };
};

export type HealthConfigInherited = {
  readonly [K in HealthCheckId]: {
    readonly [F in keyof HealthConfig[K]]: boolean;
  };
};

export interface EffectiveHealthConfig {
  readonly effective: HealthConfig;
  /** Alias retained for service code that names the resolved value explicitly. */
  readonly effectiveConfig: HealthConfig;
  readonly inheritance: HealthConfigInheritance;
  readonly sources: HealthConfigInheritance;
  readonly inherited: HealthConfigInherited;
  readonly override: HealthConfigOverride | null;
}

export interface HealthAuthoritativeMeasurement {
  /** A server-generated measurement identity; never copied into evidence. */
  readonly measurementId: string;
  /** Measurement time, not receipt time, drives freshness. */
  readonly measuredAtMs: number;
  readonly receivedAtMs: number;
  /** Canonical Celsius value.  Null means that this sample has no temperature. */
  readonly tempC: number | null;
}
export type HealthMeasurement = HealthAuthoritativeMeasurement;

export interface HealthCurrentEpochEvidence {
  readonly epochId: string;
  readonly capacityMl: number | null;
  readonly stabilizedVolumeMl: number | null;
  readonly diagnosticCode?: HealthDiagnosticCode;
  /** Telemetry state projections use this persisted name. */
  readonly lastDiagnosticCode?: HealthDiagnosticCode;
  readonly phase: HealthEpochPhase;
  readonly lastMeasuredAtMs: number | null;
  /** Compatibility alias for the persisted epoch-state projection. */
  readonly lastStabilizedVolumeMl?: number | null;
}
export type HealthEpochEvidence = HealthCurrentEpochEvidence;

export interface HealthLeakSample {
  readonly epochId: string;
  readonly atMs: number;
  readonly volumeMl: number;
}

export interface HealthEvaluationTimers {
  readonly lowKegBelowSinceMs: number | null;
  readonly scaleUnavailableSinceMs: number | null;
  readonly temperatureOutsideSinceMs: number | null;
  readonly temperatureLastMeasuredAtMs: number | null;
  readonly leakSuppressedUntilMs: number | null;
}

export interface HealthPreviousState {
  readonly state?: HealthState;
  readonly severity?: HealthSeverity;
  readonly evaluatedAtMs?: number | null;
  readonly timers?: Partial<HealthEvaluationTimers>;
  readonly lowKegBelowSinceMs?: number | null;
  readonly scaleUnavailableSinceMs?: number | null;
  readonly temperatureOutsideSinceMs?: number | null;
  readonly temperatureLastMeasuredAtMs?: number | null;
  readonly leakSuppressedUntilMs?: number | null;
  readonly leakSamples?: readonly HealthLeakSample[];
}

/**
 * The evaluator input is an authoritative, already-normalized snapshot.  It
 * intentionally has no source identifier, arbitrary entity payload, secret,
 * or free-form note field.
 */
export interface HealthEvaluationInput {
  readonly nowMs: number;
  /** Display-disabled Taps still evaluate; this flag is retained for context. */
  readonly enabled?: boolean;
  /** Retired Taps skip health evaluation entirely. */
  readonly retired?: boolean;
  readonly tapId?: string;
  readonly authorityChangedAtMs: number | null;
  readonly latestMeasurement?: HealthAuthoritativeMeasurement | null;
  /** Explicit scale freshness input; null intentionally suppresses alias fallback. */
  readonly latestScaleMeasurement?: HealthAuthoritativeMeasurement | null;
  readonly latestAuthoritativeMeasurement?: HealthAuthoritativeMeasurement | null;
  /** Compatibility alias used by repository projections. */
  readonly measurement?: HealthAuthoritativeMeasurement | null;
  readonly currentEpoch?: HealthCurrentEpochEvidence | null;
  readonly currentEpochEvidence?: HealthCurrentEpochEvidence | null;
  /** Compatibility alias used by telemetry projections. */
  readonly epoch?: HealthCurrentEpochEvidence | null;
  readonly latestCompletedPourAtMs?: number | null;
  readonly recentPourAtMs?: number | null;
  readonly lineCleanedAtMs?: number | null;
  readonly latestLineCleanedAtMs?: number | null;
  readonly lineCleaningBaselineAtMs?: number | null;
  /**
   * Persisted maintenance due dates are historical; service evaluation may
   * supply a current-policy recomputation.
   */
  readonly lineCleaningDueAtMs?: number | null;
  readonly lineDueAtMs?: number | null;
  readonly latestLineCleaning?: {
    readonly cleanedAtMs: number | null;
    readonly dueAtMs: number | null;
  } | null;
  readonly previous?: HealthPreviousState | null;
  readonly previousCurrentState?: HealthPreviousState | null;
  readonly previousState?: HealthPreviousState | null;
  readonly previousTimers?: Partial<HealthEvaluationTimers> | null;
  readonly leakSamples?: readonly HealthLeakSample[];
  /** The detector can supply this explicitly when phase is projected elsewhere. */
  readonly pourActive?: boolean;
}

export type HealthReason =
  | "tap_retired"
  | "check_disabled"
  | "no_authority"
  | "no_active_epoch"
  | "missing_measurement"
  | "invalid_measurement"
  | "stale_measurement"
  | "capacity_inconsistent"
  | "detector_waiting"
  | "detector_warning"
  | "detector_activity"
  | "threshold_settling"
  | "below_threshold"
  | "above_threshold"
  | "scale_fresh"
  | "scale_degraded"
  | "scale_unavailable"
  | "temperature_normal"
  | "temperature_invalid"
  | "temperature_stale"
  | "temperature_out_of_range"
  | "temperature_critical"
  | "temperature_continuity_reset"
  | "leak_baseline"
  | "leak_window_settling"
  | "leak_threshold"
  | "leak_movement_reset"
  | "leak_epoch_reset"
  | "leak_suppressed"
  | "line_cleaned_missing"
  | "line_cleaning_current"
  | "line_cleaning_due"
  | "line_cleaning_critical";

/** Explicit, generated evidence values only; no arbitrary payloads are allowed. */
export type HealthEvidenceScalar = string | number | boolean | null;

export type HealthEvidenceKey =
  | "reason"
  | "phase"
  | "diagnosticCode"
  | "measurementAgeMs"
  | "authorityAgeMs"
  | "unavailableAgeMs"
  | "currentVolumeMl"
  | "capacityMl"
  | "currentPercent"
  | "thresholdMl"
  | "thresholdPercent"
  | "criticalPercent"
  | "temperatureC"
  | "normalMinC"
  | "normalMaxC"
  | "criticalMinC"
  | "criticalMaxC"
  | "outOfRangeDurationMs"
  | "durationMs"
  | "lossMl"
  | "windowMs"
  | "sampleCount"
  | "maxSamples"
  | "resetMovementMl"
  | "dueAtMs"
  | "criticalAtMs"
  | "ageMs"
  | "intervalDays"
  | "criticalAfterDays";

export type HealthEvidence = {
  readonly [K in HealthEvidenceKey]?: HealthEvidenceScalar;
};

export interface HealthEvaluationContinuation {
  readonly timers: HealthEvaluationTimers;
  readonly leakSamples: readonly HealthLeakSample[];
}

export interface HealthEvaluation {
  readonly id: HealthCheckId;
  readonly checkId: HealthCheckId;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason;
  readonly evaluatedAtMs: number;
  readonly evidence: HealthEvidence;
  /** A check-local key; it never contains source IDs or raw input payloads. */
  readonly incidentKey: string | null;
  readonly continuation: HealthEvaluationContinuation;
  /** Convenience aliases for callers persisting the reducer result. */
  readonly nextTimers: HealthEvaluationTimers;
  readonly nextLeakSamples: readonly HealthLeakSample[];
}
export type HealthCheckEvaluation = HealthEvaluation;

export interface HealthEvaluationSet {
  readonly evaluatedAtMs: number;
  readonly checks: readonly HealthEvaluation[];
}

export type HealthIncidentState = "open" | "recovered";

export interface HealthIncident {
  readonly id: string;
  readonly tapId: string;
  readonly checkId: HealthCheckId;
  readonly incidentKey: string;
  readonly state: HealthIncidentState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason;
  readonly openedAtMs: number;
  readonly recoveredAtMs: number | null;
  readonly evidence: HealthEvidence;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface HealthCurrentRecord {
  readonly tapId: string;
  readonly checkId: HealthCheckId;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason;
  readonly incidentKey: string | null;
  readonly evaluatedAtMs: number;
  readonly evidence: HealthEvidence;
}

export type HealthMaintenanceType =
  "line_cleaned" | "sanitized" | "inspection" | "repair" | "other";

export interface HealthMaintenanceRecord {
  readonly id: string;
  readonly tapId: string;
  readonly maintenanceType: HealthMaintenanceType;
  readonly performedAtMs: number;
  readonly cleanedAtMs?: number;
  readonly dueAtMs?: number;
  readonly criticalAtMs?: number;
  readonly resultingDueAtMs?: number | null;
  readonly notes: string | null;
  readonly recordedAtMs: number;
  readonly actorType: "admin" | "operator" | "system";
  readonly actorId: string | null;
}

export interface HealthMaintenanceCreateInput {
  readonly maintenanceType: HealthMaintenanceType;
  readonly performedAtMs: number;
  readonly notes?: string | null;
}

export interface HealthIncidentTransition {
  readonly id: string;
  readonly incidentId: string;
  readonly transitionKind:
    "opened" | "severity_changed" | "resolved" | "acknowledged" | "cooldown_changed";
  readonly state: HealthState | null;
  readonly severity: HealthSeverity | null;
  readonly reason: HealthReason | null;
  readonly evidence: HealthEvidence;
  readonly occurredAtMs: number;
}

export type AdminHealthIncidentDto = HealthIncident;
export type AdminHealthCurrentDto = HealthCurrentRecord;
export type AdminHealthMaintenanceDto = HealthMaintenanceRecord;

export interface AdminHealthSnapshotDto {
  readonly tapId: string;
  readonly checks: readonly AdminHealthCurrentDto[];
  readonly incidents: readonly AdminHealthIncidentDto[];
  readonly maintenance: readonly AdminHealthMaintenanceDto[];
}

/** One projection-safe changed check; composed into the targeted refresh contract. */
export interface HealthTargetedCheckUpdate {
  readonly tapId: string;
  readonly checkId: HealthCheckId;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason;
  readonly incidentKey: string | null;
  readonly evaluatedAtMs: number;
  readonly dueAtMs?: number | null;
  readonly criticalAtMs?: number | null;
}

export type AdminHealthTargetedCheckUpdateDto = HealthTargetedCheckUpdate;
export type HealthCurrentDto = AdminHealthCurrentDto;
export type HealthIncidentDto = AdminHealthIncidentDto;
export type HealthMaintenanceDto = AdminHealthMaintenanceDto;

export interface LineCleaningDueResult {
  readonly cleanedAtMs: number;
  readonly dueAtMs: number;
  readonly criticalAtMs: number;
}
