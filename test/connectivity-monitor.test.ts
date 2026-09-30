import assert from "node:assert/strict";
import test from "node:test";

import { startConnectivityMonitor } from "../src/features/dashboard/connectivity-monitor.ts";
import type { PublicHeaderView } from "../src/features/dashboard/types.ts";

void test("connectivity monitor publishes escalation and recovery without repeated events, then stops", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let state: PublicHeaderView["connectivity"] = "degraded";
  let changes = 0;
  let reads = 0;
  const stop = startConnectivityMonitor({
    readState: () => {
      reads += 1;
      return state;
    },
    onChange: () => {
      changes += 1;
    },
    onError: () => assert.fail("Unexpected projection failure"),
  });
  context.mock.timers.tick(15_000);
  assert.equal(changes, 0);
  state = "disconnected";
  context.mock.timers.tick(15_000);
  assert.equal(changes, 1);
  context.mock.timers.tick(30_000);
  assert.equal(changes, 1);
  state = "healthy";
  context.mock.timers.tick(15_000);
  assert.equal(changes, 2);
  stop();
  const stoppedReads = reads;
  state = "degraded";
  context.mock.timers.tick(30_000);
  assert.equal(reads, stoppedReads);
  assert.equal(changes, 2);
});

void test("connectivity monitor retries a failed projection or publication on the next tick", (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let state: PublicHeaderView["connectivity"] = "healthy";
  let failRead = false;
  let failPublish = false;
  let changes = 0;
  let errors = 0;
  const stop = startConnectivityMonitor({
    readState: () => {
      if (failRead) throw new Error("Unavailable projection");
      return state;
    },
    onChange: () => {
      if (failPublish) throw new Error("Unavailable stream");
      changes += 1;
    },
    onError: () => {
      errors += 1;
    },
  });
  failRead = true;
  state = "disconnected";
  context.mock.timers.tick(15_000);
  assert.equal(errors, 1);
  assert.equal(changes, 0);
  failRead = false;
  failPublish = true;
  context.mock.timers.tick(15_000);
  assert.equal(errors, 2);
  failPublish = false;
  context.mock.timers.tick(15_000);
  assert.equal(changes, 1);
  stop();
});
