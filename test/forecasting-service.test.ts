import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import * as detector from "../src/features/telemetry/repositories/detector.ts";
import { createForecastService } from "../src/features/forecasting/service.ts";
import { decodeForecastHistoryCursor } from "../src/features/forecasting/forecast-validation.ts";
import type { CreateTelemetryEpoch } from "../src/features/telemetry/epoch-types.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-01-01T00:00:00.000Z";

function fixture() {
  const db = openDatabase(":memory:"),
    q = (sql: string, ...v: unknown[]) => db.prepare<unknown[]>(sql).run(...v);
  for (const n of [1, 2])
    q(
      "INSERT INTO taps (id,tap_number,enabled,created_at,updated_at) VALUES (?,?,?,?,?)",
      id(n),
      n,
      1,
      at,
      at,
    );
  q(
    "INSERT INTO beverages (id,ownership_type,created_at,updated_at) VALUES (?,?,?,?)",
    id(3),
    "custom",
    at,
    at,
  );
  q(
    "INSERT INTO kegs (id,keg_number,capacity_ml,current_tare_g,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    id(4),
    1,
    1000,
    10,
    at,
    at,
  );
  q(
    "INSERT INTO kegs (id,keg_number,capacity_ml,current_tare_g,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    id(11),
    2,
    1000,
    10,
    at,
    at,
  );
  q(
    "INSERT INTO fills (id,beverage_id,keg_id,fill_date,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    id(5),
    id(3),
    id(4),
    "2026-01-01",
    at,
    at,
  );
  q(
    "INSERT INTO fills (id,beverage_id,keg_id,fill_date,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    id(6),
    id(3),
    id(11),
    "2026-01-01",
    at,
    at,
  );
  q(
    "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
    id(7),
    id(1),
    id(5),
    at,
    at,
  );
  const epoch: CreateTelemetryEpoch = {
    id: id(8),
    tapId: id(1),
    sourceId: null,
    fillId: id(5),
    assignmentId: id(7),
    kegId: id(4),
    capacityMl: 1000,
    tareG: 10,
    densityGPerMl: 1,
    densitySource: "fallback_fg",
    normalizationVersion: 1,
    detectorConfigVersion: "x",
    globalConfigRevision: 1,
    tapOverrideRevision: null,
    arbitrationGroupId: null,
    config: DEFAULT_DETECTOR_CONFIG,
    startedAt: at,
    startedAtEpochMs: 1,
  };
  detector.insertTelemetryEpoch(db, epoch);
  detector.createInitialTelemetryEpochState(db, epoch.id, at);
  const state = detector.readTelemetryEpochState(db, epoch.id)!;
  detector.updateTelemetryEpochState(db, {
    ...state,
    phase: "ready",
    lastMeasuredAtMs: Date.parse("2026-01-20T00:00:00.000Z"),
    lastStabilizedVolumeMl: 500,
    lastPublicVolumeMl: 99,
    lastDiagnosticCode: "ok",
  });
  const pour = (
    n: number,
    fillId = id(5),
    tapId = id(1),
    assignmentId = id(7),
    epochId = id(8),
    completedAt = `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`,
  ) =>
    detector.insertCompletedPourIdempotently(db, {
      id: id(20 + n),
      effectKey: `e${n}-${fillId}-${assignmentId}`,
      fillId,
      tapId,
      assignmentId,
      epochId,
      detectorSessionId: `s${n}`,
      canonicalVolumeMl: 100,
      startedAt: completedAt,
      completedAt,
      createdAt: completedAt,
    });
  const insertEpoch = (
    epochId: string,
    tapId: string,
    assignmentId: string,
    fillId = id(5),
    capacityMl = 1000,
    kegId = id(4),
  ) => {
    const value: CreateTelemetryEpoch = {
      ...epoch,
      id: epochId,
      tapId,
      assignmentId,
      fillId,
      capacityMl,
      kegId,
      startedAtEpochMs: Number(epochId.slice(-2)) + 10,
    };
    detector.insertTelemetryEpoch(db, value);
    detector.createInitialTelemetryEpochState(db, value.id, at);
    return value;
  };
  return {
    db,
    q,
    pour,
    insertEpoch,
    service: createForecastService(db, { now: () => new Date("2026-01-20T00:00:00.000Z") }),
  };
}

void test("forecast aggregates a Fill across taps from its first assignment", () => {
  const f = fixture();
  try {
    f.pour(2);
    f.pour(3);
    f.q(
      "UPDATE tap_assignment_lifecycles SET ended_at=? WHERE id=?",
      "2026-01-04T00:00:00.000Z",
      id(7),
    );
    detector.closeTelemetryEpoch(f.db, id(8), "2026-01-04T00:00:00.000Z", 2, "assignment_moved");
    f.q(
      "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
      id(9),
      id(2),
      id(5),
      "2026-01-04T00:00:00.000Z",
      at,
    );
    f.insertEpoch(id(12), id(2), id(9));
    assert.equal(f.service.getForecast(id(5)).reason, "waiting_for_measurement");
    assert.equal(f.service.getPourHistory(id(5)).pours.length, 2);
    const s = detector.readTelemetryEpochState(f.db, id(12))!;
    detector.updateTelemetryEpochState(f.db, {
      ...s,
      phase: "ready",
      lastMeasuredAtMs: Date.parse("2026-01-20T00:00:00.000Z"),
      lastStabilizedVolumeMl: 400,
      lastPublicVolumeMl: 9,
      lastDiagnosticCode: "ok",
    });
    f.pour(4, id(5), id(2), id(9), id(12));
    f.q(
      "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
      id(13),
      id(1),
      id(6),
      "2026-01-04T00:00:00.000Z",
      at,
    );
    f.insertEpoch(id(15), id(1), id(13), id(6), 1000, id(11));
    f.pour(5, id(6), id(1), id(13), id(15));
    const forecast = f.service.getForecast(id(5));
    assert.equal(forecast.observationStart, at);
    assert.equal(forecast.qualifyingPours, 3);
    assert.equal(forecast.totalVolumeMl, 300);
    assert.equal(forecast.currentVolume.kind, "available");
    if (forecast.currentVolume.kind === "available") {
      assert.equal(forecast.currentVolume.volumeMl, 400);
      assert.equal(forecast.currentVolume.provenance.tapId, id(2));
    }
  } finally {
    f.db.close();
  }
});

void test("history uses Fill attribution descending order and keysets", () => {
  const f = fixture();
  try {
    f.pour(2);
    f.pour(3);
    f.pour(4);
    const first = f.service.getPourHistory(id(5), { limit: 2 });
    assert.deepEqual(
      first.pours.map((p) => p.canonicalVolumeMl),
      [100, 100],
    );
    assert.equal(first.pours[0]?.completedAt, "2026-01-04T00:00:00.000Z");
    assert.ok(first.nextCursor);
    const cursor = decodeForecastHistoryCursor(first.nextCursor);
    assert.ok(cursor);
    const second = f.service.getPourHistory(id(5), {
      limit: 2,
      cursor,
    });
    assert.equal(second.pours.length, 1);
    assert.deepEqual(
      Object.keys(first.pours[0]).sort(),
      [
        "assignmentId",
        "canonicalVolumeMl",
        "completedAt",
        "epochId",
        "fillId",
        "pourId",
        "startedAt",
        "tapId",
      ].sort(),
    );
  } finally {
    f.db.close();
  }
});

void test("unassign and ended Fill preserve history but fail closed", () => {
  const f = fixture();
  try {
    f.pour(2);
    f.q(
      "UPDATE tap_assignment_lifecycles SET ended_at=? WHERE id=?",
      "2026-01-03T00:00:00.000Z",
      id(7),
    );
    assert.equal(f.service.getForecast(id(5)).reason, "no_active_assignment");
    assert.equal(f.service.getPourHistory(id(5)).pours.length, 1);
    f.q("UPDATE fills SET ended_at=? WHERE id=?", "2026-01-04T00:00:00.000Z", id(5));
    assert.equal(f.service.getForecast(id(5)).reason, "fill_ended");
  } finally {
    f.db.close();
  }
});

void test("forecast uses stabilized volume and rejects warning or invalid capacity", () => {
  const f = fixture();
  try {
    const available = f.service.getForecast(id(5));
    assert.equal(available.totalVolumeMl, 0);
    assert.equal(available.servingsRemaining, Math.floor(500 / available.servingSizeMl));
    assert.equal(available.currentVolume.kind, "available");
    if (available.currentVolume.kind === "available")
      assert.equal(available.currentVolume.volumeMl, 500);
    f.service.updateSettings({ servingSizeMl: 200 });
    assert.equal(f.service.getForecast(id(5)).servingsRemaining, 2);
    const state = detector.readTelemetryEpochState(f.db, id(8))!;
    detector.updateTelemetryEpochState(f.db, {
      ...state,
      phase: "warning",
      warningCode: "implausible_jump",
      warningActivityFlag: true,
      warningStartedAtMs: 1,
      warningReferenceVolumeMl: 500,
    });
    assert.equal(f.service.getForecast(id(5)).reason, "invalid_current_volume");
    detector.closeTelemetryEpoch(f.db, id(8), "2026-01-20T00:00:00.000Z", 2, "manual_rebaseline");
    f.insertEpoch(id(14), id(1), id(7), id(5), 400);
    const replacement = detector.readTelemetryEpochState(f.db, id(14))!;
    detector.updateTelemetryEpochState(f.db, {
      ...replacement,
      phase: "ready",
      lastMeasuredAtMs: Date.parse("2026-01-20T00:00:00.000Z"),
      lastStabilizedVolumeMl: 500,
      lastPublicVolumeMl: 1,
      lastDiagnosticCode: "ok",
    });
    const inconsistent = f.service.getForecast(id(5));
    assert.equal(inconsistent.reason, "capacity_inconsistency");
    assert.equal(inconsistent.currentVolume.kind, "anomaly");
    if (inconsistent.currentVolume.kind === "anomaly") {
      assert.equal(inconsistent.currentVolume.volumeMl, 500);
      assert.equal(inconsistent.currentVolume.capacityMl, 400);
      assert.equal(inconsistent.currentVolume.provenance?.epochId, id(14));
    }
  } finally {
    f.db.close();
  }
});

void test("Beverage pour-size overrides change servings only and can be cleared", () => {
  const f = fixture();
  try {
    f.pour(2);
    f.pour(3);
    f.pour(4);
    const baseline = f.service.getForecast(id(5));
    assert.deepEqual(f.service.getEffectiveServingSizeForFill(id(5)), {
      fillId: id(5),
      beverageId: id(3),
      servingSizeMl: 354.88235475,
      source: "global",
    });
    assert.equal(f.service.updateBeveragePourSetting(id(3), { pourSizeMl: 125 }).pourSizeMl, 125);
    const overridden = f.service.getForecast(id(5));
    assert.equal(overridden.servingsRemaining, 4);
    assert.deepEqual(overridden.days, baseline.days);
    assert.equal(f.service.getEffectiveServingSizeForFill(id(5)).source, "beverage");
    assert.equal(f.service.clearBeveragePourSetting(id(3)), true);
    assert.equal(f.service.clearBeveragePourSetting(id(3)), false);
    assert.equal(f.service.getForecast(id(5)).servingsRemaining, baseline.servingsRemaining);
  } finally {
    f.db.close();
  }
});

void test("public forecast omits telemetry provenance and method counts", () => {
  const f = fixture();
  try {
    const serialized = JSON.stringify(f.service.getPublicForecastSummary(id(5)));
    for (const key of [
      "currentVolume",
      "epochId",
      "tapId",
      "assignmentId",
      "sourceId",
      "raw",
      "detector",
      "bootstrapSamples",
      "validBootstrapSamples",
    ])
      assert.equal(serialized.includes(key), false);
  } finally {
    f.db.close();
  }
});

void test("successive Fills in the same physical Keg never merge history", () => {
  const f = fixture();
  try {
    f.pour(2);
    f.q(
      "UPDATE tap_assignment_lifecycles SET ended_at=?,end_reason=? WHERE id=?",
      "2026-01-03T00:00:00.000Z",
      "fill_ended",
      id(7),
    );
    detector.closeTelemetryEpoch(f.db, id(8), "2026-01-03T00:00:00.000Z", 2, "fill_ended");
    f.q(
      "UPDATE fills SET ended_at=?,end_reason=? WHERE id=?",
      "2026-01-03T00:00:00.000Z",
      "kicked",
      id(5),
    );
    f.q(
      "INSERT INTO fills (id,beverage_id,keg_id,fill_date,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      id(16),
      id(3),
      id(4),
      "2026-01-04",
      at,
      at,
    );
    f.q(
      "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
      id(17),
      id(1),
      id(16),
      "2026-01-04T00:00:00.000Z",
      at,
    );
    f.insertEpoch(id(18), id(1), id(17), id(16));
    const state = detector.readTelemetryEpochState(f.db, id(18))!;
    detector.updateTelemetryEpochState(f.db, {
      ...state,
      phase: "ready",
      lastMeasuredAtMs: Date.parse("2026-01-20T00:00:00.000Z"),
      lastStabilizedVolumeMl: 600,
      lastPublicVolumeMl: 600,
      lastDiagnosticCode: "ok",
    });
    f.pour(6, id(16), id(1), id(17), id(18));
    assert.equal(f.service.getPourHistory(id(5)).pours.length, 1);
    assert.equal(f.service.getPourHistory(id(16)).pours.length, 1);
    assert.equal(f.service.getForecast(id(5)).reason, "fill_ended");
    assert.equal(f.service.getForecast(id(16)).qualifyingPours, 1);
  } finally {
    f.db.close();
  }
});

void test("raw telemetry pruning cannot change a durable Fill forecast", () => {
  const f = fixture();
  try {
    f.pour(2);
    f.q(
      "INSERT INTO machine_api_keys (id,public_id,verification_digest,label,created_at) VALUES (?,?,?,?,?)",
      id(30),
      "pub_000000000001",
      Buffer.alloc(32),
      "Forecast source",
      at,
    );
    f.q(
      "INSERT INTO telemetry_sources (id,name,current_machine_key_id,created_at,updated_at) VALUES (?,?,?,?,?)",
      id(31),
      "Forecast source",
      id(30),
      at,
      at,
    );
    f.q(
      "INSERT INTO telemetry_measurements (id,source_id,tap_id,measured_at,measured_at_epoch_ms,received_at,normalization_version,primary_kind,remaining_volume_ml,captured_assignment_id,captured_fill_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id(32),
      id(31),
      id(1),
      "2026-01-10T00:00:00.000Z",
      Date.parse("2026-01-10T00:00:00.000Z"),
      "2026-01-10T00:00:01.000Z",
      1,
      "remaining_volume",
      500,
      id(7),
      id(5),
      "2026-01-10T00:00:01.000Z",
    );
    const before = f.service.getForecast(id(5));
    f.q("DELETE FROM telemetry_measurements WHERE id=?", id(32));
    assert.deepEqual(f.service.getForecast(id(5)), before);
  } finally {
    f.db.close();
  }
});
