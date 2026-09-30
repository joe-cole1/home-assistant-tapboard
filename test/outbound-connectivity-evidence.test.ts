import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { createOutboundService } from "../src/features/outbound/service.ts";
import { createOutboundWorker } from "../src/features/outbound/worker.ts";
import { readDestinationCredentialRevision } from "../src/features/outbound/repository.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { requiredDestinationConnectivity } from "../src/features/dashboard/connectivity.ts";
import type {
  OutboundTransportOutcome,
  OutboundTransportRouter,
} from "../src/features/outbound/types.ts";

const DESTINATION = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-17T12:00:00.000Z";
const LATER = "2026-08-17T12:01:00.000Z";

function setup(transport: "webhook" | "home_assistant" = "webhook") {
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 11).toString("base64url"),
  });
  let sequence = 0;
  let timestamp = NOW;
  const currentTime = () => new Date(timestamp);
  const service = createOutboundService(database, {
    secrets,
    now: currentTime,
    idFactory: () => `22222222-2222-4222-8222-${(++sequence).toString(16).padStart(12, "0")}`,
  });
  service.createConfigured({
    id: DESTINATION,
    label: "Required connection",
    required: true,
    transport,
    ...(transport === "webhook"
      ? { webhookUrl: "https://example.test/original" }
      : { baseUrl: "http://ha.example.test", secret: "original-token" }),
    secretHeaders: [{ name: "Authorization", slot: "auth_header" }],
    headerSecrets: [{ name: "Authorization", value: "Bearer original" }],
    subscriptions: ["pour.completed"],
  });
  let eventSequence = 0;
  const admit = () => {
    const eventId = `33333333-3333-4333-8333-${(++eventSequence).toString(16).padStart(12, "0")}`;
    assert.equal(
      service.admit(database, {
        schema_version: 1,
        event_id: eventId,
        event_type: "pour.completed",
        occurred_at: currentTime().toISOString(),
        identifiers: {
          tap_id: "55555555-5555-4555-8555-555555555555",
          fill_id: "44444444-4444-4444-8444-444444444444",
        },
        data: { volume_ml: 355 },
      }).status,
      "queued",
    );
    return eventId;
  };
  const worker = (transports: OutboundTransportRouter) =>
    createOutboundWorker({ database, secrets, transports, clock: { now: currentTime } });
  const assertPending = () => {
    const destination = service.get(DESTINATION)!;
    assert.equal(destination.state, "unknown");
    assert.equal(destination.lastSuccessAt, null);
    assert.equal(requiredDestinationConnectivity(destination), "degraded");
  };
  return {
    database,
    secrets,
    service,
    admit,
    worker,
    assertPending,
    setNow: (value: string) => {
      timestamp = value;
    },
  };
}

void test("endpoint edits invalidate confirmed health; historical delivery cannot recover it", async () => {
  const { database, service, admit, worker, assertPending, setNow } = setup();
  const endpoints: string[] = [];
  const outboundWorker = worker({
    send: (input) => {
      endpoints.push(input.endpoint!);
      return { outcome: "success" };
    },
  });
  try {
    const initial = admit();
    await outboundWorker.pollOnce();
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
    assert.equal(
      service.listDeliveries(DESTINATION).find((row) => row.eventId === initial)?.state,
      "succeeded",
    );
    const historical = admit();
    const historyBeforeEdit = service.listDeliveries(DESTINATION);
    const oldVersion = service.get(DESTINATION)!.currentVersion!.id;
    service.edit(DESTINATION, { webhookUrl: "https://example.test/replacement" });
    assertPending();
    assert.deepEqual(service.listDeliveries(DESTINATION), historyBeforeEdit);

    await outboundWorker.pollOnce();
    assertPending();
    const historicalDelivery = service
      .listDeliveries(DESTINATION)
      .find((row) => row.eventId === historical)!;
    assert.equal(historicalDelivery.state, "succeeded");
    assert.equal(historicalDelivery.destinationVersionId, oldVersion);
    assert.deepEqual(endpoints, ["https://example.test/original", "https://example.test/original"]);

    setNow(LATER);
    admit();
    await outboundWorker.pollOnce();
    assert.equal(endpoints.at(-1), "https://example.test/replacement");
    assert.equal(service.get(DESTINATION)!.lastSuccessAt, LATER);
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
  } finally {
    database.close();
  }
});

for (const change of ["endpoint", "static_header", "header_secret", "ha_token"] as const) {
  void test(`${change} replacement rejects in-flight evidence and recovers on a fresh current success`, async () => {
    const { database, service, admit, worker, assertPending, setNow } = setup(
      change === "ha_token" ? "home_assistant" : "webhook",
    );
    let resolveSend!: (result: OutboundTransportOutcome) => void;
    const firstSend = new Promise<OutboundTransportOutcome>((resolve) => {
      resolveSend = resolve;
    });
    let sends = 0;
    const outboundWorker = worker({
      send: () => (++sends === 1 ? firstSend : { outcome: "success" }),
    });
    try {
      service.recordSuccess(DESTINATION);
      admit();
      const polling = outboundWorker.pollOnce();
      assert.equal(sends, 1);
      if (change === "endpoint") {
        service.edit(DESTINATION, { webhookUrl: "https://example.test/replacement" });
      } else if (change === "static_header") {
        service.edit(DESTINATION, { staticHeaders: [{ name: "X-Route", value: "replacement" }] });
      } else if (change === "header_secret") {
        service.setHeaderSecret(DESTINATION, "auth_header", "Bearer replacement");
      } else {
        service.setToken(DESTINATION, "replacement-token");
      }
      assertPending();
      resolveSend({ outcome: "success" });
      await polling;
      assertPending();
      assert.equal(service.listDeliveries(DESTINATION)[0]!.state, "succeeded");

      setNow(LATER);
      admit();
      await outboundWorker.pollOnce();
      assert.equal(service.get(DESTINATION)!.lastSuccessAt, LATER);
      assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
    } finally {
      database.close();
    }
  });
}

void test("label, Required, subscription, and unchanged config edits preserve confirmed health", () => {
  const { database, service } = setup();
  try {
    service.recordSuccess(DESTINATION);
    const original = service.get(DESTINATION)!;
    service.edit(DESTINATION, { label: "Renamed connection" });
    service.setRequired(DESTINATION, false);
    service.setRequired(DESTINATION, true);
    service.edit(DESTINATION, { subscriptions: ["pour.completed", "fill.assigned"] });
    service.updateConfigured(DESTINATION, {
      enabled: true,
      label: "Full submission",
      transport: "webhook",
      webhookUrl: "https://example.test/original",
      payloadFormat: "standard",
      staticHeaders: [],
      secretHeaders: [{ name: "Authorization", slot: "auth_header" }],
    });
    const updated = service.get(DESTINATION)!;
    assert.equal(updated.state, "healthy");
    assert.equal(updated.lastSuccessAt, original.lastSuccessAt);
    assert.equal(requiredDestinationConnectivity(updated), "healthy");
  } finally {
    database.close();
  }
});

void test("replacement keeps outstanding failure evidence until current transport succeeds", async () => {
  const { database, service, admit, worker, setNow } = setup("home_assistant");
  try {
    service.recordSuccess(DESTINATION);
    service.recordFailure(DESTINATION, "ha_auth_invalid", "authentication");
    service.setToken(DESTINATION, "replacement-token");
    assert.equal(service.get(DESTINATION)!.lastSuccessAt, null);
    assert.equal(service.get(DESTINATION)!.failure?.code, "ha_auth_invalid");
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "disconnected");

    setNow(LATER);
    admit();
    await worker({ send: () => ({ outcome: "success" }) }).pollOnce();
    assert.equal(service.get(DESTINATION)!.failure, null);
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
  } finally {
    database.close();
  }
});

void test("failed atomic edit restores old configuration and successful evidence", () => {
  const { database, service } = setup();
  try {
    service.recordSuccess(DESTINATION);
    const original = service.get(DESTINATION)!;
    database.execute(`CREATE TRIGGER reject_connectivity_edit
      BEFORE INSERT ON activity_log WHEN NEW.action = 'configuration_changed'
      BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;`);
    assert.throws(
      () => service.edit(DESTINATION, { webhookUrl: "https://example.test/replacement" }),
      /fixture rollback/u,
    );
    const restored = service.get(DESTINATION)!;
    assert.equal(restored.currentVersion!.id, original.currentVersion!.id);
    assert.equal(restored.lastSuccessAt, original.lastSuccessAt);
    assert.equal(requiredDestinationConnectivity(restored), "healthy");
  } finally {
    database.close();
  }
});

void test("persistent HA evidence requires the current credential generation and survives metadata edits", () => {
  const { database, service, worker, assertPending } = setup("home_assistant");
  const outboundWorker = worker({ send: () => ({ outcome: "success" }) });
  try {
    const versionId = service.get(DESTINATION)!.currentVersion!.id;
    const originalGeneration = readDestinationCredentialRevision(database, DESTINATION);
    const evidence = (generation: string | undefined, result: OutboundTransportOutcome) => {
      outboundWorker.onHomeAssistantConnectionState({
        destinationId: DESTINATION,
        destinationVersionId: versionId,
        ...(generation === undefined ? {} : { bindingGeneration: generation }),
        result:
          result.outcome === "success"
            ? { outcome: "success" }
            : { outcome: "retryable_failure", errorCode: result.errorCode ?? "fixture_failure" },
      });
    };
    evidence(originalGeneration, { outcome: "success" });
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
    service.edit(DESTINATION, { label: "Renamed HA" });
    service.setRequired(DESTINATION, false);
    service.setRequired(DESTINATION, true);
    assert.equal(readDestinationCredentialRevision(database, DESTINATION), originalGeneration);
    evidence(originalGeneration, { outcome: "retry", errorCode: "ha_socket_closed" });
    assert.equal(service.get(DESTINATION)!.failure?.code, "ha_socket_closed");
    evidence(originalGeneration, { outcome: "success" });
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");

    service.setToken(DESTINATION, "replacement-token");
    assert.equal(service.get(DESTINATION)!.currentVersion!.id, versionId);
    assertPending();
    evidence(undefined, { outcome: "success" });
    evidence(originalGeneration, { outcome: "success" });
    evidence(originalGeneration, { outcome: "retry", errorCode: "stale_socket" });
    assertPending();
    assert.equal(service.get(DESTINATION)!.failure, null);
    const replacementGeneration = readDestinationCredentialRevision(database, DESTINATION);
    assert.notEqual(replacementGeneration, originalGeneration);
    evidence(replacementGeneration, { outcome: "success" });
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");

    service.setHeaderSecret(DESTINATION, "auth_header", "Bearer replacement");
    evidence(replacementGeneration, { outcome: "success" });
    assertPending();
    evidence(readDestinationCredentialRevision(database, DESTINATION), { outcome: "success" });
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
  } finally {
    database.close();
  }
});

void test("HA probes carry credential generations and reject a replaced credential result", async () => {
  const { database, service, worker, assertPending } = setup("home_assistant");
  const probes: Array<{
    readonly input: Parameters<NonNullable<OutboundTransportRouter["ensureHealthy"]>>[0];
    readonly resolve: (value: OutboundTransportOutcome) => void;
  }> = [];
  const outboundWorker = worker({
    send: () => ({ outcome: "success" }),
    ensureHealthy: (input) =>
      new Promise<OutboundTransportOutcome>((resolve) => {
        probes.push({ input, resolve });
      }),
  });
  try {
    service.recordSuccess(DESTINATION);
    outboundWorker.onDestinationEnabled(DESTINATION);
    assert.equal(probes.length, 1);
    assert.equal(
      probes[0]!.input.bindingGeneration,
      readDestinationCredentialRevision(database, DESTINATION),
    );
    service.setToken(DESTINATION, "replacement-token");
    probes[0]!.resolve({ outcome: "success" });
    await Promise.resolve();
    assertPending();

    outboundWorker.onDestinationCredentialsChanged(DESTINATION);
    assert.equal(probes.length, 2);
    assert.notEqual(probes[1]!.input.bindingGeneration, probes[0]!.input.bindingGeneration);
    probes[1]!.resolve({ outcome: "success" });
    await Promise.resolve();
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
  } finally {
    database.close();
  }
});

void test("a historical endpoint failure leaves current successful evidence intact", async () => {
  const { database, service, admit, worker, setNow } = setup();
  try {
    admit();
    service.edit(DESTINATION, { webhookUrl: "https://example.test/replacement" });
    setNow(LATER);
    service.recordSuccess(DESTINATION);
    await worker({
      send: () => ({ outcome: "permanent_failure", errorCode: "http_401", status: 401 }),
    }).pollOnce();
    assert.equal(service.listDeliveries(DESTINATION)[0]!.state, "terminal");
    assert.equal(service.listDeliveries(DESTINATION)[0]!.lastErrorCode, "http_401");
    assert.equal(service.get(DESTINATION)!.failure, null);
    assert.equal(service.get(DESTINATION)!.lastSuccessAt, LATER);
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
  } finally {
    database.close();
  }
});

void test("standalone HA header rotation rebinds after commit and never after rollback", async () => {
  const { database, service, secrets, worker, assertPending } = setup("home_assistant");
  let transactionDepth = 0;
  const tracked: DatabaseExecutor = {
    execute: (sql) => database.execute(sql),
    prepare<Bindings extends unknown[] = unknown[], Row = unknown>(sql: string) {
      return database.prepare<Bindings, Row>(sql);
    },
    pragma<Result = unknown>(statement: string, options?: { readonly simple?: boolean }) {
      return database.pragma<Result>(statement, options);
    },
    withTransaction<Result>(work: () => Result extends PromiseLike<unknown> ? never : Result) {
      transactionDepth += 1;
      try {
        return database.withTransaction(work);
      } finally {
        transactionDepth -= 1;
      }
    },
  };
  let probes = 0;
  let notifications = 0;
  const outboundWorker = worker({
    send: () => ({ outcome: "success" }),
    ensureHealthy: () => {
      assert.equal(transactionDepth, 0, "HA probe must run after the header update commits");
      probes += 1;
      return { outcome: "success" };
    },
  });
  const configuredService = createOutboundService(tracked, {
    secrets,
    now: () => new Date(NOW),
    lifecycle: {
      onCredentialsChanged: (id) => {
        assert.equal(transactionDepth, 0);
        notifications += 1;
        outboundWorker.onDestinationCredentialsChanged(id);
      },
    },
  });
  try {
    service.recordSuccess(DESTINATION);
    configuredService.setHeaderSecret(DESTINATION, "auth_header", "Bearer replacement");
    assertPending();
    assert.equal(notifications, 1);
    assert.equal(probes, 1);
    await Promise.resolve();
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
    const generation = readDestinationCredentialRevision(database, DESTINATION);

    database.execute(`CREATE TRIGGER reject_header_edit
      BEFORE INSERT ON activity_log WHEN NEW.action = 'configuration_changed'
      BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;`);
    assert.throws(
      () => configuredService.setHeaderSecret(DESTINATION, "auth_header", "Bearer rejected"),
      /fixture rollback/u,
    );
    assert.equal(notifications, 1);
    assert.equal(probes, 1);
    assert.equal(readDestinationCredentialRevision(database, DESTINATION), generation);
    assert.equal(requiredDestinationConnectivity(service.get(DESTINATION)!), "healthy");
  } finally {
    database.close();
  }
});
