import assert from "node:assert/strict";
import { Agent, createServer, request as nativeHttpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import test from "node:test";

import type { RequestOptions } from "node:http";
import {
  WebhookTransport,
  isPublicNetworkAddress,
  normalizeWebhookUrl,
  type DnsLookupAddress,
  type WebhookRequestLike,
  type WebhookResponseLike,
} from "../src/features/outbound/transports/webhook.ts";

const EVENT = {
  schema_version: 1 as const,
  event_id: "33333333-3333-4333-8333-333333333333",
  event_type: "pour.completed" as const,
  occurred_at: "2026-08-17T12:00:00.000Z",
  identifiers: { tap_id: "11111111-1111-4111-8111-111111111111" },
  data: { volume_ml: 355 },
};

class FakeScheduler {
  #next = 1;
  readonly #timers = new Map<
    number,
    { readonly handler: () => void; readonly timeoutMs: number }
  >();
  schedule = (_handler: () => void, _timeoutMs: number): number => {
    const id = this.#next++;
    this.#timers.set(id, { handler: _handler, timeoutMs: _timeoutMs });
    return id;
  };
  cancel = (id: unknown): void => {
    if (typeof id === "number") this.#timers.delete(id);
  };
  runAll(): void {
    for (const [id, timer] of [...this.#timers]) {
      this.#timers.delete(id);
      timer.handler();
    }
  }
  runShortest(): void {
    const next = [...this.#timers.entries()].sort(
      ([, left], [, right]) => left.timeoutMs - right.timeoutMs,
    )[0];
    assert.ok(next);
    this.#timers.delete(next[0]);
    next[1].handler();
  }
}

class FakeResponse implements WebhookResponseLike {
  readonly #listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  readonly statusCode: number;
  constructor(statusCode: number) {
    this.statusCode = statusCode;
  }
  on(event: string, listener: (...args: readonly unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  destroy(): void {
    this.emit("close");
  }
  emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

class FakeRequest implements WebhookRequestLike {
  readonly #listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  body: string | undefined;
  destroyed = false;
  on(event: string, listener: (...args: readonly unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  end(data?: string): void {
    this.body = data;
  }
  destroy(): void {
    this.destroyed = true;
  }
  abort(): void {
    this.destroyed = true;
  }
  emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

class FakeSocket {
  readonly #listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  on(event: string, listener: (...args: readonly unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  once(event: string, listener: (...args: readonly unknown[]) => void): this {
    const wrapped = (...args: readonly unknown[]): void => {
      this.#listeners.set(
        event,
        (this.#listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
      );
      listener(...args);
    };
    return this.on(event, wrapped);
  }
  emit(event: string): void {
    for (const listener of this.#listeners.get(event) ?? []) listener();
  }
}

function harness(
  addresses: readonly DnsLookupAddress[] = [{ address: "93.184.216.34", family: 4 }],
  status = 204,
) {
  const scheduler = new FakeScheduler();
  const requests: { options: RequestOptions; request: FakeRequest; response: FakeResponse }[] = [];
  const transport = new WebhookTransport({
    dnsLookup: () => Promise.resolve(addresses),
    httpRequest: (options, onResponse) => {
      const request = new FakeRequest();
      const response = new FakeResponse(status);
      requests.push({ options, request, response });
      onResponse(response);
      return request;
    },
    httpsRequest: (options, onResponse) => {
      const request = new FakeRequest();
      const response = new FakeResponse(status);
      requests.push({ options, request, response });
      onResponse(response);
      return request;
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    overallTimeoutMs: 50,
    connectTimeoutMs: 20,
    responseTimeoutMs: 30,
  });
  return { scheduler, requests, transport };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

void test("webhook URL validation rejects userinfo and non-http schemes", () => {
  assert.equal(normalizeWebhookUrl("https://example.com/hooks"), "https://example.com/hooks");
  for (const value of [
    "ftp://example.com/hooks",
    "https://user:pass@example.com/hooks",
    "https://example.com/hooks#fragment",
  ]) {
    assert.throws(() => normalizeWebhookUrl(value));
  }
});

void test("public-network classifier rejects private, metadata, mapped, and reserved addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:192.168.1.1",
    "::192.0.2.1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "100::1",
    "2001:db8::1",
    "2001:20::1",
    "4000::1",
  ]) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  for (const address of ["93.184.216.34", "2001:4860:4860::8888"]) {
    assert.equal(isPublicNetworkAddress(address), true, address);
  }
});

void test("webhook pins the approved DNS address and owns content type", async () => {
  const h = harness();
  const pending = h.transport.sendEvent(
    {
      url: "https://example.com/hook?source=tapboard",
      headers: { Authorization: "Bearer secret" },
    },
    EVENT,
  );
  await flushMicrotasks();
  const request = h.requests[0]!;
  assert.equal(request.options.hostname, "example.com");
  assert.equal(request.options.protocol, "https:");
  assert.equal(
    (request.options as RequestOptions & { servername?: string }).servername,
    "example.com",
  );
  assert.equal(typeof request.options.lookup, "function");
  request.options.lookup!("example.com", { all: false }, (error, address) => {
    assert.equal(error, null);
    assert.equal(address, "93.184.216.34");
  });
  request.options.lookup!("example.com", { all: true }, (error, address) => {
    assert.equal(error, null);
    assert.deepEqual(address, [{ address: "93.184.216.34", family: 4 }]);
  });
  const headers = request.options.headers as Record<string, unknown> | undefined;
  assert.equal(headers?.["content-type"], "application/json; charset=utf-8");
  assert.equal(headers?.authorization, "Bearer secret");
  assert.equal(headers?.host, undefined);
  assert.deepEqual(parseObject(request.request.body!), EVENT);
  const socket = new FakeSocket();
  request.request.emit("socket", socket);
  socket.emit("connect");
  request.response.emit("end");
  assert.deepEqual(await pending, { outcome: "success", status: 204 });
});

void test("webhook pins a real Node 24 HTTP/TCP dial without changing the logical host", async () => {
  let receivedHost: string | undefined;
  let receivedPath: string | undefined;
  let receivedBody = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      receivedHost = request.headers.host;
      receivedPath = request.url;
      receivedBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(204);
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const localPort = address.port;
  let selectedAddress: string | undefined;
  let selectedFamily: number | undefined;
  let lookupFamily: number | string | undefined;
  let lookupWasAll = false;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (connectionOptions, _oncreate) => {
    const requestOptions = connectionOptions as typeof connectionOptions & {
      readonly autoSelectFamily?: boolean;
    };
    const productionLookup = requestOptions.lookup;
    assert.ok(productionLookup);
    return netConnect({
      host: requestOptions.host ?? "example.test",
      port: localPort,
      ...(requestOptions.family === undefined ? {} : { family: requestOptions.family }),
      autoSelectFamily: requestOptions.autoSelectFamily ?? false,
      lookup: (hostname, options, callback) => {
        lookupFamily = options.family;
        lookupWasAll = options.all === true;
        productionLookup(hostname, options, (error, addressValue, family) => {
          if (error !== null) {
            callback(error, addressValue, family);
            return;
          }
          if (options.all === true) {
            const first = Array.isArray(addressValue) ? addressValue[0] : undefined;
            selectedAddress = first?.address;
            selectedFamily = first?.family;
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
            return;
          }
          if (typeof addressValue !== "string") {
            lookupWasAll = true;
            callback(null, "127.0.0.1", 4);
            return;
          }
          selectedAddress = addressValue;
          selectedFamily = family;
          callback(null, "127.0.0.1", 4);
        });
      },
    });
  };

  try {
    const transport = new WebhookTransport({
      dnsLookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      httpRequest: (options, onResponse) =>
        nativeHttpRequest({ ...options, agent }, (response) => onResponse(response)),
      overallTimeoutMs: 1_000,
      connectTimeoutMs: 500,
      responseTimeoutMs: 500,
    });
    const result = await transport.sendEvent(
      { url: "http://example.test/hook?source=tapboard" },
      EVENT,
    );

    assert.deepEqual(result, { outcome: "success", status: 204 });
    assert.equal(selectedAddress, "93.184.216.34");
    assert.equal(selectedFamily, 4);
    assert.equal(lookupFamily, 4);
    assert.equal(lookupWasAll, false);
    assert.equal(receivedHost, "example.test");
    assert.equal(receivedPath, "/hook?source=tapboard");
    assert.deepEqual(parseObject(receivedBody), EVENT);
  } finally {
    agent.destroy();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }
});

void test("mixed DNS answers fail closed and each attempt resolves again", async () => {
  let lookups = 0;
  const h = harness([
    { address: "93.184.216.34", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);
  const unsafe = await h.transport.sendEvent({ url: "http://example.com/hook" }, EVENT);
  assert.deepEqual(unsafe, { outcome: "permanent_failure", errorCode: "webhook_dns_unsafe" });

  const mismatched = harness([{ address: "93.184.216.34", family: 6 }]);
  assert.deepEqual(
    await mismatched.transport.sendEvent({ url: "http://example.com/hook" }, EVENT),
    { outcome: "permanent_failure", errorCode: "webhook_dns_unsafe" },
  );

  const second = new WebhookTransport({
    dnsLookup: () => {
      lookups += 1;
      return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
    },
    httpRequest: (_options, _onResponse) => new FakeRequest(),
    schedule: h.scheduler.schedule,
    cancel: h.scheduler.cancel,
  });
  // Request timeouts are retryable, but DNS is still re-resolved per attempt.
  const firstPending = second.sendEvent({ url: "http://example.com/hook" }, EVENT);
  await flushMicrotasks();
  h.scheduler.runAll();
  const first = await firstPending;
  const nextPending = second.sendEvent({ url: "http://example.com/hook" }, EVENT);
  await flushMicrotasks();
  h.scheduler.runAll();
  const next = await nextPending;
  assert.equal(first.outcome, "retryable_failure");
  assert.equal(next.outcome, "retryable_failure");
  assert.equal(lookups, 2);
});

void test("direct IP literals are revalidated and private literals never reach a request", async () => {
  let publicLookup = "";
  const publicHarness = harness();
  const publicTransport = new WebhookTransport({
    dnsLookup: (hostname) => {
      publicLookup = hostname;
      return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
    },
    httpRequest: (options, onResponse) => {
      const request = new FakeRequest();
      const response = new FakeResponse(204);
      publicHarness.requests.push({ options, request, response });
      onResponse(response);
      return request;
    },
    schedule: publicHarness.scheduler.schedule,
    cancel: publicHarness.scheduler.cancel,
  });
  const pending = publicTransport.sendEvent({ url: "http://93.184.216.34/hook" }, EVENT);
  await flushMicrotasks();
  assert.equal(publicLookup, "93.184.216.34");
  publicHarness.requests[0]!.response.emit("end");
  assert.equal((await pending).outcome, "success");

  let privateRequests = 0;
  const privateTransport = new WebhookTransport({
    dnsLookup: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    httpRequest: () => {
      privateRequests += 1;
      return new FakeRequest();
    },
  });
  assert.deepEqual(await privateTransport.sendEvent({ url: "http://127.0.0.1/hook" }, EVENT), {
    outcome: "permanent_failure",
    errorCode: "webhook_dns_unsafe",
  });
  assert.equal(privateRequests, 0);
});

void test("webhook can select bounded Discord formatting with a public resolver", async () => {
  const h = harness();
  const pending = h.transport.sendEvent(
    {
      url: "http://example.com/hook",
      payloadFormat: "discord",
      publicContextResolver: () => ({ tapNumber: 3, title: "Mystery Tap" }),
    },
    EVENT,
  );
  await flushMicrotasks();
  const request = h.requests[0]!;
  const body = parseObject(request.request.body!);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(JSON.stringify(body).includes("Mystery Tap · Tap 3"), true);
  assert.equal(JSON.stringify(body).includes(EVENT.event_id), false);
  const socket = new FakeSocket();
  request.request.emit("socket", socket);
  socket.emit("secureConnect");
  request.response.emit("end");
  assert.deepEqual(await pending, { outcome: "success", status: 204 });
});

void test("header denylist is case-insensitive and redirects are never followed", async () => {
  for (const name of [
    "Host",
    "Content-Length",
    "Connection",
    "Transfer-Encoding",
    "Upgrade",
    "Proxy-Authorization",
    "Proxy-Connection",
    "TE",
    "Trailer",
    "Content-Encoding",
    "Content-Type",
    "Expect",
    "Via",
    "X-Forwarded-For",
  ]) {
    const h = harness();
    const result = await h.transport.sendEvent(
      { url: "http://example.com/hook", headers: { [name]: "x" } },
      EVENT,
    );
    assert.deepEqual(result, {
      outcome: "permanent_failure",
      errorCode: "webhook_invalid_configuration",
    });
    assert.equal(h.requests.length, 0);
  }

  for (const status of [200, 204, 408, 425, 429, 500, 502, 301, 302, 307, 308, 400, 404]) {
    const h = harness([], status);
    const transport = new WebhookTransport({
      dnsLookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
      httpRequest: (options, onResponse) => {
        const request = new FakeRequest();
        const response = new FakeResponse(status);
        h.requests.push({ options, request, response });
        onResponse(response);
        return request;
      },
      schedule: h.scheduler.schedule,
      cancel: h.scheduler.cancel,
    });
    const pending = transport.sendEvent({ url: "http://example.com/hook" }, EVENT);
    await flushMicrotasks();
    const request = h.requests[0]!;
    const socket = new FakeSocket();
    request.request.emit("socket", socket);
    socket.emit("connect");
    request.response.emit("end");
    const result = await pending;
    if (status >= 200 && status < 300) {
      assert.equal(result.outcome, "success");
    } else if (status === 408 || status === 425 || status === 429 || status >= 500) {
      assert.equal(result.outcome, "retryable_failure");
    } else {
      assert.equal(result.outcome, "permanent_failure");
      assert.equal(
        result.errorCode,
        status >= 300 && status < 400 ? "webhook_redirect" : `webhook_http_${status}`,
      );
    }
  }
});

void test("network errors retry and oversized response bodies are discarded without storage", async () => {
  const network = harness();
  const networkPending = network.transport.sendEvent({ url: "http://example.com/hook" }, EVENT);
  await flushMicrotasks();
  network.requests[0]!.request.emit("error", new Error("remote secret must not escape"));
  assert.deepEqual(await networkPending, {
    outcome: "retryable_failure",
    errorCode: "webhook_request_error",
  });

  const large = harness();
  const largePending = large.transport.sendEvent({ url: "http://example.com/hook" }, EVENT);
  await flushMicrotasks();
  large.requests[0]!.response.emit("data", new Uint8Array(65 * 1024));
  assert.deepEqual(await largePending, {
    outcome: "permanent_failure",
    errorCode: "webhook_response_too_large",
  });
  assert.equal(large.requests[0]!.request.destroyed, true);
});

void test("timeout aborts and returns a bounded retryable result without response persistence", async () => {
  const h = harness();
  const pending = h.transport.sendEvent({ url: "http://example.com/hook" }, EVENT);
  await flushMicrotasks();
  const request = h.requests[0]!;
  h.scheduler.runAll();
  const result = await pending;
  assert.equal(result.outcome, "retryable_failure");
  assert.equal(result.errorCode, "webhook_timeout");
  assert.equal(request.request.destroyed, true);
});

void test("connect timeout waits for the socket connect boundary", async () => {
  const h = harness();
  const pending = h.transport.sendEvent({ url: "http://example.com/hook" }, EVENT);
  await flushMicrotasks();
  const request = h.requests[0]!;
  const socket = new FakeSocket();
  request.request.emit("socket", socket);
  h.scheduler.runShortest();
  assert.deepEqual(await pending, {
    outcome: "retryable_failure",
    errorCode: "webhook_connect_timeout",
  });
  assert.equal(request.request.destroyed, true);
});
