import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import type { TelemetrySource } from "../src/features/telemetry/types.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function harness() {
  let now = origin,
    next = 1;
  const ids = () => uuid(next++),
    clock = () => new Date(now),
    database = openDatabase(":memory:");
  const detector = new DetectorService(database, { idFactory: ids, now: clock });
  const machineKeyService = createMachineKeyService(database, { idFactory: ids, now: clock });
  const tapService = createTapService(database, {
    extensionPort: detector,
    idFactory: ids,
    now: clock,
  });
  const kegService = createKegService(database, {
    onKegCorrection: (db, e) => detector.onKegCorrection(db, e),
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
    set: (ms: number) => {
      now = origin + ms;
    },
    close: () => database.close(),
  };
}
const fast = (arbitrationMs = 0) => ({
  ...DEFAULT_DETECTOR_CONFIG,
  baselineSamples: 2,
  baselineSpanMs: 50,
  baselineBandMl: 2,
  candidateLossMl: 10,
  candidateSamples: 2,
  candidateSampleWindowMs: 50,
  candidateLookbackMs: 500,
  arbitrationMs,
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
});
function sample(
  h: ReturnType<typeof harness>,
  source: TelemetrySource,
  tap: number,
  at: number,
  volume: number,
  id: string,
) {
  h.set(at);
  return h.telemetryService.ingestSingle(source, tap, {
    clientSampleId: id,
    measuredAt: new Date(origin + at).toISOString(),
    remainingVolume: { value: volume, unit: "ml" },
  });
}
function setupTap(
  h: ReturnType<typeof harness>,
  n: number,
  source: TelemetrySource,
  config = fast(),
) {
  const tap = h.tapService.createTap({ tapNumber: n, name: `Tap ${n}` });
  const keg = h.kegService.createKeg({ kegNumber: n, capacityMl: 1_000, currentTareG: 100 });
  const beverage = h.beverageService.createCustomBeverage({
    name: `Beer ${n}`,
    beverageType: "beer",
    fg: 1,
  });
  const fill = h.fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  h.detector.setTapOverride(tap.id, config);
  h.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });
  h.tapService.assignFill(tap.id, { fillId: fill.id });
  return { tap, keg, fill };
}

void test("ungrouped Taps establish, activate, and complete overlapping pours independently", () => {
  const h = harness();
  try {
    const source = h.telemetryService.createSource({ name: "scale" }).source;
    const a = setupTap(h, 1, source),
      b = setupTap(h, 2, source);
    for (const [tap, at, volume, id] of [
      [1, 0, 1000, "a1"],
      [2, 10, 1000, "b1"],
      [1, 50, 1000, "a2"],
      [2, 60, 1000, "b2"],
      [1, 100, 970, "a3"],
      [2, 110, 965, "b3"],
      [1, 150, 960, "a4"],
      [2, 160, 950, "b4"],
    ] as const)
      sample(h, source, tap, at, volume, id);
    assert.equal(h.detector.diagnostics(a.tap.id).detector?.phase, "pouring");
    assert.equal(h.detector.diagnostics(b.tap.id).detector?.phase, "pouring");
    h.set(260);
    h.detector.processDue();
    assert.equal(
      h.database.prepare<[], { readonly n: number }>("SELECT count(*) AS n FROM pours").get()!.n,
      2,
    );
    const pours = h.database.prepare("SELECT tap_id,fill_id FROM pours ORDER BY tap_id").all() as {
      tap_id: string;
      fill_id: string;
    }[];
    assert.deepEqual(pours, [
      { tap_id: a.tap.id, fill_id: a.fill.id },
      { tap_id: b.tap.id, fill_id: b.fill.id },
    ]);
  } finally {
    h.close();
  }
});

void test("explicit arbitration selects one grouped candidate while an ungrouped Tap remains independent", () => {
  const h = harness();
  try {
    const source = h.telemetryService.createSource({ name: "scale" }).source;
    const a = setupTap(h, 1, source, fast(100)),
      b = setupTap(h, 2, source, fast(100)),
      c = setupTap(h, 3, source, fast());
    h.detector.createArbitrationGroup("shared scale", [a.tap.id, b.tap.id]);
    // Membership changes opened epochs, so establish fresh baselines afterwards.
    for (const [tap, at, volume, id] of [
      [1, 200, 1000, "a1"],
      [2, 200, 1000, "b1"],
      [3, 200, 1000, "c1"],
      [1, 250, 1000, "a2"],
      [2, 250, 1000, "b2"],
      [3, 250, 1000, "c2"],
      [1, 300, 970, "a3"],
      [2, 300, 980, "b3"],
      [3, 300, 970, "c3"],
      [1, 350, 950, "a4"],
      [2, 350, 975, "b4"],
      [3, 350, 950, "c4"],
    ] as const)
      sample(h, source, tap, at, volume, id);
    h.set(450);
    h.detector.processDue();
    assert.equal(h.detector.diagnostics(a.tap.id).detector?.phase, "pouring");
    assert.equal(h.detector.diagnostics(b.tap.id).detector?.phase, "cooldown");
    assert.equal(
      h.database
        .prepare<[string], { readonly r: string | null }>(
          "SELECT last_cancellation_reason AS r FROM telemetry_epoch_state WHERE epoch_id=?",
        )
        .get(h.detector.diagnostics(b.tap.id).epoch!.id)!.r,
      "arbitration",
    );
    assert.equal(h.detector.diagnostics(c.tap.id).detector?.phase, "cooldown");
    assert.equal(
      h.database.prepare<[], { readonly n: number }>("SELECT count(*) AS n FROM pours").get()!.n,
      1,
    );
    h.set(550);
    h.detector.processDue();
    assert.equal(
      h.database.prepare<[], { readonly n: number }>("SELECT count(*) AS n FROM pours").get()!.n,
      2,
    );
  } finally {
    h.close();
  }
});

void test("group arbitration excludes future candidates and suppresses them while a member pours", () => {
  const h = harness();
  try {
    const source = h.telemetryService.createSource({ name: "scale" }).source;
    const a = setupTap(h, 1, source, {
      ...fast(100),
      quietPeriodMs: 500,
      hardTimeoutMs: 1_000,
    });
    const b = setupTap(h, 2, source, fast(100));
    h.detector.createArbitrationGroup("shared scale", [a.tap.id, b.tap.id]);
    for (const [tap, at, volume, id] of [
      [1, 200, 1_000, "a1"],
      [2, 200, 1_000, "b1"],
      [1, 250, 1_000, "a2"],
      [2, 250, 1_000, "b2"],
      [1, 300, 970, "a3"],
      [1, 350, 950, "a4"],
      [2, 500, 970, "b3"],
      [2, 550, 950, "b4"],
    ] as const)
      sample(h, source, tap, at, volume, id);

    h.set(550);
    h.detector.processDue();
    assert.equal(h.detector.diagnostics(a.tap.id).detector?.phase, "pouring");
    assert.equal(h.detector.diagnostics(b.tap.id).detector?.phase, "candidate");

    h.set(650);
    h.detector.processDue();
    assert.equal(h.detector.diagnostics(a.tap.id).detector?.phase, "pouring");
    assert.equal(h.detector.diagnostics(b.tap.id).detector?.phase, "cooldown");
    assert.equal(
      h.database
        .prepare<[string], { readonly reason: string | null }>(
          "SELECT last_cancellation_reason AS reason FROM telemetry_epoch_state WHERE epoch_id=?",
        )
        .get(h.detector.diagnostics(b.tap.id).epoch!.id)!.reason,
      "arbitration",
    );
  } finally {
    h.close();
  }
});

void test("accepted canonical readings use epoch snapshots and retain diagnostic actuals without baselining invalid data", () => {
  const h = harness();
  try {
    const source = h.telemetryService.createSource({ name: "scale" }).source;
    const { tap, keg } = setupTap(h, 1, source);
    // This is accepted telemetry (not a detector-private injection): total weight uses the epoch tare/density.
    h.set(0);
    h.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "weight",
      measuredAt: new Date(origin).toISOString(),
      totalWeight: { value: 150, unit: "g" },
    });
    let d = h.detector.diagnostics(tap.id);
    assert.equal(d.measurement?.canonical.kind, "total_weight");
    assert.equal(d.measurement?.canonical.value, 150);
    assert.equal(d.measurement?.interpretedVolumeMl, 50);
    assert.equal(d.measurement?.publicVolumeMl, 50);
    h.set(10);
    h.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "over",
      measuredAt: new Date(origin + 10).toISOString(),
      remainingVolume: { value: 1_100, unit: "ml" },
    });
    d = h.detector.diagnostics(tap.id);
    assert.equal(d.measurement?.interpretedVolumeMl, 1100);
    assert.equal(d.measurement?.publicVolumeMl, 1000);
    assert.equal(d.measurement?.diagnosticCode, "above_capacity");
    assert.equal(d.detector?.baselineVolumeMl, null);
    const canonical = h.database
      .prepare<[string, string], { readonly kind: string; readonly value: number }>(
        "SELECT primary_kind AS kind, remaining_volume_ml AS value FROM telemetry_measurements WHERE id=(SELECT latest_measurement_id FROM telemetry_source_tap_status WHERE source_id=? AND tap_id=?)",
      )
      .get(source.id, tap.id)!;
    assert.equal(canonical.kind, "remaining_volume");
    assert.equal(canonical.value, 1100);
    h.set(20);
    h.kegService.updateKeg(keg.id, { currentTareG: 120 });
    h.set(30);
    h.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "negative",
      measuredAt: new Date(origin + 30).toISOString(),
      totalWeight: { value: 100, unit: "g" },
    });
    d = h.detector.diagnostics(tap.id);
    assert.equal(d.measurement?.interpretedVolumeMl, -20);
    assert.equal(d.measurement?.publicVolumeMl, 0);
    assert.equal(d.measurement?.diagnosticCode, "below_tare");
    assert.equal(d.detector?.baselineVolumeMl, null);
  } finally {
    h.close();
  }
});

void test("closed epoch snapshots and completed pours remain immutable after a keg transition", () => {
  const h = harness();
  try {
    const source = h.telemetryService.createSource({ name: "scale" }).source;
    const { tap, keg } = setupTap(h, 1, source);
    sample(h, source, 1, 0, 1000, "base-1");
    sample(h, source, 1, 50, 1000, "base-2");
    sample(h, source, 1, 100, 970, "flow-1");
    sample(h, source, 1, 150, 950, "flow-2");
    h.set(250);
    h.detector.processDue();
    const oldEpoch = h.detector.diagnostics(tap.id).epoch!;
    const oldCapacity = h.database
      .prepare<[string], { readonly capacity: number; readonly ended: string | null }>(
        "SELECT capacity_ml AS capacity, ended_at AS ended FROM telemetry_epochs WHERE id=?",
      )
      .get(oldEpoch.id)!;
    assert.equal(
      h.database.prepare<[], { readonly n: number }>("SELECT count(*) AS n FROM pours").get()!.n,
      1,
    );
    h.set(300);
    h.kegService.updateKeg(keg.id, { capacityMl: 900 });
    const replacement = h.detector.diagnostics(tap.id).epoch!;
    assert.notEqual(replacement.id, oldEpoch.id);
    assert.deepEqual(
      h.database
        .prepare<[string], { readonly capacity: number; readonly ended: string | null }>(
          "SELECT capacity_ml AS capacity, ended_at AS ended FROM telemetry_epochs WHERE id=?",
        )
        .get(oldEpoch.id)!,
      { capacity: oldCapacity.capacity, ended: new Date(origin + 300).toISOString() },
    );
    assert.throws(() =>
      h.database.prepare("UPDATE telemetry_epochs SET capacity_ml=1 WHERE id=?").run(oldEpoch.id),
    );
    assert.throws(() => h.database.prepare("UPDATE pours SET canonical_volume_ml=1").run());
  } finally {
    h.close();
  }
});
