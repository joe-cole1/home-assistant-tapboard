import {
  HEALTH_CHECK_IDS,
  type EffectiveHealthConfig,
  type HealthCheckId,
  type HealthConfig,
  type HealthConfigInheritance,
  type HealthConfigInherited,
  type HealthConfigOverride,
  type HealthConfigSource,
  type LineCleaningDueHealthConfig,
  type LowKegHealthConfig,
  type ScaleAvailabilityHealthConfig,
  type ServingTemperatureHealthConfig,
  type SuspectedLeakHealthConfig,
} from "./types.ts";

export const LOW_KEG_CONFIG_FIELDS = [
  "enabled",
  "thresholdPercent",
  "criticalPercent",
  "fixedThresholdMl",
  "settlingMs",
] as const satisfies readonly (keyof LowKegHealthConfig)[];

export const SCALE_AVAILABILITY_CONFIG_FIELDS = [
  "enabled",
  "degradedAfterMs",
  "activeAfterMs",
] as const satisfies readonly (keyof ScaleAvailabilityHealthConfig)[];

export const SUSPECTED_LEAK_CONFIG_FIELDS = [
  "enabled",
  "lossThresholdMl",
  "windowMs",
  "pourGraceMs",
  "settlingMs",
  "resetMovementMl",
  "maxSamples",
] as const satisfies readonly (keyof SuspectedLeakHealthConfig)[];

export const SERVING_TEMPERATURE_CONFIG_FIELDS = [
  "enabled",
  "normalMinC",
  "normalMaxC",
  "criticalMinC",
  "criticalMaxC",
  "durationMs",
] as const satisfies readonly (keyof ServingTemperatureHealthConfig)[];

export const LINE_CLEANING_DUE_CONFIG_FIELDS = [
  "enabled",
  "intervalDays",
  "criticalGraceDays",
] as const satisfies readonly (keyof LineCleaningDueHealthConfig)[];

export const HEALTH_CONFIG_FIELDS = {
  low_keg: LOW_KEG_CONFIG_FIELDS,
  scale_availability: SCALE_AVAILABILITY_CONFIG_FIELDS,
  suspected_leak: SUSPECTED_LEAK_CONFIG_FIELDS,
  serving_temperature: SERVING_TEMPERATURE_CONFIG_FIELDS,
  line_cleaning_due: LINE_CLEANING_DUE_CONFIG_FIELDS,
} as const;

/** Canonical v2 health defaults.  Volumes are millilitres and temperatures Celsius. */
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  low_keg: {
    enabled: true,
    thresholdPercent: 20,
    criticalPercent: 5,
    fixedThresholdMl: 0,
    settlingMs: 30_000,
  },
  scale_availability: {
    enabled: true,
    degradedAfterMs: 5 * 60_000,
    activeAfterMs: 30 * 60_000,
  },
  suspected_leak: {
    enabled: false,
    lossThresholdMl: 236.5882365,
    windowMs: 15 * 60_000,
    pourGraceMs: 2 * 60_000,
    settlingMs: 10 * 60_000,
    resetMovementMl: 946.352946,
    maxSamples: 64,
  },
  serving_temperature: {
    enabled: false,
    normalMinC: 1.1111111111111112,
    normalMaxC: 5.555555555555555,
    criticalMinC: -1.1111111111111112,
    criticalMaxC: 10,
    durationMs: 15 * 60_000,
  },
  line_cleaning_due: {
    enabled: false,
    intervalDays: 14,
    criticalGraceDays: 7,
  },
};

/** Compatibility name used by the older draft-health implementation. */
export const DEFAULT_DRAFT_HEALTH_CONFIG = DEFAULT_HEALTH_CONFIG;
export const HEALTH_DEFAULT_CONFIG = DEFAULT_HEALTH_CONFIG;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCompleteConfigShape(value: unknown): value is HealthConfig {
  if (!isRecord(value)) return false;
  return HEALTH_CHECK_IDS.every((id) => {
    const section = value[id];
    return (
      isRecord(section) && HEALTH_CONFIG_FIELDS[id].every((field) => Object.hasOwn(section, field))
    );
  });
}

type ConfigSection = HealthConfig[HealthCheckId];
type OverrideSection = HealthConfigOverride[HealthCheckId];

function mergeSection<T extends ConfigSection>(base: T, override: OverrideSection): T {
  if (override === null || override === undefined) return { ...base };
  const result = { ...base } as Record<string, unknown>;
  for (const [field, value] of Object.entries(override)) {
    if (value !== null && value !== undefined) result[field] = value;
  }
  return result as T;
}

/**
 * Merge nullable per-field overrides without mutating either input.  `null`
 * and `undefined` both inherit the base value; explicit nulls are therefore
 * safe to persist as a clear operation before resolving the effective config.
 */
export function mergeHealthConfig(
  base: HealthConfig,
  override: HealthConfigOverride | null | undefined,
): HealthConfig;
export function mergeHealthConfig(override: HealthConfigOverride | null | undefined): HealthConfig;
export function mergeHealthConfig(
  baseOrOverride: HealthConfig | HealthConfigOverride | null | undefined = DEFAULT_HEALTH_CONFIG,
  maybeOverride?: HealthConfigOverride | null,
): HealthConfig {
  const base =
    maybeOverride === undefined && !hasCompleteConfigShape(baseOrOverride)
      ? DEFAULT_HEALTH_CONFIG
      : (baseOrOverride as HealthConfig);
  const override =
    maybeOverride === undefined && !hasCompleteConfigShape(baseOrOverride)
      ? (baseOrOverride as HealthConfigOverride | null | undefined)
      : maybeOverride;
  const source = override ?? null;
  return {
    low_keg: mergeSection(base.low_keg, source?.low_keg),
    scale_availability: mergeSection(base.scale_availability, source?.scale_availability),
    suspected_leak: mergeSection(base.suspected_leak, source?.suspected_leak),
    serving_temperature: mergeSection(base.serving_temperature, source?.serving_temperature),
    line_cleaning_due: mergeSection(base.line_cleaning_due, source?.line_cleaning_due),
  };
}

function sectionInheritance<T extends ConfigSection>(
  fields: readonly (keyof T)[],
  override: OverrideSection,
): Record<keyof T, HealthConfigSource> {
  const result = {} as Record<keyof T, HealthConfigSource>;
  const values = override as unknown as Record<string, unknown> | null | undefined;
  for (const field of fields) {
    result[field] =
      values !== null &&
      values !== undefined &&
      Object.hasOwn(values, field) &&
      values[field as string] !== null &&
      values[field as string] !== undefined
        ? "override"
        : "default";
  }
  return result;
}

function inheritanceFor(
  override: HealthConfigOverride | null | undefined,
): HealthConfigInheritance {
  const source = override ?? null;
  return {
    low_keg: sectionInheritance<LowKegHealthConfig>(LOW_KEG_CONFIG_FIELDS, source?.low_keg),
    scale_availability: sectionInheritance<ScaleAvailabilityHealthConfig>(
      SCALE_AVAILABILITY_CONFIG_FIELDS,
      source?.scale_availability,
    ),
    suspected_leak: sectionInheritance<SuspectedLeakHealthConfig>(
      SUSPECTED_LEAK_CONFIG_FIELDS,
      source?.suspected_leak,
    ),
    serving_temperature: sectionInheritance<ServingTemperatureHealthConfig>(
      SERVING_TEMPERATURE_CONFIG_FIELDS,
      source?.serving_temperature,
    ),
    line_cleaning_due: sectionInheritance<LineCleaningDueHealthConfig>(
      LINE_CLEANING_DUE_CONFIG_FIELDS,
      source?.line_cleaning_due,
    ),
  };
}

function inheritedFor(inheritance: HealthConfigInheritance): HealthConfigInherited {
  const result = {} as Record<HealthCheckId, Record<string, boolean>>;
  for (const id of HEALTH_CHECK_IDS) {
    const section = {} as Record<string, boolean>;
    const sources = inheritance[id] as unknown as Record<string, HealthConfigSource>;
    for (const field of HEALTH_CONFIG_FIELDS[id]) {
      section[field as string] = sources[field as string] === "default";
    }
    result[id] = section;
  }
  return result as HealthConfigInherited;
}

/** Resolve an override and include field-level inheritance metadata. */
export function resolveHealthConfig(
  override?: HealthConfigOverride | null,
  base?: HealthConfig,
): EffectiveHealthConfig;
export function resolveHealthConfig(
  base: HealthConfig,
  override?: HealthConfigOverride | null,
): EffectiveHealthConfig;
export function resolveHealthConfig(
  first?: HealthConfig | HealthConfigOverride | null,
  second?: HealthConfig | HealthConfigOverride | null,
): EffectiveHealthConfig {
  const firstIsBase = hasCompleteConfigShape(first);
  const base = firstIsBase
    ? first
    : hasCompleteConfigShape(second)
      ? second
      : DEFAULT_HEALTH_CONFIG;
  const override = firstIsBase ? second : first;
  const effective = mergeHealthConfig(base, override);
  const inheritance = inheritanceFor(override);
  return {
    effective,
    effectiveConfig: effective,
    inheritance,
    sources: inheritance,
    inherited: inheritedFor(inheritance),
    override: override ?? null,
  };
}

export function healthConfigsEqual(left: HealthConfig, right: HealthConfig): boolean {
  return (
    left.low_keg.enabled === right.low_keg.enabled &&
    left.low_keg.thresholdPercent === right.low_keg.thresholdPercent &&
    left.low_keg.criticalPercent === right.low_keg.criticalPercent &&
    left.low_keg.fixedThresholdMl === right.low_keg.fixedThresholdMl &&
    left.low_keg.settlingMs === right.low_keg.settlingMs &&
    left.scale_availability.enabled === right.scale_availability.enabled &&
    left.scale_availability.degradedAfterMs === right.scale_availability.degradedAfterMs &&
    left.scale_availability.activeAfterMs === right.scale_availability.activeAfterMs &&
    left.suspected_leak.enabled === right.suspected_leak.enabled &&
    left.suspected_leak.lossThresholdMl === right.suspected_leak.lossThresholdMl &&
    left.suspected_leak.windowMs === right.suspected_leak.windowMs &&
    left.suspected_leak.pourGraceMs === right.suspected_leak.pourGraceMs &&
    left.suspected_leak.settlingMs === right.suspected_leak.settlingMs &&
    left.suspected_leak.resetMovementMl === right.suspected_leak.resetMovementMl &&
    left.suspected_leak.maxSamples === right.suspected_leak.maxSamples &&
    left.serving_temperature.enabled === right.serving_temperature.enabled &&
    left.serving_temperature.normalMinC === right.serving_temperature.normalMinC &&
    left.serving_temperature.normalMaxC === right.serving_temperature.normalMaxC &&
    left.serving_temperature.criticalMinC === right.serving_temperature.criticalMinC &&
    left.serving_temperature.criticalMaxC === right.serving_temperature.criticalMaxC &&
    left.serving_temperature.durationMs === right.serving_temperature.durationMs &&
    left.line_cleaning_due.enabled === right.line_cleaning_due.enabled &&
    left.line_cleaning_due.intervalDays === right.line_cleaning_due.intervalDays &&
    left.line_cleaning_due.criticalGraceDays === right.line_cleaning_due.criticalGraceDays
  );
}

export const healthConfigEquals = healthConfigsEqual;
export const configEquals = healthConfigsEqual;

export function healthConfigOverridesEqual(
  left: HealthConfigOverride | null | undefined,
  right: HealthConfigOverride | null | undefined,
): boolean {
  const leftEffective = mergeHealthConfig(left);
  const rightEffective = mergeHealthConfig(right);
  return healthConfigsEqual(leftEffective, rightEffective);
}

/** True when a patch has no effective change (all null/undefined is a no-op). */
export function isNoopHealthConfigOverride(
  override: HealthConfigOverride | null | undefined,
  base: HealthConfig = DEFAULT_HEALTH_CONFIG,
): boolean {
  return healthConfigsEqual(mergeHealthConfig(base, override), base);
}

export const healthConfigOverrideIsNoop = isNoopHealthConfigOverride;
export const isHealthConfigNoop = isNoopHealthConfigOverride;
export const isHealthConfigOverrideNoop = isNoopHealthConfigOverride;

/** Canonical clear operation for a per-Tap override row. */
export function clearHealthConfigOverride(): null {
  return null;
}

/** Historical alias for callers that use a noun for the clear operation. */
export const clearHealthOverride = clearHealthConfigOverride;

/** Resolve a maintenance interval without consulting a clock or persistence. */
export function lineCleaningDueAtMs(
  cleanedAtMs: number,
  config: Pick<
    LineCleaningDueHealthConfig,
    "intervalDays"
  > = DEFAULT_HEALTH_CONFIG.line_cleaning_due,
): number {
  return cleanedAtMs + config.intervalDays * 86_400_000;
}

export function lineCleaningCriticalAtMs(
  dueAtMs: number,
  config: Pick<
    LineCleaningDueHealthConfig,
    "criticalGraceDays"
  > = DEFAULT_HEALTH_CONFIG.line_cleaning_due,
): number {
  return dueAtMs + config.criticalGraceDays * 86_400_000;
}

export function calculateLineCleaningDue(
  cleanedAtMs: number,
  config: Pick<
    LineCleaningDueHealthConfig,
    "intervalDays" | "criticalGraceDays"
  > = DEFAULT_HEALTH_CONFIG.line_cleaning_due,
): { readonly cleanedAtMs: number; readonly dueAtMs: number; readonly criticalAtMs: number } {
  const dueAtMs = lineCleaningDueAtMs(cleanedAtMs, config);
  return { cleanedAtMs, dueAtMs, criticalAtMs: lineCleaningCriticalAtMs(dueAtMs, config) };
}

export const deriveLineCleaningDue = calculateLineCleaningDue;

// Keep the default object structurally immutable for service callers.
for (const id of HEALTH_CHECK_IDS) Object.freeze(DEFAULT_HEALTH_CONFIG[id]);
Object.freeze(DEFAULT_HEALTH_CONFIG);
