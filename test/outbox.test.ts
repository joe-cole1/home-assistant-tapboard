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

void test("an expired eighth lease becomes terminal instead of remaining stuck", () => {
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
    const afterExpiry = new Date(Date.parse(finalClaim.leaseExpiresAt) + 1).toISOString();
    assert.deepEqual(claimDue(database, "replacement-worker", afterExpiry, 1_000, 1), []);
    const row = listDeliveries(database).find((item) => item.id === finalClaim.deliveryId);
    assert.equal(row?.state, "terminal");
    assert.equal(row?.attempt_count, 8);
    assert.equal(row?.last_error_code, "lease_expired_max_attempts");
  } finally {
    database.close();
  }
});

void test("eighth failed attempt becomes terminal and supports dismiss/manual retry", () => {
  const { database } = setup();
  try {
    mutateAndAdmit(database, () => undefined, intent(), { now: () => new Date(NOW) });
    let due = NOW;
    let deliveryId = "";
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [claim] = claimDue(database, "worker", due, 1_000, 1);
      assert.ok(claim);
      deliveryId = claim.deliveryId;
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
    assert.equal(dismissDelivery(database, deliveryId, due), true);
    assert.equal(manualRetry(database, deliveryId, due), true);
    assert.equal(listDeliveries(database).find((item) => item.id === deliveryId)?.attempt_count, 0);
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
