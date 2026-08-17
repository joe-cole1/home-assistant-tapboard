import assert from "node:assert/strict";
import test from "node:test";

import {
  openDatabase,
  type DatabaseConnection,
  type DatabaseExecutor,
} from "../src/infrastructure/database/connection.ts";
import { createOutboundService } from "../src/features/outbound/service.ts";
import { createOutboundWorker } from "../src/features/outbound/worker.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import type { OutboundTransportRouter } from "../src/features/outbound/types.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const DESTINATION = "11111111-1111-4111-8111-111111111111";
const FILL = "44444444-4444-4444-8444-444444444444";
const TAP = "55555555-5555-4555-8555-555555555555";
const ROOT_KEY = Buffer.alloc(32, 8).toString("base64url");

function event(eventId: string) {
  return {
    schema_version: 1 as const,
    event_id: eventId,
    event_type: "pour.completed" as const,
    occurred_at: NOW,
    identifiers: { tap_id: TAP, fill_id: FILL },
    data: { volume_ml: 355 },
  } as const;
}

function setup(): {
  readonly database: DatabaseConnection;
  readonly service: ReturnType<typeof createOutboundService>;
  readonly secrets: ReturnType<typeof createSecretsService>;
} {
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, { rootKey: ROOT_KEY });
  const service = createOutboundService(database, {
    secrets,
    now: () => new Date(NOW),
    idFactory: () => "22222222-2222-4222-8222-222222222222",
  });
  service.create({
    id: DESTINATION,
    label: "Worker hook",
    transport: "webhook",
    webhookUrl: "https://example.test/hook",
  });
  return { database, service, secrets };
}

function delivery(
  database: DatabaseConnection,
  eventId?: string,
): {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
} {
  return eventId === undefined
    ? database
        .prepare<[], { readonly id: string; readonly state: string; readonly revision: number }>(
          "SELECT id, state, revision FROM outbound_deliveries ORDER BY id LIMIT 1",
        )
        .get()!
    : database
        .prepare<
          [string],
          { readonly id: string; readonly state: string; readonly revision: number }
        >("SELECT id, state, revision FROM outbound_deliveries WHERE event_id = ?")
        .get(eventId)!;
}

function trackedExecutor(database: DatabaseConnection): {
  readonly executor: DatabaseExecutor;
  readonly transactionDepth: () => number;
} {
  let depth = 0;
  const executor: DatabaseExecutor = {
    execute: (sql) => database.execute(sql),
    prepare<Bindings extends unknown[] = unknown[], Row = unknown>(sql: string) {
      return database.prepare<Bindings, Row>(sql);
    },
    pragma<Result = unknown>(statement: string, options?: { readonly simple?: boolean }) {
      return database.pragma<Result>(statement, options);
    },
    withTransaction<Result>(work: () => Result extends PromiseLike<unknown> ? never : Result) {
      depth += 1;
      try {
        return database.withTransaction(work);
      } finally {
        depth -= 1;
      }
    },
  };
  return { executor, transactionDepth: () => depth };
}

void test("worker performs transport work after admission and keeps local truth on failure", async () => {
  const { database, service, secrets } = setup();
  const tracked = trackedExecutor(database);
  let sends = 0;
  const router: OutboundTransportRouter = {
    send: () => {
      assert.equal(
        tracked.transactionDepth(),
        0,
        "network transport ran inside SQLite transaction",
      );
      sends += 1;
      return { outcome: "retryable_failure", errorCode: "connect_timeout" };
    },
  };
  try {
    database.withTransaction(() => {
      assert.equal(
        service.admit(database, event("33333333-3333-4333-8333-333333333333")).status,
        "queued",
      );
    });
    assert.equal(sends, 0);
    const worker = createOutboundWorker({
      database: tracked.executor,
      transports: router,
      secrets,
      owner: "test-worker",
      clock: { now: () => new Date(NOW) },
      onStatusChanged: (executor, context) => {
        service.integrationStatusChanged(executor, context);
      },
    });
    await worker.pollOnce();
    assert.equal(sends, 1);
    assert.equal(delivery(database, "33333333-3333-4333-8333-333333333333").state, "retry");
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM outbound_events")
        .get()!.count,
      2,
    );
    assert.deepEqual(
      database
        .prepare<[], { readonly event_type: string }>(
          "SELECT event_type FROM outbound_events ORDER BY event_type",
        )
        .all()
        .map((row) => row.event_type),
      ["integration.status_changed", "pour.completed"],
    );
  } finally {
    database.close();
  }
});

void test("permanent delivery failure remains visible and starts connectivity degradation", async () => {
  const { database, service, secrets } = setup();
  const router: OutboundTransportRouter = {
    send: () => ({ outcome: "permanent_failure", errorCode: "http_404", status: 404 }),
  };
  try {
    service.admit(database, event("33333333-3333-4333-8333-333333333334"));
    const worker = createOutboundWorker({
      database,
      transports: router,
      secrets,
      owner: "test-worker",
      clock: { now: () => new Date(NOW) },
    });
    await worker.pollOnce();
    assert.equal(delivery(database).state, "terminal");
    assert.equal(service.get(DESTINATION)?.state, "failing");
    assert.equal(service.get(DESTINATION)?.failure?.code, "http_404");
  } finally {
    database.close();
  }
});

void test("claims are single-destination and stale completion cannot mark success", async () => {
  const { database, service, secrets } = setup();
  let resolveSend: ((value: { readonly outcome: "success" }) => void) | undefined;
  let started!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const router: OutboundTransportRouter = {
    send: () => {
      started();
      return new Promise<{ readonly outcome: "success" }>((resolve) => {
        resolveSend = resolve;
      });
    },
  };
  try {
    service.admit(database, event("33333333-3333-4333-8333-333333333333"));
    const worker = createOutboundWorker({
      database,
      transports: router,
      secrets,
      owner: "test-worker",
      clock: { now: () => new Date(NOW) },
    });
    const pending = worker.pollOnce();
    await sendStarted;
    const claimed = delivery(database);
    database
      .prepare<[string]>("UPDATE outbound_deliveries SET revision = revision + 1 WHERE id = ?")
      .run(claimed.id);
    resolveSend!({ outcome: "success" });
    await pending;
    assert.equal(delivery(database).state, "leased");
  } finally {
    database.close();
  }
});

void test("transport status evidence is discarded after destination configuration changes", async () => {
  const { database, service, secrets } = setup();
  let resolveSend: ((value: { readonly outcome: "success" }) => void) | undefined;
  let started!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const router: OutboundTransportRouter = {
    send: () => {
      started();
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
  };
  try {
    service.admit(database, event("33333333-3333-4333-8333-333333333339"));
    const worker = createOutboundWorker({
      database,
      transports: router,
      secrets,
      owner: "test-worker",
      clock: { now: () => new Date(NOW) },
    });
    const pending = worker.pollOnce();
    await sendStarted;
    service.edit(DESTINATION, { label: "Edited while sending" });
    resolveSend!({ outcome: "success" });
    await pending;
    assert.equal(delivery(database).state, "succeeded");
    assert.equal(service.get(DESTINATION)?.state, "unknown");
    assert.equal(service.get(DESTINATION)?.lastSuccessAt, null);
  } finally {
    database.close();
  }
});

void test("completion samples time after the write lock and rejects an expired lease", async () => {
  const { database, service, secrets } = setup();
  let clockReads = 0;
  const worker = createOutboundWorker({
    database,
    transports: { send: () => ({ outcome: "success" }) },
    secrets,
    owner: "test-worker",
    leaseTtlMs: 1_000,
    clock: {
      now: () => {
        clockReads += 1;
        return new Date(clockReads >= 3 ? "2026-08-17T12:00:02.000Z" : NOW);
      },
    },
  });
  try {
    service.admit(database, event("33333333-3333-4333-8333-333333333340"));
    await worker.pollOnce();
    assert.equal(delivery(database).state, "leased");
    assert.equal(service.get(DESTINATION)?.lastSuccessAt, null);
  } finally {
    database.close();
  }
});

void test("start and stop are idempotent and stop closes the injected router", async () => {
  const { database } = setup();
  let scheduled = 0;
  let cleared = 0;
  let stopped = 0;
  const router: OutboundTransportRouter = {
    send: () => ({ outcome: "success" }),
    stop: () => {
      stopped += 1;
    },
  };
  const worker = createOutboundWorker({
    database,
    transports: router,
    clock: {
      now: () => new Date(NOW),
      setInterval: () => {
        scheduled += 1;
        return scheduled;
      },
      clearInterval: () => {
        cleared += 1;
      },
    },
  });
  try {
    worker.start();
    worker.start();
    assert.equal(worker.running, true);
    assert.equal(scheduled, 1);
    await Promise.resolve();
    worker.stop();
    worker.stop();
    assert.equal(worker.running, false);
    assert.equal(cleared, 1);
    assert.equal(stopped, 1);
  } finally {
    worker.stop();
    database.close();
  }
});

void test("shutdown leaves an in-flight delivery leased without recording a fake failure", async () => {
  const { database, service, secrets } = setup();
  let resolveSend:
    | ((value: { readonly outcome: "retryable_failure"; readonly errorCode: string }) => void)
    | undefined;
  let started!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const router: OutboundTransportRouter = {
    send: () => {
      started();
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
    stop: () => {
      resolveSend?.({ outcome: "retryable_failure", errorCode: "transport_stopped" });
    },
  };
  const worker = createOutboundWorker({
    database,
    transports: router,
    secrets,
    owner: "test-worker",
    clock: {
      now: () => new Date(NOW),
      setInterval: () => 1,
      clearInterval: () => undefined,
    },
  });
  try {
    service.admit(database, event("33333333-3333-4333-8333-333333333335"));
    worker.start();
    await sendStarted;
    worker.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const row = delivery(database);
    assert.equal(row.state, "leased");
    assert.equal(
      database
        .prepare<[string], { readonly last_error_code: string | null }>(
          "SELECT last_error_code FROM outbound_deliveries WHERE id = ?",
        )
        .get(row.id)?.last_error_code,
      null,
    );
  } finally {
    worker.stop();
    database.close();
  }
});

void test("historical delivery keeps v1 endpoint while logical header rotation applies immediately", async () => {
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, { rootKey: ROOT_KEY });
  let sequence = 10;
  const service = createOutboundService(database, {
    secrets,
    now: () => new Date(NOW),
    idFactory: () => `22222222-2222-4222-8222-${(sequence++).toString(16).padStart(12, "0")}`,
  });
  const sent: Parameters<OutboundTransportRouter["send"]>[0][] = [];
  const router: OutboundTransportRouter = {
    send: (input) => {
      sent.push(input);
      return { outcome: "success" };
    },
  };
  try {
    const v1 = service.create({
      id: DESTINATION,
      label: "Versioned hook",
      transport: "webhook",
      webhookUrl: "https://old.example.test/hook",
      secretHeaders: [{ name: "Authorization" }],
    });
    const slot = v1.currentVersion!.config.secretHeaders[0]!.slot;
    service.setHeaderSecret(DESTINATION, slot, "Bearer old");
    service.admit(database, event("33333333-3333-4333-8333-333333333336"));

    const v2 = service.edit(DESTINATION, {
      webhookUrl: "https://new.example.test/hook",
      subscriptions: ["fill.assigned"],
    });
    service.setHeaderSecret(DESTINATION, slot, "Bearer rotated");
    assert.notEqual(v2.currentVersion!.id, v1.currentVersion!.id);
    assert.throws(() =>
      database
        .prepare<[string]>("DELETE FROM outbound_destination_versions WHERE id = ?")
        .run(v1.currentVersion!.id),
    );

    const worker = createOutboundWorker({
      database,
      transports: router,
      secrets,
      owner: "test-worker",
      clock: { now: () => new Date(NOW) },
    });
    await worker.pollOnce();
    assert.equal(sent[0]?.version.id, v1.currentVersion!.id);
    assert.equal(sent[0]?.endpoint, "https://old.example.test/hook");
    assert.equal(sent[0]?.headers?.Authorization, "Bearer rotated");

    assert.deepEqual(service.admit(database, event("33333333-3333-4333-8333-333333333337")), {
      status: "no_targets",
    });
    service.admit(database, {
      schema_version: 1,
      event_id: "33333333-3333-4333-8333-333333333338",
      event_type: "fill.assigned",
      occurred_at: NOW,
      identifiers: { tap_id: TAP, fill_id: FILL },
      data: { assignment_id: "66666666-6666-4666-8666-666666666666" },
    });
    await worker.pollOnce();
    assert.equal(sent[1]?.version.id, v2.currentVersion!.id);
    assert.equal(sent[1]?.endpoint, "https://new.example.test/hook");
    assert.equal(sent[1]?.headers?.Authorization, "Bearer rotated");
  } finally {
    database.close();
  }
});
