import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createAuthService } from "../src/features/auth/index.ts";
import { insertSession, revokeSession } from "../src/features/auth/repository.ts";
import { listActivities } from "../src/features/activity/index.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const START = "2026-09-30T12:00:00.123Z";
const MINUTE = 60_000;
const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const at = (offset: number): string => new Date(Date.parse(START) + offset).toISOString();

void test("session policy inherits constructor settings until saved and persists across instances and restart", async () => {
  const directory = mkdtempSync("/tmp/tapboard-auth-system-");
  const path = join(directory, "auth.sqlite3");
  const clock = () => new Date(START);
  let database = openDatabase(path);
  try {
    const first = createAuthService(database, {
      now: clock,
      session: { inactivityMs: 10 * MINUTE, absoluteMs: 20 * MINUTE },
    });
    const other = createAuthService(database, {
      now: clock,
      session: { inactivityMs: 15 * MINUTE, absoluteMs: 30 * MINUTE },
    });
    assert.deepEqual(first.getSessionPolicy(), {
      inactivityMs: 10 * MINUTE,
      absoluteMs: 20 * MINUTE,
      configured: false,
      revision: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    assert.equal(other.getSessionPolicy().inactivityMs, 15 * MINUTE);
    await first.setPin("1234");
    const before = await first.authenticate("1234");
    assert.equal(before.expiresAt, at(10 * MINUTE));
    assert.equal(before.absoluteExpiresAt, at(20 * MINUTE));
    const saved = first.updateSessionPolicy({
      inactivityMs: 5 * MINUTE,
      absoluteMs: 12 * MINUTE,
      expectedRevision: 0,
    });
    assert.deepEqual(saved, {
      inactivityMs: 5 * MINUTE,
      absoluteMs: 12 * MINUTE,
      configured: true,
      revision: 1,
      updatedAt: START,
    });
    assert.deepEqual(other.getSessionPolicy(), saved);
    const after = await other.authenticate("1234");
    assert.equal(after.expiresAt, at(5 * MINUTE));
    assert.equal(after.absoluteExpiresAt, at(12 * MINUTE));
    assert.equal(other.validateSession(before.session)?.absoluteExpiresAt, at(12 * MINUTE));
    database.close();
    database = openDatabase(path);
    const reopened = createAuthService(database, { now: clock });
    assert.deepEqual(reopened.getSessionPolicy(), saved);
    assert.equal(reopened.validateSession(after.session)?.expiresAt, at(5 * MINUTE));
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("active session listing is bounded, deterministic and contains only safe UUID/timestamp metadata", async () => {
  const database = openDatabase(":memory:");
  const auth = createAuthService(database, { now: () => new Date(START) });
  try {
    await auth.setPin("1234");
    for (let value = 1; value <= 106; value += 1) {
      const sessionDigest = Buffer.alloc(32, 1);
      sessionDigest.writeUInt32BE(value, 0);
      insertSession(database, {
        id: id(value),
        sessionDigest,
        csrfDigest: Buffer.alloc(32, 2),
        credentialRevision: value === 106 ? 2 : 1,
        createdAt: at(-value * MINUTE),
        lastUsedAt: at(-value * MINUTE),
        expiresAt: value === 104 ? START : at(MINUTE),
        absoluteExpiresAt: at(20 * MINUTE),
        revokedAt: null,
      });
    }
    revokeSession(database, id(103), START);
    const records = auth.listActiveSessions({ currentSessionId: id(105) });
    assert.equal(records.length, 100);
    assert.equal(records[0]?.id, id(105));
    assert.equal(records[0]?.current, true);
    assert.equal(records[1]?.id, id(1));
    assert.equal(records.filter((row) => row.current).length, 1);
    assert.ok(records.every((row) => ![id(103), id(104), id(106)].includes(row.id)));
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), [
        "absoluteExpiresAt",
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "lastUsedAt",
      ]);
    }
    assert.doesNotMatch(JSON.stringify(records), /digest|csrf|token|credential/i);
    assert.deepEqual(auth.listActiveSessions({ limit: 1, currentSessionId: id(105) }), [
      records[0],
    ]);
    assert.equal(auth.listActiveSessions({ limit: 3 }).length, 3);
    for (const limit of [0, 101, 1.5, Infinity]) {
      assert.throws(() => auth.listActiveSessions({ limit }), ApplicationError);
    }
    assert.throws(
      () => auth.listActiveSessions({ currentSessionId: "session-token" }),
      ApplicationError,
    );
    database.execute("UPDATE admin_sessions SET credential_revision = 2");
    assert.deepEqual(auth.listActiveSessions(), []);
  } finally {
    database.close();
  }
});

void test("selected-session and self revocation preserve other sessions and audit actor separately from target", async () => {
  const database = openDatabase(":memory:");
  const auth = createAuthService(database, { now: () => new Date(START) });
  try {
    await auth.setPin("1234");
    const current = await auth.authenticate("1234");
    const selected = await auth.authenticate("1234");
    const other = await auth.authenticate("1234");
    assert.ok(current.sessionId && selected.sessionId && other.sessionId);
    assert.equal(
      auth.revokeSessionById(selected.sessionId, {
        actorId: "local-admin",
        sessionId: current.sessionId,
      }),
      true,
    );
    assert.equal(auth.validateSession(selected.session), undefined);
    assert.ok(auth.validateSession(current.session));
    assert.ok(auth.validateSession(other.session));
    const audit = listActivities(database).find((row) => row.action === "session_revoked");
    assert.equal(audit?.actorType, "admin");
    assert.equal(audit?.actorId, "local-admin");
    assert.equal(audit?.sessionId, current.sessionId);
    assert.equal(audit?.entityType, "admin_session");
    assert.equal(audit?.entityId, selected.sessionId);
    const serialized = JSON.stringify(audit);
    for (const secret of [
      current.session,
      current.csrfToken,
      selected.session,
      selected.csrfToken,
    ]) {
      assert.ok(secret);
      assert.ok(!serialized.includes(secret));
    }
    const count = listActivities(database).length;
    assert.equal(auth.revokeSessionById(selected.sessionId), false);
    assert.equal(auth.revokeSessionById(id(999)), false);
    assert.equal(listActivities(database).length, count);
    assert.throws(() => auth.revokeSessionById("' OR 1=1 --"), ApplicationError);
    assert.throws(() => auth.revokeSessionById(current.session), ApplicationError);
    assert.equal(auth.revokeSessionById(current.sessionId, { sessionId: current.sessionId }), true);
    assert.equal(auth.validateSession(current.session), undefined);
    assert.ok(auth.validateSession(other.session));
    assert.equal(auth.revoke(other.session), true);
    assert.equal(auth.validateSession(other.session), undefined);
  } finally {
    database.close();
  }
});

void test("session policy validates exact input, uses revision CAS and audits atomically", async () => {
  const database = openDatabase(":memory:");
  const auth = createAuthService(database, { now: () => new Date(START) });
  try {
    await auth.setPin("1234");
    const login = await auth.authenticate("1234");
    assert.ok(login.sessionId);
    const input = { inactivityMs: MINUTE, absoluteMs: 3 * MINUTE, expectedRevision: 0 };
    const baseline = auth.getSessionPolicy();
    const activityCount = listActivities(database).length;
    const accessor = Object.defineProperty({ ...input }, "absoluteMs", {
      get: () => {
        throw new Error("accessor must not run");
      },
    });
    for (const invalid of [
      null,
      [],
      { ...input, unknown: true },
      { ...input, [Symbol("extra")]: true },
      { ...input, inactivityMs: MINUTE - 1 },
      { ...input, inactivityMs: MINUTE + 0.5 },
      { ...input, inactivityMs: "60000" },
      { ...input, inactivityMs: 4 * MINUTE },
      { ...input, absoluteMs: 31_536_000_001 },
      { ...input, absoluteMs: null },
      { ...input, expectedRevision: -1 },
      { ...input, expectedRevision: 0.5 },
      { ...input, expectedRevision: Number.MAX_SAFE_INTEGER },
      { inactivityMs: MINUTE, absoluteMs: 3 * MINUTE },
      accessor,
    ]) {
      assert.throws(() => auth.updateSessionPolicy(invalid), ApplicationError);
    }
    assert.deepEqual(auth.getSessionPolicy(), baseline);
    assert.equal(listActivities(database).length, activityCount);
    const saved = auth.updateSessionPolicy(input, {
      actorId: "local-admin",
      sessionId: login.sessionId,
    });
    assert.equal(saved.revision, 1);
    const audit = listActivities(database).find(
      (row) => row.entityType === "auth_session_settings",
    );
    assert.equal(audit?.actorId, "local-admin");
    assert.equal(audit?.sessionId, login.sessionId);
    assert.deepEqual(audit?.details, {
      absolute_ms: 3 * MINUTE,
      inactivity_ms: MINUTE,
      revision: 1,
    });
    assert.throws(
      () => auth.updateSessionPolicy(input),
      (error: unknown) => error instanceof ApplicationError && error.category === "conflict",
    );
    const countAfterSave = listActivities(database).length;
    assert.deepEqual(auth.updateSessionPolicy({ ...input, expectedRevision: 1 }), saved);
    assert.equal(listActivities(database).length, countAfterSave);
    const sessionBefore = auth.validateSession(login.session);
    assert.throws(() =>
      auth.updateSessionPolicy(
        { inactivityMs: MINUTE, absoluteMs: 2 * MINUTE, expectedRevision: 1 },
        { actorId: "" },
      ),
    );
    assert.deepEqual(auth.getSessionPolicy(), saved);
    assert.deepEqual(auth.validateSession(login.session), sessionBefore);
    assert.throws(() => auth.revokeSessionById(login.sessionId, { actorId: "" }));
    assert.ok(auth.validateSession(login.session));
    assert.equal(listActivities(database).length, countAfterSave);
  } finally {
    database.close();
  }
});

void test("shortened policy takes effect immediately and later lengthening cannot revive sessions", async () => {
  const database = openDatabase(":memory:");
  let clock = new Date(START);
  const options = {
    now: () => clock,
    session: { inactivityMs: 10 * MINUTE, absoluteMs: 20 * MINUTE },
  };
  const writer = createAuthService(database, options);
  const existing = createAuthService(database, options);
  try {
    await writer.setPin("1234");
    const expiredByShortening = await existing.authenticate("1234");
    clock = new Date(at(3 * MINUTE));
    writer.updateSessionPolicy({
      inactivityMs: 2 * MINUTE,
      absoluteMs: 5 * MINUTE,
      expectedRevision: 0,
    });
    assert.equal(existing.validateSession(expiredByShortening.session), undefined);
    assert.equal(existing.authenticateSession(expiredByShortening.session), undefined);
    assert.deepEqual(existing.listActiveSessions(), []);
    writer.updateSessionPolicy({
      inactivityMs: 10 * MINUTE,
      absoluteMs: 20 * MINUTE,
      expectedRevision: 1,
    });
    assert.equal(existing.validateSession(expiredByShortening.session), undefined);
    const active = await existing.authenticate("1234");
    writer.updateSessionPolicy({
      inactivityMs: 2 * MINUTE,
      absoluteMs: 5 * MINUTE,
      expectedRevision: 2,
    });
    assert.equal(existing.validateSession(active.session)?.expiresAt, at(5 * MINUTE));
    assert.equal(existing.validateSession(active.session)?.absoluteExpiresAt, at(8 * MINUTE));
    clock = new Date(at(4 * MINUTE));
    const touched = existing.authenticateSession(active.session);
    assert.equal(touched?.lastUsedAt, at(4 * MINUTE));
    assert.equal(touched?.expiresAt, at(6 * MINUTE));
    assert.equal(touched?.absoluteExpiresAt, at(8 * MINUTE));
    writer.updateSessionPolicy({
      inactivityMs: 15 * MINUTE,
      absoluteMs: 30 * MINUTE,
      expectedRevision: 3,
    });
    assert.equal(existing.validateSession(active.session)?.absoluteExpiresAt, at(8 * MINUTE));
    clock = new Date(at(5 * MINUTE));
    const rotated = existing.rotateForWorkspace(active.session ?? "");
    assert.equal(rotated?.absoluteExpiresAt, at(8 * MINUTE));
    assert.equal(rotated?.expiresAt, at(8 * MINUTE));
    clock = new Date(at(8 * MINUTE));
    assert.equal(existing.validateSession(rotated?.session), undefined);
    assert.equal(existing.revokeSessionById(rotated?.sessionId), false);
  } finally {
    database.close();
  }
});

void test("policy deadline clamping preserves milliseconds and original absolute bounds", async () => {
  const database = openDatabase(":memory:");
  const auth = createAuthService(database, {
    now: () => new Date(START),
    session: { inactivityMs: 5 * MINUTE, absoluteMs: 10 * MINUTE },
  });
  try {
    await auth.setPin("1234");
    const login = await auth.authenticate("1234");
    auth.updateSessionPolicy({ inactivityMs: 61_337, absoluteMs: 123_457, expectedRevision: 0 });
    const session = auth.validateSession(login.session);
    assert.equal(session?.expiresAt, at(61_337));
    assert.equal(session?.absoluteExpiresAt, at(123_457));
    auth.updateSessionPolicy({
      inactivityMs: 31_536_000_000,
      absoluteMs: 31_536_000_000,
      expectedRevision: 1,
    });
    assert.equal(auth.validateSession(login.session)?.absoluteExpiresAt, at(123_457));
  } finally {
    database.close();
  }
});

void test("lengthening inactivity refreshes active sessions before their captured shorter deadline", async () => {
  const database = openDatabase(":memory:");
  let clock = new Date(START);
  const auth = createAuthService(database, {
    now: () => clock,
    session: { inactivityMs: MINUTE, absoluteMs: 20 * MINUTE },
  });
  try {
    await auth.setPin("1234");
    const login = await auth.authenticate("1234");
    clock = new Date(at(20_000));
    auth.updateSessionPolicy({
      inactivityMs: 10 * MINUTE,
      absoluteMs: 20 * MINUTE,
      expectedRevision: 0,
    });
    clock = new Date(at(55_000));
    const touched = auth.authenticateSession(login.session);
    assert.equal(touched?.lastUsedAt, at(55_000));
    assert.equal(touched?.expiresAt, at(55_000 + 10 * MINUTE));
    assert.equal(touched?.absoluteExpiresAt, at(20 * MINUTE));
    clock = new Date(at(65_000));
    assert.ok(auth.authenticateSession(login.session));
    clock = new Date(at(20 * MINUTE));
    assert.equal(auth.authenticateSession(login.session), undefined);
  } finally {
    database.close();
  }
});
