import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { readDestinationCredentialRevision } from "../src/features/outbound/repository.ts";
import { createOutboundService } from "../src/features/outbound/service.ts";
import { createOutboundWorker } from "../src/features/outbound/worker.ts";
import type { TransportAttemptResult } from "../src/features/outbound/transport-types.ts";
import type {
  OutboundTransportRouter,
  OutboundWorkerClock,
} from "../src/features/outbound/types.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const DESTINATION = "11111111-1111-4111-8111-111111111111";
const SECOND_DESTINATION = "11111111-1111-4111-8111-111111111112";
const EVENT = "33333333-3333-4333-8333-333333333333";
const SECOND_EVENT = "33333333-3333-4333-8333-333333333334";
const SUCCESS = { outcome: "success" } as const;
const FAILURE = { outcome: "retryable_failure", errorCode: "ha_socket_closed" } as const;

function deferred() {
  let resolve!: (value: TransportAttemptResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<TransportAttemptResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeClock implements OutboundWorkerClock {
  current = Date.parse(NOW);
  readonly timers: (() => void)[] = [];
  readonly cleared: unknown[] = [];
  failClear = false;

  now(): Date {
    return new Date(this.current);
  }

  setInterval(callback: () => void): number {
    this.timers.push(callback);
    return this.timers.length;
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
    if (this.failClear) throw new Error("fake timer cleanup failure");
  }
}

function setup(transport: "home_assistant" | "webhook" = "home_assistant") {
  const database = openDatabase(":memory:");
  const clock = new FakeClock();
  const secrets = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 8).toString("base64url"),
    now: () => clock.now(),
  });
  const service = createOutboundService(database, { secrets, now: () => clock.now() });
  const destination = service.create({
    id: DESTINATION,
    label: "Lifecycle test destination",
    transport,
    ...(transport === "home_assistant"
      ? { baseUrl: "http://ha.example.test:8123", secret: "fake-ha-token" }
      : { webhookUrl: "https://example.test/fake-hook" }),
  });
  let databaseCalls = 0;
  const executor: DatabaseExecutor = {
    execute(sql) {
      databaseCalls += 1;
      database.execute(sql);
    },
    prepare<Bindings extends unknown[] = unknown[], Row = unknown>(sql: string) {
      databaseCalls += 1;
      return database.prepare<Bindings, Row>(sql);
    },
    pragma<Result = unknown>(statement: string, options?: { readonly simple?: boolean }) {
      databaseCalls += 1;
      return database.pragma<Result>(statement, options);
    },
    withTransaction<Result>(work: () => Result extends PromiseLike<unknown> ? never : Result) {
      databaseCalls += 1;
      return database.withTransaction(work);
    },
  };
  const probes: ReturnType<typeof deferred>[] = [];
  const sends: ReturnType<typeof deferred>[] = [];
  const errors: unknown[] = [];
  const statusChanges: unknown[] = [];
  const closedDestinations: string[] = [];
  let transportStops = 0;
  let failStop = false;
  const router: OutboundTransportRouter = {
    ensureHealthy() {
      const attempt = deferred();
      probes.push(attempt);
      return attempt.promise;
    },
    send() {
      const attempt = deferred();
      sends.push(attempt);
      return attempt.promise;
    },
    closeDestination(destinationId) {
      closedDestinations.push(destinationId);
    },
    stop() {
      transportStops += 1;
      if (failStop) throw new Error("fake transport cleanup failure");
    },
  };
  const worker = createOutboundWorker({
    database: executor,
    secrets,
    transports: router,
    clock,
    concurrency: 1,
    leaseTtlMs: 1_000,
    onError: (error) => errors.push(error),
    onStatusChanged: (_database, event) => statusChanges.push(event),
  });
  const connectionEvent = {
    destinationId: DESTINATION,
    destinationVersionId: destination.currentVersion!.id,
    bindingGeneration: readDestinationCredentialRevision(database, DESTINATION),
  };
  const admit = (eventId = EVENT) =>
    service.admit(database, {
      schema_version: 1,
      event_id: eventId,
      event_type: "pour.completed",
      occurred_at: clock.now().toISOString(),
      identifiers: { tap_id: "55555555-5555-4555-8555-555555555555" },
      data: { volume_ml: 355 },
    });
  const delivery = () =>
    database
      .prepare<
        [string],
        {
          readonly state: string;
          readonly revision: number;
          readonly attempt_count: number;
          readonly cycle_attempt_count: number;
          readonly lease_owner: string | null;
          readonly lease_expires_at: string | null;
          readonly last_error_code: string | null;
          readonly active_failure_started_at: string | null;
          readonly terminal_at: string | null;
        }
      >(
        `SELECT state, revision, attempt_count, cycle_attempt_count, lease_owner,
      lease_expires_at, last_error_code, active_failure_started_at, terminal_at
      FROM outbound_deliveries WHERE event_id = ? AND destination_id = '${DESTINATION}'`,
      )
      .get(EVENT)!;
  return {
    database,
    clock,
    service,
    worker,
    probes,
    sends,
    errors,
    statusChanges,
    connectionEvent,
    closedDestinations,
    admit,
    delivery,
    databaseCalls: () => databaseCalls,
    transportStops: () => transportStops,
    failStop: () => {
      failStop = true;
    },
    close: () => {
      worker.stop();
      database.close();
    },
  };
}

for (const completion of ["success", "failure", "rejection"] as const) {
  void test(`pre-start HA probe ${completion} cannot touch SQLite after stop and close`, async () => {
    const h = setup();
    try {
      h.worker.onDestinationEnabled(DESTINATION);
      assert.equal(h.probes.length, 1);
      assert.equal(h.worker.running, false);
      h.worker.stop();
      h.worker.stop();
      assert.equal(h.transportStops(), 1);
      const before = h.databaseCalls();
      h.database.close();
      if (completion === "rejection") h.probes[0]!.reject(new Error("fake late probe rejection"));
      else h.probes[0]!.resolve(completion === "success" ? SUCCESS : FAILURE);
      await setImmediate();
      assert.equal(h.databaseCalls(), before);
      assert.equal(h.statusChanges.length, 0);
      assert.equal(h.errors.length, 0);
    } finally {
      h.close();
    }
  });
}

void test("stopped connection-state and lifecycle callbacks do not enter a closed database", async () => {
  const h = setup();
  try {
    h.worker.stop();
    const before = h.databaseCalls();
    h.database.close();
    h.worker.onHomeAssistantConnectionState({ ...h.connectionEvent, result: SUCCESS });
    h.worker.onHomeAssistantConnectionState({ ...h.connectionEvent, result: FAILURE });
    h.worker.onDestinationEnabled(DESTINATION);
    h.worker.onDestinationCredentialsChanged(DESTINATION);
    h.worker.onDestinationDisabled(DESTINATION);
    h.worker.closeDestination(DESTINATION);
    assert.equal(await h.worker.pollOnce(), 0);
    await setImmediate();
    assert.equal(h.databaseCalls(), before);
    assert.equal(h.probes.length, 0);
    assert.equal(h.sends.length, 0);
    assert.equal(h.closedDestinations.length, 0);
    assert.equal(h.statusChanges.length, 0);
    assert.equal(h.errors.length, 0);
  } finally {
    h.close();
  }
});

void test("a cleared timer and deferred startup probe cannot revive a stopped worker", async () => {
  const h = setup();
  try {
    h.worker.start();
    assert.equal(h.probes.length, 1);
    const timer = h.clock.timers[0]!;
    h.worker.stop();
    assert.deepEqual(h.clock.cleared, [1]);
    const before = h.databaseCalls();
    h.database.close();
    timer();
    h.probes[0]!.resolve(FAILURE);
    await setImmediate();
    assert.equal(h.databaseCalls(), before);
    assert.equal(h.clock.timers.length, 1);
    assert.equal(h.errors.length, 0);
    assert.equal(h.statusChanges.length, 0);
  } finally {
    h.close();
  }
});

for (const completionOrder of ["old_first", "new_first"] as const) {
  void test(`stop/start HA probe ${completionOrder} completion ignores the stopped generation`, async () => {
    const h = setup();
    try {
      h.worker.start();
      assert.equal(h.probes.length, 1);
      h.worker.stop();
      h.worker.start();
      assert.equal(h.probes.length, 2);
      const before = h.databaseCalls();
      if (completionOrder === "old_first") {
        h.probes[0]!.resolve(FAILURE);
        await setImmediate();
        assert.equal(h.databaseCalls(), before);
        assert.equal(h.service.get(DESTINATION)?.state, "unknown");
        assert.equal(h.service.get(DESTINATION)?.failure, null);
      }
      h.probes[1]!.resolve(SUCCESS);
      await setImmediate();
      assert.equal(h.service.get(DESTINATION)?.state, "healthy");
      assert.equal(h.service.get(DESTINATION)?.lastSuccessAt, NOW);
      if (completionOrder === "new_first") {
        const currentCalls = h.databaseCalls();
        const current = h.service.get(DESTINATION);
        h.probes[0]!.resolve(FAILURE);
        await setImmediate();
        assert.equal(h.databaseCalls(), currentCalls);
        assert.deepEqual(h.service.get(DESTINATION), current);
      }
      assert.equal(h.errors.length, 0);
    } finally {
      h.close();
    }
  });
}

void test("old probe success cannot erase current-generation connectivity failure", async () => {
  const h = setup();
  try {
    h.worker.start();
    h.worker.stop();
    h.worker.start();
    h.probes[1]!.resolve(FAILURE);
    await setImmediate();
    const current = h.service.get(DESTINATION);
    assert.ok(current);
    assert.equal(current?.state, "failing");
    assert.equal(current.failure?.code, "ha_socket_closed");
    const before = h.databaseCalls();
    h.probes[0]!.resolve(SUCCESS);
    await setImmediate();
    assert.equal(h.databaseCalls(), before);
    assert.deepEqual(h.service.get(DESTINATION), current);
  } finally {
    h.close();
  }
});

void test("obsolete timer callbacks cannot poll the new worker generation", async () => {
  const h = setup("webhook");
  try {
    h.worker.start();
    const oldTimer = h.clock.timers[0]!;
    h.worker.stop();
    h.worker.start();
    await setImmediate();
    assert.equal(h.admit().status, "queued");
    const before = h.databaseCalls();
    oldTimer();
    await setImmediate();
    assert.equal(h.databaseCalls(), before);
    assert.equal(h.sends.length, 0);
    assert.equal(h.delivery().state, "pending");
    h.clock.timers[1]!();
    assert.equal(h.sends.length, 1);
    h.sends[0]!.resolve(SUCCESS);
    await setImmediate();
    assert.equal(h.delivery().state, "succeeded");
  } finally {
    h.close();
  }
});

for (const completion of ["success", "failure", "rejection"] as const) {
  void test(`manual delivery ${completion} after stop preserves its unresolved lease before database close`, async () => {
    const h = setup("webhook");
    try {
      assert.equal(h.admit().status, "queued");
      const poll = h.worker.pollOnce();
      assert.equal(h.sends.length, 1);
      const lease = h.delivery();
      assert.equal(lease.state, "leased");
      assert.equal(lease.attempt_count, 1);
      h.worker.stop();
      const before = h.databaseCalls();
      if (completion === "rejection") h.sends[0]!.reject(new Error("fake teardown rejection"));
      else h.sends[0]!.resolve(completion === "success" ? SUCCESS : FAILURE);
      assert.equal(await poll, 1);
      assert.equal(h.databaseCalls(), before);
      assert.deepEqual(h.delivery(), lease);
      assert.equal(h.service.get(DESTINATION)?.lastSuccessAt, null);
      assert.equal(h.statusChanges.length, 0);
      assert.equal(h.errors.length, 0);
      h.database.close();
    } finally {
      h.close();
    }
  });
}

for (const completion of [SUCCESS, FAILURE]) {
  void test(`late delivery ${completion.outcome} after database close never enters SQLite`, async () => {
    const h = setup("webhook");
    try {
      h.admit();
      const poll = h.worker.pollOnce();
      assert.equal(h.sends.length, 1);
      h.worker.stop();
      const before = h.databaseCalls();
      h.database.close();
      h.sends[0]!.resolve(completion);
      assert.equal(await poll, 1);
      assert.equal(h.databaseCalls(), before);
      assert.equal(h.statusChanges.length, 0);
      assert.equal(h.errors.length, 0);
    } finally {
      h.close();
    }
  });
}

for (const completion of [SUCCESS, FAILURE]) {
  void test(`restart before lease expiry ignores old delivery ${completion.outcome}`, async () => {
    const h = setup("webhook");
    try {
      h.admit();
      const oldPoll = h.worker.pollOnce();
      const lease = h.delivery();
      h.worker.stop();
      h.worker.start();
      await setImmediate();
      assert.equal(h.sends.length, 1);
      const before = h.databaseCalls();
      h.sends[0]!.resolve(completion);
      assert.equal(await oldPoll, 1);
      assert.equal(h.databaseCalls(), before);
      assert.deepEqual(h.delivery(), lease);
      assert.equal(h.service.get(DESTINATION)?.state, "unknown");
      assert.equal(h.statusChanges.length, 0);
    } finally {
      h.close();
    }
  });
}

void test("restarted worker reclaims expired leases and stale completion cannot clear current poll ownership", async () => {
  const h = setup("webhook");
  try {
    h.admit();
    const oldPoll = h.worker.pollOnce();
    const oldLease = h.delivery();
    assert.equal(h.sends.length, 1);
    h.worker.stop();
    assert.deepEqual(h.delivery(), oldLease);
    h.worker.start();
    await setImmediate();
    assert.equal(h.sends.length, 1);
    assert.deepEqual(h.delivery(), oldLease);
    h.clock.current += 1_001;
    h.clock.timers[0]!();
    assert.equal(h.sends.length, 2);
    const currentLease = h.delivery();
    assert.equal(currentLease.state, "leased");
    assert.ok(currentLease.revision > oldLease.revision);
    assert.equal(currentLease.attempt_count, 2);
    h.service.create({
      id: SECOND_DESTINATION,
      label: "Second destination",
      transport: "webhook",
      webhookUrl: "https://example.test/fake-second",
    });
    h.admit(SECOND_EVENT);
    const before = h.databaseCalls();
    h.sends[0]!.resolve(SUCCESS);
    assert.equal(await oldPoll, 1);
    assert.equal(h.databaseCalls(), before);
    assert.deepEqual(h.delivery(), currentLease);
    assert.equal(await h.worker.pollOnce(), 0);
    assert.equal(h.databaseCalls(), before);
    assert.equal(h.sends.length, 2);
    h.sends[1]!.resolve(SUCCESS);
    await setImmediate();
    const completed = h.delivery();
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.attempt_count, 2);
    assert.equal(completed.last_error_code, null);
    assert.equal(completed.active_failure_started_at, null);
    assert.equal(h.service.get(DESTINATION)?.state, "healthy");
  } finally {
    h.close();
  }
});

void test("timer cleanup failure leaves stop invalidated, detaches ownership and still stops transports", async () => {
  const h = setup("webhook");
  try {
    h.worker.start();
    await setImmediate();
    h.clock.failClear = true;
    assert.throws(() => h.worker.stop(), /fake timer cleanup failure/);
    assert.equal(h.worker.running, false);
    assert.equal(h.transportStops(), 1);
    assert.deepEqual(h.clock.cleared, [1]);
    assert.doesNotThrow(() => h.worker.stop());
    assert.deepEqual(h.clock.cleared, [1]);
    const before = h.databaseCalls();
    h.clock.timers[0]!();
    assert.equal(await h.worker.pollOnce(), 0);
    assert.equal(h.databaseCalls(), before);
    h.clock.failClear = false;
    h.worker.start();
    await setImmediate();
    h.worker.stop();
    assert.deepEqual(h.clock.cleared, [1, 2]);
    assert.equal(h.transportStops(), 2);
  } finally {
    h.clock.failClear = false;
    h.close();
  }
});

void test("transport stop failure still invalidates an unresolved pre-start HA probe", async () => {
  const h = setup();
  h.worker.onDestinationEnabled(DESTINATION);
  h.failStop();
  assert.throws(() => h.worker.stop(), /fake transport cleanup failure/);
  const before = h.databaseCalls();
  h.database.close();
  h.probes[0]!.resolve(FAILURE);
  await setImmediate();
  assert.equal(h.databaseCalls(), before);
  assert.equal(h.statusChanges.length, 0);
  assert.equal(h.errors.length, 0);
  assert.doesNotThrow(() => h.worker.stop());
  assert.equal(h.transportStops(), 1);
});

void test("timer and transport cleanup failures preserve the first error and still attempt both", async () => {
  const h = setup("webhook");
  h.worker.start();
  await setImmediate();
  h.clock.failClear = true;
  h.failStop();
  assert.throws(() => h.worker.stop(), /fake timer cleanup failure/u);
  assert.equal(h.transportStops(), 1);
  assert.deepEqual(h.clock.cleared, [1]);
  assert.equal(h.worker.running, false);
  const before = h.databaseCalls();
  h.database.close();
  h.clock.timers[0]!();
  assert.equal(await h.worker.pollOnce(), 0);
  assert.equal(h.databaseCalls(), before);
  assert.doesNotThrow(() => h.worker.stop());
});
