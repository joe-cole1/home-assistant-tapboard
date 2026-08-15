import { DEFAULT_HEALTH_CONFIG, calculateLineCleaningDue, mergeHealthConfig } from "./config.ts";
import { validateHealthConfigOverride, validateHealthEvidence } from "./health-validation.ts";
import {
  HEALTH_CHECK_IDS,
  type HealthAuthoritativeMeasurement,
  type HealthCheckId,
  type HealthConfig,
  type HealthConfigOverride,
  type HealthCurrentEpochEvidence,
  type HealthDiagnosticCode,
  type HealthEpochPhase,
  type HealthEvaluation,
  type HealthEvaluationContinuation,
  type HealthEvaluationInput,
  type HealthEvaluationSet,
  type HealthEvaluationTimers,
  type HealthEvidence,
  type HealthLeakSample,
  type HealthPreviousState,
  type HealthReason,
  type HealthSeverity,
  type HealthState,
} from "./types.ts";

const EMPTY_TIMERS: HealthEvaluationTimers = {
  lowKegBelowSinceMs: null,
  scaleUnavailableSinceMs: null,
  temperatureOutsideSinceMs: null,
  temperatureLastMeasuredAtMs: null,
  leakSuppressedUntilMs: null,
};

const SCALE_DEGRADED_FALLBACK_MS = 5 * 60_000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestMeasurement(input: HealthEvaluationInput): HealthAuthoritativeMeasurement | null {
  const candidate =
    input.latestMeasurement ?? input.latestAuthoritativeMeasurement ?? input.measurement ?? null;
  return candidate && typeof candidate === "object" ? candidate : null;
}

function currentEpoch(input: HealthEvaluationInput): HealthCurrentEpochEvidence | null {
  const candidate = input.currentEpoch ?? input.currentEpochEvidence ?? input.epoch ?? null;
  return candidate && typeof candidate === "object" ? candidate : null;
}

function previousState(input: HealthEvaluationInput): HealthPreviousState | null {
  return input.previous ?? input.previousCurrentState ?? input.previousState ?? null;
}

function timersFor(input: HealthEvaluationInput): HealthEvaluationTimers {
  const previous = previousState(input);
  const nested = previous?.timers ?? {};
  const direct = input.previousTimers ?? {};
  return {
    lowKegBelowSinceMs:
      finite(direct.lowKegBelowSinceMs) ??
      finite(nested.lowKegBelowSinceMs) ??
      finite(previous?.lowKegBelowSinceMs) ??
      null,
    scaleUnavailableSinceMs:
      finite(direct.scaleUnavailableSinceMs) ??
      finite(nested.scaleUnavailableSinceMs) ??
      finite(previous?.scaleUnavailableSinceMs) ??
      null,
    temperatureOutsideSinceMs:
      finite(direct.temperatureOutsideSinceMs) ??
      finite(nested.temperatureOutsideSinceMs) ??
      finite(previous?.temperatureOutsideSinceMs) ??
      null,
    temperatureLastMeasuredAtMs:
      finite(direct.temperatureLastMeasuredAtMs) ??
      finite(nested.temperatureLastMeasuredAtMs) ??
      finite(previous?.temperatureLastMeasuredAtMs) ??
      null,
    leakSuppressedUntilMs:
      finite(direct.leakSuppressedUntilMs) ??
      finite(nested.leakSuppressedUntilMs) ??
      finite(previous?.leakSuppressedUntilMs) ??
      null,
  };
}

function samplesFor(input: HealthEvaluationInput): readonly HealthLeakSample[] {
  const samples: unknown = input.leakSamples ?? previousState(input)?.leakSamples ?? [];
  if (!Array.isArray(samples)) return [];
  const typedSamples: readonly unknown[] = samples;
  return typedSamples.filter(isHealthLeakSample);
}

function isHealthLeakSample(value: unknown): value is HealthLeakSample {
  if (typeof value !== "object" || value === null) return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.epochId === "string" &&
    finite(sample.atMs) !== null &&
    finite(sample.volumeMl) !== null
  );
}

function fallbackScaleDegradedMs(config: HealthConfig): number {
  const value = finite(config.scale_availability.degradedAfterMs);
  return value === null ? SCALE_DEGRADED_FALLBACK_MS : value;
}

function hasAuthority(input: HealthEvaluationInput): boolean {
  return finite(input.authorityChangedAtMs) !== null;
}

function isRetired(input: HealthEvaluationInput): boolean {
  return input.retired === true;
}

function measurementIsUsable(measurement: HealthAuthoritativeMeasurement | null): boolean {
  return (
    measurement !== null &&
    typeof measurement.measurementId === "string" &&
    measurement.measurementId.length > 0 &&
    finite(measurement.measuredAtMs) !== null &&
    finite(measurement.receivedAtMs) !== null
  );
}

function measurementAgeMs(
  nowMs: number,
  measurement: HealthAuthoritativeMeasurement | null,
): number | null {
  const measuredAtMs = finite(measurement?.measuredAtMs);
  return measuredAtMs === null ? null : nowMs - measuredAtMs;
}

function epochMeasurementAtMs(
  input: HealthEvaluationInput,
  epoch: HealthCurrentEpochEvidence | null,
): number | null {
  return finite(epoch?.lastMeasuredAtMs) ?? finite(latestMeasurement(input)?.measuredAtMs);
}

function epochVolumeValid(epoch: HealthCurrentEpochEvidence | null): boolean {
  const capacity = finite(epoch?.capacityMl);
  const volume = finite(epoch?.stabilizedVolumeMl ?? epoch?.lastStabilizedVolumeMl);
  return (
    epoch !== null &&
    typeof epoch.epochId === "string" &&
    epoch.epochId.length > 0 &&
    capacity !== null &&
    capacity > 0 &&
    volume !== null &&
    volume >= 0 &&
    volume <= capacity
  );
}

function epochDiagnosticCode(epoch: HealthCurrentEpochEvidence | null): HealthDiagnosticCode {
  return epoch?.diagnosticCode ?? epoch?.lastDiagnosticCode ?? null;
}

function epochVolume(epoch: HealthCurrentEpochEvidence): number | null {
  return finite(epoch.stabilizedVolumeMl ?? epoch.lastStabilizedVolumeMl);
}

function phaseIs(phase: unknown, value: HealthEpochPhase): boolean {
  return phase === value;
}

function result(
  id: HealthCheckId,
  state: HealthState,
  severity: HealthSeverity,
  reason: HealthReason,
  evaluatedAtMs: number,
  evidence: HealthEvidence,
  timers: HealthEvaluationTimers,
  leakSamples: readonly HealthLeakSample[],
  active = state === "active",
): HealthEvaluation {
  const boundedEvidence = validateHealthEvidence(evidence);
  const incidentKey = active ? id : null;
  const continuation: HealthEvaluationContinuation = {
    timers: { ...timers },
    leakSamples: leakSamples.map((sample) => ({ ...sample })),
  };
  return {
    id,
    checkId: id,
    state,
    severity,
    reason,
    evaluatedAtMs,
    evidence: boundedEvidence,
    incidentKey,
    continuation,
    nextTimers: continuation.timers,
    nextLeakSamples: continuation.leakSamples,
  };
}

function retiredResult(id: HealthCheckId, input: HealthEvaluationInput): HealthEvaluation {
  return result(
    id,
    "not_configured",
    "none",
    "tap_retired",
    input.nowMs,
    { reason: "tap_retired" },
    EMPTY_TIMERS,
    [],
  );
}

function disabledResult(id: HealthCheckId, input: HealthEvaluationInput): HealthEvaluation {
  return result(
    id,
    "not_configured",
    "none",
    "check_disabled",
    input.nowMs,
    { reason: "check_disabled" },
    timersFor(input),
    samplesFor(input),
  );
}

function validConfig(config: HealthConfig | HealthConfigOverride | null | undefined): HealthConfig {
  if (config === null || config === undefined) return DEFAULT_HEALTH_CONFIG;
  const override = validateHealthConfigOverride(config);
  return mergeHealthConfig(DEFAULT_HEALTH_CONFIG, override);
}

/** Evaluate the low-keg check without mutating caller state. */
export function evaluateLowKeg(
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluation {
  const id = "low_keg" as const;
  if (isRetired(input)) return retiredResult(id, input);
  const config = validConfig(suppliedConfig);
  if (!config.low_keg.enabled) return disabledResult(id, input);
  const timers = timersFor(input);
  const epoch = currentEpoch(input);
  if (epoch === null || typeof epoch.epochId !== "string" || epoch.epochId.length === 0) {
    return result(
      id,
      "not_configured",
      "none",
      "no_active_epoch",
      input.nowMs,
      { reason: "no_active_epoch" },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  if (
    phaseIs(epoch.phase, "waiting_for_measurement") ||
    phaseIs(epoch.phase, "closed") ||
    epochVolume(epoch) === null ||
    epoch.lastMeasuredAtMs === null
  ) {
    return result(
      id,
      "not_configured",
      "none",
      "detector_waiting",
      input.nowMs,
      { phase: epoch.phase ?? null, reason: "detector_waiting" },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  if (phaseIs(epoch.phase, "warning") || epochDiagnosticCode(epoch) !== "ok") {
    return result(
      id,
      "degraded",
      "info",
      "detector_warning",
      input.nowMs,
      {
        phase: epoch.phase ?? null,
        diagnosticCode: epochDiagnosticCode(epoch),
        reason: "detector_warning",
      },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  if (
    phaseIs(epoch.phase, "candidate") ||
    phaseIs(epoch.phase, "pouring") ||
    phaseIs(epoch.phase, "cooldown")
  ) {
    return result(
      id,
      "degraded",
      "info",
      "detector_activity",
      input.nowMs,
      { phase: epoch.phase ?? null, reason: "detector_activity" },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  if (!epochVolumeValid(epoch)) {
    return result(
      id,
      "degraded",
      "info",
      "capacity_inconsistent",
      input.nowMs,
      { reason: "capacity_inconsistent" },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  const atMs = epochMeasurementAtMs(input, epoch);
  if (atMs === null) {
    return result(
      id,
      "not_configured",
      "none",
      "missing_measurement",
      input.nowMs,
      { reason: "missing_measurement" },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  const ageMs = input.nowMs - atMs;
  if (ageMs < 0 || ageMs >= fallbackScaleDegradedMs(config)) {
    return result(
      id,
      "degraded",
      "info",
      "stale_measurement",
      input.nowMs,
      { measurementAgeMs: ageMs, reason: "stale_measurement" },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  const volume = epochVolume(epoch)!;
  const capacity = epoch.capacityMl!;
  const thresholdMl = Math.max(
    config.low_keg.fixedThresholdMl,
    (capacity * config.low_keg.thresholdPercent) / 100,
  );
  const currentPercent = (volume / capacity) * 100;
  if (volume >= thresholdMl) {
    return result(
      id,
      "healthy",
      "none",
      "above_threshold",
      input.nowMs,
      {
        currentVolumeMl: volume,
        capacityMl: capacity,
        currentPercent,
        thresholdMl,
        thresholdPercent: config.low_keg.thresholdPercent,
      },
      { ...timers, lowKegBelowSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  const since =
    timers.lowKegBelowSinceMs !== null && timers.lowKegBelowSinceMs <= input.nowMs
      ? timers.lowKegBelowSinceMs
      : input.nowMs;
  const elapsed = input.nowMs - since;
  const evidence = {
    currentVolumeMl: volume,
    capacityMl: capacity,
    currentPercent,
    thresholdMl,
    thresholdPercent: config.low_keg.thresholdPercent,
    criticalPercent: config.low_keg.criticalPercent,
    durationMs: elapsed,
  };
  if (elapsed < config.low_keg.settlingMs) {
    return result(
      id,
      "degraded",
      "info",
      "threshold_settling",
      input.nowMs,
      { ...evidence, reason: "threshold_settling" },
      { ...timers, lowKegBelowSinceMs: since },
      samplesFor(input),
      false,
    );
  }
  const severity: HealthSeverity =
    currentPercent <= config.low_keg.criticalPercent ? "critical" : "warning";
  return result(
    id,
    "active",
    severity,
    "below_threshold",
    input.nowMs,
    evidence,
    { ...timers, lowKegBelowSinceMs: since },
    samplesFor(input),
  );
}

/** Evaluate scale freshness using authoritative measurement time, never receipt time. */
export function evaluateScaleAvailability(
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluation {
  const id = "scale_availability" as const;
  if (isRetired(input)) return retiredResult(id, input);
  const config = validConfig(suppliedConfig);
  if (!config.scale_availability.enabled) return disabledResult(id, input);
  const timers = timersFor(input);
  if (!hasAuthority(input)) {
    return result(
      id,
      "not_configured",
      "none",
      "no_authority",
      input.nowMs,
      { reason: "no_authority" },
      { ...timers, scaleUnavailableSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  const authorityAtMs = input.authorityChangedAtMs!;
  // An explicit scale projection, including null, must not fall back to the
  // generic measurement aliases used by the other checks.
  const measurement =
    input.latestScaleMeasurement !== undefined
      ? input.latestScaleMeasurement
      : latestMeasurement(input);
  const usable = measurementIsUsable(measurement);
  const ageMs = measurementAgeMs(input.nowMs, measurement);
  if (!usable || ageMs === null || ageMs < 0) {
    const authorityAgeMs = Math.max(0, input.nowMs - authorityAtMs);
    const nextTimer = timers.scaleUnavailableSinceMs ?? authorityAtMs;
    if (authorityAgeMs >= config.scale_availability.activeAfterMs) {
      return result(
        id,
        "active",
        "critical",
        "scale_unavailable",
        input.nowMs,
        { authorityAgeMs, unavailableAgeMs: authorityAgeMs, reason: "scale_unavailable" },
        { ...timers, scaleUnavailableSinceMs: nextTimer },
        samplesFor(input),
      );
    }
    return result(
      id,
      "degraded",
      "info",
      "scale_unavailable",
      input.nowMs,
      { authorityAgeMs, unavailableAgeMs: authorityAgeMs, reason: "scale_unavailable" },
      { ...timers, scaleUnavailableSinceMs: nextTimer },
      samplesFor(input),
      false,
    );
  }
  const age = ageMs;
  if (age < config.scale_availability.degradedAfterMs) {
    return result(
      id,
      "healthy",
      "none",
      "scale_fresh",
      input.nowMs,
      { measurementAgeMs: age, reason: "scale_fresh" },
      { ...timers, scaleUnavailableSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  if (age < config.scale_availability.activeAfterMs) {
    return result(
      id,
      "degraded",
      "info",
      "scale_degraded",
      input.nowMs,
      { measurementAgeMs: age, reason: "scale_degraded" },
      { ...timers, scaleUnavailableSinceMs: null },
      samplesFor(input),
      false,
    );
  }
  return result(
    id,
    "active",
    "critical",
    "scale_degraded",
    input.nowMs,
    { measurementAgeMs: age, reason: "scale_degraded" },
    { ...timers, scaleUnavailableSinceMs: null },
    samplesFor(input),
  );
}

function temperatureValue(measurement: HealthAuthoritativeMeasurement | null): number | null {
  return finite(measurement?.tempC);
}

/** Evaluate canonical Celsius temperature with continuous-valid evidence timing. */
export function evaluateServingTemperature(
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluation {
  const id = "serving_temperature" as const;
  if (isRetired(input)) return retiredResult(id, input);
  const config = validConfig(suppliedConfig);
  if (!config.serving_temperature.enabled) return disabledResult(id, input);
  const timers = timersFor(input);
  if (!hasAuthority(input)) {
    return result(
      id,
      "not_configured",
      "none",
      "no_authority",
      input.nowMs,
      { reason: "no_authority" },
      { ...timers, temperatureOutsideSinceMs: null, temperatureLastMeasuredAtMs: null },
      samplesFor(input),
      false,
    );
  }
  const measurement = latestMeasurement(input);
  if (!measurementIsUsable(measurement) || temperatureValue(measurement) === null) {
    return result(
      id,
      "degraded",
      "info",
      "temperature_invalid",
      input.nowMs,
      { reason: "temperature_invalid" },
      { ...timers, temperatureOutsideSinceMs: null, temperatureLastMeasuredAtMs: null },
      samplesFor(input),
      false,
    );
  }
  const measuredAtMs = measurement!.measuredAtMs;
  const ageMs = input.nowMs - measuredAtMs;
  if (ageMs < 0 || ageMs >= fallbackScaleDegradedMs(config)) {
    return result(
      id,
      "degraded",
      "info",
      "temperature_stale",
      input.nowMs,
      { measurementAgeMs: ageMs, reason: "temperature_stale" },
      { ...timers, temperatureOutsideSinceMs: null, temperatureLastMeasuredAtMs: measuredAtMs },
      samplesFor(input),
      false,
    );
  }
  const value = temperatureValue(measurement)!;
  const temperatureConfig = config.serving_temperature;
  const normal = value >= temperatureConfig.normalMinC && value <= temperatureConfig.normalMaxC;
  if (normal) {
    return result(
      id,
      "healthy",
      "none",
      "temperature_normal",
      input.nowMs,
      {
        temperatureC: value,
        normalMinC: temperatureConfig.normalMinC,
        normalMaxC: temperatureConfig.normalMaxC,
        reason: "temperature_normal",
      },
      { ...timers, temperatureOutsideSinceMs: null, temperatureLastMeasuredAtMs: measuredAtMs },
      samplesFor(input),
      false,
    );
  }
  const previousMeasuredAt = timers.temperatureLastMeasuredAtMs;
  const gap =
    previousMeasuredAt !== null &&
    measuredAtMs - previousMeasuredAt > fallbackScaleDegradedMs(config);
  const existingSince = timers.temperatureOutsideSinceMs;
  const since =
    !gap && existingSince !== null && existingSince <= input.nowMs ? existingSince : input.nowMs;
  const outOfRangeDurationMs = input.nowMs - since;
  const critical = value < temperatureConfig.criticalMinC || value > temperatureConfig.criticalMaxC;
  const evidence = {
    temperatureC: value,
    normalMinC: temperatureConfig.normalMinC,
    normalMaxC: temperatureConfig.normalMaxC,
    criticalMinC: temperatureConfig.criticalMinC,
    criticalMaxC: temperatureConfig.criticalMaxC,
    outOfRangeDurationMs,
    durationMs: temperatureConfig.durationMs,
  };
  if (outOfRangeDurationMs < temperatureConfig.durationMs) {
    return result(
      id,
      "degraded",
      "info",
      gap ? "temperature_continuity_reset" : "temperature_out_of_range",
      input.nowMs,
      { ...evidence, reason: gap ? "temperature_continuity_reset" : "temperature_out_of_range" },
      { ...timers, temperatureOutsideSinceMs: since, temperatureLastMeasuredAtMs: measuredAtMs },
      samplesFor(input),
      false,
    );
  }
  return result(
    id,
    "active",
    critical ? "critical" : "warning",
    critical ? "temperature_critical" : "temperature_out_of_range",
    input.nowMs,
    evidence,
    { ...timers, temperatureOutsideSinceMs: since, temperatureLastMeasuredAtMs: measuredAtMs },
    samplesFor(input),
  );
}

function leakEpochUsable(
  input: HealthEvaluationInput,
  config: HealthConfig,
): {
  readonly epoch: HealthCurrentEpochEvidence;
  readonly atMs: number;
  readonly ageMs: number;
} | null {
  const epoch = currentEpoch(input);
  if (epoch === null || !epochVolumeValid(epoch) || epochDiagnosticCode(epoch) !== "ok")
    return null;
  if (
    !phaseIs(epoch.phase, "ready") &&
    !phaseIs(epoch.phase, "candidate") &&
    !phaseIs(epoch.phase, "pouring") &&
    !phaseIs(epoch.phase, "cooldown")
  )
    return null;
  const atMs = epochMeasurementAtMs(input, epoch);
  if (atMs === null) return null;
  const ageMs = input.nowMs - atMs;
  if (ageMs < 0 || ageMs >= fallbackScaleDegradedMs(config)) return null;
  return { epoch, atMs, ageMs };
}

function normalizedSamples(
  samples: readonly HealthLeakSample[],
  epochId: string,
  currentAtMs: number,
): HealthLeakSample[] {
  const normalized = samples
    .filter(
      (sample) =>
        sample.epochId === epochId &&
        finite(sample.atMs) !== null &&
        finite(sample.volumeMl) !== null &&
        sample.atMs <= currentAtMs,
    )
    .map((sample) => ({ epochId, atMs: sample.atMs, volumeMl: sample.volumeMl }))
    .sort(
      (left, right) =>
        left.atMs - right.atMs ||
        left.volumeMl - right.volumeMl ||
        left.epochId.localeCompare(right.epochId),
    );
  // A repeated sweep can feed the same observation back into continuation;
  // exact deduplication keeps that replay from growing the persisted state.
  return normalized.filter(
    (sample, index) =>
      index === 0 ||
      sample.atMs !== normalized[index - 1]!.atMs ||
      sample.volumeMl !== normalized[index - 1]!.volumeMl ||
      sample.epochId !== normalized[index - 1]!.epochId,
  );
}

function sameLeakSample(left: HealthLeakSample, right: HealthLeakSample): boolean {
  return (
    left.epochId === right.epochId && left.atMs === right.atMs && left.volumeMl === right.volumeMl
  );
}

function compactLeakSamples(
  prior: readonly HealthLeakSample[],
  current: HealthLeakSample,
  windowMs: number,
  maxSamples: number,
): HealthLeakSample[] {
  const combined = normalizedSamples([...prior, current], current.epochId, current.atMs);
  if (maxSamples === 1) {
    // With one slot, retain a historical anchor/baseline so the next current
    // input can still be compared; use current only when no baseline exists.
    if (prior.length === 0) return [current];
    const cutoff = current.atMs - windowMs;
    const anchor =
      [...prior].reverse().find((sample) => sample.atMs <= cutoff) ?? prior[0] ?? current;
    return [{ ...anchor }];
  }

  const cutoff = current.atMs - windowMs;
  const anchor = [...combined].reverse().find((sample) => sample.atMs <= cutoff);
  const afterCutoff = combined.filter((sample) => sample.atMs > cutoff);
  const slots = maxSamples - (anchor === undefined ? 0 : 1);
  if (afterCutoff.length <= slots) {
    return [...(anchor === undefined ? [] : [anchor]), ...afterCutoff];
  }

  const currentIndex = Math.max(
    0,
    afterCutoff.findIndex((sample) => sameLeakSample(sample, current)),
  );
  const selected = new Set<number>();
  const add = (index: number) => {
    if (selected.size < slots && index >= 0 && index < afterCutoff.length) selected.add(index);
  };
  // Always retain the current observation, and use the remaining slots for
  // temporal coverage from the earliest/latest post-cutoff observations.
  add(currentIndex);
  if (slots >= 2) add(0);
  if (slots >= 3) add(afterCutoff.length - 1);
  for (let slot = 0; selected.size < slots && slot < slots; slot += 1) {
    const firstAtMs = afterCutoff[0]!.atMs;
    const lastAtMs = afterCutoff.at(-1)!.atMs;
    const targetAtMs =
      slots === 1
        ? afterCutoff[currentIndex]!.atMs
        : firstAtMs + ((lastAtMs - firstAtMs) * slot) / Math.max(1, slots - 1);
    let nearest: number | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < afterCutoff.length; index += 1) {
      if (selected.has(index)) continue;
      const distance = Math.abs(afterCutoff[index]!.atMs - targetAtMs);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance && (nearest === null || index < nearest))
      ) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    if (nearest === null) break;
    selected.add(nearest);
  }
  const retained = [...selected]
    .sort((left, right) => left - right)
    .map((index) => afterCutoff[index]!);
  return [...(anchor === undefined ? [] : [anchor]), ...retained].sort(
    (left, right) =>
      left.atMs - right.atMs ||
      left.volumeMl - right.volumeMl ||
      left.epochId.localeCompare(right.epochId),
  );
}

/**
 * Conservative leak detector.  It only consumes canonical settled epoch
 * volumes; detector activity and recent pours seed a fresh baseline and keep
 * those observations from accumulating into a leak window.
 */
export function evaluateSuspectedLeak(
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluation {
  const id = "suspected_leak" as const;
  if (isRetired(input)) return retiredResult(id, input);
  const config = validConfig(suppliedConfig);
  if (!config.suspected_leak.enabled) return disabledResult(id, input);
  const timers = timersFor(input);
  const epoch = currentEpoch(input);
  if (epoch === null || typeof epoch.epochId !== "string" || epoch.epochId.length === 0) {
    return result(
      id,
      "not_configured",
      "none",
      "no_active_epoch",
      input.nowMs,
      { reason: "no_active_epoch" },
      { ...timers, leakSuppressedUntilMs: null },
      [],
      false,
    );
  }
  const usable = leakEpochUsable(input, config);
  if (usable === null) {
    const reason: HealthReason =
      epochDiagnosticCode(epoch) !== "ok" ? "invalid_measurement" : "stale_measurement";
    return result(
      id,
      "degraded",
      "info",
      reason,
      input.nowMs,
      { phase: epoch.phase ?? null, diagnosticCode: epochDiagnosticCode(epoch), reason },
      { ...timers, leakSuppressedUntilMs: null },
      [],
      false,
    );
  }
  const { epoch: current, atMs } = usable;
  const volume = epochVolume(current)!;
  const capacity = current.capacityMl!;
  const previousSamples = normalizedSamples(samplesFor(input), current.epochId, atMs);
  const hasOtherEpoch = samplesFor(input).some((sample) => sample.epochId !== current.epochId);
  if (hasOtherEpoch) {
    const seeded = [{ epochId: current.epochId, atMs, volumeMl: volume }];
    return result(
      id,
      "degraded",
      "info",
      "leak_epoch_reset",
      input.nowMs,
      { reason: "leak_epoch_reset", currentVolumeMl: volume, capacityMl: capacity },
      { ...timers, leakSuppressedUntilMs: null },
      seeded,
      false,
    );
  }
  const previous = previousSamples.at(-1);
  const recentPourAt = finite(input.latestCompletedPourAtMs ?? input.recentPourAtMs);
  const recentPour =
    recentPourAt !== null &&
    recentPourAt <= atMs &&
    atMs - recentPourAt <= config.suspected_leak.pourGraceMs;
  const detectorActive =
    input.pourActive === true ||
    phaseIs(current.phase, "candidate") ||
    phaseIs(current.phase, "pouring") ||
    phaseIs(current.phase, "cooldown");
  const currentSuppression =
    timers.leakSuppressedUntilMs !== null && atMs < timers.leakSuppressedUntilMs;
  const suppression = detectorActive || recentPour || currentSuppression;
  if (suppression) {
    const until =
      detectorActive || recentPour
        ? atMs + config.suspected_leak.settlingMs
        : timers.leakSuppressedUntilMs;
    const seeded = [{ epochId: current.epochId, atMs, volumeMl: volume }];
    return result(
      id,
      "healthy",
      "none",
      recentPour || detectorActive ? "leak_suppressed" : "leak_window_settling",
      input.nowMs,
      {
        reason: recentPour || detectorActive ? "leak_suppressed" : "leak_window_settling",
        currentVolumeMl: volume,
        capacityMl: capacity,
      },
      { ...timers, leakSuppressedUntilMs: until ?? null },
      seeded,
      false,
    );
  }
  const movementReset =
    previous !== undefined && volume - previous.volumeMl >= config.suspected_leak.resetMovementMl;
  if (movementReset) {
    const seeded = [{ epochId: current.epochId, atMs, volumeMl: volume }];
    return result(
      id,
      "healthy",
      "none",
      "leak_movement_reset",
      input.nowMs,
      {
        reason: "leak_movement_reset",
        currentVolumeMl: volume,
        capacityMl: capacity,
        resetMovementMl: config.suspected_leak.resetMovementMl,
      },
      { ...timers, leakSuppressedUntilMs: null },
      seeded,
      false,
    );
  }
  const samples = compactLeakSamples(
    previousSamples,
    { epochId: current.epochId, atMs, volumeMl: volume },
    config.suspected_leak.windowMs,
    config.suspected_leak.maxSamples,
  );
  if (previousSamples.length === 0) {
    return result(
      id,
      "healthy",
      "none",
      "leak_baseline",
      input.nowMs,
      {
        reason: "leak_baseline",
        sampleCount: samples.length,
        maxSamples: config.suspected_leak.maxSamples,
      },
      { ...timers, leakSuppressedUntilMs: null },
      samples,
      false,
    );
  }
  const oldest = samples[0]!;
  const elapsedMs = atMs - oldest.atMs;
  const lossMl = oldest.volumeMl - volume;
  const evidence = {
    reason: "leak_threshold" as const,
    lossMl,
    windowMs: config.suspected_leak.windowMs,
    sampleCount: samples.length,
    maxSamples: config.suspected_leak.maxSamples,
    currentVolumeMl: volume,
    capacityMl: capacity,
  };
  if (
    elapsedMs >= config.suspected_leak.windowMs &&
    lossMl >= config.suspected_leak.lossThresholdMl
  ) {
    return result(
      id,
      "active",
      "warning",
      "leak_threshold",
      input.nowMs,
      evidence,
      { ...timers, leakSuppressedUntilMs: null },
      samples,
    );
  }
  return result(
    id,
    "healthy",
    "none",
    "leak_window_settling",
    input.nowMs,
    { ...evidence, reason: "leak_window_settling" },
    { ...timers, leakSuppressedUntilMs: null },
    samples,
    false,
  );
}

function cleaningBaselineAndDue(
  input: HealthEvaluationInput,
  config: HealthConfig,
): { cleanedAtMs: number; dueAtMs: number; criticalAtMs: number } | null {
  const maintenance = input.latestLineCleaning;
  const cleanedAtMs =
    finite(input.lineCleanedAtMs) ??
    finite(input.latestLineCleanedAtMs) ??
    finite(input.lineCleaningBaselineAtMs) ??
    finite(maintenance?.cleanedAtMs);
  if (cleanedAtMs === null) return null;
  const dueInput =
    finite(input.lineCleaningDueAtMs ?? input.lineDueAtMs) ?? finite(maintenance?.dueAtMs);
  const derived =
    dueInput === null
      ? calculateLineCleaningDue(cleanedAtMs, config.line_cleaning_due)
      : {
          cleanedAtMs,
          dueAtMs: dueInput,
          criticalAtMs: dueInput + config.line_cleaning_due.criticalGraceDays * 86_400_000,
        };
  return derived;
}

/**
 * Evaluate due/critical maintenance; persisted due dates are historical, while
 * service may supply a current-policy due.
 */
export function evaluateLineCleaningDue(
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluation {
  const id = "line_cleaning_due" as const;
  if (isRetired(input)) return retiredResult(id, input);
  const config = validConfig(suppliedConfig);
  if (!config.line_cleaning_due.enabled) return disabledResult(id, input);
  const maintenance = cleaningBaselineAndDue(input, config);
  if (maintenance === null) {
    return result(
      id,
      "not_configured",
      "none",
      "line_cleaned_missing",
      input.nowMs,
      { reason: "line_cleaned_missing" },
      timersFor(input),
      samplesFor(input),
      false,
    );
  }
  if (
    !Number.isFinite(maintenance.cleanedAtMs) ||
    !Number.isFinite(maintenance.dueAtMs) ||
    !Number.isFinite(maintenance.criticalAtMs) ||
    maintenance.dueAtMs < maintenance.cleanedAtMs ||
    maintenance.criticalAtMs < maintenance.dueAtMs
  ) {
    return result(
      id,
      "degraded",
      "info",
      "line_cleaning_current",
      input.nowMs,
      { reason: "line_cleaning_current" },
      timersFor(input),
      samplesFor(input),
      false,
    );
  }
  if (maintenance.cleanedAtMs > input.nowMs) {
    return result(
      id,
      "degraded",
      "info",
      "line_cleaning_current",
      input.nowMs,
      { reason: "line_cleaning_current" },
      timersFor(input),
      samplesFor(input),
      false,
    );
  }
  const evidence = {
    dueAtMs: maintenance.dueAtMs,
    criticalAtMs: maintenance.criticalAtMs,
    intervalDays: config.line_cleaning_due.intervalDays,
    criticalAfterDays: config.line_cleaning_due.criticalGraceDays,
  };
  if (input.nowMs < maintenance.dueAtMs) {
    return result(
      id,
      "healthy",
      "none",
      "line_cleaning_current",
      input.nowMs,
      { ...evidence, reason: "line_cleaning_current" },
      timersFor(input),
      samplesFor(input),
      false,
    );
  }
  if (input.nowMs < maintenance.criticalAtMs) {
    return result(
      id,
      "active",
      "warning",
      "line_cleaning_due",
      input.nowMs,
      { ...evidence, reason: "line_cleaning_due" },
      timersFor(input),
      samplesFor(input),
    );
  }
  return result(
    id,
    "active",
    "critical",
    "line_cleaning_critical",
    input.nowMs,
    { ...evidence, reason: "line_cleaning_critical" },
    timersFor(input),
    samplesFor(input),
  );
}

export function evaluateHealthCheck(
  id: HealthCheckId,
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluation {
  switch (id) {
    case "low_keg":
      return evaluateLowKeg(input, suppliedConfig);
    case "scale_availability":
      return evaluateScaleAvailability(input, suppliedConfig);
    case "suspected_leak":
      return evaluateSuspectedLeak(input, suppliedConfig);
    case "serving_temperature":
      return evaluateServingTemperature(input, suppliedConfig);
    case "line_cleaning_due":
      return evaluateLineCleaningDue(input, suppliedConfig);
  }
}

export function evaluateAllHealthChecks(
  input: HealthEvaluationInput,
  suppliedConfig: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEvaluationSet {
  const config = validConfig(suppliedConfig);
  const checks = HEALTH_CHECK_IDS.map((id) => evaluateHealthCheck(id, input, config));
  return { evaluatedAtMs: input.nowMs, checks };
}

export const evaluateHealth = evaluateAllHealthChecks;
export const evaluateAll = evaluateAllHealthChecks;
export const evaluateHealthChecks = evaluateAllHealthChecks;
export const evaluateLowKegCheck = evaluateLowKeg;
export const evaluateScaleAvailabilityCheck = evaluateScaleAvailability;
export const evaluateSuspectedLeakCheck = evaluateSuspectedLeak;
export const evaluateServingTemperatureCheck = evaluateServingTemperature;
export const evaluateLineCleaningDueCheck = evaluateLineCleaningDue;

export class HealthEngine {
  readonly config: HealthConfig;

  constructor(config: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG) {
    this.config = validConfig(config);
  }

  evaluateCheck(id: HealthCheckId, input: HealthEvaluationInput): HealthEvaluation {
    return evaluateHealthCheck(id, input, this.config);
  }

  evaluate(input: HealthEvaluationInput): HealthEvaluationSet {
    return evaluateAllHealthChecks(input, this.config);
  }

  evaluateAll(input: HealthEvaluationInput): HealthEvaluationSet {
    return this.evaluate(input);
  }
}

export const createHealthEngine = (
  config: HealthConfig | HealthConfigOverride = DEFAULT_HEALTH_CONFIG,
): HealthEngine => new HealthEngine(config);
