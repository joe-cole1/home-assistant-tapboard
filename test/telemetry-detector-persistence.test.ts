import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import * as repo from "../src/features/telemetry/repositories/detector.ts";
import { waitingDetectorState } from "../src/features/telemetry/detector.ts";
import type { CreateTelemetryEpoch } from "../src/features/telemetry/epoch-types.ts";

const iso = "2026-01-01T00:00:00.000Z";
const ids = {
  tap: "00000000-0000-4000-8000-000000000001",
  tap2: "00000000-0000-4000-8000-000000000002",
  beverage: "00000000-0000-4000-8000-000000000003",
  keg: "00000000-0000-4000-8000-000000000004",
  fill: "00000000-0000-4000-8000-000000000005",
  assignment: "00000000-0000-4000-8000-000000000006",
};
function fixture() {
  const root = mkdtempSync(join("/tmp", "tapboard-detector-"));
  const path = join(root, "tapboard.sqlite");
  const db = openDatabase(path);
  const q = (sql: string, ...p: unknown[]) => db.prepare<unknown[]>(sql).run(...p);
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
    "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
    ids.assignment,
    ids.tap,
    ids.fill,
    iso,
    iso,
  );
  return {
    db,
    path,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function epoch(id = "epoch-1", tapId = ids.tap, startedAtEpochMs = 1000): CreateTelemetryEpoch {
  return {
    id,
    tapId,
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
    startedAtEpochMs,
  };
}
function waiting(epochId: string) {
  return {
    ...waitingDetectorState(),
    epochId,
    lastMeasurementId: null,
    lastPrimaryKind: null,
    lastPrimaryValue: null,
    lastTemperatureC: null,
    lastPublicVolumeMl: null,
    lastDiagnosticCode: null,
    updatedAt: iso,
  };
}

void test("global defaults seed exactly, revisions change only effectively, and persist", () => {
  const f = fixture();
  try {
    const seeded = repo.readDetectorGlobalConfig(f.db);
    assert.deepEqual(seeded.config, DEFAULT_DETECTOR_CONFIG);
    assert.equal(seeded.revision, 1);
    assert.equal(repo.updateDetectorGlobalConfig(f.db, seeded.config, "later").revision, 1);
    const changed = { ...seeded.config, quietPeriodMs: 6000 };
    assert.equal(repo.updateDetectorGlobalConfig(f.db, changed, "later").revision, 2);
    f.db.close();
    const reopened = openDatabase(f.path);
    assert.deepEqual(repo.readDetectorGlobalConfig(reopened).config, changed);
    reopened.close();
  } finally {
    rmSync(join(f.path, ".."), { recursive: true, force: true });
  }
});
void test("tap overrides merge nullable fields, revision only on change, and remove", () => {
  const f = fixture();
  try {
    assert.equal(
      repo.upsertDetectorTapOverride(f.db, ids.tap, { quietPeriodMs: 9000 }, iso).revision,
      1,
    );
    assert.equal(repo.resolveEffectiveDetectorConfig(f.db, ids.tap).config.quietPeriodMs, 9000);
    assert.equal(
      repo.upsertDetectorTapOverride(f.db, ids.tap, { quietPeriodMs: 9000 }, "later").revision,
      1,
    );
    assert.equal(
      repo.upsertDetectorTapOverride(
        f.db,
        ids.tap,
        { quietPeriodMs: null, candidateSamples: 4 },
        "later",
      ).revision,
      2,
    );
    assert.equal(
      repo.resolveEffectiveDetectorConfig(f.db, ids.tap).config.quietPeriodMs,
      DEFAULT_DETECTOR_CONFIG.quietPeriodMs,
    );
    assert.equal(repo.removeDetectorTapOverride(f.db, ids.tap), true);
  } finally {
    f.close();
  }
});
void test("arbitration membership is explicit, ordered, one group per tap, and replacement rolls back", () => {
  const f = fixture();
  try {
    for (const [id, name] of [
      ["g2", "zeta"],
      ["g1", "Alpha"],
    ] as const)
      repo.insertDetectorArbitrationGroup(f.db, { id, name, createdAt: iso, updatedAt: iso });
    assert.deepEqual(
      repo.listDetectorArbitrationGroups(f.db).map((x) => x.id),
      ["g1", "g2"],
    );
    repo.replaceDetectorArbitrationMembership(f.db, "g1", [ids.tap, ids.tap2], iso);
    assert.throws(() => repo.replaceDetectorArbitrationMembership(f.db, "g2", [ids.tap], iso));
    assert.deepEqual(
      repo.listDetectorArbitrationMembers(f.db, "g1").map((x) => x.tapId),
      [ids.tap, ids.tap2],
    );
  } finally {
    f.close();
  }
});
void test("epochs snapshot provenance/config, begin waiting, and allow only one open tap epoch", () => {
  const f = fixture();
  try {
    repo.insertDetectorArbitrationGroup(f.db, {
      id: "g1",
      name: "one",
      createdAt: iso,
      updatedAt: iso,
    });
    const e = {
      ...epoch(),
      arbitrationGroupId: "g1",
      tapOverrideRevision: 3,
      detectorConfigVersion: "2:3",
      config: { ...DEFAULT_DETECTOR_CONFIG, historyMs: 7000 },
    };
    repo.insertTelemetryEpoch(f.db, e);
    repo.createInitialTelemetryEpochState(f.db, e.id, iso);
    assert.deepEqual(repo.readTelemetryEpoch(f.db, e.id), {
      ...e,
      endedAt: null,
      endedAtEpochMs: null,
      closeReason: null,
    });
    assert.deepEqual(repo.readTelemetryEpochState(f.db, e.id), waiting(e.id));
    assert.throws(() =>
      repo.insertTelemetryEpoch(f.db, { ...epoch("epoch-2"), startedAtEpochMs: 2000 }),
    );
  } finally {
    f.close();
  }
});
void test("epoch context is immutable and close is one-way", () => {
  const f = fixture();
  try {
    repo.insertTelemetryEpoch(f.db, epoch());
    assert.equal(
      repo.closeTelemetryEpoch(
        f.db,
        "epoch-1",
        "2026-01-01T00:01:00.000Z",
        2000,
        "manual_rebaseline",
      ),
      true,
    );
    assert.equal(repo.closeTelemetryEpoch(f.db, "epoch-1", iso, 3000, "manual_rebaseline"), false);
    assert.throws(() =>
      f.db.prepare("UPDATE telemetry_epochs SET capacity_ml=1 WHERE id=?").run("epoch-1"),
    );
    assert.throws(() =>
      f.db
        .prepare(
          "UPDATE telemetry_epochs SET ended_at=NULL,ended_at_epoch_ms=NULL,close_reason=NULL WHERE id=?",
        )
        .run("epoch-1"),
    );
  } finally {
    f.close();
  }
});
void test("candidate and warning epoch states persist independently across reopen", () => {
  const f = fixture();
  try {
    repo.insertTelemetryEpoch(f.db, epoch());
    repo.createInitialTelemetryEpochState(f.db, "epoch-1", iso);
    const s = {
      ...waiting("epoch-1"),
      phase: "candidate" as const,
      baselineVolumeMl: 100,
      baselineAtMs: 1000,
      lastMeasuredAtMs: 1200,
      candidateSessionId: "session",
      candidateStartedAtMs: 1100,
      candidateBaselineVolumeMl: 100,
      candidateLossMl: 30,
      arbitrationDeadlineMs: 1500,
    };
    repo.updateTelemetryEpochState(f.db, s);
    f.db.close();
    let reopened = openDatabase(f.path);
    assert.deepEqual(repo.readTelemetryEpochState(reopened, "epoch-1"), s);
    const warning = {
      ...waiting("epoch-1"),
      phase: "warning" as const,
      baselineVolumeMl: 100,
      baselineAtMs: 1000,
      lastMeasuredAtMs: 1300,
      warningCode: "implausible_jump" as const,
      warningActivityFlag: true,
      warningStartedAtMs: 1300,
      warningReferenceVolumeMl: 100,
    };
    repo.updateTelemetryEpochState(reopened, warning);
    reopened.close();
    reopened = openDatabase(f.path);
    assert.deepEqual(repo.readTelemetryEpochState(reopened, "epoch-1"), warning);
    reopened.close();
  } finally {
    rmSync(join(f.path, ".."), { recursive: true, force: true });
  }
});
void test("samples order and prune independently, while completed pours are idempotent and immutable", () => {
  const f = fixture();
  try {
    repo.insertTelemetryEpoch(f.db, epoch());
    for (const [id, at] of [
      ["m2", 200],
      ["m1", 100],
      ["m3", 300],
    ] as const)
      repo.insertTelemetryEpochSample(f.db, {
        epochId: "epoch-1",
        measurementId: id,
        measuredAtEpochMs: at,
        interpretedVolumeMl: at,
      });
    assert.deepEqual(
      repo.listTelemetryEpochSamples(f.db, "epoch-1").map((x) => x.measurementId),
      ["m1", "m2", "m3"],
    );
    assert.equal(repo.pruneTelemetryEpochSamples(f.db, "epoch-1", 250), 2);
    const p = {
      id: "pour-1",
      effectKey: "effect",
      fillId: ids.fill,
      tapId: ids.tap,
      assignmentId: ids.assignment,
      epochId: "epoch-1",
      detectorSessionId: "session",
      canonicalVolumeMl: 100,
      startedAt: iso,
      completedAt: iso,
      createdAt: iso,
    };
    assert.equal(repo.insertCompletedPourIdempotently(f.db, p).created, true);
    assert.equal(repo.insertCompletedPourIdempotently(f.db, { ...p, id: "other" }).created, false);
    assert.throws(() =>
      f.db.prepare("UPDATE pours SET canonical_volume_ml=2 WHERE id=?").run(p.id),
    );
  } finally {
    f.close();
  }
});
void test("fill deletion cascades epochs state samples and pours", () => {
  const f = fixture();
  try {
    repo.insertTelemetryEpoch(f.db, epoch());
    repo.createInitialTelemetryEpochState(f.db, "epoch-1", iso);
    repo.insertTelemetryEpochSample(f.db, {
      epochId: "epoch-1",
      measurementId: "m",
      measuredAtEpochMs: 1,
      interpretedVolumeMl: 1,
    });
    repo.insertCompletedPourIdempotently(f.db, {
      id: "p",
      effectKey: "e",
      fillId: ids.fill,
      tapId: ids.tap,
      assignmentId: ids.assignment,
      epochId: "epoch-1",
      detectorSessionId: "s",
      canonicalVolumeMl: 1,
      startedAt: iso,
      completedAt: iso,
      createdAt: iso,
    });
    f.db.prepare("DELETE FROM fills WHERE id=?").run(ids.fill);
    for (const table of [
      "telemetry_epochs",
      "telemetry_epoch_state",
      "telemetry_epoch_samples",
      "pours",
    ])
      assert.equal(
        (f.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count,
        0,
      );
  } finally {
    f.close();
  }
});
void test("due states are deterministically bounded and group candidates explicit", () => {
  const f = fixture();
  try {
    repo.insertDetectorArbitrationGroup(f.db, {
      id: "g",
      name: "g",
      createdAt: iso,
      updatedAt: iso,
    });
    f.db.withTransaction(() => {
      for (let i = 0; i < 501; i++) {
        const id = `e${i}`,
          tapId = `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`;
        f.db
          .prepare(
            "INSERT INTO taps (id,tap_number,enabled,created_at,updated_at) VALUES (?,?,?,?,?)",
          )
          .run(tapId, i + 100, 1, iso, iso);
        repo.insertTelemetryEpoch(f.db, { ...epoch(id, tapId, i), arbitrationGroupId: "g" });
        repo.createInitialTelemetryEpochState(f.db, id, iso);
        repo.updateTelemetryEpochState(f.db, {
          ...waiting(id),
          phase: "candidate",
          baselineVolumeMl: 100,
          baselineAtMs: 0,
          candidateSessionId: id,
          candidateStartedAtMs: i,
          candidateBaselineVolumeMl: 100,
          candidateLossMl: 40,
          arbitrationDeadlineMs: 10,
        });
        if (i === 0) repo.closeTelemetryEpoch(f.db, id, iso, 20, "manual_rebaseline");
      }
    });
    const due = repo.listDueDetectorStates(f.db, 10);
    assert.equal(due.length, 500);
    assert.deepEqual(
      due.slice(0, 2).map((x) => x.epoch.id),
      ["e1", "e10"],
    );
    assert.equal(repo.listOpenCandidateDetectorStatesForGroup(f.db, "g").length, 500);
  } finally {
    f.close();
  }
});
void test("schema config constraints reject invalid types and bounds", () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.db.prepare("UPDATE detector_global_config SET candidate_samples=0 WHERE id=1").run(),
    );
    assert.throws(() =>
      f.db.prepare("UPDATE detector_global_config SET history_ms='bad' WHERE id=1").run(),
    );
  } finally {
    f.close();
  }
});
