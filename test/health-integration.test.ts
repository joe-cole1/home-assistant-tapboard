import assert from "node:assert/strict";
import { test } from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { listActivity } from "../src/features/activity/repository.ts";
import { createHealthService, listHealthCheckStates } from "../src/features/health/index.ts";
import { createTapService } from "../src/features/taps/service.ts";
import type {
  AssignmentClosedContext,
  AssignmentOpenedContext,
  TapAssignmentExtensionPort,
} from "../src/features/taps/types.ts";
import type {
  AcceptedSampleEvent,
  AcceptedTelemetryExtensionPort,
  AuthorityChangedEvent,
  TelemetryAuthorityExtensionPort,
} from "../src/features/telemetry/types.ts";
import type {
  BeverageDensityExtensionPort,
  EffectiveDensityChangedEvent,
} from "../src/features/beverages/types.ts";
import type { KegCorrectionEvent } from "../src/features/kegs/types.ts";

const NOW = "2026-08-15T12:00:00.000Z";

function ids(prefix: number): () => string {
  let value = prefix;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function orderedPorts(order: string[]) {
  const detector: TapAssignmentExtensionPort &
    AcceptedTelemetryExtensionPort &
    TelemetryAuthorityExtensionPort &
    BeverageDensityExtensionPort & {
      onKegCorrection(database: DatabaseExecutor, event: KegCorrectionEvent): void;
    } = {
    onAssignmentOpened: () => order.push("detector.assignment_opened"),
    onAssignmentClosed: () => order.push("detector.assignment_closed"),
    onAcceptedSample: () => order.push("detector.accepted_sample"),
    onAuthorityChanged: () => order.push("detector.authority_changed"),
    onEffectiveDensityChanged: () => order.push("detector.density_changed"),
    onKegCorrection: () => order.push("detector.keg_correction"),
  };
  const health: TapAssignmentExtensionPort &
    AcceptedTelemetryExtensionPort &
    TelemetryAuthorityExtensionPort &
    BeverageDensityExtensionPort & {
      onKegCorrection(database: DatabaseExecutor, event: KegCorrectionEvent): void;
    } = {
    onAssignmentOpened: () => order.push("health.assignment_opened"),
    onAssignmentClosed: () => order.push("health.assignment_closed"),
    onAcceptedSample: () => order.push("health.accepted_sample"),
    onAuthorityChanged: () => order.push("health.authority_changed"),
    onEffectiveDensityChanged: () => order.push("health.density_changed"),
    onKegCorrection: () => order.push("health.keg_correction"),
  };

  const tap: TapAssignmentExtensionPort = {
    onAssignmentOpened: (database, context) => {
      detector.onAssignmentOpened(database, context);
      health.onAssignmentOpened(database, context);
    },
    onAssignmentClosed: (database, context) => {
      detector.onAssignmentClosed(database, context);
      health.onAssignmentClosed(database, context);
    },
    onTapCreated: () => order.push("health.tap_created"),
    onTapRetired: () => order.push("health.tap_retired"),
  };
  const accepted: AcceptedTelemetryExtensionPort = {
    onAcceptedSample: (database, event) => {
      detector.onAcceptedSample(database, event);
      health.onAcceptedSample(database, event);
    },
  };
  const authority: TelemetryAuthorityExtensionPort = {
    onAuthorityChanged: (database, event) => {
      detector.onAuthorityChanged(database, event);
      health.onAuthorityChanged(database, event);
    },
  };
  const density: BeverageDensityExtensionPort = {
    onEffectiveDensityChanged: (database, event) => {
      detector.onEffectiveDensityChanged(database, event);
      health.onEffectiveDensityChanged(database, event);
    },
  };
  const keg = {
    onKegCorrection: (database: DatabaseExecutor, event: KegCorrectionEvent) => {
      detector.onKegCorrection(database, event);
      health.onKegCorrection(database, event);
    },
  };
  return { tap, accepted, authority, density, keg };
}

void test("shared transaction callbacks preserve detector-before-health ordering", () => {
  const database = openDatabase(":memory:");
  const order: string[] = [];
  const ports = orderedPorts(order);
  const assignmentOpened: AssignmentOpenedContext = {
    assignmentId: "00000000-0000-4000-8000-000000000001",
    tapId: "00000000-0000-4000-8000-000000000002",
    fillId: "00000000-0000-4000-8000-000000000003",
    occurredAt: NOW,
    reason: "assigned",
  };
  const assignmentClosed: AssignmentClosedContext = {
    ...assignmentOpened,
    reason: "unassigned",
  };
  const accepted: AcceptedSampleEvent = {
    measurementId: "00000000-0000-4000-8000-000000000004",
    sourceId: "00000000-0000-4000-8000-000000000005",
    tapId: assignmentOpened.tapId,
    measuredAt: NOW,
    receivedAt: NOW,
    normalizationVersion: 1,
    primaryMeasurement: { kind: "remaining_volume", value: 10 },
    temperatureC: null,
    capturedAssignmentId: assignmentOpened.assignmentId,
    capturedFillId: assignmentOpened.fillId,
  };
  const authority: AuthorityChangedEvent = {
    tapId: assignmentOpened.tapId,
    previousSourceId: null,
    newSourceId: accepted.sourceId,
    changedAt: NOW,
    requiresFreshBaseline: true,
  };
  const density: EffectiveDensityChangedEvent = {
    beverageId: "00000000-0000-4000-8000-000000000006",
    previousDensity: { densityGPerMl: 1, specificGravity: 1, source: "fallback_fg" },
    newDensity: { densityGPerMl: 1.01, specificGravity: 1.01, source: "fallback_fg" },
    changedAt: NOW,
  };
  const keg: KegCorrectionEvent = {
    kegId: "00000000-0000-4000-8000-000000000007",
    previousCapacityMl: 19_000,
    newCapacityMl: 18_000,
    previousTareG: 1_000,
    newTareG: 1_100,
    changedAt: NOW,
  };

  ports.tap.onAssignmentOpened(database, assignmentOpened);
  ports.tap.onAssignmentClosed(database, assignmentClosed);
  ports.accepted.onAcceptedSample(database, accepted);
  ports.authority.onAuthorityChanged(database, authority);
  ports.keg.onKegCorrection(database, keg);
  ports.density.onEffectiveDensityChanged(database, density);
  ports.tap.onTapCreated?.(database, assignmentOpened.tapId, NOW);
  ports.tap.onTapRetired?.(database, assignmentOpened.tapId, NOW);

  assert.deepEqual(order, [
    "detector.assignment_opened",
    "health.assignment_opened",
    "detector.assignment_closed",
    "health.assignment_closed",
    "detector.accepted_sample",
    "health.accepted_sample",
    "detector.authority_changed",
    "health.authority_changed",
    "detector.keg_correction",
    "health.keg_correction",
    "detector.density_changed",
    "health.density_changed",
    "health.tap_created",
    "health.tap_retired",
  ]);
  database.close();
});

void test("Tap lifecycle hooks seed and retire health state transactionally", () => {
  const database = openDatabase(":memory:");
  const health = createHealthService(database, { now: () => new Date(NOW), idFactory: ids(100) });
  let failCreate = false;
  let failRetire = false;
  let retireCalls = 0;
  const extensionPort: TapAssignmentExtensionPort = {
    onAssignmentOpened: () => undefined,
    onAssignmentClosed: () => undefined,
    onTapCreated: (db, tapId, occurredAt) => {
      if (failCreate) throw new Error("create lifecycle failed");
      health.onTapCreated(db, tapId, occurredAt);
    },
    onTapRetired: (db, tapId, occurredAt) => {
      retireCalls += 1;
      if (failRetire) throw new Error("retire lifecycle failed");
      health.onTapRetired(db, tapId, occurredAt);
    },
  };
  const tapService = createTapService(database, {
    extensionPort,
    now: () => new Date(NOW),
    idFactory: ids(1),
  });

  const disabledTap = tapService.createTap({ tapNumber: 1, enabled: false });
  assert.equal(listHealthCheckStates(database, disabledTap.id).length, 5);
  assert.ok(
    listHealthCheckStates(database, disabledTap.id).every(
      (state) => state.state === "not_configured",
    ),
  );
  assert.equal(listActivity(database).length, 1);

  failCreate = true;
  assert.throws(() => tapService.createTap({ tapNumber: 2 }), /create lifecycle failed/);
  assert.equal(
    database.prepare<[], { count: number }>("SELECT count(*) AS count FROM taps").get()?.count,
    1,
  );
  assert.equal(listActivity(database).length, 1);
  failCreate = false;

  tapService.updateTap(disabledTap.id, { name: "Still disabled" });
  assert.equal(retireCalls, 0);
  assert.equal(listActivity(database).length, 2);

  const asyncLifecyclePort: TapAssignmentExtensionPort = {
    onAssignmentOpened: () => undefined,
    onAssignmentClosed: () => undefined,
    onTapCreated: () => ({ then() {} }),
  };
  const asyncTapService = createTapService(database, { extensionPort: asyncLifecyclePort });
  assert.throws(
    () => asyncTapService.createTap({ tapNumber: 3 }),
    /Tap lifecycle extensions must complete synchronously/,
  );
  assert.equal(
    database.prepare<[], { count: number }>("SELECT count(*) AS count FROM taps").get()?.count,
    1,
  );

  failRetire = true;
  assert.throws(() => tapService.retireTap(disabledTap.id), /retire lifecycle failed/);
  assert.equal(tapService.getTap(disabledTap.id).retiredAt, null);
  assert.equal(listActivity(database).length, 2);
  failRetire = false;

  tapService.retireTap(disabledTap.id);
  assert.equal(retireCalls, 2);
  assert.ok(
    listHealthCheckStates(database, disabledTap.id).every(
      (state) => state.state === "not_configured" && state.reason === "tap_retired",
    ),
  );
  assert.equal(listActivity(database).length, 3);
  database.close();
});

void test("Health maintenance timer stops without touching a closed database", async () => {
  const database = openDatabase(":memory:");
  let errors = 0;
  const health = createHealthService(database, {
    sweepIntervalMs: 1,
    onError: () => {
      errors += 1;
    },
  });
  health.startMaintenance();
  health.stopMaintenance();
  database.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors, 0);
});
