import assert from "node:assert/strict";
import test from "node:test";

import { SseHub, type SseResponse } from "../src/infrastructure/sse/index.ts";

class Response implements SseResponse {
  readonly writes: string[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  readonly headers = new Map<string, string>();
  status = 0;
  writable = true;
  ended = false;
  destroyed = false;
  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }
  writeHead(status: number, headers: Readonly<Record<string, string>> = {}): void {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value);
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.writable;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: "close" | "error" | "drain", listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  off(event: "close" | "error" | "drain", listener: () => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
  }
  emit(event: "close" | "error" | "drain"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

void test("SSE hub frames, queues, coalesces, drains, and cleans up", () => {
  const hub = new SseHub({ heartbeatMs: 0, maxQueuedEvents: 2, maxQueuedBytes: 1024 });
  const response = new Response();
  response.writable = false;
  assert.equal(hub.connect(response), true);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.writes[0], "retry: 3000\n: connected\n\n");
  hub.publish("tap.changed", { id: 1 }, { dirtyKey: "tap" });
  hub.publish("tap.changed", { id: 2 }, { dirtyKey: "tap" });
  assert.deepEqual(hub.stats(), {
    clients: 1,
    blockedClients: 1,
    queuedEvents: 1,
    queuedBytes: Buffer.byteLength('event: tap.changed\ndata: {"id":2}\n\n'),
  });
  response.writable = true;
  response.emit("drain");
  assert.equal(response.writes.at(-1), 'event: tap.changed\ndata: {"id":2}\n\n');
  response.emit("close");
  assert.equal(hub.stats().clients, 0);
  hub.stop();
});

void test("SSE rejects injection and closes overflowing clients", () => {
  const hub = new SseHub({ heartbeatMs: 0, maxQueuedEvents: 0 });
  const response = new Response();
  response.writable = false;
  hub.connect(response);
  hub.publish("ok", { ok: true });
  assert.equal(response.destroyed, true);
  assert.throws(() => hub.publish("bad\nevent", {}));
  hub.stop();
});

void test("SSE enforces client and byte bounds without harming healthy clients", () => {
  const hub = new SseHub({
    heartbeatMs: 0,
    maxClients: 2,
    maxQueuedEvents: 8,
    maxQueuedBytes: 39,
  });
  const slow = new Response();
  slow.writable = false;
  const healthy = new Response();
  assert.equal(hub.connect(slow), true);
  assert.equal(hub.connect(healthy), true);
  const rejected = new Response();
  assert.equal(hub.connect(rejected), false);
  assert.equal(rejected.status, 503);

  hub.publish("tap.updated", { tapId: "a" }, { dirtyKey: "tap:a" });
  assert.equal(slow.destroyed, true);
  assert.equal(healthy.writes.at(-1), 'event: tap.updated\ndata: {"tapId":"a"}\n\n');
  assert.equal(hub.stats().clients, 1);
  hub.stop();
});

void test("SSE emits heartbeat comments and revalidates authenticated clients", async () => {
  let valid = true;
  const hub = new SseHub<{ readonly isAdmin: true; readonly session: string }>({
    heartbeatMs: 5,
    maxClients: 1,
    authRevalidateMs: 5,
    authRevalidate: () => valid,
  });
  const response = new Response();
  assert.equal(hub.connect(response, { isAdmin: true, session: "opaque" }), true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(response.writes.includes(": ping\n\n"));
  valid = false;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(response.ended, true);
  assert.equal(hub.stats().clients, 0);
  hub.stop();
});
