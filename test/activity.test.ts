import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import {
  appendActivity,
  appendDeletionAudit,
  listActivities,
  listDeletionAudits,
  pruneActivity,
  setActivityRetention,
} from "../src/features/activity/index.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const ID_2 = "123e4567-e89b-12d3-a456-426614174001";
const ID_3 = "123e4567-e89b-12d3-a456-426614174002";

void test("activity validates pairs, scalar details, appends and lists typed records", () => {
  const database = openDatabase(":memory:");
  try {
    assert.throws(
      () =>
        appendActivity(database, {
          category: "security",
          action: "configuration_changed",
          actorType: "system",
        }),
      /pair/i,
    );
    const record = appendActivity(database, {
      id: ID,
      category: "security",
      action: "auth_login_succeeded",
      actorType: "system",
      occurredAt: "2026-08-13T12:00:00.000Z",
      details: { ok: true, note: "é" },
    });
    assert.deepEqual(record.details, { note: "é", ok: true });
    assert.deepEqual(listActivities(database), [record]);
    assert.throws(
      () =>
        database
          .prepare<[string, string]>("UPDATE activity_log SET action = ? WHERE id = ?")
          .run("auth_login_failed", ID),
      /append-only/i,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM outbound_events")
        .get()?.count,
      0,
    );
    assert.throws(
      () =>
        appendActivity(database, {
          id: ID_2,
          category: "security",
          action: "auth_login_succeeded",
          actorType: "system",
          details: { api_key: "secret" },
        }),
      /secret/i,
    );
  } finally {
    database.close();
  }
});

void test("activity retention prunes only bounded old Activity rows", () => {
  const database = openDatabase(":memory:");
  try {
    appendActivity(database, {
      id: ID,
      category: "domain",
      action: "deletion",
      actorType: "system",
      occurredAt: "2020-01-01T00:00:00.000Z",
    });
    appendActivity(database, {
      id: ID_2,
      category: "domain",
      action: "transition",
      actorType: "system",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });
    setActivityRetention(database, 30, { now: () => new Date("2026-08-13T00:00:00.000Z") });
    assert.equal(
      pruneActivity(database, { now: () => new Date("2026-08-13T00:00:00.000Z"), batchSize: 1 }),
      1,
    );
    assert.equal(listActivities(database).length, 1);
    assert.throws(() => pruneActivity(database, { batchSize: 1_001 }), /batch/i);
  } finally {
    database.close();
  }
});

void test("deletion audit is typed, immutable, and independent of unrelated records", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    database.prepare<[string]>("INSERT INTO unrelated (id) VALUES (?)").run(ID_3);
    const record = appendDeletionAudit(database, {
      id: ID_2,
      entityType: "fill",
      entityId: ID,
      actorType: "operator",
      reason: "cleanup",
      impacts: [{ code: "fill_history", count: 2 }],
      deletedAt: "2026-08-13T12:00:00.000Z",
    });
    database.prepare<[string]>("DELETE FROM unrelated WHERE id = ?").run(ID_3);
    assert.deepEqual(listDeletionAudits(database), [record]);
    assert.throws(
      () =>
        database
          .prepare<[string, string]>("UPDATE deletion_audit SET reason = ? WHERE id = ?")
          .run("x", ID_2),
      /immutable/i,
    );
    assert.throws(
      () => database.prepare<[string]>("DELETE FROM deletion_audit WHERE id = ?").run(ID_2),
      /immutable/i,
    );
    assert.throws(
      () =>
        appendDeletionAudit(database, {
          id: ID_3,
          entityType: "fill",
          entityId: ID,
          actorType: "system",
          impacts: [{ code: "bad code", count: 1 }],
        }),
      /machine code/i,
    );
  } finally {
    database.close();
  }
});
