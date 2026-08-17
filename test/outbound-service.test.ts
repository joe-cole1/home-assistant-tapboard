import assert from "node:assert/strict";
import test from "node:test";

import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createOutboundService, type OutboundService } from "../src/features/outbound/service.ts";
import { readActivities } from "../src/features/activity/operations.ts";

const ROOT_KEY = Buffer.alloc(32, 9).toString("base64url");
const NOW = "2026-08-17T12:00:00.000Z";
const DESTINATION = "11111111-1111-4111-8111-111111111111";
const DESTINATION_TWO = "11111111-1111-4111-8111-111111111112";
const FILL = "44444444-4444-4444-8444-444444444444";
const TAP = "55555555-5555-4555-8555-555555555555";
const ASSIGNMENT = "66666666-6666-4666-8666-666666666666";
const SECRET_SENTINEL = "SENTINEL_OUTBOUND_SECRET_MUST_NOT_ESCAPE";

function harness(): {
  readonly database: DatabaseConnection;
  readonly service: OutboundService;
  readonly secrets: ReturnType<typeof createSecretsService>;
  readonly setNow: (value: string) => void;
} {
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, { rootKey: ROOT_KEY });
  let now = NOW;
  let sequence = 0;
  const service = createOutboundService(database, {
    secrets,
    now: () => new Date(now),
    idFactory: () => `22222222-2222-4222-8222-${(sequence++ + 1).toString(16).padStart(12, "0")}`,
  });
  return {
    database,
    service,
    secrets,
    setNow: (value) => {
      now = value;
    },
  };
}

function rowCount(database: DatabaseConnection, table: string): number {
  return database
    .prepare<[], { readonly count: number }>(`SELECT count(*) AS count FROM ${table}`)
    .get()!.count;
}

void test("destination defaults, immutable versions, safe projections, and payload format", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Discord hook",
      transport: "webhook",
      webhookUrl: "https://example.test/private-hook",
      payloadFormat: "discord",
    });
    assert.equal(created.enabled, true);
    assert.equal(created.required, false);
    assert.equal(created.subscriptions.length, 6);
    assert.equal(created.currentVersion?.versionNumber, 1);
    assert.equal(created.currentVersion?.config.transport, "webhook");
    assert.equal(
      created.currentVersion?.config.transport === "webhook" &&
        created.currentVersion.config.payloadFormat,
      "discord",
    );
    assert.equal(JSON.stringify(created).includes("private-hook"), false);
    assert.equal(JSON.stringify(created).includes("https://example.test/private-hook"), false);
    assert.equal(JSON.stringify(secrets.list()).includes("private-hook"), false);

    const edited = service.edit(DESTINATION, { payloadFormat: "standard" });
    assert.equal(edited.currentVersion?.versionNumber, 2);
    assert.equal(
      edited.currentVersion?.config.transport === "webhook" &&
        edited.currentVersion.config.payloadFormat,
      "standard",
    );
    assert.equal(rowCount(database, "outbound_destination_versions"), 2);
    assert.equal(rowCount(database, "outbound_destination_configs"), 2);
    assert.equal(rowCount(database, "outbound_destination_subscriptions"), 12);

    const replacedEndpoint = "https://replacement.example.test/new-hook?token=rotated";
    const replaced = service.edit(DESTINATION, { webhookUrl: replacedEndpoint });
    assert.equal(replaced.currentVersion?.versionNumber, 3);
    assert.equal(
      secrets.revealPrivileged("outbound", replaced.currentVersion.id, "endpoint"),
      replacedEndpoint,
    );
    assert.equal(
      secrets.revealPrivileged("outbound", created.currentVersion.id, "endpoint"),
      "https://example.test/private-hook",
    );
  } finally {
    database.close();
  }
});

void test("malformed secret-bearing configuration fails without exposing or persisting secrets", () => {
  const { database, service, secrets } = harness();
  try {
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Invalid HA",
        transport: "home_assistant",
        baseUrl: "http://ha.test?ambiguous=1",
        secret: SECRET_SENTINEL,
      }),
    );
    assert.deepEqual(service.list(), []);
    assert.equal(JSON.stringify(readActivities(database)).includes(SECRET_SENTINEL), false);
    assert.equal(JSON.stringify(secrets.list()).includes(SECRET_SENTINEL), false);

    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Plain authorization",
        transport: "webhook",
        webhookUrl: "https://example.test/hook",
        staticHeaders: [{ name: "Authorization", value: `Bearer ${SECRET_SENTINEL}` }],
      }),
    );
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Reserved slot",
        transport: "webhook",
        webhookUrl: "https://example.test/hook",
        secretHeaders: [{ name: "X-Token", slot: "token_current" }],
      }),
    );
    assert.throws(() =>
      service.create({
        id: DESTINATION,
        label: "Divergent endpoint",
        transport: "webhook",
        webhookUrl: "https://example.test/hook",
        secret: "https://different.example.test/hook",
      }),
    );
    assert.deepEqual(service.list(), []);
    assert.equal(JSON.stringify(readActivities(database)).includes(SECRET_SENTINEL), false);

    service.create({
      id: DESTINATION,
      label: "Header hook",
      transport: "webhook",
      webhookUrl: "https://example.test/hook",
      secretHeaders: [{ name: "Authorization" }],
    });
    const slot = service.get(DESTINATION)!.currentVersion!.config.secretHeaders[0]!.slot;
    assert.throws(() => service.setHeaderSecret(DESTINATION, slot, `${SECRET_SENTINEL}\n`));
    assert.equal(JSON.stringify(service.get(DESTINATION)).includes(SECRET_SENTINEL), false);
    assert.equal(JSON.stringify(readActivities(database)).includes(SECRET_SENTINEL), false);
    assert.equal(JSON.stringify(secrets.list()).includes(SECRET_SENTINEL), false);
  } finally {
    database.close();
  }
});

void test("HA token rotation does not fake recovery and removal disables the destination", () => {
  const { database, service, secrets } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "HA",
      transport: "home_assistant",
      baseUrl: "http://home-assistant.test",
      required: true,
      enabled: false,
    });
    service.setToken(DESTINATION, "first-token");
    service.enable(DESTINATION);
    service.recordFailure(DESTINATION, "ha_auth_invalid", "authentication");
    service.setToken(DESTINATION, "rotated-token");
    assert.equal(service.get(DESTINATION)?.failure?.code, "ha_auth_invalid");
    assert.equal(
      secrets.revealPrivileged("outbound", DESTINATION, "token_current"),
      "rotated-token",
    );
    service.removeToken(DESTINATION);
    const removed = service.get(DESTINATION)!;
    assert.equal(removed.enabled, false);
    assert.equal(removed.state, "disabled");
    assert.equal(
      secrets
        .list()
        .some((item) => item.recordId === DESTINATION && item.fieldName === "token_current"),
      false,
    );
  } finally {
    database.close();
  }
});

void test("optional failures remain visible while required degradation waits five minutes", () => {
  const { database, service, setNow } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Required",
      transport: "home_assistant",
      baseUrl: "http://ha.test",
      required: true,
    });
    service.create({
      id: DESTINATION_TWO,
      label: "Optional",
      transport: "home_assistant",
      baseUrl: "http://ha2.test",
    });
    service.recordFailure(DESTINATION, "auth_invalid", "authentication");
    service.recordFailure(DESTINATION_TWO, "connect_timeout", "connectivity");
    assert.equal(service.get(DESTINATION)?.state, "needs_attention");
    assert.equal(service.get(DESTINATION_TWO)?.state, "failing");
    assert.equal(service.connectivity().state, "healthy");
    setNow("2026-08-17T12:05:00.000Z");
    assert.equal(service.get(DESTINATION)?.state, "degraded");
    assert.equal(service.connectivity().state, "degraded");
  } finally {
    database.close();
  }
});

void test("aggregate connectivity stays degraded until every required destination recovers", () => {
  const { database, service, setNow } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Required one",
      transport: "webhook",
      webhookUrl: "https://one.example.test/hook",
      required: true,
    });
    service.create({
      id: DESTINATION_TWO,
      label: "Required two",
      transport: "webhook",
      webhookUrl: "https://two.example.test/hook",
      required: true,
    });
    service.recordFailure(DESTINATION, "connect_timeout", "connectivity");
    service.recordFailure(DESTINATION_TWO, "webhook_http_500", "connectivity");
    setNow("2026-08-17T12:04:59.000Z");
    assert.equal(service.connectivity().state, "healthy");
    setNow("2026-08-17T12:05:00.000Z");
    assert.deepEqual(
      new Set(service.connectivity().degradedRequiredDestinationIds),
      new Set([DESTINATION, DESTINATION_TWO]),
    );
    service.recordSuccess(DESTINATION);
    assert.deepEqual(service.connectivity().degradedRequiredDestinationIds, [DESTINATION_TWO]);
    service.recordSuccess(DESTINATION_TWO);
    assert.equal(service.connectivity().state, "healthy");
  } finally {
    database.close();
  }
});

void test("retirement dismisses pending work and revokes endpoint material", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Retired hook",
      transport: "webhook",
      webhookUrl: "https://retire.example.test/hook",
    });
    service.pourCompleted(database, {
      fillId: FILL,
      tapId: TAP,
      canonicalVolumeMl: 355,
      completedAt: NOW,
    });
    const retired = service.retire(DESTINATION);
    assert.equal(retired.retiredAt, NOW);
    assert.equal(retired.enabled, false);
    assert.equal(service.listDeliveries(DESTINATION)[0]?.state, "dismissed");
    assert.equal(
      secrets
        .list()
        .some((item) => item.recordId === created.currentVersion!.id && item.configured),
      false,
    );
  } finally {
    database.close();
  }
});

void test("secret header slots follow logical names and removal pauses historical delivery", () => {
  const { database, service, secrets } = harness();
  try {
    const created = service.create({
      id: DESTINATION,
      label: "Header hook",
      transport: "webhook",
      webhookUrl: "https://example.test/hook",
      secretHeaders: [{ name: "X-First" }, { name: "X-Second" }],
    });
    const first = created.currentVersion!.config;
    assert.equal(first.transport, "webhook");
    const firstSlots = new Map(first.secretHeaders.map((header) => [header.name, header.slot]));
    const edited = service.edit(DESTINATION, {
      secretHeaders: [{ name: "X-Second" }, { name: "X-First" }],
    });
    const second = edited.currentVersion!.config;
    assert.equal(second.transport, "webhook");
    assert.equal(
      second.secretHeaders.find((header) => header.name === "X-First")?.slot,
      firstSlots.get("X-First"),
    );
    assert.equal(
      second.secretHeaders.find((header) => header.name === "X-Second")?.slot,
      firstSlots.get("X-Second"),
    );

    const firstSlot = firstSlots.get("X-First")!;
    service.setHeaderSecret(DESTINATION, firstSlot, "header-secret");
    assert.equal(JSON.stringify(service.get(DESTINATION)).includes("header-secret"), false);
    service.removeHeaderSecret(DESTINATION, firstSlot);
    assert.equal(service.get(DESTINATION)?.enabled, false);
    assert.throws(
      () => service.enable(DESTINATION),
      /Every configured secret header requires a value/u,
    );
    assert.equal(
      secrets.list().some((item) => item.recordId === DESTINATION && item.fieldName === firstSlot),
      false,
    );
  } finally {
    database.close();
  }
});

void test("producer admission methods preserve fill-end semantics and low-keg evidence", () => {
  const { database, service } = harness();
  try {
    service.create({
      id: DESTINATION,
      label: "Events",
      transport: "webhook",
      webhookUrl: "https://example.test/events",
    });
    const closed = {
      assignmentId: ASSIGNMENT,
      tapId: TAP,
      fillId: FILL,
      occurredAt: NOW,
      reason: "unassigned" as const,
    };
    assert.deepEqual(service.assignmentClosed(database, closed), { status: "no_targets" });
    assert.equal(rowCount(database, "outbound_events"), 0);
    assert.equal(service.assignmentClosed(database, closed, "manual").status, "queued");
    assert.equal(
      service.healthTransitioned(database, {
        tapId: TAP,
        checkId: "low_keg",
        previousState: "healthy",
        previousSeverity: "none",
        current: {
          state: "degraded",
          severity: "warning",
          evidence: { remaining_percent: 12, threshold_percent: 20 },
        },
        occurredAt: NOW,
      }).status,
      "queued",
    );
    assert.equal(rowCount(database, "outbound_events"), 3);
    const eventRows = database
      .prepare<[], { readonly event_type: string }>(
        "SELECT event_type FROM outbound_events ORDER BY created_at, id",
      )
      .all();
    assert.deepEqual(eventRows.map((row) => row.event_type).sort(), [
      "fill.ended",
      "health.transitioned",
      "keg.low",
    ]);
    assert.equal(
      service.integrationStatusChanged(database, {
        integrationType: "home_assistant",
        state: "degraded",
        occurredAt: NOW,
        coalescingKey: "ha",
      }).status,
      "queued",
    );
    assert.equal(rowCount(database, "outbound_events"), 4);
  } finally {
    database.close();
  }
});
