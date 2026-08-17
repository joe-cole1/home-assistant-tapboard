import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import { waitingDetectorState } from "../src/features/telemetry/detector.ts";
import * as detector from "../src/features/telemetry/repositories/detector.ts";
import { findFirstAssignmentByFillId } from "../src/features/taps/repository.ts";
import * as settings from "../src/features/forecasting/repository.ts";
import {
  decodeForecastHistoryCursor,
  encodeForecastHistoryCursor,
  validateBeverageId,
  validateForecastHistoryLimit,
  validateUpdateBeveragePourSettingInput,
  validateUpdateForecastSettingsInput,
} from "../src/features/forecasting/forecast-validation.ts";
import type { CreateTelemetryEpoch } from "../src/features/telemetry/epoch-types.ts";

const iso = "2026-01-01T00:00:00.000Z";
const ids = {
  tap: "00000000-0000-4000-8000-000000000001",
  tap2: "00000000-0000-4000-8000-000000000002",
  beverage: "00000000-0000-4000-8000-000000000003",
  keg: "00000000-0000-4000-8000-000000000004",
  fill: "00000000-0000-4000-8000-000000000005",
  otherFill: "00000000-0000-4000-8000-000000000006",
  assignment: "00000000-0000-4000-8000-000000000007",
};

function fixture() {
  const root = mkdtempSync(join("/tmp", "tapboard-forecast-"));
  const db = openDatabase(join(root, "tapboard.sqlite"));
  const q = (sql: string, ...values: unknown[]) => db.prepare<unknown[]>(sql).run(...values);
  q(
    "INSERT INTO taps (id,tap_number,enabled,created_at,updated_at) VALUES (?,?,?,?,?)",
    ids.tap,
    1,
    1,
    iso,
    iso,
  );
  q(
    "INSERT INTO taps (id,tap_number,enabled,created_at,updated_at) VALUES (?,?,?,?,?)",
    ids.tap2,
    2,
    1,
    iso,
    iso,
  );
  q(
    "INSERT INTO beverages (id,ownership_type,created_at,updated_at) VALUES (?,?,?,?)",
    ids.beverage,
    "custom",
    iso,
    iso,
  );
  q(
    "INSERT INTO kegs (id,keg_number,capacity_ml,current_tare_g,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ids.keg,
    1,
    19000,
    4000,
    iso,
    iso,
  );
  q(
    "INSERT INTO fills (id,beverage_id,keg_id,fill_date,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ids.fill,
    ids.beverage,
    ids.keg,
    "2026-01-01",
    iso,
    iso,
  );
  q(
    "INSERT INTO fills (id,beverage_id,keg_id,fill_date,ended_at,end_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ids.otherFill,
    ids.beverage,
    ids.keg,
    "2026-01-02",
    iso,
    "fixture",
    iso,
    iso,
  );
  q(
    "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
    ids.assignment,
    ids.tap,
    ids.fill,
    iso,
    iso,
  );
  return {
    db,
    q,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function insertEpoch(
  db: ReturnType<typeof fixture>["db"],
  id = "00000000-0000-4000-8000-000000000008",
) {
  const epoch: CreateTelemetryEpoch = {
    id,
    tapId: ids.tap,
    sourceId: null,
    fillId: ids.fill,
    assignmentId: ids.assignment,
    kegId: ids.keg,
    capacityMl: 19000,
    tareG: 4000,
    densityGPerMl: 1.01,
    densitySource: "fallback_fg",
    normalizationVersion: 1,
    detectorConfigVersion: "1:none",
    globalConfigRevision: 1,
    tapOverrideRevision: null,
    arbitrationGroupId: null,
    config: DEFAULT_DETECTOR_CONFIG,
    startedAt: iso,
    startedAtEpochMs: 1,
  };
  detector.insertTelemetryEpoch(db, epoch);
  detector.createInitialTelemetryEpochState(db, id, iso);
  return epoch;
}

function insertPour(
  db: ReturnType<typeof fixture>["db"],
  epochId: string,
  id: string,
  completedAt: string,
  fillId = ids.fill,
) {
  detector.insertCompletedPourIdempotently(db, {
    id,
    effectKey: `effect-${id}`,
    fillId,
    tapId: ids.tap,
    assignmentId: ids.assignment,
    epochId,
    detectorSessionId: `session-${id}`,
    canonicalVolumeMl: 100,
    startedAt: completedAt,
    completedAt,
    createdAt: completedAt,
  });
}

void test("forecast settings seed exactly and updates avoid semantic no-ops", () => {
  const f = fixture();
  try {
    assert.equal(settings.readForecastSettings(f.db).servingSizeMl, 354.88235475);
    assert.equal(settings.updateForecastServingSize(f.db, 354.88235475, "later").changed, false);
    const changed = settings.updateForecastServingSize(f.db, 355, "later");
    assert.equal(changed.changed, true);
    assert.equal(changed.previous.servingSizeMl, 354.88235475);
    assert.equal(changed.current.servingSizeMl, 355);
  } finally {
    f.close();
  }
});

void test("forecast validators strictly bound PATCH, history limits, and cursors", () => {
  assert.deepEqual(validateUpdateForecastSettingsInput({ servingSizeMl: 1 }), { servingSizeMl: 1 });
  for (const value of [
    {},
    { servingSizeMl: 1, extra: true },
    { servingSizeMl: 0 },
    { servingSizeMl: -1 },
    { servingSizeMl: Infinity },
    { servingSizeMl: NaN },
  ])
    assert.throws(() => validateUpdateForecastSettingsInput(value));
  assert.equal(validateForecastHistoryLimit(undefined), 50);
  assert.equal(validateForecastHistoryLimit(200), 200);
  assert.throws(() => validateForecastHistoryLimit(201));
  const cursor = { completedAt: iso, id: ids.fill };
  assert.deepEqual(decodeForecastHistoryCursor(encodeForecastHistoryCursor(cursor)), cursor);
  const offsetCursor = encodeForecastHistoryCursor({
    ...cursor,
    completedAt: "2025-12-31T19:00:00-05:00",
  });
  for (const value of ["%%%", "eyJjb21wbGV0ZWRBdCI6ImJhZCIsImlkIjoieCJ9", "e30", "A", offsetCursor])
    assert.throws(() => decodeForecastHistoryCursor(value));
});

void test("Beverage pour settings persist canonical overrides and fall back to global serving size", () => {
  const f = fixture();
  try {
    assert.deepEqual(settings.readEffectiveServingSizeForBeverage(f.db, ids.beverage), {
      servingSizeMl: 354.88235475,
      source: "global",
    });
    assert.equal(validateBeverageId(ids.beverage), ids.beverage);
    assert.deepEqual(validateUpdateBeveragePourSettingInput({ pourSizeMl: 147.86 }), {
      pourSizeMl: 147.86,
    });
    for (const value of [
      {},
      { pourSizeMl: 0 },
      { pourSizeMl: Infinity },
      { pourSizeMl: 1, extra: true },
      { pourSizeMl: "147.86" },
    ])
      assert.throws(() => validateUpdateBeveragePourSettingInput(value));
    const first = settings.updateBeveragePourSetting(
      f.db,
      ids.beverage,
      147.86,
      "2026-01-02T00:00:00.000Z",
    );
    assert.equal(first.changed, true);
    assert.equal(first.current?.pourSizeMl, 147.86);
    assert.deepEqual(settings.readEffectiveServingSizeForBeverage(f.db, ids.beverage), {
      servingSizeMl: 147.86,
      source: "beverage",
    });
    assert.equal(
      settings.updateBeveragePourSetting(f.db, ids.beverage, 147.86, "later").changed,
      false,
    );
    assert.equal(settings.deleteBeveragePourSetting(f.db, ids.beverage), true);
    assert.deepEqual(settings.readEffectiveServingSizeForBeverage(f.db, ids.beverage), {
      servingSizeMl: 354.88235475,
      source: "global",
    });
  } finally {
    f.close();
  }
});

void test("Fill history reads preserve attribution, deterministic order, keysets, isolation, and deletion cascade", () => {
  const f = fixture();
  try {
    const epoch = insertEpoch(f.db);
    insertPour(f.db, epoch.id, "00000000-0000-4000-8000-000000000010", "2026-01-03T00:00:00.000Z");
    insertPour(f.db, epoch.id, "00000000-0000-4000-8000-000000000009", "2026-01-03T00:00:00.000Z");
    insertPour(f.db, epoch.id, "00000000-0000-4000-8000-000000000011", "2026-01-02T00:00:00.000Z");
    assert.deepEqual(
      detector.listCompletedPoursForFill(f.db, ids.fill).map((x) => x.id),
      [
        "00000000-0000-4000-8000-000000000011",
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-000000000010",
      ],
    );
    const page = detector.listCompletedPourHistoryPageForFill(f.db, ids.fill, 2);
    assert.deepEqual(
      page.map((x) => x.id),
      [
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000009",
        "00000000-0000-4000-8000-000000000011",
      ],
    );
    assert.deepEqual(
      detector.listCompletedPourHistoryPageForFill(f.db, ids.fill, 2, page[1]).map((x) => x.id),
      ["00000000-0000-4000-8000-000000000011"],
    );
    detector.closeTelemetryEpoch(f.db, epoch.id, "2026-01-04T00:00:00.000Z", 2, "fill_ended");
    f.q(
      "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
      "00000000-0000-4000-8000-000000000012",
      ids.tap2,
      ids.otherFill,
      iso,
      iso,
    );
    const other = {
      ...epoch,
      id: "00000000-0000-4000-8000-000000000013",
      tapId: ids.tap2,
      fillId: ids.otherFill,
      assignmentId: "00000000-0000-4000-8000-000000000012",
      startedAtEpochMs: 3,
    };
    detector.insertTelemetryEpoch(f.db, other);
    detector.createInitialTelemetryEpochState(f.db, other.id, iso);
    insertPour(
      f.db,
      other.id,
      "00000000-0000-4000-8000-000000000014",
      "2026-01-04T00:00:00.000Z",
      ids.otherFill,
    );
    assert.deepEqual(
      detector.listCompletedPourHistoryPageForFill(f.db, ids.otherFill, 2).map((x) => x.id),
      ["00000000-0000-4000-8000-000000000014"],
    );
    assert.throws(
      () =>
        f.q(
          "UPDATE pours SET canonical_volume_ml=101 WHERE id=?",
          "00000000-0000-4000-8000-000000000010",
        ),
      /pours are immutable/,
    );
    f.q("DELETE FROM fills WHERE id=?", ids.fill);
    assert.equal(
      f.db
        .prepare<[string], { count: number }>("SELECT count(*) AS count FROM pours WHERE fill_id=?")
        .get(ids.fill)?.count,
      0,
    );
  } finally {
    f.close();
  }
});

void test("first assignment survives moves and the current Fill state exposes internal stabilized volume", () => {
  const f = fixture();
  try {
    f.q(
      "UPDATE tap_assignment_lifecycles SET ended_at=?,end_reason=? WHERE id=?",
      "2026-01-02T00:00:00.000Z",
      "moved",
      ids.assignment,
    );
    f.q(
      "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
      "00000000-0000-4000-8000-000000000012",
      ids.tap2,
      ids.fill,
      iso,
      iso,
    );
    assert.equal(findFirstAssignmentByFillId(f.db, ids.fill)?.id, ids.assignment);
    const epoch = insertEpoch(f.db);
    const state = {
      ...waitingDetectorState(),
      epochId: epoch.id,
      lastMeasurementId: null,
      lastPrimaryKind: null,
      lastPrimaryValue: null,
      lastTemperatureC: null,
      lastPublicVolumeMl: 99,
      lastDiagnosticCode: null,
      lastStabilizedVolumeMl: 123,
      updatedAt: iso,
    };
    detector.updateTelemetryEpochState(f.db, state);
    assert.equal(
      detector.readOpenTelemetryEpochStateForFill(f.db, ids.fill)?.state.lastStabilizedVolumeMl,
      123,
    );
  } finally {
    f.close();
  }
});
