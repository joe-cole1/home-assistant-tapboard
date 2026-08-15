import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_HEALTH_CONFIG,
  HEALTH_CHECK_IDS,
  calculateLineCleaningDue,
  clearHealthConfigOverride,
  evaluateAllHealthChecks,
  evaluateLineCleaningDue,
  evaluateLowKeg,
  evaluateScaleAvailability,
  evaluateServingTemperature,
  evaluateSuspectedLeak,
  healthEvidenceSizeBytes,
  isHealthEvidenceWithinLimit,
  isNoopHealthConfigOverride,
  mergeHealthConfig,
  resolveHealthConfig,
  serializeHealthEvidence,
  validateHealthConfig,
  validateHealthConfigOverride,
  validateHealthEvidence,
  type HealthConfigOverride,
  type HealthEvaluationInput,
} from "../src/features/health/index.ts";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const FIVE_MINUTES = 5 * 60_000;

function measurement(
  overrides: Partial<NonNullable<HealthEvaluationInput["latestMeasurement"]>> = {},
) {
  return {
    measurementId: "measurement-1",
    measuredAtMs: NOW,
    receivedAtMs: NOW + 500,
    tempC: null,
    ...overrides,
  };
}

function epoch(overrides: Partial<NonNullable<HealthEvaluationInput["currentEpoch"]>> = {}) {
  return {
    epochId: "epoch-1",
    capacityMl: 1_000,
    stabilizedVolumeMl: 500,
    diagnosticCode: "ok" as const,
    phase: "ready" as const,
    lastMeasuredAtMs: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<HealthEvaluationInput> = {}): HealthEvaluationInput {
  return {
    nowMs: NOW,
    enabled: true,
    retired: false,
    authorityChangedAtMs: NOW - 60_000,
    latestMeasurement: measurement(),
    currentEpoch: epoch(),
    ...overrides,
  };
}

function config(enabled: keyof typeof DEFAULT_HEALTH_CONFIG): HealthConfigOverride {
  return { [enabled]: { enabled: true } };
}

void test("health identifiers, states, severities, and exact defaults are stable", () => {
  assert.deepEqual(HEALTH_CHECK_IDS, [
    "low_keg",
    "scale_availability",
    "suspected_leak",
    "serving_temperature",
    "line_cleaning_due",
  ]);
  assert.deepEqual(DEFAULT_HEALTH_CONFIG.low_keg, {
    enabled: true,
    thresholdPercent: 20,
    criticalPercent: 5,
    fixedThresholdMl: 0,
    settlingMs: 30_000,
  });
  assert.equal(DEFAULT_HEALTH_CONFIG.suspected_leak.lossThresholdMl, 236.5882365);
  assert.equal(DEFAULT_HEALTH_CONFIG.suspected_leak.resetMovementMl, 946.352946);
  assert.deepEqual(DEFAULT_HEALTH_CONFIG.serving_temperature, {
    enabled: false,
    normalMinC: 1.1111111111111112,
    normalMaxC: 5.555555555555555,
    criticalMinC: -1.1111111111111112,
    criticalMaxC: 10,
    durationMs: 900_000,
  });
  assert.deepEqual(DEFAULT_HEALTH_CONFIG.line_cleaning_due, {
    enabled: false,
    intervalDays: 14,
    criticalGraceDays: 7,
  });
});

void test("nullable overrides merge, clear, and expose field inheritance", () => {
  const override = {
    low_keg: { thresholdPercent: 25, criticalPercent: null },
    serving_temperature: null,
  } as const;
  const merged = mergeHealthConfig(DEFAULT_HEALTH_CONFIG, override);
  assert.equal(merged.low_keg.thresholdPercent, 25);
  assert.equal(merged.low_keg.criticalPercent, 5);
  assert.equal(merged.serving_temperature.enabled, false);
  const resolved = resolveHealthConfig(DEFAULT_HEALTH_CONFIG, override);
  assert.equal(resolved.effective.low_keg.thresholdPercent, 25);
  assert.equal(resolved.inheritance.low_keg.thresholdPercent, "override");
  assert.equal(resolved.inheritance.low_keg.criticalPercent, "default");
  assert.equal(isNoopHealthConfigOverride({ low_keg: { thresholdPercent: null } }), true);
  assert.equal(clearHealthConfigOverride(), null);
  assert.equal(
    validateHealthConfigOverride({ low_keg: { thresholdPercent: null } })?.low_keg
      ?.thresholdPercent,
    null,
  );
});

void test("config and evidence validators reject unknowns and unsafe cross-fields", () => {
  assert.throws(() => validateHealthConfig({ low_keg: { unknown: 1 } }));
  assert.throws(() => validateHealthConfig({ low_keg: { criticalPercent: 30 } }));
  assert.throws(() =>
    validateHealthConfig({
      scale_availability: { degradedAfterMs: 10_000, activeAfterMs: 10_000 },
    }),
  );
  assert.throws(() =>
    validateHealthConfig({ serving_temperature: { criticalMinC: 5, normalMinC: 1 } }),
  );
  assert.throws(() => validateHealthConfigOverride({ suspected_leak: { maxSamples: 65 } }));
  assert.throws(() => validateHealthEvidence({ sourceId: "secret" }));
  assert.throws(() => validateHealthEvidence({ notes: "private" }));
});

void test("low keg uses canonical volume, exact threshold and settling boundaries", () => {
  const healthy = evaluateLowKeg(input({ currentEpoch: epoch({ stabilizedVolumeMl: 200 }) }));
  assert.equal(healthy.state, "healthy");
  const first = evaluateLowKeg(input({ currentEpoch: epoch({ stabilizedVolumeMl: 199 }) }));
  assert.equal(first.state, "degraded");
  assert.equal(first.severity, "info");
  const active = evaluateLowKeg(
    input({
      nowMs: NOW + 30_000,
      currentEpoch: epoch({ stabilizedVolumeMl: 199, lastMeasuredAtMs: NOW + 30_000 }),
      previous: { timers: first.nextTimers },
    }),
  );
  assert.equal(active.state, "active");
  assert.equal(active.severity, "warning");
  const critical = evaluateLowKeg(
    input({
      nowMs: NOW + 30_000,
      currentEpoch: epoch({ stabilizedVolumeMl: 40 }),
      previous: { timers: { lowKegBelowSinceMs: NOW } },
    }),
    {
      low_keg: {
        thresholdPercent: 20,
        criticalPercent: 5,
        fixedThresholdMl: 0,
        settlingMs: 30_000,
      },
    },
  );
  assert.equal(critical.state, "active");
  assert.equal(critical.severity, "critical");
});

void test("scale uses authority age and measurement time, not receipt time", () => {
  assert.equal(
    evaluateScaleAvailability(input({ authorityChangedAtMs: null })).state,
    "not_configured",
  );
  assert.equal(
    evaluateScaleAvailability(input({ latestMeasurement: null, authorityChangedAtMs: NOW })).state,
    "degraded",
  );
  assert.equal(
    evaluateScaleAvailability(
      input({ latestMeasurement: null, authorityChangedAtMs: NOW - 30 * 60_000 }),
    ).state,
    "active",
  );
  assert.equal(
    evaluateScaleAvailability(
      input({
        latestMeasurement: measurement({ measuredAtMs: NOW - FIVE_MINUTES, receivedAtMs: NOW }),
      }),
    ).state,
    "degraded",
  );
  assert.equal(
    evaluateScaleAvailability(
      input({
        latestMeasurement: measurement({ measuredAtMs: NOW - 30 * 60_000, receivedAtMs: NOW }),
      }),
    ).severity,
    "critical",
  );
});

void test("temperature is canonical Celsius and continuity resets on invalid, stale, or gap", () => {
  const enabled = config("serving_temperature");
  assert.equal(
    evaluateServingTemperature(input({ latestMeasurement: measurement({ tempC: 4 }) }), enabled)
      .state,
    "healthy",
  );
  const first = evaluateServingTemperature(
    input({ latestMeasurement: measurement({ tempC: 10 }) }),
    enabled,
  );
  assert.equal(first.state, "degraded");
  assert.equal(
    evaluateServingTemperature(
      input({
        nowMs: NOW + 900_000,
        latestMeasurement: measurement({
          measuredAtMs: NOW + 900_000,
          receivedAtMs: NOW + 900_000,
          tempC: 10,
        }),
        previous: {
          timers: {
            ...first.nextTimers,
            temperatureOutsideSinceMs: NOW,
            temperatureLastMeasuredAtMs: NOW + 600_000,
          },
        },
      }),
      enabled,
    ).state,
    "active",
  );
  assert.equal(
    evaluateServingTemperature(input({ latestMeasurement: measurement({ tempC: null }) }), enabled)
      .state,
    "degraded",
  );
  assert.equal(
    evaluateServingTemperature(input({ latestMeasurement: measurement({ tempC: 50 }) }), enabled)
      .state,
    "degraded",
  );
});

void test("leak detector suppresses pours, resets epoch/movement, caps samples, and requires a full window", () => {
  let current = NOW;
  const enabled = config("suspected_leak");
  const baseline = evaluateSuspectedLeak(input({ nowMs: current }), enabled);
  assert.equal(baseline.state, "healthy");
  current += 60_000;
  const suppressed = evaluateSuspectedLeak(
    input({
      nowMs: current,
      latestCompletedPourAtMs: current,
      currentEpoch: epoch({ stabilizedVolumeMl: 900, lastMeasuredAtMs: current }),
      previous: { leakSamples: baseline.nextLeakSamples, timers: baseline.nextTimers },
    }),
    enabled,
  );
  assert.equal(suppressed.state, "healthy");
  assert.equal(suppressed.nextLeakSamples.length, 1);
  current += 10 * 60_000;
  const stillSuppressed = evaluateSuspectedLeak(
    input({
      nowMs: current,
      currentEpoch: epoch({ stabilizedVolumeMl: 700, lastMeasuredAtMs: current }),
      previous: { leakSamples: suppressed.nextLeakSamples, timers: suppressed.nextTimers },
    }),
    enabled,
  );
  assert.equal(stillSuppressed.state, "healthy");
  current += 5 * 60_000;
  const active = evaluateSuspectedLeak(
    input({
      nowMs: current,
      currentEpoch: epoch({ stabilizedVolumeMl: 600, lastMeasuredAtMs: current }),
      previous: {
        leakSamples: stillSuppressed.nextLeakSamples,
        timers: stillSuppressed.nextTimers,
      },
    }),
    enabled,
  );
  assert.equal(active.state, "active");
  assert.equal(active.severity, "warning");
  const changedEpoch = evaluateSuspectedLeak(
    input({
      currentEpoch: epoch({ epochId: "epoch-2", stabilizedVolumeMl: 0 }),
      previous: { leakSamples: active.nextLeakSamples },
    }),
    enabled,
  );
  assert.equal(changedEpoch.reason, "leak_epoch_reset");
  const changedBaseline = evaluateSuspectedLeak(
    input({
      currentEpoch: epoch({ epochId: "epoch-2", stabilizedVolumeMl: 0 }),
      previous: { leakSamples: changedEpoch.nextLeakSamples },
    }),
    enabled,
  );
  const moved = evaluateSuspectedLeak(
    input({
      currentEpoch: epoch({ epochId: "epoch-2", stabilizedVolumeMl: 1_000 }),
      previous: { leakSamples: changedBaseline.nextLeakSamples },
    }),
    enabled,
  );
  assert.equal(moved.reason, "leak_movement_reset");
  const bounded = evaluateSuspectedLeak(
    input({
      leakSamples: Array.from({ length: 100 }, (_, index) => ({
        epochId: "epoch-1",
        atMs: NOW + index,
        volumeMl: 500,
      })),
    }),
    { suspected_leak: { enabled: true, maxSamples: 3 } },
  );
  assert.ok(bounded.nextLeakSamples.length <= 3);
});

void test("leak cooldown suppresses at the boundary and resets its evidence baseline", () => {
  const enabled = {
    suspected_leak: {
      enabled: true,
      lossThresholdMl: 100,
      windowMs: 15 * 60_000,
      settlingMs: 10_000,
    },
  } satisfies HealthConfigOverride;
  const baseline = evaluateSuspectedLeak(
    input({ currentEpoch: epoch({ stabilizedVolumeMl: 900 }) }),
    enabled,
  );
  const cooldownAt = NOW + 60_000;
  const cooldown = evaluateSuspectedLeak(
    input({
      nowMs: cooldownAt,
      currentEpoch: epoch({
        phase: "cooldown",
        stabilizedVolumeMl: 800,
        lastMeasuredAtMs: cooldownAt,
      }),
      previous: { leakSamples: baseline.nextLeakSamples },
    }),
    enabled,
  );
  assert.equal(cooldown.state, "healthy");
  assert.equal(cooldown.reason, "leak_suppressed");
  assert.deepEqual(cooldown.nextLeakSamples, [
    { epochId: "epoch-1", atMs: cooldownAt, volumeMl: 800 },
  ]);
  assert.equal(cooldown.nextTimers.leakSuppressedUntilMs, cooldownAt + 10_000);

  const atSettlingBoundary = evaluateSuspectedLeak(
    input({
      nowMs: cooldownAt + 10_000,
      currentEpoch: epoch({
        phase: "ready",
        stabilizedVolumeMl: 750,
        lastMeasuredAtMs: cooldownAt + 10_000,
      }),
      previous: { leakSamples: cooldown.nextLeakSamples, timers: cooldown.nextTimers },
    }),
    enabled,
  );
  assert.equal(atSettlingBoundary.state, "healthy");
  assert.notEqual(atSettlingBoundary.state, "active");
  assert.equal(atSettlingBoundary.nextLeakSamples[0]?.volumeMl, 800);

  const afterSuppressedWindow = evaluateSuspectedLeak(
    input({
      nowMs: cooldownAt + 15 * 60_000,
      currentEpoch: epoch({
        phase: "ready",
        stabilizedVolumeMl: 750,
        lastMeasuredAtMs: cooldownAt + 15 * 60_000,
      }),
      previous: {
        leakSamples: atSettlingBoundary.nextLeakSamples,
        timers: atSettlingBoundary.nextTimers,
      },
    }),
    enabled,
  );
  assert.equal(afterSuppressedWindow.state, "healthy");
  assert.notEqual(afterSuppressedWindow.state, "active");
});

void test("leak movement resets only for threshold upward movement", () => {
  const enabled = {
    suspected_leak: { enabled: true, resetMovementMl: 10 },
  } satisfies HealthConfigOverride;
  const baseline = evaluateSuspectedLeak(
    input({ currentEpoch: epoch({ stabilizedVolumeMl: 500 }) }),
    enabled,
  );
  const smallUpward = evaluateSuspectedLeak(
    input({
      nowMs: NOW + 60_000,
      currentEpoch: epoch({ stabilizedVolumeMl: 509, lastMeasuredAtMs: NOW + 60_000 }),
      previous: { leakSamples: baseline.nextLeakSamples },
    }),
    enabled,
  );
  assert.notEqual(smallUpward.reason, "leak_movement_reset");
  assert.equal(smallUpward.nextLeakSamples.length, 2);

  const atUpwardThreshold = evaluateSuspectedLeak(
    input({
      nowMs: NOW + 60_000,
      currentEpoch: epoch({ stabilizedVolumeMl: 510, lastMeasuredAtMs: NOW + 60_000 }),
      previous: { leakSamples: baseline.nextLeakSamples },
    }),
    enabled,
  );
  assert.equal(atUpwardThreshold.reason, "leak_movement_reset");
  assert.equal(atUpwardThreshold.nextLeakSamples.length, 1);

  const largeDownward = evaluateSuspectedLeak(
    input({
      nowMs: NOW + 60_000,
      currentEpoch: epoch({ stabilizedVolumeMl: 0, lastMeasuredAtMs: NOW + 60_000 }),
      previous: { leakSamples: baseline.nextLeakSamples },
    }),
    enabled,
  );
  assert.notEqual(largeDownward.reason, "leak_movement_reset");
  assert.equal(largeDownward.nextLeakSamples.length, 2);
});

void test("line cleaning due is historical and exact at due/critical boundaries", () => {
  const cleanedAtMs = NOW - 14 * 86_400_000;
  const due = calculateLineCleaningDue(cleanedAtMs);
  assert.equal(due.dueAtMs, NOW);
  const enabled = config("line_cleaning_due");
  assert.equal(
    evaluateLineCleaningDue(input({ lineCleanedAtMs: null }), enabled).state,
    "not_configured",
  );
  assert.equal(
    evaluateLineCleaningDue(input({ lineCleanedAtMs: cleanedAtMs }), enabled).severity,
    "warning",
  );
  assert.equal(
    evaluateLineCleaningDue(
      input({ nowMs: due.criticalAtMs, lineCleanedAtMs: cleanedAtMs }),
      enabled,
    ).severity,
    "critical",
  );
  assert.equal(
    evaluateLineCleaningDue(
      input({
        nowMs: NOW + 1,
        lineCleanedAtMs: cleanedAtMs,
        lineCleaningDueAtMs: NOW + 7 * 86_400_000,
      }),
      enabled,
    ).state,
    "healthy",
  );
});

void test("retired skips every check while display-disabled Taps still evaluate", () => {
  const retired = evaluateAllHealthChecks(input({ retired: true }));
  assert.deepEqual(
    retired.checks.map((check) => [check.state, check.reason]),
    HEALTH_CHECK_IDS.map(() => ["not_configured", "tap_retired"]),
  );
  assert.equal(evaluateLowKeg(input({ enabled: false })).state, "healthy");
});

void test("evidence is allowlisted and bounded", () => {
  const evidence = validateHealthEvidence({ reason: "scale_fresh", measurementAgeMs: 10 });
  assert.equal(
    healthEvidenceSizeBytes(evidence),
    Buffer.byteLength(serializeHealthEvidence(evidence)),
  );
  assert.equal(isHealthEvidenceWithinLimit(evidence), true);
  assert.throws(() => serializeHealthEvidence({ reason: "x".repeat(3_000) }));
});
