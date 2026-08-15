import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import { DEFAULT_HEALTH_CONFIG, HEALTH_CONFIG_FIELDS, mergeHealthConfig } from "./config.ts";
import {
  HEALTH_CHECK_IDS,
  type HealthConfig,
  type HealthConfigOverride,
  type HealthEvidence,
  type HealthEvidenceKey,
  type HealthEvaluationInput,
  type HealthReason,
} from "./types.ts";

export const MAX_HEALTH_EVIDENCE_BYTES = 2_048;
export const MAX_HEALTH_DURATION_MS = 365 * 86_400_000;
export const MAX_HEALTH_VOLUME_ML = 1_000_000_000;
export const MAX_HEALTH_DAYS = 3_650;

function invalid(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(field, "must be a finite number");
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field, "must be a boolean");
  return value;
}

function boundedNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  inclusiveMinimum = true,
): number {
  const parsed = finiteNumber(value, field);
  const tooLow = inclusiveMinimum ? parsed < minimum : parsed <= minimum;
  if (tooLow || parsed > maximum) {
    const minimumText = inclusiveMinimum ? `at least ${minimum}` : `greater than ${minimum}`;
    throw invalid(field, `must be ${minimumText} and at most ${maximum}`);
  }
  return parsed;
}

function positiveSafeInteger(value: unknown, field: string, maximum: number): number {
  const parsed = boundedNumber(value, field, 0, maximum, false);
  if (!Number.isSafeInteger(parsed)) throw invalid(field, "must be a safe integer");
  return parsed;
}

function partialSection(
  value: unknown,
  id: (typeof HEALTH_CHECK_IDS)[number],
): Record<string, unknown> {
  if (value === undefined) return {};
  const object = requirePlainObject(value, id);
  rejectUnknownKeys(object, HEALTH_CONFIG_FIELDS[id], id);
  return object;
}

function parseSectionFields(
  value: unknown,
  id: (typeof HEALTH_CHECK_IDS)[number],
  allowNullFields: boolean,
): Record<string, unknown> | null {
  if (value === null) return null;
  const object = partialSection(value, id);
  const result: Record<string, unknown> = {};
  for (const field of HEALTH_CONFIG_FIELDS[id]) {
    if (!Object.hasOwn(object, field)) continue;
    const fieldValue = object[field];
    if (fieldValue === null) {
      if (!allowNullFields) throw invalid(`${id}.${field}`, "must not be null");
      result[field] = null;
      continue;
    }
    if (field === "enabled") result[field] = bool(fieldValue, `${id}.${field}`);
    else result[field] = finiteNumber(fieldValue, `${id}.${field}`);
  }
  return result;
}

function validateEffectiveConfig(config: HealthConfig): HealthConfig {
  const low = config.low_keg;
  if (low.criticalPercent < 0 || low.criticalPercent > low.thresholdPercent) {
    throw invalid("low_keg.criticalPercent", "must be between zero and thresholdPercent");
  }
  if (low.thresholdPercent < 0 || low.thresholdPercent > 100) {
    throw invalid("low_keg.thresholdPercent", "must be between zero and 100");
  }
  if (low.fixedThresholdMl < 0 || low.fixedThresholdMl > MAX_HEALTH_VOLUME_ML) {
    throw invalid("low_keg.fixedThresholdMl", `must be between zero and ${MAX_HEALTH_VOLUME_ML}`);
  }
  positiveSafeInteger(low.settlingMs, "low_keg.settlingMs", MAX_HEALTH_DURATION_MS);

  positiveSafeInteger(
    config.scale_availability.degradedAfterMs,
    "scale_availability.degradedAfterMs",
    MAX_HEALTH_DURATION_MS,
  );
  positiveSafeInteger(
    config.scale_availability.activeAfterMs,
    "scale_availability.activeAfterMs",
    MAX_HEALTH_DURATION_MS,
  );
  if (config.scale_availability.degradedAfterMs >= config.scale_availability.activeAfterMs) {
    throw invalid("scale_availability", "degradedAfterMs must be less than activeAfterMs");
  }

  const leak = config.suspected_leak;
  boundedNumber(
    leak.lossThresholdMl,
    "suspected_leak.lossThresholdMl",
    0,
    MAX_HEALTH_VOLUME_ML,
    false,
  );
  positiveSafeInteger(leak.windowMs, "suspected_leak.windowMs", MAX_HEALTH_DURATION_MS);
  positiveSafeInteger(leak.pourGraceMs, "suspected_leak.pourGraceMs", MAX_HEALTH_DURATION_MS);
  positiveSafeInteger(leak.settlingMs, "suspected_leak.settlingMs", MAX_HEALTH_DURATION_MS);
  boundedNumber(
    leak.resetMovementMl,
    "suspected_leak.resetMovementMl",
    0,
    MAX_HEALTH_VOLUME_ML,
    false,
  );
  if (!Number.isSafeInteger(leak.maxSamples) || leak.maxSamples < 1 || leak.maxSamples > 64) {
    throw invalid("suspected_leak.maxSamples", "must be an integer between 1 and 64");
  }

  const temperature = config.serving_temperature;
  boundedNumber(temperature.normalMinC, "serving_temperature.normalMinC", -100, 100);
  boundedNumber(temperature.normalMaxC, "serving_temperature.normalMaxC", -100, 100);
  boundedNumber(temperature.criticalMinC, "serving_temperature.criticalMinC", -100, 100);
  boundedNumber(temperature.criticalMaxC, "serving_temperature.criticalMaxC", -100, 100);
  if (!(
    temperature.criticalMinC < temperature.normalMinC &&
    temperature.normalMinC < temperature.normalMaxC &&
    temperature.normalMaxC < temperature.criticalMaxC
  )) {
    throw invalid(
      "serving_temperature",
      "criticalMinC < normalMinC < normalMaxC < criticalMaxC is required",
    );
  }
  positiveSafeInteger(
    temperature.durationMs,
    "serving_temperature.durationMs",
    MAX_HEALTH_DURATION_MS,
  );

  positiveSafeInteger(
    config.line_cleaning_due.intervalDays,
    "line_cleaning_due.intervalDays",
    MAX_HEALTH_DAYS,
  );
  positiveSafeInteger(
    config.line_cleaning_due.criticalGraceDays,
    "line_cleaning_due.criticalGraceDays",
    MAX_HEALTH_DAYS,
  );
  return config;
}

/** Validate a complete config or a partial default-inheriting config. */
export function validateHealthConfig(value: unknown = DEFAULT_HEALTH_CONFIG): HealthConfig {
  const object = requirePlainObject(value, "healthConfig");
  rejectUnknownKeys(object, HEALTH_CHECK_IDS, "healthConfig");
  const sections = {
    low_keg: parseSectionFields(
      object.low_keg,
      "low_keg",
      false,
    ) as HealthConfigOverride["low_keg"],
    scale_availability: parseSectionFields(
      object.scale_availability,
      "scale_availability",
      false,
    ) as HealthConfigOverride["scale_availability"],
    suspected_leak: parseSectionFields(
      object.suspected_leak,
      "suspected_leak",
      false,
    ) as HealthConfigOverride["suspected_leak"],
    serving_temperature: parseSectionFields(
      object.serving_temperature,
      "serving_temperature",
      false,
    ) as HealthConfigOverride["serving_temperature"],
    line_cleaning_due: parseSectionFields(
      object.line_cleaning_due,
      "line_cleaning_due",
      false,
    ) as HealthConfigOverride["line_cleaning_due"],
  } as unknown as HealthConfigOverride;
  const effective = mergeHealthConfig(DEFAULT_HEALTH_CONFIG, sections);
  return validateEffectiveConfig(effective);
}

/** Validate nullable per-field overrides while preserving null clear markers. */
export function validateHealthConfigOverride(value: unknown): HealthConfigOverride | null {
  if (value === null || value === undefined) return null;
  const object = requirePlainObject(value, "healthConfigOverride");
  rejectUnknownKeys(object, HEALTH_CHECK_IDS, "healthConfigOverride");
  const parsed = {
    low_keg: parseSectionFields(object.low_keg, "low_keg", true) as HealthConfigOverride["low_keg"],
    scale_availability: parseSectionFields(
      object.scale_availability,
      "scale_availability",
      true,
    ) as HealthConfigOverride["scale_availability"],
    suspected_leak: parseSectionFields(
      object.suspected_leak,
      "suspected_leak",
      true,
    ) as HealthConfigOverride["suspected_leak"],
    serving_temperature: parseSectionFields(
      object.serving_temperature,
      "serving_temperature",
      true,
    ) as HealthConfigOverride["serving_temperature"],
    line_cleaning_due: parseSectionFields(
      object.line_cleaning_due,
      "line_cleaning_due",
      true,
    ) as HealthConfigOverride["line_cleaning_due"],
  } as unknown as HealthConfigOverride;
  validateEffectiveConfig(mergeHealthConfig(DEFAULT_HEALTH_CONFIG, parsed));
  return parsed;
}

const EVIDENCE_KEYS = [
  "reason",
  "phase",
  "diagnosticCode",
  "measurementAgeMs",
  "authorityAgeMs",
  "unavailableAgeMs",
  "currentVolumeMl",
  "capacityMl",
  "currentPercent",
  "thresholdMl",
  "thresholdPercent",
  "criticalPercent",
  "temperatureC",
  "normalMinC",
  "normalMaxC",
  "criticalMinC",
  "criticalMaxC",
  "outOfRangeDurationMs",
  "durationMs",
  "lossMl",
  "windowMs",
  "sampleCount",
  "maxSamples",
  "resetMovementMl",
  "dueAtMs",
  "criticalAtMs",
  "ageMs",
  "intervalDays",
  "criticalAfterDays",
] as const satisfies readonly HealthEvidenceKey[];

export const HEALTH_EVIDENCE_KEYS = EVIDENCE_KEYS;

function evidenceScalar(value: unknown, field: string): value is string | number | boolean | null {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`evidence.${field}`, "must be finite");
    return true;
  }
  if (typeof value === "string") {
    if (value.length > 120 || value.includes("\u0000")) {
      throw invalid(`evidence.${field}`, "contains an invalid or oversized string");
    }
    return true;
  }
  throw invalid(`evidence.${field}`, "must be a scalar");
}

/** Strictly validate generated evidence and reject arbitrary/source-bearing keys. */
export function validateHealthEvidence(value: unknown): HealthEvidence {
  const object = requirePlainObject(value, "evidence");
  rejectUnknownKeys(object, EVIDENCE_KEYS, "evidence");
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of EVIDENCE_KEYS) {
    if (!Object.hasOwn(object, key)) continue;
    const current = object[key];
    evidenceScalar(current, key);
    result[key] = current as string | number | boolean | null;
  }
  return result;
}

export function healthEvidenceSizeBytes(value: HealthEvidence): number {
  const json = JSON.stringify(validateHealthEvidence(value));
  return Buffer.byteLength(json, "utf8");
}

export function isHealthEvidenceWithinLimit(value: HealthEvidence): boolean {
  try {
    return healthEvidenceSizeBytes(value) <= MAX_HEALTH_EVIDENCE_BYTES;
  } catch {
    return false;
  }
}

export function serializeHealthEvidence(value: HealthEvidence): string {
  const validated = validateHealthEvidence(value);
  const json = JSON.stringify(validated);
  if (Buffer.byteLength(json, "utf8") > MAX_HEALTH_EVIDENCE_BYTES) {
    throw invalid(
      "evidence",
      `serialized value must be at most ${MAX_HEALTH_EVIDENCE_BYTES} bytes`,
    );
  }
  return json;
}

export const serializedHealthEvidenceBytes = healthEvidenceSizeBytes;
export const isBoundedHealthEvidence = isHealthEvidenceWithinLimit;

/** Input validation is strict at the contract boundary; evaluators still fail closed for bad snapshots. */
export function validateHealthEvaluationInput(value: unknown): HealthEvaluationInput {
  const object = requirePlainObject(value, "healthInput");
  rejectUnknownKeys(
    object,
    [
      "nowMs",
      "enabled",
      "retired",
      "tapId",
      "authorityChangedAtMs",
      "latestMeasurement",
      "latestAuthoritativeMeasurement",
      "measurement",
      "currentEpoch",
      "currentEpochEvidence",
      "epoch",
      "latestCompletedPourAtMs",
      "recentPourAtMs",
      "lineCleanedAtMs",
      "latestLineCleanedAtMs",
      "lineCleaningBaselineAtMs",
      "lineCleaningDueAtMs",
      "lineDueAtMs",
      "latestLineCleaning",
      "previous",
      "previousCurrentState",
      "previousState",
      "previousTimers",
      "leakSamples",
      "pourActive",
    ],
    "healthInput",
  );
  if (!Object.hasOwn(object, "nowMs")) throw invalid("nowMs", "is required");
  finiteNumber(object.nowMs, "nowMs");
  if (Object.hasOwn(object, "enabled") && typeof object.enabled !== "boolean")
    throw invalid("enabled", "must be a boolean");
  if (Object.hasOwn(object, "retired") && typeof object.retired !== "boolean")
    throw invalid("retired", "must be a boolean");
  if (!Object.hasOwn(object, "authorityChangedAtMs")) {
    throw invalid("authorityChangedAtMs", "is required");
  }
  if (object.authorityChangedAtMs !== null)
    finiteNumber(object.authorityChangedAtMs, "authorityChangedAtMs");
  return value as HealthEvaluationInput;
}

/** Narrow helper for reason DTOs without permitting arbitrary user text. */
export function validateHealthReason(value: unknown): HealthReason {
  if (typeof value !== "string") throw invalid("reason", "must be a reason code");
  const reasons: readonly HealthReason[] = [
    "tap_retired",
    "check_disabled",
    "no_authority",
    "no_active_epoch",
    "missing_measurement",
    "invalid_measurement",
    "stale_measurement",
    "capacity_inconsistent",
    "detector_waiting",
    "detector_warning",
    "detector_activity",
    "threshold_settling",
    "below_threshold",
    "scale_fresh",
    "scale_degraded",
    "scale_unavailable",
    "temperature_normal",
    "temperature_invalid",
    "temperature_stale",
    "temperature_out_of_range",
    "temperature_critical",
    "temperature_continuity_reset",
    "leak_baseline",
    "leak_window_settling",
    "leak_threshold",
    "leak_movement_reset",
    "leak_epoch_reset",
    "leak_suppressed",
    "line_cleaned_missing",
    "line_cleaning_current",
    "line_cleaning_due",
    "line_cleaning_critical",
  ];
  if (!reasons.includes(value as HealthReason))
    throw invalid("reason", "must be a known reason code");
  return value as HealthReason;
}
