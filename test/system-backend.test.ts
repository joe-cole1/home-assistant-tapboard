import assert from "node:assert/strict";
import test from "node:test";

import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { createActivityService } from "../src/features/activity/operations.ts";
import { appendDeletionAudit } from "../src/features/activity/deletion-audit.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { insertSession } from "../src/features/auth/repository.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createForecastService } from "../src/features/forecasting/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createOutboundService } from "../src/features/outbound/service.ts";
import {
  createDestination,
  createDestinationVersion,
  pruneTerminalOutbox,
} from "../src/features/outbox/repository.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import {
  SystemService,
  type SystemServiceDependencies,
  type SystemMaintenanceError,
} from "../src/features/system/index.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import {
  insertTelemetryMeasurement,
  insertTelemetryReceipt,
} from "../src/features/telemetry/repository.ts";
import {
  insertCompletedPourIdempotently,
  readOpenTelemetryEpochForTap,
  readTelemetryEpoch,
} from "../src/features/telemetry/repositories/detector.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-30T12:00:00.000Z";
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

function harness() {
  let current = OLD;
  const now = () => new Date(current);
  const database = openDatabase(":memory:");
  const activityService = createActivityService(database);
  const authService = createAuthService(database, { now });
  const detector = new DetectorService(database, { now });
  const beverageService = createBeverageService(database, { now, densityExtensionPort: detector });
  const forecastService = createForecastService(database, { now });
  const machineKeyService = createMachineKeyService(database, { now });
  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    clock: now,
    authorityExtensionPort: detector,
    acceptedExtensionPort: detector,
  });
  const tapService = createTapService(database, { now, extensionPort: detector });
  const kegService = createKegService(database, { now });
  const fillService = createFillService(database, {
    now,
    beverageService,
    assignmentPort: tapService.asFillAssignmentPort(),
  });
  const dependencies = {
    database,
    activityService,
    authService,
    beverageService,
    forecastService,
    telemetryService,
    now,
  };
  const system = new SystemService(dependencies);
  return {
    ...dependencies,
    system,
    tapService,
    kegService,
    fillService,
    createSystem: (overrides: Partial<SystemServiceDependencies> = {}) =>
      new SystemService({ ...dependencies, ...overrides }),
    setNow: (value: string) => {
      current = value;
    },
    close: () => {
      system.stopMaintenance();
      database.close();
    },
  };
}

function setupDomain(h: ReturnType<typeof harness>) {
  const tap = h.tapService.createTap({ tapNumber: 1 });
  const keg = h.kegService.createKeg({ kegNumber: 1, capacityMl: 20_000, currentTareG: 1_000 });
  const beverage = h.beverageService.createCustomBeverage({
    name: "Test beer",
    beverageType: "beer",
  });
  const fill = h.fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  h.tapService.assignFill(tap.id, { fillId: fill.id });
  const source = h.telemetryService.createSource({ name: "Test scale" }).source;
  h.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });
  const epoch = readOpenTelemetryEpochForTap(h.database, tap.id)!;
  const pour = insertCompletedPourIdempotently(h.database, {
    id: id(90_000),
    effectKey: "system-test-terminal-effect",
    detectorSessionId: id(90_001),
    epochId: epoch.id,
    tapId: tap.id,
    fillId: fill.id,
    assignmentId: epoch.assignmentId,
    canonicalVolumeMl: 250,
    startedAt: OLD,
    completedAt: OLD,
    createdAt: OLD,
  }).pour;
  return { tap, keg, beverage, fill, source, epoch, pour };
}

function count(database: DatabaseConnection, table: string): number {
  return database.prepare<[], { count: number }>(`SELECT count(*) AS count FROM ${table}`).get()!
    .count;
}

function seedSession(database: DatabaseConnection, number: number, expiresAt = OLD) {
  const digest = Buffer.alloc(32, 8);
  digest.writeUInt32BE(number);
  insertSession(database, {
    id: id(100_000 + number),
    sessionDigest: digest,
    csrfDigest: Buffer.alloc(32, 9),
    credentialRevision: 1,
    createdAt: OLD,
    lastUsedAt: OLD,
    expiresAt,
    absoluteExpiresAt: expiresAt,
    revokedAt: null,
  });
}

function seedTelemetry(
  h: ReturnType<typeof harness>,
  domain: ReturnType<typeof setupDomain>,
  number: number,
  at = OLD,
) {
  const measurementId = id(200_000 + number);
  insertTelemetryMeasurement(h.database, {
    id: measurementId,
    source_id: domain.source.id,
    tap_id: domain.tap.id,
    measured_at: at,
    measured_at_epoch_ms: Date.parse(at) + number,
    received_at: at,
    normalization_version: 1,
    primary_kind: "remaining_volume",
    total_mass_g: null,
    remaining_volume_ml: 10_000,
    fill_percentage: null,
    temperature_c: null,
    captured_assignment_id: domain.epoch.assignmentId,
    captured_fill_id: domain.fill.id,
    created_at: at,
  });
  insertTelemetryReceipt(h.database, {
    id: id(300_000 + number),
    source_id: domain.source.id,
    tap_id: domain.tap.id,
    identity_kind: "client_sample_id",
    client_sample_id: `sample-${number}`,
    measured_at_epoch_ms: Date.parse(at) + number,
    payload_digest: "a".repeat(64),
    normalization_version: 1,
    outcome: "accepted",
    outcome_code: "telemetry.accepted",
    accepted_measurement_id: measurementId,
    measured_at: at,
    received_at: at,
    processed_at: at,
  });
}

type DeliveryState = "pending" | "leased" | "retry" | "succeeded" | "terminal" | "dismissed";
function seedEvent(database: DatabaseConnection, number: number, createdAt = OLD): string {
  const eventId = id(400_000 + number);
  const json = JSON.stringify({ event_id: eventId, private: "OUTBOX_PRIVATE_SENTINEL" });
  database
    .prepare<[string, string, string, number, string]>(
      "INSERT INTO outbound_events (id,event_type,schema_version,occurred_at,envelope_json,envelope_bytes,created_at) VALUES (?,'integration.status_changed',1,?,?,?,?)",
    )
    .run(eventId, createdAt, json, Buffer.byteLength(json), createdAt);
  return eventId;
}

function seedDelivery(
  database: DatabaseConnection,
  number: number,
  destinationId: string,
  versionId: string,
  state: DeliveryState,
  eventId = seedEvent(database, number),
  at = OLD,
): string {
  const deliveryId = id(500_000 + number);
  const terminal = state === "succeeded" || state === "terminal" || state === "dismissed";
  database
    .prepare<
      [
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        string | null,
      ]
    >(
      `INSERT INTO outbound_deliveries
     (id,event_id,destination_id,destination_version_id,state,attempt_count,next_attempt_at,lease_owner,lease_expires_at,revision,envelope_bytes,created_at,updated_at,terminal_at)
     VALUES (?,?,?,?,?,0,?,?,?,0,2,?,?,?)`,
    )
    .run(
      deliveryId,
      eventId,
      destinationId,
      versionId,
      state,
      at,
      state === "leased" ? "private-lease-owner" : null,
      state === "leased" ? at : null,
      at,
      at,
      terminal ? at : null,
    );
  return deliveryId;
}

void test("System calculation updates use existing feature ownership and preserve policy, epochs and pours", () => {
  const h = harness();
  try {
    const domain = setupDomain(h);
    h.beverageService.updateSettings({ brewfatherCompletionPolicy: "completed" });
    h.setNow(NOW);
    const updated = h.system.updateCalculationSettings(
      { fallbackFg: 1.018, servingSizeMl: 355 },
      { actorId: "admin", sessionId: "private-session" },
    );
    assert.deepEqual(updated, { fallbackFg: 1.018, servingSizeMl: 355 });
    assert.equal(h.beverageService.getSettings().brewfatherCompletionPolicy, "completed");
    assert.equal(readTelemetryEpoch(h.database, domain.epoch.id)?.endedAt, NOW);
    const next = readOpenTelemetryEpochForTap(h.database, domain.tap.id)!;
    assert.notEqual(next.id, domain.epoch.id);
    assert.equal(next.densitySource, "fallback_fg");
    assert.equal(
      readTelemetryEpoch(h.database, domain.epoch.id)?.densityGPerMl,
      domain.epoch.densityGPerMl,
    );
    assert.equal(count(h.database, "pours"), 1);
    assert.equal(h.forecastService.getPourHistory(domain.fill.id).pours[0]?.canonicalVolumeMl, 250);
    const activityCount = count(h.database, "activity_log");
    assert.deepEqual(h.system.updateCalculationSettings(updated), updated);
    assert.equal(count(h.database, "activity_log"), activityCount);
  } finally {
    h.close();
  }
});

void test("System calculation validation and feature failures cannot leave partial settings or epoch changes", () => {
  const h = harness();
  try {
    const domain = setupDomain(h);
    const previous = h.system.getCalculationSettings();
    const activityCount = count(h.database, "activity_log");
    for (const input of [
      { fallbackFg: 1.02, servingSizeMl: 0 },
      { fallbackFg: 1.02, brewfatherCompletionPolicy: "never" },
      { fallbackFg: null },
      { fallbackFg: "1.018" },
      { servingSizeMl: Infinity },
      { servingSizeMl: 300, sql: "private" },
      {},
    ])
      assert.throws(() => h.system.updateCalculationSettings(input), ApplicationError);
    assert.throws(
      () => h.system.updateCalculationSettings({ servingSizeMl: 300 }, { actorId: "bad\nactor" }),
      ApplicationError,
    );
    const failed = h.createSystem({
      forecastService: {
        ...h.forecastService,
        updateSettings: () => {
          throw new Error("private failure");
        },
      },
    });
    assert.throws(() => failed.updateCalculationSettings({ fallbackFg: 1.02, servingSizeMl: 300 }));
    assert.deepEqual(h.system.getCalculationSettings(), previous);
    assert.equal(readTelemetryEpoch(h.database, domain.epoch.id)?.endedAt, null);
    assert.equal(readOpenTelemetryEpochForTap(h.database, domain.tap.id)?.id, domain.epoch.id);
    assert.equal(count(h.database, "activity_log"), activityCount);
  } finally {
    h.close();
  }
});

void test("System validates all retention groups and merged receipt horizons before mutation", () => {
  const h = harness();
  try {
    const before = h.system.getRetentionSettings();
    const activityCount = count(h.database, "activity_log");
    for (const input of [
      { activity: { retentionDays: 1 }, outbox: { retentionDays: 0 } },
      { activity: { retentionDays: 1 }, telemetry: { receiptRetentionSeconds: 3_600 } },
      {
        activity: { retentionDays: 1 },
        telemetry: { reconnectHorizonSeconds: 86_400, receiptRetentionSeconds: 43_200 },
      },
      { telemetry: { rawRetentionSeconds: 86_400, receiptRetentionSeconds: 43_200 } },
      { outbox: { retentionDays: 3_651 } },
      { activity: { retentionDays: 0.5 } },
      { telemetry: { maxBatchSize: 1 } },
      { telemetry: {} },
      { telemetry: { rawRetentionSeconds: "300" } },
      { sql: "SELECT private" },
      {},
    ])
      assert.throws(() => h.system.updateRetentionSettings(input), ApplicationError);
    assert.deepEqual(h.system.getRetentionSettings(), before);
    assert.equal(count(h.database, "activity_log"), activityCount);
    h.setNow(NOW);
    const updated = h.system.updateRetentionSettings({
      activity: { retentionDays: 1 },
      telemetry: {
        rawRetentionSeconds: 300,
        receiptRetentionSeconds: 3_600,
        reconnectHorizonSeconds: 3_600,
      },
      outbox: { retentionDays: 3_650 },
    });
    assert.equal(updated.activity.retentionDays, 1);
    assert.equal(updated.telemetry.rawRetentionSeconds, 300);
    assert.equal(updated.telemetry.receiptRetentionSeconds, 3_600);
    assert.equal(updated.outbox.retentionDays, 3_650);
    assert.equal(updated.outbox.revision, before.outbox.revision + 1);
    assert.ok(
      h.system
        .getActivityPage()
        .items.some((item) => item.entityType === "system_retention_settings"),
    );
    const afterCount = count(h.database, "activity_log");
    assert.deepEqual(
      h.system.updateRetentionSettings({ outbox: { retentionDays: 3_650 } }),
      updated,
    );
    assert.equal(count(h.database, "activity_log"), afterCount);
  } finally {
    h.close();
  }
});

void test("System settings and feature Activity writes roll back if the final retention audit fails", () => {
  const h = harness();
  try {
    const before = h.system.getRetentionSettings();
    const activityCount = count(h.database, "activity_log");
    const failed = h.createSystem({
      activityService: {
        ...h.activityService,
        append: () => {
          throw new Error("private audit failure");
        },
      },
    });
    assert.throws(() =>
      failed.updateRetentionSettings({
        activity: { retentionDays: 1 },
        telemetry: { rawRetentionSeconds: 300 },
        outbox: { retentionDays: 5 },
      }),
    );
    assert.deepEqual(h.system.getRetentionSettings(), before);
    assert.equal(count(h.database, "activity_log"), activityCount);
  } finally {
    h.close();
  }
});

void test("Activity pagination is capped, stable for tied timestamps, filterable and redacted", () => {
  const h = harness();
  try {
    for (let number = 1; number <= 105; number++)
      h.activityService.append({
        id: id(number),
        category: "admin",
        action: "configuration_changed",
        actorType: "admin",
        actorId: "ACTOR_PRIVATE_SENTINEL",
        sessionId: "SESSION_PRIVATE_SENTINEL",
        entityType: number === 1 ? "https://private.invalid/endpoint" : "tap",
        entityId: "ENTITY_PRIVATE_SENTINEL",
        details: { private: "DETAIL_PRIVATE_SENTINEL", endpoint: "https://private.invalid/path" },
        occurredAt: NOW,
      });
    h.activityService.append({
      category: "security",
      action: "session_revoked",
      actorType: "admin",
      occurredAt: NOW,
    });
    const first = h.system.getActivityPage({ category: "admin" });
    assert.equal(first.items.length, 50);
    assert.equal(first.pageSize, 50);
    assert.ok(first.nextCursor);
    const second = h.system.getActivityPage({ category: "admin", cursor: first.nextCursor });
    assert.equal(second.items.length, 50);
    assert.ok(second.nextCursor);
    const third = h.system.getActivityPage({ category: "admin", cursor: second.nextCursor });
    assert.equal(third.items.length, 5);
    assert.equal(third.nextCursor, null);
    const all = [...first.items, ...second.items, ...third.items];
    assert.deepEqual(
      all.map((item) => item.id),
      Array.from({ length: 105 }, (_, number) => id(105 - number)),
    );
    assert.equal(all.at(-1)?.entityType, null);
    const json = JSON.stringify(all);
    for (const forbidden of ["PRIVATE_SENTINEL", "https://", "actorId", "sessionId", "details"])
      assert.equal(json.includes(forbidden), false);
    assert.equal(h.system.getActivityPage({ category: "security" }).items.length, 1);
    assert.ok(all.every((item) => item.entityId === null));
  } finally {
    h.close();
  }
});

void test("Activity projects canonical UUIDs only for explicitly allowlisted resource identities", () => {
  const h = harness();
  try {
    const entries = [
      ["tap", id(1), id(1)],
      ["beverage", id(2), id(2)],
      ["keg", id(3), id(3)],
      ["fill", id(4), id(4)],
      ["telemetry_source", id(5), id(5)],
      ["outbound_destination", id(6), id(6)],
      ["health_incident", id(7), id(7)],
      ["tap_war", id(8), id(8)],
      ["admin_session", id(9), id(9)],
      ["tap", "PRIVATE_SESSION_SENTINEL", null],
      ["tap", "https://internal.invalid/private", null],
      ["tap", id(10).toUpperCase(), null],
      ["beverage_settings", id(11), null],
      ["secret", id(12), null],
      ["arbitrary", id(13), null],
    ] as const;
    for (let number = 0; number < entries.length; number++) {
      const [entityType, entityId] = entries[number]!;
      h.activityService.append({
        id: id(1_000 + number),
        category: "admin",
        action: "configuration_changed",
        actorType: "admin",
        entityType,
        entityId,
        occurredAt: NOW,
      });
    }
    const page = h.system.getActivityPage();
    for (let number = 0; number < entries.length; number++) {
      assert.equal(
        page.items.find((item) => item.id === id(1_000 + number))?.entityId,
        entries[number]![2],
      );
    }
    assert.equal(JSON.stringify(page).includes("PRIVATE_SESSION_SENTINEL"), false);
    assert.equal(JSON.stringify(page).includes("https://"), false);
  } finally {
    h.close();
  }
});

void test("Activity cursors and input reject malformed, arbitrary and accessor-bearing requests", () => {
  const h = harness();
  try {
    for (const cursor of [
      "",
      "!",
      "a".repeat(181),
      Buffer.from(JSON.stringify([NOW, "not-a-uuid"])).toString("base64url"),
      Buffer.from(JSON.stringify(["2026-09-30", id(1)])).toString("base64url"),
      Buffer.from(JSON.stringify({ time: NOW, id: id(1) })).toString("base64url"),
    ]) {
      assert.throws(() => h.system.getActivityPage({ cursor }), ApplicationError);
    }
    assert.throws(() => h.system.getActivityPage({ category: "unknown" }), ApplicationError);
    assert.throws(() => h.system.getActivityPage({ limit: 1_000 } as never), ApplicationError);
    let reads = 0;
    const input = Object.defineProperty({}, "fallbackFg", {
      enumerable: true,
      get() {
        reads++;
        return 1.01;
      },
    });
    assert.throws(() => h.system.updateCalculationSettings(input), ApplicationError);
    assert.equal(reads, 0);
  } finally {
    h.close();
  }
});

void test("System retention performs one bounded batch in order and preserves first-use and domain history", () => {
  const h = harness();
  try {
    const domain = setupDomain(h);
    const firstUsedAt = h.tapService.getTap(domain.tap.id).firstUsedAt;
    appendDeletionAudit(h.database, {
      entityType: "fill",
      entityId: id(8),
      actorType: "admin",
      impacts: [{ code: "pours", count: 2 }],
      deletedAt: OLD,
    });
    h.database.withTransaction(() => {
      for (let number = 1; number <= 1_005; number++)
        h.activityService.append({
          id: id(number),
          category: "admin",
          action: "configuration_changed",
          actorType: "admin",
          occurredAt: OLD,
        });
      for (let number = 1; number <= 1_005; number++) seedSession(h.database, number);
      for (let number = 1; number <= 605; number++) seedTelemetry(h, domain, number);
    });
    seedSession(h.database, 2_000, "2026-10-30T12:00:00.000Z");
    h.database
      .execute(`CREATE TRIGGER system_receipt_order BEFORE DELETE ON telemetry_ingest_receipts
      WHEN EXISTS (SELECT 1 FROM telemetry_measurements WHERE id = OLD.accepted_measurement_id)
      BEGIN SELECT RAISE(ABORT, 'receipt removed before raw measurement'); END`);
    const protectedTables = [
      "taps",
      "kegs",
      "fills",
      "tap_assignment_lifecycles",
      "telemetry_epochs",
      "telemetry_epoch_state",
      "pours",
      "deletion_audit",
    ];
    const before = protectedTables.map((table) => count(h.database, table));
    const activityBefore = count(h.database, "activity_log");
    h.setNow(NOW);
    const result = h.system.runRetention();
    assert.equal(result.activity, 1_000);
    assert.equal(result.rawTelemetry, 500);
    assert.equal(result.ingestReceipts, 500);
    assert.equal(result.sessions, 1_000);
    assert.equal(count(h.database, "activity_log"), activityBefore - 1_000);
    assert.equal(count(h.database, "telemetry_measurements"), 105);
    assert.equal(count(h.database, "telemetry_ingest_receipts"), 105);
    assert.equal(count(h.database, "admin_sessions"), 6);
    assert.deepEqual(
      protectedTables.map((table) => count(h.database, table)),
      before,
    );
    assert.equal(h.tapService.getTap(domain.tap.id).firstUsedAt, firstUsedAt);
    assert.equal(h.forecastService.getPourHistory(domain.fill.id).pours[0]?.pourId, domain.pour.id);
    assert.equal(h.system.getDiagnostics().retention.lastOutcome, "completed");
    assert.deepEqual(h.database.pragma("foreign_key_check"), []);
  } finally {
    h.close();
  }
});

void test("System raw pruning preserves unexpired durable receipts and hardware projections", () => {
  const h = harness();
  try {
    const domain = setupDomain(h);
    h.telemetryService.updateSettings({
      rawRetentionSeconds: 300,
      receiptRetentionSeconds: 3_600,
      reconnectHorizonSeconds: 3_600,
    });
    const sample = {
      clientSampleId: "retention-retry",
      measuredAt: OLD,
      remainingVolume: { value: 10_000, unit: "ml" },
    };
    const accepted = h.telemetryService.ingestSingle(domain.source, 1, sample);
    assert.equal(accepted.outcome, "accepted");
    h.setNow("2026-01-01T00:20:00.000Z");
    const pruned = h.system.runRetention();
    assert.equal(pruned.rawTelemetry, 1);
    assert.equal(pruned.ingestReceipts, 0);
    assert.equal(
      h.telemetryService.getTapLatestHardwareStatus(domain.tap.id)[0]?.remainingVolumeMl,
      10_000,
    );
    const duplicate = h.telemetryService.ingestSingle(domain.source, 1, sample);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.acceptedMeasurementId, accepted.acceptedMeasurementId);
    assert.equal(count(h.database, "pours"), 1);
  } finally {
    h.close();
  }
});

void test("Terminal outbox retention protects active deliveries, shared events and current destination versions", () => {
  const h = harness();
  try {
    const secrets = createSecretsService(h.database, {
      rootKey: Buffer.alloc(32, 7).toString("base64url"),
      now: h.now,
    });
    const outbound = createOutboundService(h.database, { secrets, now: h.now });
    const destination = outbound.create({
      label: "private destination",
      transport: "webhook",
      webhookUrl: "https://example.test/private-path",
    });
    const firstVersion = destination.currentVersion!.id;
    const obsoleteVersion = outbound.edit(destination.id, { payloadFormat: "discord" })
      .currentVersion!.id;
    const currentVersion = outbound.edit(destination.id, { payloadFormat: "standard" })
      .currentVersion!.id;
    const other = createDestination(h.database, { label: "Other", createdAt: OLD });
    const otherVersion = createDestinationVersion(h.database, {
      destinationId: other.id,
      versionNumber: 1,
      createdAt: OLD,
    });
    const shared = seedEvent(h.database, 1);
    const pending = seedDelivery(h.database, 1, destination.id, firstVersion, "pending", shared);
    const sharedTerminal = seedDelivery(
      h.database,
      2,
      other.id,
      otherVersion.id,
      "terminal",
      shared,
    );
    const leased = seedDelivery(h.database, 3, destination.id, firstVersion, "leased");
    const retry = seedDelivery(h.database, 4, destination.id, firstVersion, "retry");
    const expiredTerminal = seedDelivery(
      h.database,
      5,
      destination.id,
      obsoleteVersion,
      "succeeded",
    );
    const recent = seedDelivery(
      h.database,
      6,
      destination.id,
      currentVersion,
      "terminal",
      seedEvent(h.database, 6),
      NOW,
    );
    const cutoff = new Date(Date.parse(NOW) - 30 * 86_400_000).toISOString();
    const result = pruneTerminalOutbox(h.database, cutoff);
    assert.equal(result.deliveries, 2);
    assert.equal(result.events, 1);
    assert.equal(result.versions, 1);
    const ids = h.database
      .prepare<[], { id: string }>("SELECT id FROM outbound_deliveries ORDER BY id")
      .all()
      .map((row) => row.id);
    assert.deepEqual(ids, [pending, leased, retry, recent]);
    assert.equal(ids.includes(sharedTerminal), false);
    assert.equal(ids.includes(expiredTerminal), false);
    assert.ok(h.database.prepare("SELECT id FROM outbound_events WHERE id = ?").get(shared));
    assert.ok(
      h.database
        .prepare("SELECT id FROM outbound_destination_versions WHERE id = ?")
        .get(firstVersion),
    );
    assert.ok(
      h.database
        .prepare("SELECT id FROM outbound_destination_versions WHERE id = ?")
        .get(currentVersion),
    );
    assert.ok(
      h.database
        .prepare("SELECT id FROM outbound_destination_versions WHERE id = ?")
        .get(obsoleteVersion),
    );
    assert.deepEqual(h.database.pragma("foreign_key_check"), []);
  } finally {
    h.close();
  }
});

void test("Outbox retention preserves encrypted endpoint ownership until explicit destination retirement", () => {
  const h = harness();
  try {
    const secrets = createSecretsService(h.database, {
      rootKey: Buffer.alloc(32, 7).toString("base64url"),
      now: h.now,
    });
    const outbound = createOutboundService(h.database, { secrets, now: h.now });
    const destination = outbound.create({
      label: "Endpoint history",
      transport: "webhook",
      webhookUrl: "https://example.test/retention-private-first",
    });
    const firstVersion = destination.currentVersion!.id;
    const secondVersion = outbound.edit(destination.id, {
      webhookUrl: "https://example.test/retention-private-second",
    }).currentVersion!.id;
    const currentVersion = outbound.edit(destination.id, {
      webhookUrl: "https://example.test/retention-private-current",
    }).currentVersion!.id;
    h.setNow(NOW);
    const cutoff = new Date(Date.parse(NOW) - 30 * 86_400_000).toISOString();
    assert.equal(pruneTerminalOutbox(h.database, cutoff).versions, 0);
    assert.deepEqual(
      new Set(secrets.list().map((secret) => secret.recordId)),
      new Set([firstVersion, secondVersion, currentVersion]),
    );
    assert.equal(count(h.database, "outbound_destination_versions"), 3);
    outbound.retire(destination.id);
    assert.equal(secrets.list().length, 0);
    assert.equal(pruneTerminalOutbox(h.database, cutoff).versions, 2);
    assert.equal(count(h.database, "outbound_destination_versions"), 1);
    assert.ok(
      h.database
        .prepare("SELECT id FROM outbound_destination_versions WHERE id = ?")
        .get(currentVersion),
    );
    assert.deepEqual(h.database.pragma("foreign_key_check"), []);
  } finally {
    h.close();
  }
});

void test("System outbox maintenance has a shared bounded budget and never drains a backlog", () => {
  const h = harness();
  try {
    const destination = createDestination(h.database, { label: "Queue", createdAt: OLD });
    const version = createDestinationVersion(h.database, {
      destinationId: destination.id,
      versionNumber: 1,
      createdAt: OLD,
    });
    h.database.withTransaction(() => {
      for (let number = 1; number <= 105; number++)
        seedDelivery(h.database, number, destination.id, version.id, "dismissed");
    });
    h.setNow(NOW);
    const first = h.system.runRetention();
    assert.equal(first.outboxDeliveries, 100);
    assert.equal(first.outboxEvents, 0);
    assert.equal(first.outboxVersions, 0);
    assert.equal(count(h.database, "outbound_deliveries"), 5);
    assert.equal(count(h.database, "outbound_events"), 105);
    const second = h.system.runRetention();
    assert.equal(second.outboxDeliveries, 5);
    assert.equal(second.outboxEvents, 95);
    assert.equal(second.outboxVersions, 0);
    assert.equal(count(h.database, "outbound_events"), 10);
    for (const limit of [0, 101, 1.5])
      assert.throws(() => pruneTerminalOutbox(h.database, OLD, limit));
    assert.throws(() => pruneTerminalOutbox(h.database, "2026-01-01"));
  } finally {
    h.close();
  }
});

void test("Retention failure rolls back pruning and exposes only a fixed safe error", () => {
  const h = harness();
  try {
    h.activityService.append({
      category: "admin",
      action: "configuration_changed",
      actorType: "admin",
      occurredAt: OLD,
    });
    h.setNow(NOW);
    const failed = h.createSystem({
      authService: {
        pruneExpiredSessions: () => {
          throw new Error("PRIVATE_ERROR_SENTINEL https://internal.invalid?token=private");
        },
      },
    });
    assert.throws(
      () => failed.runRetention(),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "system.retention_failed");
        assert.equal(error.cause, undefined);
        assert.equal(error.details, undefined);
        assert.equal(error.message.includes("PRIVATE"), false);
        return true;
      },
    );
    assert.equal(count(h.database, "activity_log"), 1);
    assert.equal(failed.getDiagnostics().retention.lastOutcome, "failed");
    assert.equal(failed.getDiagnostics().retention.lastPruned, null);
  } finally {
    h.close();
  }
});

void test("System diagnostics expose fixed counts, storage metadata and safe outcomes without private data", () => {
  const h = harness();
  try {
    const secrets = createSecretsService(h.database, {
      rootKey: Buffer.alloc(32, 7).toString("base64url"),
      now: h.now,
    });
    secrets.upsert("brewfather", "default", "api_key", "SECRET_PRIVATE_SENTINEL");
    h.activityService.append({
      category: "admin",
      action: "configuration_changed",
      actorType: "admin",
      actorId: "ACTOR_PRIVATE_SENTINEL",
      sessionId: "SESSION_PRIVATE_SENTINEL",
      entityType: "https://internal.invalid/private",
      details: { note: "NOTE_PRIVATE_SENTINEL" },
      occurredAt: OLD,
    });
    seedSession(h.database, 1);
    const diagnostics = h.system.getDiagnostics();
    assert.equal(diagnostics.counts.activity, 2);
    assert.equal(diagnostics.counts.sessions, 1);
    assert.equal(diagnostics.storage.schemaVersion, 22);
    assert.ok(diagnostics.storage.pageSizeBytes > 0);
    assert.deepEqual(diagnostics.retention, {
      running: false,
      lastRunAt: null,
      lastOutcome: "never_run",
      lastPruned: null,
    });
    assert.deepEqual(Object.keys(diagnostics), ["counts", "storage", "retention"]);
    for (const forbidden of [
      "PRIVATE_SENTINEL",
      "https://",
      "digest",
      "nonce",
      "ciphertext",
      "config",
      "endpoint",
      "details",
      "sessionId",
    ])
      assert.equal(JSON.stringify(diagnostics).includes(forbidden), false);
  } finally {
    h.close();
  }
});

void test("Maintenance starts once, skips reentrant runs, stops cleanly and sanitizes timer failures", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const errors: SystemMaintenanceError[] = [];
  let calls = 0;
  let stopped = false;
  const maintenance: SystemService = h.createSystem({
    maintenanceIntervalMs: 1_000,
    onError: (error) => {
      errors.push(error);
      throw new Error("PRIVATE_CALLBACK_SENTINEL");
    },
    activityService: {
      ...h.activityService,
      prune: () => {
        calls++;
        assert.throws(
          () => maintenance.runRetention(),
          (error: unknown) =>
            error instanceof ApplicationError && error.code === "system.retention_running",
        );
        if (stopped) maintenance.stopMaintenance();
        throw new Error("PRIVATE_TIMER_SENTINEL");
      },
    },
  });
  try {
    maintenance.startMaintenance();
    maintenance.startMaintenance();
    context.mock.timers.tick(1);
    assert.equal(calls, 1);
    context.mock.timers.tick(1_000);
    assert.equal(calls, 2);
    assert.equal(errors.length, 2);
    assert.equal(errors[0]?.code, "system.retention_failed");
    assert.equal(JSON.stringify(errors).includes("PRIVATE"), false);
    maintenance.stopMaintenance();
    context.mock.timers.tick(5_000);
    assert.equal(calls, 2);
    stopped = true;
    maintenance.startMaintenance();
    context.mock.timers.tick(1);
    assert.equal(calls, 3);
    context.mock.timers.tick(5_000);
    assert.equal(calls, 3);
    h.database.close();
    context.mock.timers.tick(5_000);
    assert.equal(calls, 3);
  } finally {
    maintenance.stopMaintenance();
    h.close();
  }
});
