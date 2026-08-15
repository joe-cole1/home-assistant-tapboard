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
import { openDatabase } from "../src/infrastructure/database/connection.ts";

const origin = Date.parse("2026-01-01T00:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function harness() {
  let now = origin;
  let nextId = 1;
  const ids = () => uuid(nextId++);
  const clock = () => new Date(now);
  const database = openDatabase(":memory:");
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
  // This is deliberately the production extension seam: density updates must
  // close/open detector epochs in the same database transaction.
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

function setup(h: ReturnType<typeof harness>) {
  const tap = h.tapService.createTap({ tapNumber: 1, name: "One" });
  const keg = h.kegService.createKeg({ kegNumber: 1, capacityMl: 1_000, currentTareG: 100 });
  const beverage = h.beverageService.createCustomBeverage({
    name: "Test beer",
    beverageType: "beer",
    fg: 1.0,
  });
  const fill = h.fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const source = h.telemetryService.createSource({ name: "scale" }).source;
  h.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });
  return { tap, keg, beverage, fill, source };
}

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
function sample(
  h: ReturnType<typeof harness>,
  source: unknown,
  at: number,
  volume: number,
  id: string,
  tapNumber = 1,
) {
  h.set(at);
  return h.telemetryService.ingestSingle(source as never, tapNumber, {
    clientSampleId: id,
    measuredAt: new Date(origin + at).toISOString(),
    remainingVolume: { value: volume, unit: "ml" },
  });
}
function count(h: ReturnType<typeof harness>, table: "telemetry_epochs" | "pours") {
  return h.database.prepare<[], { readonly n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!
    .n;
}
function activityCount(h: ReturnType<typeof harness>, entityType: string, transition: string) {
  return h.database
    .prepare<[string, string], { readonly n: number }>(
      "SELECT count(*) AS n FROM activity_log WHERE entity_type=? AND details_json LIKE ?",
    )
    .get(entityType, `%\"transition\":\"${transition}\"%`)!.n;
}

void test("assignment snapshots provenance and only eligible stable telemetry establishes its baseline", () => {
  const h = harness();
  try {
    const { tap, fill, keg, source } = setup(h);
    h.detector.setTapOverride(tap.id, fastConfig());
    sample(h, source, 100, 999, "unassigned");
    h.set(1_000);
    const assignment = h.tapService.assignFill(tap.id, { fillId: fill.id }).assignment;
    const initial = h.detector.diagnostics(tap.id);
    assert.equal(initial.detector?.phase, "waiting_for_measurement");
    assert.equal(initial.epoch?.snapshots.capacityMl, keg.capacityMl);
    assert.equal(initial.epoch?.sourceId, source.id);
    assert.equal(initial.epoch?.fillId, fill.id);
    assert.equal(initial.epoch?.assignmentId, assignment.id);
    sample(h, source, 900, 999, "pre-epoch");
    assert.equal(h.detector.diagnostics(tap.id).detector?.baselineVolumeMl, null);
    sample(h, source, 1_000, 1_000, "base-1");
    sample(h, source, 1_050, 1_000, "base-2");
    assert.equal(h.detector.diagnostics(tap.id).detector?.baselineVolumeMl, 1_000);
  } finally {
    h.close();
  }
});

void test("assignment without an authoritative source remains valid and waits explicitly", () => {
  const h = harness();
  try {
    const tap = h.tapService.createTap({ tapNumber: 1, name: "One" });
    const keg = h.kegService.createKeg({
      kegNumber: 1,
      capacityMl: 1_000,
      currentTareG: 100,
    });
    const beverage = h.beverageService.createCustomBeverage({
      name: "No source beer",
      beverageType: "beer",
      fg: 1,
    });
    const fill = h.fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
    h.tapService.assignFill(tap.id, { fillId: fill.id });
    const diagnostics = h.detector.diagnostics(tap.id);
    assert.equal(diagnostics.epoch?.sourceId, null);
    assert.equal(diagnostics.detector?.waitingForMeasurement, true);
    assert.equal(diagnostics.detector?.baselineVolumeMl, null);
  } finally {
    h.close();
  }
});

void test("startup reconciliation opens a fresh waiting epoch for an existing active assignment", () => {
  const h = harness();
  try {
    const { tap, fill, source } = setup(h);
    h.detector.setTapOverride(tap.id, fastConfig());
    h.set(1_000);
    const assignment = h.tapService.assignFill(tap.id, { fillId: fill.id }).assignment;
    h.database.prepare("DELETE FROM telemetry_epochs").run();

    h.set(2_000);
    assert.equal(h.detector.reconcileActiveAssignments(), 1);
    const reconciled = h.detector.diagnostics(tap.id);
    assert.equal(reconciled.epoch?.assignmentId, assignment.id);
    assert.equal(reconciled.epoch?.startedAt, new Date(origin + 2_000).toISOString());
    assert.equal(reconciled.detector?.phase, "waiting_for_measurement");
    assert.equal(h.detector.reconcileActiveAssignments(), 0);

    sample(h, source, 1_900, 1_000, "delayed-before-startup");
    assert.equal(h.detector.diagnostics(tap.id).detector?.baselineVolumeMl, null);
    sample(h, source, 2_000, 1_000, "fresh-after-startup-1");
    sample(h, source, 2_050, 1_000, "fresh-after-startup-2");
    assert.equal(h.detector.diagnostics(tap.id).detector?.baselineVolumeMl, 1_000);
  } finally {
    h.close();
  }
});

void test("effective density and detector configuration transitions are transactional and only occur when effective snapshots change", () => {
  const h = harness();
  try {
    const { tap, fill, source, beverage } = setup(h);
    h.detector.setTapOverride(tap.id, fastConfig());
    h.set(1_000);
    h.tapService.assignFill(tap.id, { fillId: fill.id });
    sample(h, source, 1_000, 1_000, "base-1");
    sample(h, source, 1_050, 1_000, "base-2");
    const baselineEpoch = h.detector.diagnostics(tap.id).epoch!;

    h.set(1_100);
    h.beverageService.updateCustomBeverage(beverage.beverage.id, { fg: 1.01 });
    const densityEpoch = h.detector.diagnostics(tap.id).epoch!;
    assert.notEqual(densityEpoch.id, baselineEpoch.id);
    assert.equal(h.detector.diagnostics(tap.id).detector?.baselineVolumeMl, null);
    assert.equal(
      h.database
        .prepare<[string], { readonly close_reason: string }>(
          "SELECT close_reason FROM telemetry_epochs WHERE id=?",
        )
        .get(baselineEpoch.id)!.close_reason,
      "density_changed",
    );
    // Name edits and a same effective density are intentionally inert.
    h.beverageService.updateCustomBeverage(beverage.beverage.id, { name: "Renamed" });
    h.beverageService.updateCustomBeverage(beverage.beverage.id, { fg: 1.01 });
    assert.equal(h.detector.diagnostics(tap.id).epoch?.id, densityEpoch.id);

    // Drop the test-only fast override so a global update is effective.
    h.detector.clearTapOverride(tap.id);
    const afterOverrideClear = h.detector.diagnostics(tap.id).epoch!;
    const global = h.detector.getGlobalConfig();
    h.set(1_200);
    h.detector.updateGlobalConfig({
      ...global.config,
      quietPeriodMs: global.config.quietPeriodMs + 1,
    });
    const configEpoch = h.detector.diagnostics(tap.id).epoch!;
    assert.notEqual(configEpoch.id, afterOverrideClear.id);
    assert.equal(h.detector.diagnostics(tap.id).detector?.baselineVolumeMl, null);
    h.detector.updateGlobalConfig(h.detector.getGlobalConfig().config);
    assert.equal(h.detector.diagnostics(tap.id).epoch?.id, configEpoch.id);
    // A tap override pinning the value makes later unrelated global default changes inert for this tap.
    h.detector.setTapOverride(tap.id, {
      quietPeriodMs: configEpoch.snapshots.detectorConfig.quietPeriodMs,
    });
    const pinnedEpoch = h.detector.diagnostics(tap.id).epoch!;
    h.detector.updateGlobalConfig({
      ...h.detector.getGlobalConfig().config,
      quietPeriodMs: global.config.quietPeriodMs + 99,
    });
    assert.equal(h.detector.diagnostics(tap.id).epoch?.id, pinnedEpoch.id);
  } finally {
    h.close();
  }
});

void test("moving, unassigning, and kicking a Fill close detector epochs without carrying candidates", async () => {
  const h = harness();
  try {
    const { tap, fill, source } = setup(h);
    const target = h.tapService.createTap({ tapNumber: 2, name: "Two" });
    h.detector.setTapOverride(tap.id, { ...fastConfig(), arbitrationMs: 1_000 });
    h.detector.setTapOverride(target.id, fastConfig());
    h.set(1_000);
    h.tapService.assignFill(tap.id, { fillId: fill.id });
    sample(h, source, 1_000, 1_000, "base-1");
    sample(h, source, 1_050, 1_000, "base-2");
    sample(h, source, 1_100, 980, "candidate-1");
    sample(h, source, 1_150, 970, "candidate-2");
    assert.notEqual(h.detector.diagnostics(tap.id).detector?.candidate, null);
    const sourceEpoch = h.detector.diagnostics(tap.id).epoch!;
    h.set(1_200);
    h.tapService.moveFill({ tapId: tap.id }, { targetTapId: target.id });
    const targetEpoch = h.detector.diagnostics(target.id).epoch!;
    assert.equal(h.detector.diagnostics(tap.id).epoch, null);
    assert.equal(targetEpoch.fillId, fill.id);
    assert.equal(h.detector.diagnostics(target.id).detector?.candidate, null);
    assert.equal(h.detector.diagnostics(target.id).detector?.baselineVolumeMl, null);
    assert.equal(
      h.database
        .prepare<[string], { readonly close_reason: string }>(
          "SELECT close_reason FROM telemetry_epochs WHERE id=?",
        )
        .get(sourceEpoch.id)!.close_reason,
      "assignment_moved",
    );
    h.tapService.unassign(target.id);
    assert.equal(h.detector.diagnostics(target.id).epoch, null);
    h.tapService.assignFill(target.id, { fillId: fill.id });
    const beforeKick = h.detector.diagnostics(target.id).epoch!.id;
    await h.fillService.kickFill(fill.id);
    assert.equal(h.detector.diagnostics(target.id).epoch, null);
    assert.equal(
      h.database
        .prepare<[string], { readonly close_reason: string }>(
          "SELECT close_reason FROM telemetry_epochs WHERE id=?",
        )
        .get(beforeKick)!.close_reason,
      "fill_ended",
    );
  } finally {
    h.close();
  }
});

void test("accepted trace completes one immutable pour and duplicate terminal receipt has no detector effect", () => {
  const h = harness();
  try {
    const { tap, fill, source } = setup(h);
    h.detector.setTapOverride(tap.id, fastConfig());
    h.set(1_000);
    h.tapService.assignFill(tap.id, { fillId: fill.id });
    sample(h, source, 1_000, 1_000, "base-1");
    sample(h, source, 1_050, 1_000, "base-2");
    sample(h, source, 1_100, 980, "fall-1");
    sample(h, source, 1_150, 970, "fall-2");
    h.detector.processDue(new Date(origin + 1_300));
    assert.equal(count(h, "pours"), 1);
    const pour = h.database
      .prepare<[], { readonly canonical_volume_ml: number; readonly effect_key: string }>(
        "SELECT canonical_volume_ml,effect_key FROM pours",
      )
      .get()!;
    assert.equal(pour.canonical_volume_ml, 29.5735295625);
    assert.match(pour.effect_key, /^telemetry-pour:/);
    assert.equal(activityCount(h, "pour", "completed"), 1);
    const before = h.detector.diagnostics(tap.id);
    const replay = sample(h, source, 1_150, 970, "fall-2");
    assert.equal(replay.duplicate, true);
    assert.equal(count(h, "pours"), 1);
    assert.deepEqual(h.detector.diagnostics(tap.id), before);
    h.set(1_400);
    h.detector.manualRebaseline(tap.id, { actorType: "admin" });
    assert.equal(count(h, "pours"), 1);
  } finally {
    h.close();
  }
});

void test("implausible upward jumps open one durable warning without Activity spam", () => {
  const h = harness();
  try {
    const { tap, fill, source } = setup(h);
    h.detector.setTapOverride(tap.id, {
      ...fastConfig(),
      implausibleJumpMl: 100,
      jumpStableSamples: 3,
      jumpStableSpanMs: 100,
    });
    h.set(1_000);
    h.tapService.assignFill(tap.id, { fillId: fill.id });
    sample(h, source, 1_000, 1_000, "base-1");
    sample(h, source, 1_050, 1_000, "base-2");
    sample(h, source, 1_100, 1_200, "jump-1");
    sample(h, source, 1_150, 1_210, "jump-2");
    assert.equal(h.detector.diagnostics(tap.id).detector?.phase, "warning");
    assert.equal(activityCount(h, "telemetry_epoch", "implausible_jump_warning"), 1);
    assert.equal(count(h, "pours"), 0);
  } finally {
    h.close();
  }
});

void test("source and keg corrections transition epochs, while manual rebaseline preserves assignment", () => {
  const h = harness();
  try {
    const { tap, fill, keg, source } = setup(h);
    h.detector.setTapOverride(tap.id, fastConfig());
    h.set(1_000);
    const assignment = h.tapService.assignFill(tap.id, { fillId: fill.id }).assignment;
    const first = h.detector.diagnostics(tap.id).epoch!;
    h.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });
    h.telemetryService.rotateSourceKey(source.id, { label: "rotated scale key" });
    assert.equal(h.detector.diagnostics(tap.id).epoch?.id, first.id);
    const source2 = h.telemetryService.createSource({ name: "scale two" }).source;
    h.set(1_100);
    h.telemetryService.setTapAuthority(tap.id, { sourceId: source2.id });
    const afterSource = h.detector.diagnostics(tap.id).epoch!;
    assert.notEqual(afterSource.id, first.id);
    assert.equal(
      h.database
        .prepare<[string], { readonly close_reason: string }>(
          "SELECT close_reason FROM telemetry_epochs WHERE id=?",
        )
        .get(first.id)!.close_reason,
      "source_changed",
    );
    h.set(1_200);
    h.kegService.updateKeg(keg.id, { capacityMl: 1_100, currentTareG: 110 });
    const afterKeg = h.detector.diagnostics(tap.id).epoch!;
    assert.notEqual(afterKeg.id, afterSource.id);
    assert.equal(afterKeg.snapshots.capacityMl, 1_100);
    h.set(1_300);
    const rebased = h.detector.manualRebaseline(tap.id, { actorType: "admin" });
    assert.notEqual(rebased.epoch?.id, afterKeg.id);
    assert.equal(rebased.epoch?.fillId, fill.id);
    assert.equal(rebased.epoch?.assignmentId, assignment.id);
    assert.equal(rebased.detector?.phase, "waiting_for_measurement");
    assert.equal(activityCount(h, "telemetry_epoch", "manual_rebaseline"), 1);
  } finally {
    h.close();
  }
});
