import assert from "node:assert/strict";
import test from "node:test";

import { observeCommittedCalls } from "../src/features/live/post-commit.ts";
import { LiveUpdateService } from "../src/features/live/service.ts";

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
