import assert from "node:assert/strict";
import test from "node:test";

import type {
  WebSocketEventLike,
  WebSocketLike,
} from "../src/features/outbound/transports/home-assistant.ts";
import {
  HomeAssistantConnectionManager,
  deriveHomeAssistantWebSocketUrl,
  normalizeHomeAssistantBaseUrl,
  type HomeAssistantDestination,
} from "../src/features/outbound/transports/home-assistant.ts";

const EVENT = {
  schema_version: 1 as const,
  event_id: "33333333-3333-4333-8333-333333333333",
  event_type: "pour.completed" as const,
  occurred_at: "2026-08-17T12:00:00.000Z",
  identifiers: { tap_id: "11111111-1111-4111-8111-111111111111" },
  data: { volume_ml: 355 },
};

type Listener = (event: WebSocketEventLike) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  readonly #listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type: string, event: WebSocketEventLike = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }
}

class FakeScheduler {
  #next = 1;
  readonly #timers = new Map<number, () => void>();
  readonly delays: number[] = [];
  schedule = (handler: () => void, timeoutMs: number): number => {
    const id = this.#next++;
    this.#timers.set(id, handler);
    this.delays.push(timeoutMs);
    return id;
  };
  cancel = (id: unknown): void => {
    if (typeof id === "number") this.#timers.delete(id);
  };
  runAll(): void {
    for (const [id, handler] of [...this.#timers]) {
      this.#timers.delete(id);
      handler();
    }
  }
  runNext(): void {
    const next = this.#timers.entries().next();
    if (next.done === true) throw new Error("No scheduled timer");
    this.#timers.delete(next.value[0]);
    next.value[1]();
  }
  get size(): number {
    return this.#timers.size;
  }
}

function destination(overrides: Partial<HomeAssistantDestination> = {}): HomeAssistantDestination {
  return {
    destinationId: "ha-main",
    baseUrl: "http://ha.example:8123/",
    token: "secret-token",
    ...overrides,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function numberField(object: Record<string, unknown>, field: string): number {
  const value = object[field];
  if (typeof value !== "number") throw new Error(`Expected numeric ${field}`);
  return value;
}

async function authenticated(
  manager: HomeAssistantConnectionManager,
  sockets: readonly FakeSocket[],
  input: HomeAssistantDestination = destination(),
): Promise<FakeSocket> {
  const result = manager.ensureAuthenticated(input);
  const socket = sockets.at(-1);
  assert.ok(socket);
  socket.open();
  socket.message({ type: "auth_required", ha_version: "2026.8" });
  assert.deepEqual(parseObject(socket.sent[0]!), { type: "auth", access_token: input.token });
  socket.message({ type: "auth_ok", ha_version: "2026.8" });
  assert.deepEqual(await result, { outcome: "success" });
  return socket;
}

void test("HA URL normalization accepts LAN HTTP and derives websocket endpoint", () => {
  assert.equal(normalizeHomeAssistantBaseUrl("http://ha.example:8123/"), "http://ha.example:8123");
  assert.equal(
    deriveHomeAssistantWebSocketUrl("https://ha.example:8123/ha/"),
    "wss://ha.example:8123/ha/api/websocket",
  );
  for (const value of [
    "ftp://ha.example",
    "http://user:pass@ha.example",
    "http://ha.example?token=secret",
    "http://ha.example#fragment",
  ]) {
    assert.throws(() => normalizeHomeAssistantBaseUrl(value));
  }
});

void test("HA connection-state evidence reports idle loss and recovery without secrets", async () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const states: unknown[] = [];
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onConnectionStateChanged: (event) => states.push(event),
  });

  const first = await authenticated(
    manager,
    sockets,
    destination({ destinationVersionId: "version-1", bindingGeneration: "generation-1" }),
  );
  first.close();
  assert.equal(scheduler.size, 1);
  assert.deepEqual(states, [
    {
      destinationId: "ha-main",
      destinationVersionId: "version-1",
      bindingGeneration: "generation-1",
      result: { outcome: "success" },
    },
    {
      destinationId: "ha-main",
      destinationVersionId: "version-1",
      bindingGeneration: "generation-1",
      result: { outcome: "retryable_failure", errorCode: "ha_socket_closed" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(states), /secret-token|ha\.example/iu);

  scheduler.runNext();
  const second = sockets.at(-1)!;
  second.open();
  second.message({ type: "auth_required" });
  second.message({ type: "auth_ok" });
  await Promise.resolve();
  assert.deepEqual((states as readonly Record<string, unknown>[]).at(-1), {
    destinationId: "ha-main",
    destinationVersionId: "version-1",
    bindingGeneration: "generation-1",
    result: { outcome: "success" },
  });
  manager.stop();
});

void test("HA reconnect retries indefinitely with capped exponential cadence", async () => {
  const scheduler = new FakeScheduler();
  let factoryCalls = 0;
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      factoryCalls += 1;
      throw new Error("private provider detail");
    },
    reconnectDelayMs: 10,
    maxReconnectDelayMs: 40,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });

  assert.deepEqual(await manager.ensureAuthenticated(destination()), {
    outcome: "retryable_failure",
    errorCode: "ha_connect_failed",
  });
  for (let attempt = 0; attempt < 8; attempt += 1) scheduler.runNext();
  assert.equal(factoryCalls, 9);
  assert.deepEqual(scheduler.delays, [10, 20, 40, 40, 40, 40, 40, 40, 40]);
  assert.equal(scheduler.size, 1);
  manager.stop();
  assert.equal(scheduler.size, 0);
});

void test("HA manager authenticates once per logical destination and switches bindings", async () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const states: unknown[] = [];
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: (url) => {
      assert.equal(url, "ws://ha.example:8123/api/websocket");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onConnectionStateChanged: (event) => states.push(event),
  });

  const first = await authenticated(manager, sockets);
  assert.deepEqual(await manager.ensureAuthenticated(destination({ endpointVersion: 2 })), {
    outcome: "success",
  });
  assert.equal(sockets.length, 1);

  const changed = manager.ensureAuthenticated(destination({ tokenGeneration: 2 }));
  const second = sockets.at(-1);
  assert.ok(second);
  assert.notEqual(second, first);
  second.open();
  second.message({ type: "auth_required" });
  second.message({ type: "auth_ok" });
  assert.deepEqual(await changed, { outcome: "success" });
  assert.equal(first.closed, true);
  assert.equal(JSON.stringify(states).includes("secret-token"), false);

  manager.closeDestination("ha-main");
  assert.equal(scheduler.size, 0);
  manager.closeDestination("ha-main");
  manager.stop();
  manager.stop();
});

void test("HA intentional binding switches, closes, and stop never emit failure evidence", async () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const states: unknown[] = [];
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onConnectionStateChanged: (event) => states.push(event),
  });

  const first = await authenticated(manager, sockets, destination({ token: "old-token" }));
  const switched = manager.ensureAuthenticated(destination({ token: "new-token" }));
  const second = sockets.at(-1)!;
  assert.notEqual(second, first);
  assert.equal(first.closed, true);
  second.open();
  second.message({ type: "auth_required" });
  assert.deepEqual(parseObject(second.sent[0]!), { type: "auth", access_token: "new-token" });
  second.message({ type: "auth_ok" });
  assert.deepEqual(await switched, { outcome: "success" });
  const beforeClose = states.length;

  manager.closeDestination("ha-main");
  assert.equal(scheduler.size, 0);
  first.emit("error", { reason: "stale old socket" });
  second.emit("close", { reason: "intentional close" });
  assert.equal(states.length, beforeClose);
  manager.stop();
  assert.equal(states.length, beforeClose);
  assert.doesNotMatch(JSON.stringify(states), /old-token|new-token|ha\.example/iu);
});

void test("HA fire_event accepts only its matching successful result", async () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    requestTimeoutMs: 10,
  });
  const socket = await authenticated(manager, sockets);
  const pending = manager.sendEvent(destination(), EVENT);
  await Promise.resolve();
  const frame = parseObject(socket.sent.at(-1)!);
  const frameId = numberField(frame, "id");
  assert.equal(frame.type, "fire_event");
  assert.equal(frame.event_type, "tapboard_event");
  assert.deepEqual(frame.event_data, EVENT);

  socket.message({ type: "result", id: frameId + 1, success: true });
  await Promise.resolve();
  socket.message({ type: "result", id: frameId, success: true });
  assert.deepEqual(await pending, { outcome: "success" });

  const negative = manager.sendEvent(destination(), EVENT);
  await Promise.resolve();
  const negativeFrame = parseObject(socket.sent.at(-1)!);
  const negativeFrameId = numberField(negativeFrame, "id");
  socket.message({
    type: "result",
    id: negativeFrameId,
    success: false,
    error: { message: "secret" },
  });
  assert.deepEqual(await negative, {
    outcome: "permanent_failure",
    errorCode: "ha_result_failed",
  });
  manager.stop();
});

void test("HA disconnect before ACK is retryable and retry keeps the canonical event ID", async () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  });
  const firstSocket = await authenticated(manager, sockets);
  const firstAttempt = manager.sendEvent(destination(), EVENT);
  await Promise.resolve();
  const firstFrame = parseObject(firstSocket.sent.at(-1)!);
  assert.equal((firstFrame.event_data as Record<string, unknown>).event_id, EVENT.event_id);
  firstSocket.close();
  assert.deepEqual(await firstAttempt, {
    outcome: "retryable_failure",
    errorCode: "ha_socket_closed",
  });
  assert.equal(scheduler.size, 1, "only one bounded reconnect timer should be scheduled");

  const retry = manager.sendEvent(destination(), EVENT);
  assert.equal(scheduler.size, 0, "an explicit send cancels the stale reconnect timer");
  const secondSocket = sockets.at(-1)!;
  assert.notEqual(secondSocket, firstSocket);
  secondSocket.open();
  secondSocket.message({ type: "auth_required" });
  secondSocket.message({ type: "auth_ok" });
  await Promise.resolve();
  const retryFrame = parseObject(secondSocket.sent.at(-1)!);
  assert.equal((retryFrame.event_data as Record<string, unknown>).event_id, EVENT.event_id);
  secondSocket.message({ type: "result", id: numberField(retryFrame, "id"), success: true });
  assert.deepEqual(await retry, { outcome: "success" });
  assert.equal(sockets.length, 2);
  manager.stop();
});

void test("HA auth invalid, close, and request timeout are sanitized and retryable/permanent", async () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const states: unknown[] = [];
  const manager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    requestTimeoutMs: 10,
    onConnectionStateChanged: (event) => states.push(event),
  });
  const auth = manager.ensureAuthenticated(destination());
  const socket = sockets[0]!;
  socket.open();
  socket.message({ type: "auth_required" });
  socket.message({ type: "auth_invalid", message: "Bearer secret-token rejected" });
  const authResult = await auth;
  assert.deepEqual(authResult, { outcome: "permanent_failure", errorCode: "ha_auth_invalid" });
  assert.equal(JSON.stringify(authResult).includes("secret-token"), false);
  assert.deepEqual(states, [
    {
      destinationId: "ha-main",
      result: { outcome: "permanent_failure", errorCode: "ha_auth_invalid" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(states), /secret-token|ha\.example/iu);
  manager.stop();

  const timeoutManager = new HomeAssistantConnectionManager({
    webSocketFactory: () => {
      const next = new FakeSocket();
      sockets.push(next);
      return next;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    requestTimeoutMs: 10,
  });
  const ready = timeoutManager.ensureAuthenticated(destination({ destinationId: "other" }));
  const timeoutSocket = sockets.at(-1)!;
  timeoutSocket.open();
  timeoutSocket.message({ type: "auth_required" });
  timeoutSocket.message({ type: "auth_ok" });
  assert.deepEqual(await ready, { outcome: "success" });
  const pending = timeoutManager.sendEvent(destination({ destinationId: "other" }), EVENT);
  await Promise.resolve();
  scheduler.runAll();
  const timedOut = await pending;
  assert.equal(timedOut.outcome, "retryable_failure");
  assert.equal(timedOut.errorCode, "ha_request_timeout");
  timeoutManager.stop();
});
