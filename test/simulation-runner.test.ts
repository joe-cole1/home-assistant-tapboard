import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readBrewingInputs } from "../src/features/beverages/brewing-inputs.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import {
  insertSensor,
  listSensors,
  readFillVolume,
  readSensor,
  readSettings,
  setSeeded,
  setFillVolume,
} from "../src/features/simulation/repository.ts";
import { SimulationRunner, SIMULATION_OUNCE_ML } from "../src/features/simulation/runner.ts";
import { seedSimulation } from "../src/features/simulation/seed.ts";
import { HISTORY_BEERS } from "../src/features/simulation/history-beers.ts";
import { LEGACY_BEERS } from "../src/features/simulation/legacy-samples.ts";
import type { SimulationDependencies, SimulationSensor } from "../src/features/simulation/types.ts";
import { resolveFlavorProfile } from "../src/features/story/profile.ts";
import { FILL_GLASS_IDS } from "../src/features/story/vessels.ts";
import { createTapService, tapDeletionConfirmationLabel } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const ORIGIN = Date.parse("2026-01-01T00:00:00.000Z");

function harness(
  path = ":memory:",
  time = { now: ORIGIN },
  hooks: { onSampleCommitted?: (tapId: string) => void } = {},
) {
  const database = openDatabase(path);
  const clock = () => new Date(time.now);
  const errors: unknown[] = [];
  const faults: { tapId: string | null } = { tapId: null };
  const detectorService = new DetectorService(database, { now: clock });
  const machineKeyService = createMachineKeyService(database, { now: clock });
  const tapService = createTapService(database, { extensionPort: detectorService, now: clock });
  const kegService = createKegService(database, {
    onKegCorrection: (db, event) => detectorService.onKegCorrection(db, event),
    now: clock,
  });
  const beverageService = createBeverageService(database, {
    densityExtensionPort: detectorService,
    now: clock,
  });
  const fillService = createFillService(database, {
    beverageService,
    assignmentPort: tapService.asFillAssignmentPort(),
    now: clock,
  });
  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    authorityExtensionPort: detectorService,
    acceptedExtensionPort: {
      onAcceptedSample(db, event) {
        detectorService.onAcceptedSample(db, event);
        if (event.tapId === faults.tapId) throw new Error("Injected accepted-sample hook failure");
      },
    },
    clock,
  });
  const dependencies = {
    database,
    detectorService,
    tapService,
    kegService,
    beverageService,
    fillService,
    telemetryService,
  };
  const runner = new SimulationRunner(dependencies, {
    clock,
    autoSchedule: false,
    onError: (error) => errors.push(error),
    onSampleCommitted: (tapId) => hooks.onSampleCommitted?.(tapId),
  });
  return {
    ...dependencies,
    machineKeyService,
    runner,
    errors,
    faults,
    time,
    seed: () => seedSimulation(dependencies),
    advance(milliseconds: number, step = 100) {
      assert.equal(milliseconds % step, 0);
      for (let elapsed = 0; elapsed < milliseconds; elapsed += step) {
        time.now += step;
        runner.tick();
      }
    },
    close() {
      runner.stop();
      database.close();
    },
  };
}

function count(
  database: DatabaseConnection,
  table:
    | "pours"
    | "taps"
    | "beverages"
    | "fills"
    | "kegs"
    | "telemetry_sources"
    | "telemetry_measurements"
    | "telemetry_ingest_receipts"
    | "simulation_fill_volumes",
  tapId?: string,
): number {
  return tapId === undefined
    ? database.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n
    : database
        .prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE tap_id = ?`)
        .get(tapId)!.n;
}

function warm(h: ReturnType<typeof harness>) {
  h.seed();
  h.runner.start();
  h.advance(2_500);
  assert.deepEqual(
    h.runner.listSensors().map((sensor) => sensor.status),
    Array<string>(5).fill("ready"),
  );
}

void test("simulation seeds five ordinary assignments and two On Deck once, with catalog glasses", () => {
  const h = harness();
  try {
    const first = h.seed();
    const assignments = h.tapService.listTaps().map((tap) => tap.activeAssignment);
    assert.equal(first.length, 5);
    assert.equal(new Set(first.map((sensor) => sensor.sourceId)).size, 5);
    assert.equal(new Set(first.map((sensor) => sensor.remainingMl)).size, 5);
    assert.equal(new Set(assignments.map((assignment) => assignment!.fillId)).size, 5);
    assert.equal(new Set(assignments.map((assignment) => assignment!.kegId)).size, 5);
    assert.equal(h.fillService.listFills({ state: "on_deck" }).length, 2);
    assert.equal(count(h.database, "simulation_fill_volumes"), 7);
    for (const tap of h.tapService.listTaps())
      assert.equal(
        readFillVolume(h.database, tap.activeAssignment!.fillId),
        first.find((sensor) => sensor.tapId === tap.id)!.remainingMl,
      );
    for (const onDeck of h.fillService.listFills({ state: "on_deck" })) {
      assert.equal(
        readFillVolume(h.database, onDeck.id),
        h.kegService.getKeg(onDeck.kegId).keg.capacityMl,
      );
    }
    const glasses = assignments.map(
      (assignment) =>
        h.beverageService.getBeverage(assignment!.beverageId).effectivePresentation.fillGlass,
    );
    assert.equal(new Set(glasses).size, 5);
    assert.ok(glasses.every((glass) => FILL_GLASS_IDS.some((known) => known === glass)));
    assert.deepEqual(h.seed(), first);
    assert.equal(count(h.database, "taps"), 5);
    assert.equal(count(h.database, "beverages"), 7);
    assert.equal(count(h.database, "pours"), 0);
    assert.equal(count(h.database, "telemetry_measurements"), 0);
    assert.equal(readSettings(h.database).seeded, true);
  } finally {
    h.close();
  }
});

void test("seed is atomic and refuses an unmarked database with existing inventory", () => {
  const h = harness();
  try {
    const create = h.beverageService.createCustomBeverage.bind(h.beverageService);
    let calls = 0;
    h.beverageService.createCustomBeverage = (...args) => {
      if (++calls === 3) throw new Error("Injected seed failure");
      return create(...args);
    };
    assert.throws(() => h.seed(), /Injected seed failure/);
    for (const table of ["taps", "kegs", "beverages", "fills", "telemetry_sources"] as const)
      assert.equal(count(h.database, table), 0);
    assert.equal(readSettings(h.database).seeded, false);
    assert.deepEqual(listSensors(h.database), []);
    assert.equal(count(h.database, "simulation_fill_volumes"), 0);
    h.beverageService.createCustomBeverage = create;
    h.tapService.createTap({ tapNumber: 20 });
    assert.throws(
      () => h.seed(),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "simulation.database_not_empty",
    );
    assert.equal(count(h.database, "taps"), 1);
    assert.equal(count(h.database, "beverages"), 0);
  } finally {
    h.close();
  }
});

void test("default detector records each sized pour once through real ingestion with physical volume preserved", () => {
  const h = harness();
  try {
    warm(h);
    const before = h.runner.listSensors();
    const ounces = [4, 12, 16, 1, 32];
    for (const [index, sensor] of before.entries()) h.runner.pour(sensor.tapId, ounces[index]!);
    assert.throws(() => h.runner.pour(before[0]!.tapId, 4), /ready/);
    assert.throws(() => h.runner.pour(before[0]!.tapId, 0), /between 1 and 32/);
    // A delayed scheduler need not hit perfectly spaced 100/200 ms boundaries.
    h.advance(25_000, 125);
    assert.equal(h.errors.length, 0);
    const pours = h.database
      .prepare<
        [],
        { tap_id: string; canonical_volume_ml: number; epoch_id: string; assignment_id: string }
      >("SELECT tap_id, canonical_volume_ml, epoch_id, assignment_id FROM pours")
      .all();
    assert.equal(pours.length, 5);
    for (const [index, sensor] of before.entries()) {
      const pour = pours.find((item) => item.tap_id === sensor.tapId)!;
      assert.ok(pour, `pour exists for ${ounces[index]} ounces`);
      assert.ok(
        Math.abs(pour.canonical_volume_ml - ounces[index]! * SIMULATION_OUNCE_ML) <=
          SIMULATION_OUNCE_ML * 0.1,
      );
      assert.equal(
        readFillVolume(h.database, h.tapService.getTap(sensor.tapId).activeAssignment!.fillId),
        readSensor(h.database, sensor.tapId)!.remainingMl,
      );
      assert.equal(pour.assignment_id, h.tapService.getTap(sensor.tapId).activeAssignment!.id);
      assert.equal(pour.epoch_id, h.detectorService.diagnostics(sensor.tapId).epoch!.id);
      assert.ok(
        Math.abs(
          readSensor(h.database, sensor.tapId)!.remainingMl -
            (sensor.remainingMl - ounces[index]! * SIMULATION_OUNCE_ML),
        ) < 1e-6,
      );
    }
    h.advance(10_000);
    assert.equal(count(h.database, "pours"), 5);
    assert.ok(h.runner.listSensors().every((sensor) => sensor.status === "ready"));
    const fractionalSensor = h.runner.listSensors()[0]!;
    h.runner.pour(fractionalSensor.tapId, 7.3);
    h.advance(25_000, 125);
    assert.equal(h.errors.length, 0);
    assert.equal(count(h.database, "pours"), 6);
    const fractionalPours = h.database
      .prepare<[string], { canonical_volume_ml: number }>(
        "SELECT canonical_volume_ml FROM pours WHERE tap_id = ? ORDER BY started_at DESC",
      )
      .all(fractionalSensor.tapId);
    assert.equal(fractionalPours.length, 2);
    assert.ok(
      Math.abs(fractionalPours[0]!.canonical_volume_ml - 7.3 * SIMULATION_OUNCE_ML) <=
        SIMULATION_OUNCE_ML * 0.1,
    );
    const fractionalRemaining = readSensor(h.database, fractionalSensor.tapId)!.remainingMl;
    assert.ok(
      Math.abs(fractionalRemaining - (fractionalSensor.remainingMl - 7.3 * SIMULATION_OUNCE_ML)) <
        1e-6,
    );
    assert.equal(
      readFillVolume(
        h.database,
        h.tapService.getTap(fractionalSensor.tapId).activeAssignment!.fillId,
      ),
      fractionalRemaining,
    );
    h.advance(10_000);
    assert.equal(count(h.database, "pours"), 6);
    assert.ok(h.runner.listSensors().every((sensor) => sensor.status === "ready"));
    assert.ok(count(h.database, "telemetry_ingest_receipts") > 100);
    assert.deepEqual(
      h.database
        .prepare<[], { primary_kind: string }>(
          "SELECT DISTINCT primary_kind FROM telemetry_measurements",
        )
        .all(),
      [{ primary_kind: "total_weight" }],
    );
  } finally {
    h.close();
  }
});

void test("deterministic idle noise causes no false pours and stalled ticks stay bounded", () => {
  const h = harness();
  try {
    warm(h);
    const before = h.runner.listSensors();
    for (const sensor of before) h.runner.setNoise(sensor.tapId, true);
    h.advance(30_000);
    assert.equal(count(h.database, "pours"), 0);
    assert.deepEqual(
      h.runner.listSensors().map((sensor) => sensor.remainingMl),
      before.map((sensor) => sensor.remainingMl),
    );
    assert.ok(h.runner.listSensors().every((sensor) => sensor.status === "ready"));
    const acceptedBefore = count(h.database, "telemetry_measurements");
    h.time.now += 60_000;
    assert.equal(h.runner.tick(), 5);
    assert.equal(h.runner.tick(), 0);
    assert.equal(count(h.database, "telemetry_measurements") - acceptedBefore, 5);
    assert.equal(h.errors.length, 0);
  } finally {
    h.close();
  }
});

void test("pause, stop and a real-file restart retain hardware state and never repeat a completed pour", () => {
  const directory = mkdtempSync(join("/tmp", "tapboard-simulation-test-"));
  const path = join(directory, "simulation.sqlite3");
  let h = harness(path);
  try {
    warm(h);
    const [pouring, offline] = h.runner.listSensors();
    h.runner.pour(pouring!.tapId, 4);
    h.advance(15_000);
    assert.equal(count(h.database, "pours"), 1);
    h.runner.setOnline(offline!.tapId, false);
    h.runner.setNoise(offline!.tapId, true);
    h.runner.setTemperature(offline!.tapId, 8);
    const sequence = readSensor(h.database, offline!.tapId)!.sequence;
    h.advance(5_000);
    assert.equal(readSensor(h.database, offline!.tapId)!.sequence, sequence);
    const before = listSensors(h.database);
    const keys = new Map(
      h.telemetryService.listSources().map((source) => [source.id, source.currentMachineKeyId]),
    );
    const time = h.time;
    h.runner.stop();
    h.time.now += 30_000;
    assert.equal(h.runner.tick(), 0);
    assert.deepEqual(listSensors(h.database), before);
    h.close();
    h = harness(path, time);
    assert.deepEqual(h.seed(), before);
    h.runner.start();
    for (const source of h.telemetryService.listSources()) {
      assert.notEqual(source.currentMachineKeyId, keys.get(source.id));
      assert.ok(h.machineKeyService.get(keys.get(source.id)!)!.revokedAt !== null);
    }
    h.advance(15_000);
    assert.equal(count(h.database, "pours"), 1);
    assert.equal(count(h.database, "taps"), 5);
    assert.equal(count(h.database, "beverages"), 7);
    assert.equal(readSensor(h.database, offline!.tapId)!.sequence, sequence);
    assert.equal(readSensor(h.database, offline!.tapId)!.noiseEnabled, true);
    assert.equal(readSensor(h.database, offline!.tapId)!.temperatureC, 8);
    h.runner.setOnline(offline!.tapId, true);
    h.advance(3_000);
    assert.ok(readSensor(h.database, offline!.tapId)!.sequence > sequence);
    assert.equal(count(h.database, "pours"), 1);
    assert.equal(h.errors.length, 0);
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("rotation, revocation and authority changes fail visibly without stealing authority or consuming volume", () => {
  const h = harness();
  try {
    warm(h);
    const [rotated, reassigned, revoked, healthy] = h.runner.listSensors();
    for (const sensor of [rotated!, reassigned!, revoked!]) h.runner.pour(sensor.tapId, 4);
    h.telemetryService.rotateSourceKey(rotated!.sourceId, {});
    h.telemetryService.setTapAuthority(reassigned!.tapId, { sourceId: healthy!.sourceId });
    const key = h.telemetryService.getSourceById(revoked!.sourceId)!.currentMachineKeyId;
    h.machineKeyService.revoke(key);
    h.advance(1_000);
    for (const sensor of [rotated!, reassigned!, revoked!]) {
      const current = h.runner.listSensors().find((item) => item.tapId === sensor.tapId)!;
      assert.equal(current.status, "error");
      assert.ok(current.error);
      assert.equal(current.remainingMl, sensor.remainingMl);
    }
    assert.equal(
      h.telemetryService.getTapAuthority(reassigned!.tapId)!.sourceId,
      healthy!.sourceId,
    );
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === healthy!.tapId)!.status,
      "ready",
    );
    assert.equal(count(h.database, "pours"), 0);
    h.runner.stop();
    h.runner.start();
    assert.equal(h.telemetryService.getSourceById(revoked!.sourceId)!.currentMachineKeyId, key);
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === revoked!.tapId)!.status,
      "error",
    );
  } finally {
    h.close();
  }
});

void test("accepted-hook failure rolls back the physical state, receipt, measurement and detector transition together", () => {
  const h = harness();
  try {
    warm(h);
    const sensor = h.runner.listSensors()[0]!;
    const diagnostics = h.detectorService.diagnostics(sensor.tapId);
    const physicalVolume = readFillVolume(h.database, diagnostics.epoch!.fillId);
    const measurements = count(h.database, "telemetry_measurements", sensor.tapId);
    const receipts = count(h.database, "telemetry_ingest_receipts", sensor.tapId);
    h.runner.pour(sensor.tapId, 4);
    h.faults.tapId = sensor.tapId;
    h.advance(100);
    assert.deepEqual(readSensor(h.database, sensor.tapId), {
      tapId: sensor.tapId,
      sourceId: sensor.sourceId,
      remainingMl: sensor.remainingMl,
      temperatureC: sensor.temperatureC,
      online: sensor.online,
      noiseEnabled: sensor.noiseEnabled,
      sequence: sensor.sequence,
    });
    assert.deepEqual(h.detectorService.diagnostics(sensor.tapId), diagnostics);
    assert.equal(readFillVolume(h.database, diagnostics.epoch!.fillId), physicalVolume);
    assert.equal(count(h.database, "telemetry_measurements", sensor.tapId), measurements);
    assert.equal(count(h.database, "telemetry_ingest_receipts", sensor.tapId), receipts);
    assert.equal(h.runner.listSensors()[0]!.status, "error");
  } finally {
    h.close();
  }
});

void test("sample notifications observe a committed physical state from a separate database connection", () => {
  const directory = mkdtempSync(join("/tmp", "tapboard-simulation-commit-test-"));
  const path = join(directory, "simulation.sqlite3");
  const hooks: { onSampleCommitted?: (tapId: string) => void } = {};
  const h = harness(path, { now: ORIGIN }, hooks);
  let reader: DatabaseConnection | undefined;
  try {
    h.seed();
    reader = openDatabase(path);
    let notifications = 0;
    hooks.onSampleCommitted = (tapId) => {
      notifications += 1;
      assert.deepEqual(readSensor(reader!, tapId), readSensor(h.database, tapId));
      assert.ok(readSensor(reader!, tapId)!.sequence > 0);
      const fillId = h.tapService.getTap(tapId).activeAssignment!.fillId;
      assert.equal(readFillVolume(reader!, fillId), readSensor(reader!, tapId)!.remainingMl);
      assert.equal(
        count(reader!, "telemetry_measurements", tapId),
        count(h.database, "telemetry_measurements", tapId),
      );
    };
    h.runner.start();
    h.advance(100);
    assert.equal(notifications, 5);
    const failed = h.runner.listSensors()[0]!;
    h.faults.tapId = failed.tapId;
    notifications = 0;
    h.advance(500);
    assert.equal(notifications, 4);
    assert.equal(h.errors.length, 1);
  } finally {
    reader?.close();
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("hidden taps keep measuring; stopping a mid-pour cancels future physical loss", () => {
  const h = harness();
  try {
    warm(h);
    const tap = h.runner.listSensors()[0]!;
    h.tapService.updateTap(tap.tapId, { enabled: false });
    h.runner.pour(tap.tapId, 16);
    h.advance(1_000);
    const partial = readSensor(h.database, tap.tapId)!;
    assert.ok(partial.remainingMl < tap.remainingMl);
    assert.ok(partial.remainingMl > tap.remainingMl - 16 * SIMULATION_OUNCE_ML);
    h.runner.stop();
    h.advance(20_000);
    assert.deepEqual(readSensor(h.database, tap.tapId), partial);
    h.runner.start();
    h.advance(20_000);
    assert.equal(readSensor(h.database, tap.tapId)!.remainingMl, partial.remainingMl);
    assert.ok(readSensor(h.database, tap.tapId)!.sequence > partial.sequence);
    assert.equal(h.runner.listSensors()[0]!.status, "ready");
    assert.equal(h.errors.length, 0);
  } finally {
    h.close();
  }
});

void test("normal renumber, move, kick and unused-tap deletion do not leave stale pour plans", async () => {
  const h = harness();
  try {
    warm(h);
    const [renumbered, moved, kicked, , destination] = h.runner.listSensors();
    h.tapService.updateTap(renumbered!.tapId, {
      tapNumber: 40,
      acknowledgeTelemetryEndpointImpact: true,
    });
    h.runner.pour(renumbered!.tapId, 4);
    h.runner.pour(moved!.tapId, 16);
    h.runner.pour(kicked!.tapId, 16);
    h.advance(1_000);
    const movedRemaining = readSensor(h.database, moved!.tapId)!.remainingMl;
    const kickedRemaining = readSensor(h.database, kicked!.tapId)!.remainingMl;
    h.tapService.unassign(destination!.tapId);
    h.tapService.moveFill({ tapId: moved!.tapId }, { targetTapId: destination!.tapId });
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === destination!.tapId)!.remainingMl,
      movedRemaining,
    );
    assert.equal(readSensor(h.database, destination!.tapId)!.remainingMl, destination!.remainingMl);
    await h.fillService.kickFill(h.tapService.getTap(kicked!.tapId).activeAssignment!.fillId);
    const unused = h.tapService.createTap({ tapNumber: 50 });
    insertSensor(h.database, {
      ...readSensor(h.database, renumbered!.tapId)!,
      tapId: unused.id,
      sequence: 0,
    });
    h.tapService.deleteTap(unused.id, { confirmation: tapDeletionConfirmationLabel(unused) });
    h.advance(15_000);
    assert.equal(h.errors.length, 0);
    assert.equal(h.runner.listSensors().length, 5);
    assert.equal(readSensor(h.database, unused.id), undefined);
    assert.equal(readSensor(h.database, moved!.tapId)!.remainingMl, movedRemaining);
    assert.equal(readSensor(h.database, kicked!.tapId)!.remainingMl, kickedRemaining);
    assert.equal(readSensor(h.database, destination!.tapId)!.remainingMl, movedRemaining);
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === moved!.tapId)!.status,
      "unassigned",
    );
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === kicked!.tapId)!.status,
      "unassigned",
    );
    assert.equal(count(h.database, "pours"), 1);
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === renumbered!.tapId)!.tapNumber,
      40,
    );
  } finally {
    h.close();
  }
});

void test("Fill volume follows moves and replacement switches, and survives a runner restart", () => {
  const directory = mkdtempSync(join("/tmp", "tapboard-simulation-fill-test-"));
  const path = join(directory, "simulation.sqlite3");
  let h = harness(path);
  try {
    warm(h);
    const original = h.runner.listSensors()[0]!;
    const destination = h.runner.listSensors()[4]!;
    const assignment = h.tapService.getTap(original.tapId).activeAssignment!;
    h.runner.pour(original.tapId, 4);
    h.advance(15_000);
    const originalRemaining = readFillVolume(h.database, assignment.fillId)!;
    assert.ok(
      Math.abs(originalRemaining - (original.remainingMl - 4 * SIMULATION_OUNCE_ML)) < 1e-6,
    );
    assert.equal(count(h.database, "pours"), 1);

    h.tapService.unassign(destination.tapId);
    h.tapService.moveFill({ tapId: original.tapId }, { targetTapId: destination.tapId });
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === destination.tapId)!.remainingMl,
      originalRemaining,
    );
    assert.equal(readSensor(h.database, destination.tapId)!.remainingMl, destination.remainingMl);
    h.advance(2_500);
    assert.equal(readSensor(h.database, destination.tapId)!.remainingMl, originalRemaining);

    const replacementKeg = h.kegService.createKeg({
      kegNumber: 20,
      capacityMl: 12_000,
      currentTareG: 3_000,
    });
    const replacement = h.fillService.createFill({
      beverageId: assignment.beverageId,
      kegId: replacementKeg.id,
    });
    h.tapService.unassign(destination.tapId);
    h.tapService.assignFill(destination.tapId, { fillId: replacement.id });
    const rowsBeforeRead = count(h.database, "simulation_fill_volumes");
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === destination.tapId)!.remainingMl,
      replacementKeg.capacityMl,
    );
    assert.equal(count(h.database, "simulation_fill_volumes"), rowsBeforeRead);
    assert.equal(readFillVolume(h.database, replacement.id), undefined);
    assert.equal(readSensor(h.database, destination.tapId)!.remainingMl, originalRemaining);

    // A failed first sample does not persist the provisional full-Keg volume or its cache.
    h.faults.tapId = destination.tapId;
    h.advance(500);
    assert.equal(readFillVolume(h.database, replacement.id), undefined);
    assert.equal(readSensor(h.database, destination.tapId)!.remainingMl, originalRemaining);
    h.faults.tapId = null;
    h.runner.setOnline(destination.tapId, false);
    h.runner.setOnline(destination.tapId, true);
    h.advance(2_500);
    assert.equal(readFillVolume(h.database, replacement.id), replacementKeg.capacityMl);
    h.runner.pour(destination.tapId, 4);
    h.advance(15_000);
    const replacementRemaining = readFillVolume(h.database, replacement.id)!;
    assert.ok(
      Math.abs(replacementRemaining - (replacementKeg.capacityMl - 4 * SIMULATION_OUNCE_ML)) < 1e-6,
    );
    assert.equal(count(h.database, "pours"), 2);

    h.tapService.unassign(destination.tapId);
    h.tapService.assignFill(destination.tapId, { fillId: assignment.fillId });
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === destination.tapId)!.remainingMl,
      originalRemaining,
    );
    h.advance(2_500);
    const time = h.time;
    h.close();
    time.now += 30_000;
    h = harness(path, time);
    h.seed();
    assert.equal(
      h.runner.listSensors().find((sensor) => sensor.tapId === destination.tapId)!.remainingMl,
      originalRemaining,
    );
    h.runner.start();
    h.advance(15_000);
    assert.equal(readFillVolume(h.database, assignment.fillId), originalRemaining);
    assert.equal(readFillVolume(h.database, replacement.id), replacementRemaining);
    assert.equal(readSensor(h.database, destination.tapId)!.remainingMl, originalRemaining);
    assert.equal(count(h.database, "pours"), 2);
    assert.equal(count(h.database, "simulation_fill_volumes"), 8);
    assert.equal(h.errors.length, 0);
  } finally {
    h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Seed only a new, dedicated simulation database, through ordinary domain services. */
function seedLegacySimulation(dependencies: SimulationDependencies): readonly SimulationSensor[] {
  const { database, tapService, kegService, beverageService, fillService, telemetryService } =
    dependencies;
  return database.withTransaction(() => {
    if (readSettings(database).seeded) return listSensors(database);
    // A forgotten marker is never permission to mix examples into an existing installation.
    if (
      tapService.listTaps().length > 0 ||
      kegService.listKegs().length > 0 ||
      beverageService.listBeverages().length > 0 ||
      fillService.listFills().length > 0 ||
      telemetryService.listSources().length > 0 ||
      listSensors(database).length > 0
    ) {
      throw new ApplicationError({
        category: "conflict",
        code: "simulation.database_not_empty",
        clientMessage: "Simulation can only be initialized in an empty, separate database.",
      });
    }

    const actor = { actorType: "system" } as const;
    for (const [index, beer] of LEGACY_BEERS.entries()) {
      const { fraction, ...profile } = beer;
      const tapNumber = index + 1;
      const tap = tapService.createTap({ tapNumber, name: `Sample Tap ${tapNumber}` }, actor);
      const beverage = beverageService.createCustomBeverage(
        {
          ...profile,
          beverageType: "beer",
          fg: 1.012,
          description: "Fictional sample beer for the built-in Simulation workspace.",
        },
        actor,
      );
      const keg = kegService.createKeg(
        {
          kegNumber: tapNumber,
          label: `Sample Keg ${tapNumber}`,
          capacityMl: 19_000,
          currentTareG: 4_200,
        },
        actor,
      );
      const fill = fillService.createFill(
        { beverageId: beverage.beverage.id, kegId: keg.id },
        actor,
      );
      setFillVolume(database, fill.id, keg.capacityMl * fraction);
      // Initial plaintext is deliberately discarded. Each runner lifecycle rotates it in memory.
      const { source } = telemetryService.createSource(
        { name: `Simulation sensor ${tapNumber}` },
        actor,
      );
      telemetryService.setTapAuthority(tap.id, { sourceId: source.id }, actor);
      tapService.assignFill(tap.id, { fillId: fill.id }, actor);
      insertSensor(database, {
        tapId: tap.id,
        sourceId: source.id,
        remainingMl: keg.capacityMl * fraction,
        temperatureC: 4 + index * 0.2,
        online: true,
        noiseEnabled: false,
        sequence: 0,
      });
    }

    const onDeckBeer = beverageService.createCustomBeverage(
      {
        name: "Harvest Märzen",
        beverageType: "beer",
        style: "Märzen",
        abv: 5.7,
        ibu: 24,
        srm: 12,
        fg: 1.013,
        fillGlass: "mug",
        description: "Fictional sample beer waiting On Deck in Simulation.",
      },
      actor,
    );
    const onDeckKeg = kegService.createKeg(
      { kegNumber: 7, label: "Sample On Deck Keg", capacityMl: 19_000, currentTareG: 4_200 },
      actor,
    );
    const onDeckFill = fillService.createFill(
      { beverageId: onDeckBeer.beverage.id, kegId: onDeckKeg.id },
      actor,
    );
    setFillVolume(database, onDeckFill.id, onDeckKeg.capacityMl);
    fillService.markOnDeck(onDeckFill.id, actor);
    setSeeded(database);
    return listSensors(database);
  });
}

void test("history snapshots retain selected batch values and real brewing/barrel inputs", () => {
  const h = harness();
  try {
    h.seed();
    const details = h.beverageService
      .listBeverages()
      .map(({ beverage }) => h.beverageService.getBeverage(beverage.id));
    assert.deepEqual(
      new Set(details.map((d) => d.effectivePresentation.name)),
      new Set(HISTORY_BEERS.map((b) => b.profile.name)),
    );
    for (const beer of HISTORY_BEERS) {
      const detail = details.find((d) => d.effectivePresentation.name === beer.profile.name)!;
      assert.equal(detail.effectivePresentation.fg, beer.profile.fg);
      assert.equal(detail.recipeSnapshot!.recipeJson, beer.snapshotJson);
      assert.equal(detail.recipeSnapshot!.sourceBatchId, beer.caseId);
      assert.equal(detail.recipeSnapshot!.state, "detached");
      assert.equal(detail.customRecipe, undefined);
      assert.equal(detail.sensoryOverrides, undefined);
      const snapshot = readBrewingInputs(JSON.parse(detail.recipeSnapshot!.recipeJson));
      assert.ok(snapshot);
      assert.equal(snapshot.format, "brewfather-export-v3");
      assert.ok(snapshot.ingredients.fermentables.items.length > 0);
      const flavor = resolveFlavorProfile({ brewingInputs: snapshot });
      assert.ok(flavor.axes.bitterness.value !== null);
      assert.ok(flavor.axes.body.value !== null);
      if (beer.caseId === "B026") {
        assert.ok(snapshot.processFacts.length > 0);
        assert.ok(flavor.processTags.includes("Bourbon barrel-aged"));
      }
    }
    assert.equal(h.telemetryService.listSources().length, 5);
  } finally {
    h.close();
  }
});

void test("legacy upgrade preserves IDs, pours, physical volumes, controls and five assignment lifecycles", () => {
  const h = harness();
  try {
    seedLegacySimulation(h);
    h.runner.start();
    h.advance(2500);
    const sensors = h.runner.listSensors();
    h.runner.pour(sensors[0]!.tapId, 4);
    h.advance(15000);
    h.runner.setNoise(sensors[5]!.tapId, true);
    h.runner.setTemperature(sensors[5]!.tapId, 8);
    h.runner.setOnline(sensors[5]!.tapId, false);
    h.runner.stop();
    const beforeSensors = listSensors(h.database);
    const beforeFills = h.fillService.listFills();
    const beforeTaps = h.tapService.listTaps();
    const physical = h.database
      .prepare("SELECT * FROM simulation_fill_volumes ORDER BY fill_id")
      .all();
    const pours = h.database.prepare("SELECT * FROM pours").all();
    const settings = readSettings(h.database);
    h.seed();
    assert.deepEqual(listSensors(h.database), beforeSensors);
    assert.deepEqual(
      h.database.prepare("SELECT * FROM simulation_fill_volumes ORDER BY fill_id").all(),
      physical,
    );
    assert.deepEqual(h.database.prepare("SELECT * FROM pours").all(), pours);
    assert.deepEqual(readSettings(h.database), settings);
    assert.deepEqual(
      new Set(h.fillService.listFills().map((f) => f.id)),
      new Set(beforeFills.map((f) => f.id)),
    );
    for (const tap of beforeTaps.slice(0, 5))
      assert.equal(h.tapService.getTap(tap.id).activeAssignment!.id, tap.activeAssignment!.id);
    assert.equal(h.tapService.getTap(beforeTaps[5]!.id).enabled, false);
    assert.equal(h.tapService.getTap(beforeTaps[5]!.id).activeAssignment, null);
    assert.deepEqual(
      h.fillService
        .listFills({ state: "on_deck" })
        .toSorted((a, b) => a.onDeckOrder! - b.onDeckOrder!)
        .map((f) => f.beverageName),
      ["Hefeweizen", "Spiced Lager"],
    );
    const writes = h.database.prepare<[], { n: number }>("SELECT total_changes() AS n").get()!.n;
    h.seed();
    assert.equal(
      h.database.prepare<[], { n: number }>("SELECT total_changes() AS n").get()!.n,
      writes,
    );
    h.runner.start();
    h.advance(2500);
    h.runner.pour(sensors[0]!.tapId, 4);
    h.advance(15000);
    assert.equal(count(h.database, "pours"), 2);
    assert.equal(h.errors.length, 0);
  } finally {
    h.close();
  }
});

void test("legacy customization and changed topology remain authoritative", () => {
  for (const customization of ["rename", "scalar", "recipe", "manual", "topology"] as const) {
    const h = harness();
    try {
      seedLegacySimulation(h);
      const tap = h.tapService.listTaps()[0]!;
      const id = tap.activeAssignment!.beverageId;
      if (customization === "rename")
        h.beverageService.updateCustomBeverage(id, { name: "My beer" });
      if (customization === "scalar") h.beverageService.updateCustomBeverage(id, { og: 1.05 });
      if (customization === "recipe")
        h.beverageService.updateCustomBeverage(id, { recipe: { notes: "My recipe" } });
      if (customization === "manual") h.beverageService.updateSensoryOverrides(id, { roast: 0 });
      if (customization === "topology") h.tapService.updateTap(tap.id, { name: "My tap" });
      const before = h.beverageService.getBeverage(id);
      const assignments = h.tapService.listTaps().map((t) => t.activeAssignment!.id);
      h.seed();
      assert.deepEqual(
        h.tapService.listTaps().map((t) => t.activeAssignment!.id),
        assignments,
      );
      assert.equal(h.fillService.listFills({ state: "on_deck" }).length, 1);
      const after = h.beverageService.getBeverage(id);
      if (customization !== "topology") assert.deepEqual(after, before);
      else assert.equal(after.effectivePresentation.name, "Oktoberfest");
      assert.equal(
        h.beverageService.getBeverage(h.tapService.listTaps()[1]!.activeAssignment!.beverageId)
          .effectivePresentation.name,
        "Saison",
      );
    } finally {
      h.close();
    }
  }
});

void test("legacy import failure rolls back profiles, snapshots, topology and density epochs", () => {
  const h = harness();
  try {
    seedLegacySimulation(h);
    h.runner.start();
    h.advance(2500);
    h.runner.stop();
    const before = h.database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const snapshot = () =>
      before.map(({ name }) => [name, h.database.prepare(`SELECT * FROM ${name}`).all()]);
    const rows = snapshot();
    const attach = h.beverageService.attachOfflineRecipeSnapshot.bind(h.beverageService);
    let calls = 0;
    h.beverageService.attachOfflineRecipeSnapshot = (...args) => {
      if (++calls === 3) throw new Error("Injected history import failure");
      return attach(...args);
    };
    assert.throws(() => h.seed(), /Injected history import failure/);
    assert.deepEqual(snapshot(), rows);
  } finally {
    h.close();
  }
});
