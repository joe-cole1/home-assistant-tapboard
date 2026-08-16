import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { observeCommittedCalls } from "../src/features/live/post-commit.ts";
import { LiveUpdateService } from "../src/features/live/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";

class Response {
  ended = false;
  setHeader(): void {}
  write(): boolean {
    return true;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {}
  on(): void {}
  off(): void {}
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for SSE revalidation");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void test("local live observers run only after successful synchronous and asynchronous calls", async () => {
  const observed: string[] = [];
  const service = {
    sync(value: string): string {
      if (value === "fail") throw new Error("rollback");
      return `committed:${value}`;
    },
    asyncCall(value: string): Promise<string> {
      return value === "fail"
        ? Promise.reject(new Error("rollback"))
        : Promise.resolve(`committed:${value}`);
    },
  };
  const wrapped = observeCommittedCalls(service, {
    sync: (result) => observed.push(String(result)),
    asyncCall: (result) => observed.push(String(result)),
  });
  assert.equal(wrapped.sync("one"), "committed:one");
  assert.deepEqual(observed, ["committed:one"]);
  assert.throws(() => wrapped.sync("fail"));
  assert.deepEqual(observed, ["committed:one"]);
  assert.equal(await wrapped.asyncCall("two"), "committed:two");
  await assert.rejects(wrapped.asyncCall("fail"));
  assert.deepEqual(observed, ["committed:one", "committed:two"]);
});

void test("public live events contain only the named dirty-target contract", () => {
  const writes: string[] = [];
  const response = {
    setHeader: () => undefined,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => undefined,
    destroy: () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
  const live = new LiveUpdateService({ authenticateSession: () => undefined } as never, {
    heartbeatMs: 0,
    adminRevalidateMs: 0,
  });
  assert.equal(live.connectPublic(response as never), true);
  live.publish({
    name: "telemetry.updated",
    tapId: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(
    writes.at(-1),
    'event: telemetry.updated\ndata: {"tapId":"00000000-0000-4000-8000-000000000001"}\n\n',
  );
  const serialized = writes.join("");
  for (const forbidden of ["sourceId", "measurementId", "secret", "session", "rawPayload"])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  live.stop();
});

void test("admin SSE revalidation is read-only and disconnects sessions after idle expiry", async () => {
  const directory = mkdtempSync("/tmp/tapboard-live-auth-");
  try {
    const database = openDatabase(join(directory, "auth.sqlite3"));
    let now = new Date("2026-08-13T12:00:00.000Z");
    const auth = createAuthService(database, {
      now: () => now,
      session: { inactivityMs: 10 * 60_000, absoluteMs: 20 * 60_000 },
    });
    await auth.setPin("1234");
    const login = await auth.authenticate("1234");
    const before = database
      .prepare<[string], { readonly last_used_at: string; readonly expires_at: string }>(
        "SELECT last_used_at, expires_at FROM admin_sessions WHERE id = ?",
      )
      .get(login.sessionId!);
    let revalidationCount = 0;
    const live = new LiveUpdateService(
      {
        validateSession: (token: unknown) => {
          revalidationCount += 1;
          return auth.validateSession(token);
        },
      } as never,
      { heartbeatMs: 0, adminRevalidateMs: 5 },
    );
    const response = new Response();
    assert.equal(live.connectAdmin(response as never, login.session!), true);

    now = new Date("2026-08-13T12:06:00.000Z");
    await waitFor(() => revalidationCount > 0);
    assert.equal(response.ended, false);
    assert.deepEqual(
      database
        .prepare<[string], { readonly last_used_at: string; readonly expires_at: string }>(
          "SELECT last_used_at, expires_at FROM admin_sessions WHERE id = ?",
        )
        .get(login.sessionId!),
      before,
    );

    const revalidationsBeforeActivity = revalidationCount;
    assert.ok(auth.authenticateSession(login.session!));
    const afterActivity = database
      .prepare<[string], { readonly last_used_at: string; readonly expires_at: string }>(
        "SELECT last_used_at, expires_at FROM admin_sessions WHERE id = ?",
      )
      .get(login.sessionId!);
    assert.equal(afterActivity?.last_used_at, "2026-08-13T12:06:00.000Z");
    assert.equal(afterActivity?.expires_at, "2026-08-13T12:16:00.000Z");
    await waitFor(() => revalidationCount > revalidationsBeforeActivity);

    now = new Date("2026-08-13T12:10:00.000Z");
    const revalidationsBeforeActiveCheck = revalidationCount;
    await waitFor(() => revalidationCount > revalidationsBeforeActiveCheck);
    assert.equal(response.ended, false);

    now = new Date("2026-08-13T12:16:00.000Z");
    await waitFor(() => response.ended);
    assert.equal(live.stats().admin.clients, 0);
    live.stop();
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("tap live-event coalescing retains distinct header-affecting semantics", () => {
  const writes: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  let writable = false;
  const response = {
    setHeader: () => undefined,
    write: (chunk: string) => {
      writes.push(chunk);
      return writable;
    },
    end: () => undefined,
    destroy: () => undefined,
    on: (event: string, listener: () => void) =>
      listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    off: () => undefined,
  };
  const live = new LiveUpdateService({ validateSession: () => undefined } as never, {
    heartbeatMs: 0,
    adminRevalidateMs: 0,
  });
  const tapId = "00000000-0000-4000-8000-000000000001";
  assert.equal(live.connectPublic(response as never), true);
  live.publish({ name: "health.updated", tapId });
  live.publish({ name: "fill.updated", tapId });
  writable = true;
  for (const listener of listeners.get("drain") ?? []) listener();
  assert.ok(writes.includes(`event: health.updated\ndata: {"tapId":"${tapId}"}\n\n`));
  assert.ok(writes.includes(`event: fill.updated\ndata: {"tapId":"${tapId}"}\n\n`));
  live.stop();
});
