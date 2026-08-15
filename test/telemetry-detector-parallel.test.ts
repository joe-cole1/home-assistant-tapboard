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
import {
  laterIdleFalsePositiveTrace,
  oscillatingPourTrace,
  slowPourTrace,
  tap2Trace2035,
  tap2Trace2046,
  type TelemetryPourTrace,
} from "./fixtures/telemetry-pour-traces.ts";

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
  capacityMl = 1_000,
) {
  const tap = h.tapService.createTap({ tapNumber: n, name: `Tap ${n}` });
  const keg = h.kegService.createKeg({ kegNumber: n, capacityMl, currentTareG: 100 });
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

const historicalConfig = (override: Partial<typeof DEFAULT_DETECTOR_CONFIG> = {}) => ({
  ...DEFAULT_DETECTOR_CONFIG,
  ...override,
});

function replayUsFloz(
  h: ReturnType<typeof harness>,
  source: TelemetrySource,
  trace: TelemetryPourTrace,
  offset: number,
  label: string,
) {
  for (const [at, tap, volume] of trace) {
    const timestamp = offset + at;
    h.set(timestamp);
    h.telemetryService.ingestSingle(source, tap, {
      clientSampleId: `${label}-${tap}-${at}`,
      measuredAt: new Date(origin + timestamp).toISOString(),
      remainingVolume: { value: volume, unit: "us_fl_oz" },
    });
  }
}

function feedFlatUsFloz(
  h: ReturnType<typeof harness>,
  source: TelemetrySource,
  tap: number,
  volume: number,
  start: number,
  end: number,
  label: string,
) {
  for (let at = start; at <= end; at += 200) replayUsFloz(h, source, [[at, tap, volume]], 0, label);
}

function establishHistoricalBaseline(
  h: ReturnType<typeof harness>,
  source: TelemetrySource,
  tap: number,
  volume: number,
  offset: number,
  label: string,
) {
  feedFlatUsFloz(h, source, tap, volume, offset - 1_000, offset - 200, label);
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

for (const scenario of [
  {
    name: "terminal before arbitration with reversed epoch creation",
    groupOrder: "b-first",
    bSamples: [400, 450] as const,
    expectedBPour: true,
  },
  {
    name: "arbitration before terminal with forward epoch creation",
    groupOrder: "a-first",
    bSamples: [200, 250] as const,
    expectedBPour: false,
  },
  {
    name: "terminal wins an equal-deadline tie",
    groupOrder: "b-first",
    bSamples: [350, 400] as const,
    expectedBPour: true,
  },
] as const) {
  void test(`grouped overdue recovery orders ${scenario.name}`, () => {
    const h = harness();
    try {
      const source = h.telemetryService.createSource({ name: "ordered scale" }).source;
      const groupConfig = { ...fast(100), quietPeriodMs: 200, hardTimeoutMs: 1_000 };
      const a = setupTap(h, 1, source, groupConfig),
        b = setupTap(h, 2, source, groupConfig);
      h.detector.createArbitrationGroup(
        "ordered group",
        scenario.groupOrder === "a-first" ? [a.tap.id, b.tap.id] : [b.tap.id, a.tap.id],
      );
      for (const [tap, at, volume, id] of [
        [1, 0, 1_000, "a-base-1"],
        [2, 0, 1_000, "b-base-1"],
        [1, 50, 1_000, "a-base-2"],
        [2, 50, 1_000, "b-base-2"],
        [1, 100, 970, "a-flow-1"],
        [1, 150, 950, "a-flow-2"],
        [2, scenario.bSamples[0], 970, "b-flow-1"],
        [2, scenario.bSamples[1], 950, "b-flow-2"],
      ] as const)
        sample(h, source, tap, at, volume, id);
      h.set(250);
      h.detector.processDue();
      assert.equal(h.detector.diagnostics(a.tap.id).detector?.phase, "pouring");
      sample(h, source, 1, 300, 950, "a-settled");

      h.set(1_000);
      h.detector.processDue();
      assert.equal(h.detector.diagnostics(b.tap.id).detector?.phase, "cooldown");
      const pours = h.database
        .prepare<[], { readonly tap_id: string; readonly completed_at: string }>(
          "SELECT tap_id,completed_at FROM pours ORDER BY completed_at,tap_id",
        )
        .all();
      assert.deepEqual(
        pours,
        scenario.expectedBPour
          ? [
              { tap_id: a.tap.id, completed_at: new Date(origin + 500).toISOString() },
              {
                tap_id: b.tap.id,
                completed_at: new Date(origin + scenario.bSamples[1] + 300).toISOString(),
              },
            ]
          : [{ tap_id: a.tap.id, completed_at: new Date(origin + 500).toISOString() }],
      );
      if (!scenario.expectedBPour)
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
}

for (const [label, trace] of [
  ["20:35", tap2Trace2035],
  ["20:46", tap2Trace2046],
] as const) {
  void test(`historical v1 ${label} coupled trace selects tap 2 without a paired false pour`, () => {
    const h = harness();
    try {
      const source = h.telemetryService.createSource({ name: "historical scale" }).source;
      const a = setupTap(h, 1, source, historicalConfig(), 20_000);
      const b = setupTap(h, 2, source, historicalConfig(), 20_000);
      h.detector.createArbitrationGroup("historical coupled scale", [a.tap.id, b.tap.id]);
      const offset = 10_000;
      establishHistoricalBaseline(h, source, 1, trace[0]![2], offset, `${label}-a-baseline`);
      establishHistoricalBaseline(h, source, 2, trace[1]![2], offset, `${label}-b-baseline`);
      replayUsFloz(h, source, trace, offset, `historical-${label}`);
      const tailStart = label === "20:35" ? 1_600 : 1_800,
        tailEnd = label === "20:35" ? 5_800 : 6_200,
        tailVolume = label === "20:35" ? 613.3 : 609.36,
        completionAt = label === "20:35" ? 6_600 : 6_400;
      feedFlatUsFloz(
        h,
        source,
        2,
        tailVolume,
        offset + tailStart,
        offset + tailEnd,
        `${label}-tail`,
      );
      h.set(offset + completionAt);
      h.detector.processDue();

      const pours = h.database
        .prepare<[], { readonly tap_id: string; readonly fill_id: string }>(
          "SELECT tap_id, fill_id FROM pours ORDER BY tap_id",
        )
        .all();
      assert.deepEqual(pours, [{ tap_id: b.tap.id, fill_id: b.fill.id }]);
      assert.equal(
        pours.some((pour) => pour.tap_id === a.tap.id),
        false,
      );
    } finally {
      h.close();
    }
  });
}

void test("historical later idle trace does not create a false pour", () => {
  const h = harness();
  try {
    const source = h.telemetryService.createSource({ name: "historical scale" }).source;
    const { tap } = setupTap(h, 2, source, historicalConfig(), 20_000);
    const offset = 20_000;
    establishHistoricalBaseline(
      h,
      source,
      2,
      laterIdleFalsePositiveTrace[0]![2],
      offset,
      "later-idle-baseline",
    );
    replayUsFloz(h, source, laterIdleFalsePositiveTrace, offset, "later-idle");
    h.set(offset + laterIdleFalsePositiveTrace.at(-1)![0] + 1_500);
    h.detector.processDue();
    assert.equal(
      h.database.prepare<[], { readonly n: number }>("SELECT count(*) AS n FROM pours").get()!.n,
      0,
    );
    assert.notEqual(h.detector.diagnostics(tap.id).detector?.phase, "pouring");
  } finally {
    h.close();
  }
});

for (const [label, trace] of [
  ["oscillating", oscillatingPourTrace],
  ["slow", slowPourTrace],
] as const) {
  void test(`historical ${label} pour trace detects and completes a pour`, () => {
    const h = harness();
    try {
      const source = h.telemetryService.createSource({ name: "historical scale" }).source;
      const config =
        label === "oscillating"
          ? historicalConfig({ candidateSamples: 2, candidateSampleWindowMs: 500 })
          : historicalConfig({ candidateSamples: 2, candidateSampleWindowMs: 1_000 });
      const { tap, fill } = setupTap(h, 1, source, config, 20_000);
      const offset = 30_000;
      establishHistoricalBaseline(h, source, 1, trace[0]![2], offset, `${label}-baseline`);
      replayUsFloz(h, source, trace, offset, label);
      const tailStart = label === "oscillating" ? 2_000 : 4_200,
        tailEnd = label === "oscillating" ? 5_600 : 5_000,
        completionAt = label === "oscillating" ? 5_800 : 9_200;
      feedFlatUsFloz(
        h,
        source,
        1,
        trace.at(-1)![2],
        offset + tailStart,
        offset + tailEnd,
        `${label}-tail`,
      );
      h.set(offset + completionAt);
      h.detector.processDue();
      const pour = h.database
        .prepare<[], { readonly tap_id: string; readonly fill_id: string }>(
          "SELECT tap_id, fill_id FROM pours",
        )
        .get();
      assert.deepEqual(pour, { tap_id: tap.id, fill_id: fill.id });
      assert.equal(h.detector.diagnostics(tap.id).detector?.phase, "cooldown");
    } finally {
      h.close();
    }
  });
}

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
