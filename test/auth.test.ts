import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createAuthService, hashPin, isPin, verifyPin } from "../src/features/auth/index.ts";
import { ADMIN_SESSION_COOKIE } from "../src/infrastructure/http/security/index.ts";

void test("PIN validation accepts exactly all ASCII four-digit values", async () => {
  for (let value = 0; value < 10_000; value += 1) {
    assert.equal(isPin(value.toString().padStart(4, "0")), true);
  }
  for (const value of ["", "123", "12345", " 1234", "1234 ", "１２３４", "12\n4", 1234, null]) {
    assert.equal(isPin(value), false);
  }
  const verifier = await hashPin("0000");
  assert.equal(await verifyPin("0000", verifier), true);
  assert.equal(await verifyPin("0001", verifier), false);
  assert.equal(await verifyPin("bad", verifier), false);
  assert.equal(await verifyPin("0000", { ...verifier, scryptN: 1 }), false);
});

void test("credential status, login rotation, and PIN change are durable", async () => {
  const path = join(mkdtempSync("/tmp/tapboard-auth-"), "auth.sqlite3");
  const clock = () => new Date("2026-08-13T12:00:00.000Z");
  try {
    const first = openDatabase(path);
    const auth = createAuthService(first, { now: clock, canonicalOrigin: "https://admin.example" });
    assert.deepEqual(auth.status(), { configured: false, revision: null });
    await auth.setPin("1234");
    assert.deepEqual(auth.status(), { configured: true, revision: 1 });
    const result = await auth.authenticate("1234");
    assert.equal(result.authenticated, true);
    assert.match(result.session ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.match(result.cookie ?? "", /Secure/);
    assert.notEqual(auth.authenticateSession(result.session), undefined);
    await auth.changePin("1234", "5678");
    assert.equal(auth.authenticateSession(result.session), undefined);
    const activeOne = await auth.authenticate("5678");
    const activeTwo = await auth.authenticate("5678");
    assert.equal(auth.revokeAll(), 2);
    assert.equal(auth.authenticateSession(activeOne.session), undefined);
    assert.equal(auth.authenticateSession(activeTwo.session), undefined);
    const activeBeforeReset = await auth.authenticate("5678");
    await auth.resetOperatorPin("0000");
    assert.equal(auth.authenticateSession(activeBeforeReset.session), undefined);
    first.close();

    const second = openDatabase(path);
    assert.deepEqual(createAuthService(second, { now: clock }).status(), {
      configured: true,
      revision: 3,
    });
    second.close();
  } finally {
    rmSync(path, { force: true });
  }
});

void test("throttling persists, rolls its fixed window, and fails safely at the boundary", async () => {
  const directory = mkdtempSync("/tmp/tapboard-throttle-");
  const path = join(directory, "auth.sqlite3");
  try {
    const database = openDatabase(path);
    let now = new Date("2026-08-13T12:00:00.000Z");
    const auth = createAuthService(database, { now: () => now });
    await auth.setPin("0000");
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await auth.authenticate("9999")).authenticated, false);
    }
    database.close();

    const reopened = openDatabase(path);
    const afterRestart = createAuthService(reopened, { now: () => now });
    const blocked = await afterRestart.authenticate("0000");
    assert.equal(blocked.authenticated, false);
    assert.equal(blocked.throttled, true);
    assert.equal(
      reopened
        .prepare<[], { count: number }>(
          "SELECT count(*) AS count FROM activity_log WHERE action IN ('auth_login_failed', 'auth_throttled')",
        )
        .get()?.count,
      2,
    );

    now = new Date("2026-08-13T12:15:00.000Z");
    assert.equal((await afterRestart.authenticate("0000")).authenticated, true);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("concurrent throttle reservations use generation CAS across SQLite connections", async () => {
  const directory = mkdtempSync("/tmp/tapboard-throttle-race-");
  const path = join(directory, "auth.sqlite3");
  const now = () => new Date("2026-08-13T12:00:00.000Z");
  try {
    const first = openDatabase(path);
    const firstAuth = createAuthService(first, { now });
    await firstAuth.setPin("1234");
    const second = openDatabase(path);
    const secondAuth = createAuthService(second, { now });
    const [failed, succeeded] = await Promise.all([
      firstAuth.authenticate("9999"),
      secondAuth.authenticate("1234"),
    ]);
    assert.equal(failed.authenticated, false);
    assert.equal(succeeded.authenticated, true);
    assert.deepEqual(
      first
        .prepare<[], { generation: number; attempt_count: number }>(
          "SELECT generation, attempt_count FROM login_throttle WHERE id = 1",
        )
        .get(),
      { generation: 1, attempt_count: 0 },
    );
    assert.equal((await firstAuth.authenticate("9999")).throttled, false);
    assert.equal(
      first
        .prepare<[], { attempt_count: number }>(
          "SELECT attempt_count FROM login_throttle WHERE id = 1",
        )
        .get()?.attempt_count,
      1,
    );
    first.close();
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("sessions enforce inactivity, absolute expiry, revocation, rotation, and bounded touch", async () => {
  const directory = mkdtempSync("/tmp/tapboard-session-");
  try {
    const database = openDatabase(join(directory, "auth.sqlite3"));
    let now = new Date("2026-08-13T12:00:00.000Z");
    let identifier = 0;
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    const auth = createAuthService(database, {
      now: () => now,
      session: { inactivityMs: 10 * 60_000, absoluteMs: 20 * 60_000 },
      canonicalOrigin: "https://admin.example",
      idFactory: () => ids[identifier++] ?? ids[2]!,
    });
    await auth.setPin("1234");
    const first = await auth.authenticate("1234");
    assert.match(first.cookie ?? "", /HttpOnly/);
    assert.match(first.cookie ?? "", /SameSite=Strict/);
    assert.match(first.cookie ?? "", /Secure/);
    assert.doesNotMatch(first.cookie ?? "", /1234/);
    const raw = database
      .prepare<[], { session_digest: Buffer }>("SELECT session_digest FROM admin_sessions LIMIT 1")
      .get();
    assert.equal(raw?.session_digest.byteLength, 32);
    assert.notEqual(raw?.session_digest.toString("utf8"), first.session);

    now = new Date("2026-08-13T12:02:00.000Z");
    const untouched = auth.authenticateSession(first.session);
    assert.equal(untouched?.lastUsedAt, "2026-08-13T12:00:00.000Z");
    now = new Date("2026-08-13T12:03:00.000Z");
    const touched = auth.authenticateSession(first.session);
    assert.equal(touched?.lastUsedAt, "2026-08-13T12:03:00.000Z");

    const rotated = await auth.authenticate("1234", first.session);
    assert.equal(auth.authenticateSession(first.session), undefined);
    assert.notEqual(rotated.session, first.session);
    assert.equal(auth.revoke(rotated.session), true);
    assert.equal(auth.authenticateSession(rotated.session), undefined);

    const third = await auth.authenticate("1234");
    now = new Date("2026-08-13T12:20:00.000Z");
    assert.equal(auth.authenticateSession(third.session), undefined);
    assert.equal(auth.pruneExpiredSessions() > 0, true);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("cookie mutation authorization requires exact Origin, session, and CSRF", async () => {
  const directory = mkdtempSync("/tmp/tapboard-csrf-");
  try {
    const database = openDatabase(join(directory, "auth.sqlite3"));
    let now = new Date("2026-08-13T12:00:00.000Z");
    const auth = createAuthService(database, {
      canonicalOrigin: "https://admin.example",
      now: () => now,
    });
    await auth.setPin("1234");
    const login = await auth.authenticate("1234");
    const input = {
      cookieHeader: `${ADMIN_SESSION_COOKIE}=${login.session}`,
      originHeader: "https://admin.example",
      csrfHeader: login.csrfToken,
      canonicalOrigin: "https://admin.example",
    } as const;
    assert.equal(auth.authorizeCookieMutation(input)?.id, login.sessionId);
    now = new Date("2026-08-13T12:06:00.000Z");
    const lastUsedBeforeRejection = database
      .prepare<[string], { readonly last_used_at: string }>(
        "SELECT last_used_at FROM admin_sessions WHERE id = ?",
      )
      .get(login.sessionId!)?.last_used_at;
    assert.equal(auth.authorizeCookieMutation({ ...input, originHeader: undefined }), undefined);
    assert.equal(auth.authorizeCookieMutation({ ...input, originHeader: "null" }), undefined);
    assert.equal(
      auth.authorizeCookieMutation({
        ...input,
        originHeader: "https://evil.example",
        canonicalOrigin: "https://evil.example",
      }),
      undefined,
    );
    assert.equal(
      database
        .prepare<[string], { readonly last_used_at: string }>(
          "SELECT last_used_at FROM admin_sessions WHERE id = ?",
        )
        .get(login.sessionId!)?.last_used_at,
      lastUsedBeforeRejection,
    );
    assert.equal(auth.authorizeCookieMutation({ ...input, csrfHeader: undefined }), undefined);
    assert.equal(auth.authorizeCookieMutation({ ...input, csrfHeader: "invalid" }), undefined);
    assert.equal(
      auth.authorizeCookieMutation({
        ...input,
        cookieHeader: `${input.cookieHeader}; ${input.cookieHeader}`,
      }),
      undefined,
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
