import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import {
  applyDeliveryResult,
  claimDue,
  createDestination,
  createDestinationVersion,
  dismissDelivery,
  getCapacityStatus,
  listDeliveries,
  listOverflowIncidents,
  manualRetry,
  mutateAndAdmit,
  recoverCapacity,
  setDestinationEnabled,
} from "../src/features/outbox/repository.ts";

const DESTINATION_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-13T12:00:00.000Z";

function setup(): { database: DatabaseConnection; destinationId: string; versionId: string } {
  const database = openDatabase(":memory:");
  createDestination(
    database,
    { id: DESTINATION_ID, label: "Test destination" },
    { now: () => new Date(NOW) },
  );
  createDestinationVersion(
    database,
    { id: VERSION_ID, destinationId: DESTINATION_ID, versionNumber: 1 },
    { now: () => new Date(NOW) },
  );
  return { database, destinationId: DESTINATION_ID, versionId: VERSION_ID };
}

function scalar(database: DatabaseConnection, sql: string, key: string): unknown {
  return database.prepare<[], Record<string, unknown>>(sql).get()?.[key];
}

function intent(eventId = EVENT_ID, coalescingKey?: string) {
  return {
    event: {
      event_type: "integration.status_changed",
      event_id: eventId,
      occurred_at: NOW,
      coalescing_key: coalescingKey ?? "integration-a",
      data: { integration_type: "ha", state: "degraded", reason_code: "timeout" },
    },
    targets: [{ destinationId: DESTINATION_ID, destinationVersionId: VERSION_ID }],
  } as const;
}

function destinationId(index: number): string {
  return `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`;
}

function versionId(index: number): string {
  return `22222222-2222-4222-8222-${index.toString(16).padStart(12, "0")}`;
}

function eventId(index: number): string {
  return `33333333-3333-4333-8333-${index.toString(16).padStart(12, "0")}`;
}

function intentFor(index: number) {
  return {
    event: {
      event_type: "integration.status_changed",
      event_id: eventId(index),
      occurred_at: NOW,
      coalescing_key: `integration_${index}`,
      data: { integration_type: "ha", state: "degraded", reason_code: "timeout" },
    },
    targets: [{ destinationId: destinationId(index), destinationVersionId: versionId(index) }],
  } as const;
}

function addIndexedDestination(
  database: DatabaseConnection,
  index: number,
  enabled = true,
): { destinationId: string; versionId: string } {
  const destination = destinationId(index);
  const version = versionId(index);
  createDestination(
    database,
    { id: destination, label: `Destination ${index}`, enabled },
    { now: () => new Date(NOW) },
  );
  createDestinationVersion(
    database,
    { id: version, destinationId: destination, versionNumber: 1 },
    { now: () => new Date(NOW) },
  );
  return { destinationId: destination, versionId: version };
}

function indexedIntent(eventIndex: number, targetIndex: number) {
  return {
    event: {
      event_type: "integration.status_changed",
      event_id: eventId(eventIndex),
      occurred_at: NOW,
      coalescing_key: `integration_${eventIndex}`,
      data: { integration_type: "ha", state: "degraded", reason_code: "timeout" },
    },
    targets: [
      { destinationId: destinationId(targetIndex), destinationVersionId: versionId(targetIndex) },
    ],
  } as const;
}

void test("creates typed destinations and immutable versions", () => {
  const { database } = setup();
  try {
    assert.equal(setDestinationEnabled(database, DESTINATION_ID, false, NOW).enabled, false);
    assert.throws(
      () => createDestinationVersion(database, { destinationId: DESTINATION_ID, versionNumber: 0 }),
      /versionNumber/,
    );
    assert.throws(() => createDestination(database, { label: "bad\nlabel" }), /label/);
    assert.throws(
      () =>
        database
          .prepare("UPDATE outbound_destination_versions SET version_number = 2 WHERE id = ?")
          .run(VERSION_ID),
      /immutable/,
    );
  } finally {
    database.close();
  }
});

void test("mutation and queue admission are atomic", () => {
  const { database } = setup();
  try {
    const result = mutateAndAdmit(
      database,
      (connection) => connection.execute("CREATE TABLE mutation_probe (value TEXT NOT NULL)"),
      intent(),
      { now: () => new Date(NOW) },
    );
    assert.equal(result.status, "queued");
    assert.equal(
      scalar(
        database,
        "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'mutation_probe'",
        "count",
      ),
      1,
    );
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_events", "count"), 1);
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_deliveries", "count"), 1);
    assert.throws(
      () =>
        mutateAndAdmit(
          database,
          (connection) => {
            connection.execute("INSERT INTO mutation_probe VALUES ('rolled-back')");
            throw new Error("forced");
          },
          intent("55555555-5555-4555-8555-555555555555"),
          { now: () => new Date(NOW) },
        ),
      /forced/,
    );
    assert.equal(scalar(database, "SELECT count(*) AS count FROM mutation_probe", "count"), 0);
  } finally {
    database.close();
  }
});

void test("quota rejection commits local mutation and records bounded degradation", () => {
  const { database } = setup();
  try {
    const result = mutateAndAdmit(
      database,
      (connection) => connection.execute("CREATE TABLE capacity_probe (value TEXT NOT NULL)"),
      intent(),
      {
        now: () => new Date(NOW),
        globalMaxRows: 1,
        globalMaxBytes: 1,
        destinationMaxRows: 1,
        destinationMaxBytes: 1,
      },
    );
    assert.equal(result.status, "not_queued_capacity");
    assert.equal(
      scalar(
        database,
        "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'capacity_probe'",
        "count",
      ),
      1,
    );
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_events", "count"), 0);
    assert.equal(listOverflowIncidents(database).filter((item) => item.state === "open").length, 1);
    assert.equal(
      scalar(database, "SELECT state FROM outbox_degradation WHERE id = 1", "state"),
      "degraded",
    );
    assert.equal(getCapacityStatus(database).state, "degraded");
    assert.equal(
      scalar(
        database,
        "SELECT count(*) AS count FROM activity_log WHERE action = 'capacity_degraded'",
        "count",
      ),
      1,
    );
    assert.equal(
      recoverCapacity(database, NOW, {
        globalMaxRows: 10,
        globalMaxBytes: 10_000,
        destinationMaxRows: 10,
        destinationMaxBytes: 10_000,
      }),
      true,
    );
    assert.equal(
      scalar(database, "SELECT state FROM outbox_degradation WHERE id = 1", "state"),
      "healthy",
    );
    assert.equal(
      scalar(
        database,
        "SELECT count(*) AS count FROM activity_log WHERE action = 'capacity_recovered'",
        "count",
      ),
      1,
    );
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_events", "count"), 0);
  } finally {
    database.close();
  }
});

void test("terminal pruning is bounded and runs before admission", () => {
  const { database } = setup();
  try {
    assert.equal(
      mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) }).status,
      "queued",
    );
    const [claim] = claimDue(database, "worker", NOW, 5_000, 1);
    assert.ok(claim);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: claim.deliveryId,
        owner: "worker",
        revision: claim.revision,
        outcome: "success",
        now: NOW,
      }),
      true,
    );
    const replacement = mutateAndAdmit(
      database,
      () => undefined,
      intent("99999999-9999-4999-8999-999999999999", "replacement"),
      {
        now: () => new Date(NOW),
        globalMaxRows: 2,
        globalMaxBytes: 32_768,
        destinationMaxRows: 1,
        destinationMaxBytes: 16_384,
        pruneBatch: 2,
      },
    );
    assert.equal(replacement.status, "queued");
    assert.equal(replacement.pruned, 2);
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_events", "count"), 1);
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_deliveries", "count"), 1);
  } finally {
    database.close();
  }
});

void test("overflow uses fifteen keyed slots plus a fixed catch-all and coalesces Activity", () => {
  const database = openDatabase(":memory:");
  try {
    for (let index = 0; index < 16; index += 1) {
      createDestination(
        database,
        { id: destinationId(index), label: `Destination ${index}` },
        { now: () => new Date(NOW) },
      );
      createDestinationVersion(
        database,
        {
          id: versionId(index),
          destinationId: destinationId(index),
          versionNumber: 1,
        },
        { now: () => new Date(NOW) },
      );
      assert.equal(
        mutateAndAdmit(database, () => undefined, intentFor(index), {
          now: () => new Date(NOW),
          globalMaxRows: 1,
          globalMaxBytes: 1,
          destinationMaxRows: 1,
          destinationMaxBytes: 1,
        }).status,
        "not_queued_capacity",
      );
    }
    const incidents = listOverflowIncidents(database);
    assert.equal(incidents.length, 16);
    assert.equal(incidents.filter((incident) => incident.state === "open").length, 16);
    assert.equal(incidents[15]?.isCatchall, true);
    assert.equal(incidents[15]?.incidentKey, "catchall");
    assert.equal(
      scalar(
        database,
        "SELECT count(*) AS count FROM activity_log WHERE action = 'capacity_degraded'",
        "count",
      ),
      1,
    );
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_events", "count"), 0);
    assert.equal(
      recoverCapacity(database, NOW, {
        globalMaxRows: 10,
        globalMaxBytes: 10_000,
        destinationMaxRows: 10,
        destinationMaxBytes: 10_000,
      }),
      true,
    );
    assert.equal(
      scalar(
        database,
        "SELECT count(*) AS count FROM activity_log WHERE action = 'capacity_recovered'",
        "count",
      ),
      1,
    );
  } finally {
    database.close();
  }
});

void test("coalescing replaces only an unattempted supersedable event", () => {
  const { database } = setup();
  try {
    const first = mutateAndAdmit(database, () => undefined, intent(EVENT_ID), {
      now: () => new Date(NOW),
    });
    assert.equal(first.status, "queued");
    const second = mutateAndAdmit(
      database,
      () => undefined,
      intent("66666666-6666-4666-8666-666666666666"),
      { now: () => new Date(NOW) },
    );
    assert.equal(second.status, "queued");
    assert.equal(second.coalesced, true);
    assert.equal(scalar(database, "SELECT count(*) AS count FROM outbound_events", "count"), 1);
    const claimed = claimDue(database, "worker-1", NOW, 5_000, 1);
    assert.equal(claimed.length, 1);
    const third = mutateAndAdmit(
      database,
      () => undefined,
      intent("77777777-7777-4777-8777-777777777777"),
      { now: () => new Date(NOW) },
    );
    assert.equal(third.status, "queued");
    assert.equal(third.coalesced, false);
  } finally {
    database.close();
  }
});

void test("claimDue leases at most one due delivery per destination while allowing cross-destination work", () => {
  const { database } = setup();
  try {
    const first = addIndexedDestination(database, 1);
    const second = addIndexedDestination(database, 2);
    mutateAndAdmit(database, () => undefined, indexedIntent(1, 1), {
      now: () => new Date(NOW),
    });
    mutateAndAdmit(database, () => undefined, indexedIntent(2, 1), {
      now: () => new Date(NOW),
    });
    mutateAndAdmit(database, () => undefined, indexedIntent(3, 2), {
      now: () => new Date(NOW),
    });

    const claims = claimDue(database, "worker", NOW, 5_000, 10);
    assert.equal(claims.length, 2);
    assert.deepEqual(
      new Set(claims.map((claim) => claim.destinationId)),
      new Set([first.destinationId, second.destinationId]),
    );
    assert.deepEqual(claimDue(database, "worker-2", NOW, 5_000, 10), []);
  } finally {
    database.close();
  }
});

void test("claimDue ignores disabled destinations and does not let a later row block an earlier row", () => {
  const { database } = setup();
  try {
    const indexed = addIndexedDestination(database, 4);
    mutateAndAdmit(database, () => undefined, indexedIntent(4, 4), {
      now: () => new Date(NOW),
    });
    mutateAndAdmit(database, () => undefined, indexedIntent(5, 4), {
      now: () => new Date(NOW),
    });
    const later = "2026-08-13T13:00:00.000Z";
    database
      .prepare<[string, string]>(
        "UPDATE outbound_deliveries SET next_attempt_at = ? WHERE event_id = ?",
      )
      .run(later, eventId(4));
    assert.equal(setDestinationEnabled(database, indexed.destinationId, false, NOW).enabled, false);
    assert.deepEqual(claimDue(database, "worker", NOW, 5_000, 10), []);

    assert.equal(setDestinationEnabled(database, indexed.destinationId, true, NOW).enabled, true);
    const [claim] = claimDue(database, "worker", NOW, 5_000, 10);
    assert.ok(claim);
    assert.equal(claim.eventId, eventId(5));
  } finally {
    database.close();
  }
});

void test("claim, CAS success, retry, terminal, manual retry, and dismiss", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    const [claim] = claimDue(database, "worker-1", NOW, 5_000, 1);
    assert.ok(claim);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: claim.deliveryId,
        owner: "wrong",
        revision: claim.revision,
        outcome: "success",
        now: NOW,
      }),
      false,
    );
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: claim.deliveryId,
        owner: "worker-1",
        revision: claim.revision,
        outcome: "retry",
        errorCode: "timeout",
        now: NOW,
      }),
      true,
    );
    const [reclaimed] = claimDue(database, "worker-2", "2026-08-13T12:00:10.000Z", 5_000, 1);
    assert.ok(reclaimed);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: reclaimed.deliveryId,
        owner: "worker-2",
        revision: reclaimed.revision,
        outcome: "success",
        now: "2026-08-13T12:00:10.000Z",
      }),
      true,
    );
    assert.equal(dismissDelivery(database, reclaimed.deliveryId, NOW), false);
    assert.equal(manualRetry(database, reclaimed.deliveryId, NOW), false);
    const delivery = listDeliveries(database).find((row) => row.id === reclaimed.deliveryId);
    assert.equal(delivery?.attempt_count, 2);
    assert.equal(dismissDelivery(database, reclaimed.deliveryId, NOW), false);
  } finally {
    database.close();
  }
});

void test("expired leases are reclaimed and stale workers cannot complete", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    const [first] = claimDue(database, "worker-a", NOW, 1_000, 1);
    assert.ok(first);
    const reclaimedAt = "2026-08-13T12:00:01.000Z";
    const [second] = claimDue(database, "worker-b", reclaimedAt, 1_000, 1);
    assert.ok(second);
    assert.equal(second.deliveryId, first.deliveryId);
    assert.equal(second.attemptCount, 2);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: first.deliveryId,
        owner: "worker-a",
        revision: first.revision,
        outcome: "success",
        now: reclaimedAt,
      }),
      false,
    );
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: second.deliveryId,
        owner: "worker-b",
        revision: second.revision,
        outcome: "success",
        now: reclaimedAt,
      }),
      true,
    );
  } finally {
    database.close();
  }
});

void test("an expired cycle-limit lease becomes terminal instead of remaining stuck", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    let due = NOW;
    let finalClaim: ReturnType<typeof claimDue>[number] | undefined;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [claim] = claimDue(database, "worker", due, 1_000, 1);
      assert.ok(claim);
      if (attempt === 8) {
        finalClaim = claim;
        break;
      }
      assert.equal(
        applyDeliveryResult(database, {
          deliveryId: claim.deliveryId,
          owner: "worker",
          revision: claim.revision,
          outcome: "retry",
          errorCode: "temporary_failure",
          now: due,
        }),
        true,
      );
      due = listDeliveries(database).find((row) => row.id === claim.deliveryId)
        ?.next_attempt_at as string;
    }
    assert.ok(finalClaim);
    database
      .prepare<[number, string]>(
        "UPDATE outbound_deliveries SET cycle_attempt_count = ? WHERE id = ?",
      )
      .run(1000, finalClaim.deliveryId);
    const afterExpiry = new Date(Date.parse(finalClaim.leaseExpiresAt) + 1).toISOString();
    assert.deepEqual(claimDue(database, "replacement-worker", afterExpiry, 1_000, 1), []);
    const row = listDeliveries(database).find((item) => item.id === finalClaim.deliveryId);
    assert.equal(row?.state, "terminal");
    assert.equal(row?.attempt_count, 8);
    assert.equal(row?.last_error_code, "cycle_attempt_limit");
  } finally {
    database.close();
  }
});

void test("cycle-limit failure becomes terminal and manual retry preserves total attempts", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    let due = NOW;
    let deliveryId = "";
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [claim] = claimDue(database, "worker", due, 1_000, 1);
      assert.ok(claim);
      deliveryId = claim.deliveryId;
      if (attempt === 8) {
        database
          .prepare<[number, string]>(
            "UPDATE outbound_deliveries SET cycle_attempt_count = ? WHERE id = ?",
          )
          .run(1000, deliveryId);
      }
      assert.equal(
        applyDeliveryResult(database, {
          deliveryId,
          owner: "worker",
          revision: claim.revision,
          outcome: "failure",
          errorCode: "temporary_failure",
          now: due,
        }),
        true,
      );
      const row = listDeliveries(database).find((item) => item.id === deliveryId);
      if (attempt < 8) {
        assert.equal(row?.state, "retry");
        due = row?.next_attempt_at as string;
      } else {
        assert.equal(row?.state, "terminal");
      }
    }
    assert.equal(manualRetry(database, deliveryId, due), true);
    const retried = listDeliveries(database).find((item) => item.id === deliveryId);
    assert.equal(retried?.attempt_count, 8);
    assert.equal(retried?.cycle_attempt_count, 0);
    const [terminalClaim] = claimDue(database, "worker", due, 1_000, 1);
    assert.ok(terminalClaim);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId,
        owner: "worker",
        revision: terminalClaim.revision,
        outcome: "permanent",
        errorCode: "operator_terminal",
        now: due,
      }),
      true,
    );
    assert.equal(dismissDelivery(database, deliveryId, due), true);
    assert.equal(manualRetry(database, deliveryId, due), false);
  } finally {
    database.close();
  }
});

void test("an active retry window becomes terminal at 24 hours", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    const [claim] = claimDue(database, "worker", NOW, 1_000, 1);
    assert.ok(claim);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: claim.deliveryId,
        owner: "worker",
        revision: claim.revision,
        outcome: "retry",
        errorCode: "timeout",
        now: NOW,
      }),
      true,
    );
    const timeoutAt = "2026-08-14T12:00:00.000Z";
    assert.deepEqual(claimDue(database, "worker-2", timeoutAt, 1_000, 1), []);
    const row = listDeliveries(database).find((item) => item.id === claim.deliveryId);
    assert.equal(row?.state, "terminal");
    assert.equal(row?.last_error_code, "active_failure_timeout");
  } finally {
    database.close();
  }
});

void test("disabled destinations do not terminalize while the active failure clock is paused", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    const [claim] = claimDue(database, "worker", NOW, 1_000, 1);
    assert.ok(claim);
    assert.equal(
      applyDeliveryResult(database, {
        deliveryId: claim.deliveryId,
        owner: "worker",
        revision: claim.revision,
        outcome: "retry",
        errorCode: "timeout",
        now: NOW,
      }),
      true,
    );
    setDestinationEnabled(database, claim.destinationId, false, NOW);
    assert.deepEqual(claimDue(database, "worker-2", "2026-08-15T12:00:00.000Z", 1_000, 1), []);
    const paused = listDeliveries(database).find((item) => item.id === claim.deliveryId);
    assert.equal(paused?.state, "retry");
  } finally {
    database.close();
  }
});

void test("storage constraint errors are not capacity results", () => {
  const { database } = setup();
  try {
    const first = mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    assert.equal(first.status, "queued");
    database.execute("CREATE TABLE storage_probe (value TEXT NOT NULL)");
    assert.throws(() =>
      mutateAndAdmit(
        database,
        (connection) => connection.execute("INSERT INTO storage_probe VALUES ('rollback')"),
        intent(EVENT_ID, "different-key"),
        { now: () => new Date(NOW) },
      ),
    );
    assert.equal(scalar(database, "SELECT count(*) AS count FROM storage_probe", "count"), 0);
    const queued = mutateAndAdmit(
      database,
      () => undefined,
      intent("88888888-8888-4888-8888-888888888888"),
      { now: () => new Date(NOW) },
    );
    assert.equal(queued.status, "queued");
  } finally {
    database.close();
  }
});

void test("separate SQLite connections serialize admission and cannot over-admit", () => {
  const directory = mkdtempSync("/tmp/tapboard-outbox-contention-");
  const path = join(directory, "outbox.sqlite3");
  try {
    const first = openDatabase(path);
    createDestination(
      first,
      { id: DESTINATION_ID, label: "Test destination" },
      { now: () => new Date(NOW) },
    );
    createDestinationVersion(
      first,
      { id: VERSION_ID, destinationId: DESTINATION_ID, versionNumber: 1 },
      { now: () => new Date(NOW) },
    );
    const second = openDatabase(path);
    second.pragma("busy_timeout = 1");
    let firstResult: ReturnType<typeof mutateAndAdmit> | undefined;
    first.withTransaction(() => {
      assert.throws(
        () =>
          mutateAndAdmit(
            second,
            () => undefined,
            intent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "second"),
            { globalMaxRows: 2, globalMaxBytes: 32_768 },
          ),
        /busy|locked/i,
      );
      firstResult = mutateAndAdmit(first, () => undefined, intent(), {
        now: () => new Date(NOW),
        globalMaxRows: 2,
        globalMaxBytes: 32_768,
        destinationMaxRows: 1,
        destinationMaxBytes: 16_384,
      });
    });
    assert.equal(firstResult?.status, "queued");
    assert.equal(
      mutateAndAdmit(
        second,
        () => undefined,
        intent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "second"),
        {
          now: () => new Date(NOW),
          globalMaxRows: 2,
          globalMaxBytes: 32_768,
          destinationMaxRows: 1,
          destinationMaxBytes: 16_384,
        },
      ).status,
      "not_queued_capacity",
    );
    assert.equal(scalar(first, "SELECT count(*) AS count FROM outbound_events", "count"), 1);
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("delivery reference prevents version deletion", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    assert.throws(
      () =>
        database.prepare("DELETE FROM outbound_destination_versions WHERE id = ?").run(VERSION_ID),
      /FOREIGN KEY/,
    );
  } finally {
    database.close();
  }
});
