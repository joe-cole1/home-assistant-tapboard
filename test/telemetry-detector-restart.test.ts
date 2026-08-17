import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fastConfig() {
  return {
    ...DEFAULT_DETECTOR_CONFIG,
    baselineSamples: 2,
    baselineSpanMs: 50,
    baselineBandMl: 2,
    candidateLossMl: 10,
    candidateSamples: 2,
    candidateSampleWindowMs: 50,
    candidateLookbackMs: 500,
    arbitrationMs: 0,
    arbitrationMinimumMl: 1,
    meaningfulFlowMl: 1,
    quietPeriodMs: 100,
    hardTimeoutMs: 500,
    minimumPourMl: 10,
    settledSamples: 1,
    settledSpanMs: 0,
    settledBandMl: 2,
    jumpStableSamples: 1,
    jumpStableSpanMs: 0,
    cooldownMs: 100,
    historyMs: 500,
  };
}

function harness(path: string, sequence = { value: 1 }) {
  let now = origin;
  const ids = () => uuid(sequence.value++);
  const database = openDatabase(path);
  const clock = () => new Date(now);
  const detector = new DetectorService(database, { idFactory: ids, now: clock });
  const machineKeyService = createMachineKeyService(database, { idFactory: ids, now: clock });
  const tapService = createTapService(database, {
    extensionPort: detector,
    idFactory: ids,
    now: clock,
  });
  const kegService = createKegService(database, {
    onKegCorrection: (db, event) => detector.onKegCorrection(db, event),
    idFactory: ids,
    now: clock,
  });
  const beverageService = createBeverageService(database, {
    densityExtensionPort: detector,
    idFactory: ids,
    now: clock,
  });
  const fillService = createFillService(database, {
    beverageService,
    assignmentPort: tapService.asFillAssignmentPort(),
    idFactory: ids,
    now: clock,
  });
  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    authorityExtensionPort: detector,
    acceptedExtensionPort: detector,
    idGenerator: ids,
    clock,
  });
  return {
    database,
    detector,
    tapService,
    kegService,
    beverageService,
    fillService,
    telemetryService,
    sequence,
    set: (ms: number) => {
      now = origin + ms;
    },
    close: () => database.close(),
  };
}
function setup(h: ReturnType<typeof harness>) {
  const tap = h.tapService.createTap({ tapNumber: 1, name: "One" });
  const keg = h.kegService.createKeg({ kegNumber: 1, capacityMl: 1000, currentTareG: 100 });
  const beverage = h.beverageService.createCustomBeverage({
    name: "Test",
    beverageType: "beer",
    fg: 1,
  });
  const fill = h.fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const source = h.telemetryService.createSource({ name: "scale" }).source;
  h.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });
  h.detector.setTapOverride(tap.id, fastConfig());
  h.set(1000);
  const assignment = h.tapService.assignFill(tap.id, { fillId: fill.id }).assignment;
  return { tap, fill, source, assignment };
}
function sample(
  h: ReturnType<typeof harness>,
  source: unknown,
  at: number,
  volume: number,
  id: string,
) {
  h.set(at);
  return h.telemetryService.ingestSingle(source as never, 1, {
    clientSampleId: id,
    measuredAt: new Date(origin + at).toISOString(),
    remainingVolume: { value: volume, unit: "ml" },
  });
}
function count(db: DatabaseConnection, table: string) {
  return db.prepare<[], { readonly n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
}
function temp() {
  const root = mkdtempSync(join("/tmp", "tapboard-detector-restart-"));
  return { root, path: join(root, "tapboard.sqlite") };
}

void test("real-file restart preserves a mid-candidate epoch and emits one immutable pour", () => {
  const f = temp();
  let h = harness(f.path);
  try {
    const { tap, fill, source, assignment } = setup(h);
    sample(h, source, 1000, 1000, "base-1");
    sample(h, source, 1050, 1000, "base-2");
    sample(h, source, 1100, 980, "fall-1");
    sample(h, source, 1150, 970, "fall-2");
    const before = h.detector.diagnostics(tap.id);
    const epoch = before.epoch!;
    const session = before.detector!.candidate!.sessionId;
    h.close();
    h = harness(f.path, h.sequence);
    const restored = h.detector.diagnostics(tap.id);
    assert.equal(restored.epoch!.id, epoch.id);
    assert.equal(restored.detector!.candidate!.sessionId, session);
    assert.equal(restored.detector!.candidate!.lossMl, before.detector!.candidate!.lossMl);
    h.detector.processDue(new Date(origin + 1300));
    const pour = h.database
      .prepare<
        [],
        {
          readonly fill_id: string;
          readonly tap_id: string;
          readonly assignment_id: string;
          readonly epoch_id: string;
          readonly canonical_volume_ml: number;
        }
      >("SELECT fill_id,tap_id,assignment_id,epoch_id,canonical_volume_ml FROM pours")
      .get()!;
    assert.deepEqual(pour, {
      fill_id: fill.id,
      tap_id: tap.id,
      assignment_id: assignment.id,
      epoch_id: epoch.id,
      canonical_volume_ml: 29.5735295625,
    });
    h.close();
    h = harness(f.path, h.sequence);
    h.detector.processDue(new Date(origin + 2000));
    assert.equal(count(h.database, "pours"), 1);
    assert.equal(
      h.database
        .prepare<[], { readonly n: number }>(
          "SELECT count(*) AS n FROM activity_log WHERE entity_type='pour'",
        )
        .get()!.n,
      1,
    );
  } finally {
    h.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

void test("overdue persisted deadline uses its logical deadline and cancels without a pour", () => {
  const f = temp();
  let h = harness(f.path);
  try {
    const { tap, source } = setup(h);
    h.detector.setTapOverride(tap.id, { ...fastConfig(), settledSamples: 3 });
    sample(h, source, 1000, 1000, "base-1");
    sample(h, source, 1050, 1000, "base-2");
    sample(h, source, 1100, 980, "fall-1");
    sample(h, source, 1150, 970, "fall-2");
    const epochId = h.detector.diagnostics(tap.id).epoch!.id;
    h.close();
    h = harness(f.path, h.sequence);
    h.detector.processDue(new Date(origin + 5000));
    const state = h.detector.diagnostics(tap.id).detector!;
    assert.equal(state.phase, "cooldown");
    assert.equal(
      h.database
        .prepare<[string], { readonly last_cancellation_reason: string | null }>(
          "SELECT last_cancellation_reason FROM telemetry_epoch_state WHERE epoch_id=?",
        )
        .get(epochId)!.last_cancellation_reason,
      "timeout",
    );
    assert.equal(count(h.database, "pours"), 0);
    assert.equal(
      h.database
        .prepare<[], { readonly n: number }>(
          "SELECT count(*) AS n FROM activity_log WHERE entity_type='pour' AND details_json LIKE '%\"transition\":\"completed\"%'",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      h.database
        .prepare<[string], { readonly ended_at: string | null }>(
          "SELECT ended_at FROM telemetry_epochs WHERE id=?",
        )
        .get(epochId)!.ended_at,
      null,
    );
  } finally {
    h.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

void test("accepted terminal persistence failure rolls receipt, measurement, status, detector, pour, and activity back", () => {
  const f = temp();
  const h = harness(f.path);
  try {
    const { tap, source } = setup(h);
    sample(h, source, 1000, 1000, "base-1");
    sample(h, source, 1050, 1000, "base-2");
    sample(h, source, 1100, 980, "fall-1");
    const before = h.detector.diagnostics(tap.id);
    const measurements = count(h.database, "telemetry_measurements");
    const activities = count(h.database, "activity_log");
    h.database.execute(
      "CREATE TRIGGER abort_epoch_sample BEFORE INSERT ON telemetry_epoch_samples WHEN NEW.measurement_id = (SELECT id FROM telemetry_measurements ORDER BY rowid DESC LIMIT 1) BEGIN SELECT RAISE(ABORT, 'test abort'); END",
    );
    assert.throws(() => sample(h, source, 1150, 970, "fall-2"), /test abort/);
    assert.equal(count(h.database, "telemetry_ingest_receipts"), 3);
    assert.equal(count(h.database, "telemetry_measurements"), measurements);
    assert.deepEqual(h.detector.diagnostics(tap.id), before);
    assert.equal(count(h.database, "pours"), 0);
    assert.equal(count(h.database, "activity_log"), activities);
    h.database.execute("DROP TRIGGER abort_epoch_sample");
    sample(h, source, 1150, 970, "fall-2");
    h.detector.processDue(new Date(origin + 1300));
    assert.equal(count(h.database, "pours"), 1);
    assert.equal(
      h.database
        .prepare<[], { readonly n: number }>(
          "SELECT count(*) AS n FROM activity_log WHERE entity_type='pour'",
        )
        .get()!.n,
      1,
    );
  } finally {
    h.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

void test("retention preserves completed pours, closed epochs never reopen, and Fill deletion cascades detector records", () => {
  const f = temp();
  const h = harness(f.path);
  try {
    const { tap, fill, source } = setup(h);
    sample(h, source, 1000, 1000, "base-1");
    sample(h, source, 1050, 1000, "base-2");
    sample(h, source, 1100, 980, "fall-1");
    sample(h, source, 1150, 970, "fall-2");
    h.detector.processDue(new Date(origin + 1300));
    const epochId = h.detector.diagnostics(tap.id).epoch!.id;
    h.telemetryService.updateSettings({
      reconnectHorizonSeconds: 3600,
      rawRetentionSeconds: 300,
      receiptRetentionSeconds: 3600,
    });
    const pruned = h.telemetryService.pruneTelemetry(new Date(origin + 400_000));
    assert.ok(pruned.prunedMeasurementsCount > 0);
    assert.equal(count(h.database, "pours"), 1);
    h.detector.processDue(new Date(origin + 500_000));
    assert.equal(count(h.database, "pours"), 1);
    h.fillService.deleteFill(fill.id, {
      reason: "cascade detector evidence",
      confirmation: "Test — Keg 1",
    });
    for (const table of [
      "telemetry_epochs",
      "telemetry_epoch_state",
      "telemetry_epoch_samples",
      "pours",
    ])
      assert.equal(count(h.database, table), 0, table);
    assert.equal(
      h.database
        .prepare<[string], { readonly n: number }>(
          "SELECT count(*) AS n FROM telemetry_epochs WHERE id=?",
        )
        .get(epochId)!.n,
      0,
    );
  } finally {
    h.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
