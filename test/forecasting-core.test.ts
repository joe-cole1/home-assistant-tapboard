import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  bootstrapDailyRates,
  FALLBACK_FAST_ML_PER_DAY,
  FALLBACK_MEDIAN_ML_PER_DAY,
  FALLBACK_SLOW_ML_PER_DAY,
  forecastFill,
  ML_PER_US_FL_OZ,
} from "../src/features/forecasting/forecast.ts";
import { toPublicForecastProjection } from "../src/features/forecasting/projections.ts";
import type { ForecastInput } from "../src/features/forecasting/types.ts";

const start = "2026-01-01T12:00:00.000Z";
const now = "2026-01-15T12:00:00.000Z";
function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    fill: { id: "b3c2970c-10aa-4f2d-b677-e8f7cc830556", endedAt: null, observationStart: start },
    pours: [],
    currentVolume: {
      kind: "available",
      volumeMl: 120 * ML_PER_US_FL_OZ,
      capacityMl: 5_000,
      diagnosticCode: "ok",
      provenance: provenance("epoch", "tap", "assignment", overrides.now ?? now),
    },
    servingSizeMl: 12 * ML_PER_US_FL_OZ,
    now,
    ...overrides,
  };
}
function provenance(
  epochId: string,
  tapId: string,
  assignmentId: string,
  asOf: string | number | Date = now,
) {
  return {
    identifier: "telemetry_epoch_stabilized" as const,
    epochId,
    tapId,
    assignmentId,
    measuredAt: start,
    asOf:
      asOf instanceof Date
        ? asOf.toISOString()
        : typeof asOf === "number"
          ? new Date(asOf).toISOString()
          : asOf,
  };
}
function pour(day: number, volumeMl = 100) {
  return {
    id: `pour-${day}`,
    fillId: "b3c2970c-10aa-4f2d-b677-e8f7cc830556",
    attributed: true,
    volumeMl,
    startedAt: null,
    completedAt: `2026-01-${String(day).padStart(2, "0")}T18:00:00.000Z`,
  };
}

void test("v1 UTC zero days aggregate from the first assignment day and use 120oz fallback 10/20/40", () => {
  const result = forecastFill(
    input({
      fill: {
        id: "b3c2970c-10aa-4f2d-b677-e8f7cc830556",
        endedAt: null,
        observationStart: "2026-07-30T23:00:00.000Z",
      },
      pours: [{ ...pour(1, 12 * ML_PER_US_FL_OZ), completedAt: "2026-08-01T00:30:00.000Z" }],
      now: "2026-08-01T16:00:00.000Z",
    }),
  );
  assert.deepEqual(result.dailyConsumptionMl, [0, 0, 12 * ML_PER_US_FL_OZ]);
  assert.equal(result.method?.id, "fallback_24oz_per_4d");
  assert.equal(FALLBACK_FAST_ML_PER_DAY, 354.88235475);
  assert.equal(FALLBACK_MEDIAN_ML_PER_DAY, 177.441177375);
  assert.equal(FALLBACK_SLOW_ML_PER_DAY, 88.7205886875);
  assert.deepEqual(
    [result.days?.p10Days, result.days?.p50Days, result.days?.p90Days],
    [10, 20, 40],
  );
  assert.deepEqual(result.confidence, {
    level: "low",
    status: "available",
    reason: "insufficient_fill_history",
  });
});

void test("bootstrap selection requires both 14 UTC days and three qualifying pours", () => {
  assert.equal(
    forecastFill(input({ pours: [pour(1), pour(2)] })).method?.id,
    "fallback_24oz_per_4d",
  );
  assert.equal(
    forecastFill(input({ now: "2026-01-13T12:00:00.000Z", pours: [pour(1), pour(2), pour(3)] }))
      .method?.id,
    "fallback_24oz_per_4d",
  );
  assert.equal(
    forecastFill(input({ pours: [pour(1), pour(2), pour(3)] })).method?.id,
    "circular_moving_block_bootstrap_7d",
  );
  assert.equal(
    forecastFill(input({ pours: [pour(1), pour(2), pour(3)] })).confidence.level,
    "medium",
  );
});

void test("bootstrap is deterministic with exactly 512 process-stable samples", () => {
  const pours = Array.from({ length: 14 }, (_, index) => pour(index + 1, 50 + index));
  const first = forecastFill(input({ pours }));
  const second = forecastFill(input({ pours }));
  assert.equal(first.method?.bootstrapSamples, 512);
  assert.equal(first.method?.validBootstrapSamples, 512);
  assert.equal(first.method?.id, "circular_moving_block_bootstrap_7d");
  assert.deepEqual(first.days, second.days);
});

void test("high confidence requires 28 UTC days and eight qualifying pours", () => {
  const pours = Array.from({ length: 8 }, (_, index) => pour(index + 1));
  const result = forecastFill(input({ now: "2026-01-29T12:00:00.000Z", pours }));
  assert.equal(result.confidence.level, "high");
});

void test("zero volume is depleted and exposes zero whole servings", () => {
  const result = forecastFill(
    input({
      currentVolume: {
        kind: "available",
        volumeMl: 0,
        capacityMl: 100,
        diagnosticCode: "ok",
        provenance: provenance("e", "t", "a"),
      },
    }),
  );
  assert.equal(result.status, "depleted");
  assert.equal(result.reason, "current_volume_depleted");
  assert.equal(result.servingsRemaining, 0);
  assert.equal(result.days?.medianDays, 0);
  assert.equal(result.days?.medianDepletionAt, now);
});

void test("all-zero bootstrap input safely has no usable samples", () => {
  assert.deepEqual(
    bootstrapDailyRates(
      Array.from({ length: 14 }, () => 0),
      "fill",
      0,
    ),
    [],
  );
});

void test("empty qualifying pours use the explicit fallback without NaN", () => {
  const result = forecastFill(input());
  assert.equal(result.method?.id, "fallback_24oz_per_4d");
  assert.equal(result.method?.bootstrapSamples, 0);
  assert.equal(Number.isFinite(result.days?.medianDays ?? Number.NaN), true);
});

void test("dates use unrounded fractional days and a future same-day observation start fails closed", () => {
  const nearBoundary = forecastFill(
    input({
      currentVolume: {
        kind: "available",
        volumeMl: 178.8,
        capacityMl: 1_000,
        diagnosticCode: "ok",
        provenance: provenance("e", "t", "a"),
      },
    }),
  );
  assert.equal(nearBoundary.days?.medianDays, 1); // 1.007... days rounds to 1.0
  assert.equal(nearBoundary.days?.medianDepletionAt, "2026-01-17T00:00:00.000Z");
  const futureStart = forecastFill(
    input({
      fill: {
        id: "b3c2970c-10aa-4f2d-b677-e8f7cc830556",
        endedAt: null,
        observationStart: "2026-01-15T18:00:00.000Z",
      },
    }),
  );
  assert.equal(futureStart.status, "anomaly");
  assert.equal(futureStart.reason, "invalid_observation_range");
});

void test("invalid, future, pre-start, and mismatched pours are excluded while valid evidence remains", () => {
  const pours = [
    pour(2),
    { ...pour(3), id: "future", completedAt: "2026-02-01T00:00:00.000Z" },
    { ...pour(3), id: "before", completedAt: "2025-12-30T00:00:00.000Z" },
    { ...pour(3), id: "bad", completedAt: "2026-01-03 12:00:00" },
    { ...pour(3), id: "wrong", fillId: "other" },
    { ...pour(3), id: "zero", volumeMl: 0 },
  ];
  const result = forecastFill(input({ pours }));
  assert.equal(result.dailyConsumptionMl[1], 100);
  assert.equal(result.status, "anomaly");
  assert.equal(result.confidence.level, "low");
  assert.deepEqual(result.anomalies, {
    invalidTimestamp: 1,
    futureTimestamp: 1,
    beforeObservationRange: 1,
    fillMismatch: 1,
    invalidVolume: 1,
  });
});

void test("invalid current volume and capacity inconsistency fail closed", () => {
  const invalid = forecastFill(
    input({ currentVolume: { kind: "anomaly", reason: "invalid_current_volume" } }),
  );
  const capacity = forecastFill(
    input({
      currentVolume: {
        kind: "available",
        volumeMl: 101,
        capacityMl: 100,
        diagnosticCode: "ok",
        provenance: provenance("e", "t", "a"),
      },
    }),
  );
  const futureMeasurement = forecastFill(
    input({
      currentVolume: {
        kind: "available",
        volumeMl: 50,
        capacityMl: 100,
        diagnosticCode: "ok",
        provenance: { ...provenance("e", "t", "a"), measuredAt: "2026-01-16T00:00:00.000Z" },
      },
    }),
  );
  assert.equal(invalid.reason, "invalid_current_volume");
  assert.equal(capacity.reason, "capacity_inconsistency");
  assert.equal(futureMeasurement.reason, "invalid_current_volume");
  assert.equal(invalid.days, null);
  assert.equal(capacity.days, null);
  assert.equal(futureMeasurement.days, null);
});

void test("stale volume retains a low-confidence forecast while reporting stale status", () => {
  const result = forecastFill(
    input({
      currentVolume: {
        kind: "stale",
        volumeMl: 500,
        capacityMl: 1_000,
        diagnosticCode: "ok",
        provenance: provenance("e", "t", "a"),
      },
    }),
  );
  assert.equal(result.status, "stale");
  assert.equal(result.reason, "stale_current_volume");
  assert.equal(result.confidence.level, "low");
});

void test("servings are an exact conservative floor independent of depletion rate", () => {
  const exact = forecastFill(
    input({
      currentVolume: {
        kind: "available",
        volumeMl: 20,
        capacityMl: 100,
        diagnosticCode: "ok",
        provenance: provenance("e", "t", "a"),
      },
      servingSizeMl: 10,
    }),
  );
  const partial = forecastFill(
    input({
      currentVolume: {
        kind: "available",
        volumeMl: 25,
        capacityMl: 100,
        diagnosticCode: "ok",
        provenance: provenance("e", "t", "a"),
      },
      servingSizeMl: 10,
    }),
  );
  assert.equal(exact.servingsRemaining, 2);
  assert.equal(partial.servingsRemaining, 2);
  assert.equal(partial.servingSizeMl, 10);
});

void test("public projection excludes IDs, telemetry provenance, aggregates, and anomaly counts", () => {
  const publicView = toPublicForecastProjection(forecastFill(input()));
  assert.deepEqual(Object.keys(publicView).sort(), [
    "confidence",
    "days",
    "method",
    "reason",
    "servingSizeMl",
    "servingsRemaining",
    "status",
  ]);
  assert.equal(JSON.stringify(publicView).includes("epoch"), false);
  assert.equal(JSON.stringify(publicView).includes("bootstrapSamples"), false);
});

void test("forecast output is stable across process restarts and host timezones", () => {
  const moduleUrl = new URL("../src/features/forecasting/forecast.ts", import.meta.url).href;
  const script = `
    import { forecastFill, ML_PER_US_FL_OZ } from ${JSON.stringify(moduleUrl)};
    const fillId = "b3c2970c-10aa-4f2d-b677-e8f7cc830556";
    const pours = Array.from({ length: 8 }, (_, index) => ({
      id: String(index), fillId, attributed: true, volumeMl: 100 + index,
      startedAt: null,
      completedAt: new Date(Date.UTC(2026, 0, 1 + index * 3, 12)).toISOString(),
    }));
    const result = forecastFill({
      fill: { id: fillId, endedAt: null, observationStart: "2026-01-01T00:00:00.000Z" },
      pours,
      currentVolume: {
        kind: "available", volumeMl: 120 * ML_PER_US_FL_OZ, capacityMl: 5000,
        diagnosticCode: "ok",
        provenance: {
          identifier: "telemetry_epoch_stabilized", epochId: "epoch", tapId: "tap",
          assignmentId: "assignment", measuredAt: "2026-01-29T12:00:00.000Z",
          asOf: "2026-01-29T12:00:00.000Z",
        },
      },
      servingSizeMl: 12 * ML_PER_US_FL_OZ,
      now: "2026-01-29T12:00:00.000Z",
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const run = (timezone: string) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: timezone },
    });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  assert.equal(run("UTC"), run("America/Los_Angeles"));
  assert.equal(run("UTC"), run("UTC"));
});
