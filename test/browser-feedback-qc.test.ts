import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Script } from "node:vm";

import { createApplication } from "../src/application.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createDisplaySettingsService } from "../src/features/display/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import type { Router } from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";

const { createDirtyQueue } = (await import(
  new URL("../public/js/dirty-targets.js", import.meta.url).href
)) as {
  createDirtyQueue: (
    run: (target: string) => void | Promise<void>,
    maximumConcurrency?: number,
  ) => (target: string) => void;
};

void test("dirty queue releases synchronously thrown work and coalesces a pending rerun", async () => {
  const calls: string[] = [];
  const queue = createDirtyQueue((target) => {
    calls.push(target);
    if (target === "failed") throw new Error("synchronous failure");
  }, 1);
  assert.doesNotThrow(() => queue("failed"));
  queue("next");
  for (let count = 0; count < 50; count++) {
    queue("failed");
    queue("next");
  }
  assert.deepEqual(calls, [], "work starts in a promise continuation");
  await setImmediate();
  assert.deepEqual(calls, ["failed", "next", "failed"]);
  queue("later");
  await setImmediate();
  assert.deepEqual(calls, ["failed", "next", "failed", "later"]);
});

void test("dirty queue handles rejected work, bounds concurrency, and drains coalesced targets", async () => {
  const calls: string[] = [];
  const pending: { target: string; resolve: () => void; reject: (reason: Error) => void }[] = [];
  const queue = createDirtyQueue((target) => {
    calls.push(target);
    return new Promise<void>((resolve, reject) => pending.push({ target, resolve, reject }));
  }, 2);
  for (let count = 0; count < 50; count++) {
    queue("first");
    queue("second");
    queue("third");
  }
  await setImmediate();
  assert.deepEqual(calls, ["first", "second"]);
  pending.shift()!.reject(new Error("asynchronous failure"));
  await setImmediate();
  assert.deepEqual(calls, ["first", "second", "third"]);
  pending.shift()!.reject(new Error("another asynchronous failure"));
  await setImmediate();
  assert.deepEqual(calls, ["first", "second", "third", "first"]);
  pending.shift()!.resolve();
  await setImmediate();
  assert.deepEqual(calls, ["first", "second", "third", "first", "second"]);
  for (const task of pending.splice(0)) task.resolve();
  await setImmediate();
  queue("later");
  await setImmediate();
  assert.deepEqual(calls, ["first", "second", "third", "first", "second", "later"]);
  pending.shift()!.resolve();
  await setImmediate();
});

interface DashboardResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function dashboardSnapshot(name: string) {
  return {
    sharedDisplay: { revision: 1, tapboardName: name },
    header: { tapboardName: name, connectivityLabel: "Connected", connectivity: "connected" },
    taps: [],
    onDeck: { items: [] },
    tapWars: null,
  };
}

async function dashboardHarness() {
  const requests: {
    path: string;
    resolve: (response: DashboardResponse) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const paths: string[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  const brand = { textContent: "Server-rendered Tapboard" };
  const grid = { children: [], childElementCount: 0, querySelectorAll: () => [] };
  const voteFeedback = { textContent: "", classList: { remove: () => undefined } };
  const voteForm = { action: "/api/public/tap-wars/vote", querySelector: () => voteFeedback };
  let onEvent: (name: string, event: { data: string }) => void = () => assert.fail("No stream");
  let onReconnect: () => Promise<void> = () => Promise.reject(new Error("No stream"));
  let onSubmit: (event: {
    target: { closest: () => typeof voteForm };
    preventDefault: () => void;
  }) => Promise<void> = () => Promise.reject(new Error("No submit handler"));
  const source = await readFile(new URL("../public/js/dashboard.js", import.meta.url), "utf8");
  new Script(source.replace(/^import[\s\S]*?;\n/gmu, ""), {
    filename: "dashboard.js",
  }).runInNewContext({
    createDirtyQueue,
    document: {
      documentElement: { dataset: { layoutMode: "scroll" } },
      querySelector: (selector: string) => {
        if (selector === "[data-dashboard]") return { dataset: { ssePath: "/api/public/events" } };
        if (selector === "[data-tap-grid]") return grid;
        if (selector === ".public-brand") return brand;
        return null;
      },
      addEventListener: (name: string, listener: typeof onSubmit) => {
        if (name === "submit") onSubmit = listener;
      },
    },
    window: {
      addEventListener: () => undefined,
      clearInterval: () => undefined,
      setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
      matchMedia: () => ({ matches: true }),
    },
    FormData: class extends Map<string, string> {
      constructor() {
        super([["side", "1"]]);
      }
    },
    URLSearchParams,
    matchMedia: () => ({ matches: false }),
    applyPreferences: () => undefined,
    readPreferences: () => ({}),
    watchUtcDayChanges: () => ({ check: () => undefined, stop: () => undefined }),
    connect: (_path: string, receive: typeof onEvent, reconnect: typeof onReconnect) => {
      onEvent = receive;
      onReconnect = reconnect;
    },
    fetch: (path: string) => {
      paths.push(path);
      return new Promise<DashboardResponse>((resolve, reject) =>
        requests.push({ path, resolve, reject }),
      );
    },
  });
  function take(path: string) {
    const index = requests.findIndex((request) => request.path === path);
    assert.notEqual(
      index,
      -1,
      `Expected request for ${path}; pending: ${requests.map((request) => request.path).join(", ")}`,
    );
    return requests.splice(index, 1)[0]!;
  }
  function respond(path: string, value: unknown, status = 200) {
    take(path).resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(value),
    });
  }
  await setImmediate();
  respond("/api/public/tap-wars", { tapWars: null });
  await setImmediate();
  paths.length = 0;
  return {
    brand,
    paths,
    requests,
    timers,
    take,
    respond,
    voteFeedback,
    emit: (name: string, data: unknown = {}) => onEvent(name, { data: JSON.stringify(data) }),
    reconnect: () => onReconnect(),
    vote: () => onSubmit({ target: { closest: () => voteForm }, preventDefault: () => undefined }),
  };
}

for (const [event, target] of [
  ["integration_status.updated", "header"],
  ["ondeck.updated", "on-deck"],
  ["display.updated", "display"],
  ["tap.updated", "taps/tap-1"],
  ["tap_wars.updated", "tap-wars"],
]) {
  void test(`failed ${target} refresh reconciles authoritative state after HTTP failure`, async () => {
    const dashboard = await dashboardHarness();
    const path =
      target === "tap-wars" ? "/api/public/tap-wars" : `/api/public/dashboard/${target!}`;
    dashboard.emit(event!, { tapId: "tap-1" });
    await setImmediate();
    if (event === "tap.updated") {
      dashboard.respond(
        "/api/public/dashboard/header",
        dashboardSnapshot("Before recovery").header,
      );
      await setImmediate();
    }
    dashboard.respond(path, {}, 503);
    await setImmediate();
    assert.equal(dashboard.paths.filter((path) => path === "/api/public/dashboard").length, 1);
    dashboard.respond("/api/public/dashboard", dashboardSnapshot("Recovered Tapboard"));
    await setImmediate();
    assert.equal(dashboard.brand.textContent, "Recovered Tapboard");
    assert.equal(dashboard.requests.length, 0);
    assert.equal(dashboard.timers.length, 0);
  });
}

void test("failed refresh recovery retries with one timer and coalesces live updates without unhandled rejections", async () => {
  const dashboard = await dashboardHarness();
  dashboard.emit("integration_status.updated");
  dashboard.emit("tap_wars.updated");
  await setImmediate();
  dashboard.take("/api/public/dashboard/header").reject(new Error("Target fetch failed"));
  dashboard.take("/api/public/tap-wars").reject(new Error("Another target fetch failed"));
  await setImmediate();
  dashboard.take("/api/public/dashboard").reject(new Error("Recovery fetch failed"));
  await setImmediate();
  assert.equal(dashboard.timers.length, 1);
  assert.equal(dashboard.timers[0]?.delay, 1500);
  for (let count = 0; count < 100; count++) {
    dashboard.emit("integration_status.updated");
    dashboard.emit("tap_wars.updated");
  }
  await setImmediate();
  assert.deepEqual(dashboard.paths, [
    "/api/public/dashboard/header",
    "/api/public/tap-wars",
    "/api/public/dashboard",
  ]);
  dashboard.timers.shift()!.callback();
  await setImmediate();
  dashboard.respond("/api/public/dashboard", {}, 503);
  await setImmediate();
  assert.equal(dashboard.timers.length, 1);
  assert.equal(dashboard.timers[0]?.delay, 1500);
  dashboard.timers.shift()!.callback();
  await setImmediate();
  dashboard.take("/api/public/dashboard").resolve({
    ok: true,
    status: 200,
    json: () => Promise.reject(new Error("Recovery JSON failed")),
  });
  await setImmediate();
  assert.equal(dashboard.timers.length, 1);
  dashboard.timers.shift()!.callback();
  await setImmediate();
  dashboard.respond("/api/public/dashboard", dashboardSnapshot("Recovered Tapboard"));
  await setImmediate();
  assert.equal(dashboard.brand.textContent, "Recovered Tapboard");
  assert.deepEqual(dashboard.requests.map((request) => request.path).sort(), [
    "/api/public/dashboard/header",
    "/api/public/tap-wars",
  ]);
  dashboard.respond("/api/public/dashboard/header", dashboardSnapshot("Latest Tapboard").header);
  dashboard.respond("/api/public/tap-wars", { tapWars: null });
  await setImmediate();
  assert.equal(dashboard.brand.textContent, "Latest Tapboard");
  assert.equal(dashboard.requests.length, 0);
  assert.equal(dashboard.timers.length, 0);
  assert.equal(dashboard.paths.filter((path) => path === "/api/public/dashboard").length, 4);
});

void test("an older targeted response cannot overwrite a completed authoritative reconciliation", async () => {
  const dashboard = await dashboardHarness();
  dashboard.emit("integration_status.updated");
  await setImmediate();
  const stale = dashboard.take("/api/public/dashboard/header");
  const reconnect = dashboard.reconnect();
  await setImmediate();
  dashboard.respond("/api/public/dashboard", dashboardSnapshot("Reconnected Tapboard"));
  await reconnect;
  stale.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(dashboardSnapshot("Stale Tapboard").header),
  });
  await setImmediate();
  assert.equal(dashboard.brand.textContent, "Reconnected Tapboard");
  dashboard.respond("/api/public/dashboard/header", dashboardSnapshot("Latest Tapboard").header);
  await setImmediate();
  assert.equal(dashboard.brand.textContent, "Latest Tapboard");
  assert.deepEqual(dashboard.paths, [
    "/api/public/dashboard/header",
    "/api/public/dashboard",
    "/api/public/dashboard/header",
  ]);
});

void test("successful vote acknowledgement survives failed follow-up refresh and recovery", async () => {
  const dashboard = await dashboardHarness();
  const vote = dashboard.vote();
  dashboard.respond("/api/public/tap-wars/vote", {});
  await vote;
  await setImmediate();
  assert.equal(dashboard.voteFeedback.textContent, "Vote counted!");
  dashboard.respond("/api/public/tap-wars", {}, 503);
  await setImmediate();
  assert.equal(dashboard.voteFeedback.textContent, "Vote counted!");
  dashboard.respond("/api/public/dashboard", dashboardSnapshot("Recovered Tapboard"));
  await setImmediate();
  assert.equal(dashboard.voteFeedback.textContent, "Vote counted!");
  assert.equal(dashboard.brand.textContent, "Recovered Tapboard");
  assert.equal(dashboard.requests.length, 0);
});

const { watchUtcDayChanges } = (await import(
  new URL("../public/js/utc-day-refresh.js", import.meta.url).href
)) as {
  watchUtcDayChanges: (
    refresh: () => void,
    clock: {
      now: () => number;
      setTimer: (callback: () => void, delay: number) => number;
      clearTimer: (timer: number | undefined) => void;
    },
  ) => { check: () => void; stop: () => void };
};

void test("badge day refresh handles midnight, sleeping displays, and resume without duplicate timers", () => {
  let now = Date.parse("2026-08-17T23:59:59.000Z");
  let refreshed = 0;
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const watcher = watchUtcDayChanges(() => refreshed++, {
    now: () => now,
    setTimer(callback, delay) {
      timers.set(++nextId, { callback, delay });
      return nextId;
    },
    clearTimer(timer) {
      if (timer !== undefined) timers.delete(timer);
    },
  });
  assert.equal(refreshed, 0);
  assert.equal(timers.get(nextId)?.delay, 1_000);
  now += 1_000;
  timers.get(nextId)!.callback();
  assert.equal(refreshed, 1);
  assert.equal(timers.size, 1);
  assert.equal(timers.get(nextId)?.delay, 86_400_000);
  watcher.check();
  assert.equal(refreshed, 1);
  assert.equal(timers.size, 1);
  watcher.stop();
  assert.equal(timers.size, 0);
  now += 3 * 86_400_000 + 5_000;
  watcher.check();
  assert.equal(refreshed, 2);
  assert.equal(timers.get(nextId)?.delay, 86_395_000);
  watcher.stop();
});

class CapturedResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    Object.assign(this.headers, headers);
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(chunk);
  }
  destroy(): void {}
}

void test("Featured publishes only the assigned Tap after commit and Kick requires confirmation", async (context) => {
  const database = openDatabase(":memory:");
  const origin = "http://127.0.0.1:3000";
  const auth = createAuthService(database, { canonicalOrigin: origin });
  await auth.setPin("1234");
  const login = await auth.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const beverage = createBeverageService(database).createCustomBeverage({ name: "QC Ale" });
  const keg = createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19000 });
  const fills = createFillService(database);
  const fill = fills.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const taps = createTapService(database);
  const tap = taps.createTap({ tapNumber: 1 });
  taps.assignFill(tap.id, { fillId: fill.id });
  taps.createTap({ tapNumber: 2 });
  createDisplaySettingsService(database).setTapCardOverride(tap.id, { showIbu: false });
  let router: Pick<Router, "handle"> | undefined;
  const application = createApplication({
    config: {
      host: "127.0.0.1",
      port: 0,
      databasePath: ":memory:",
      shutdownGraceMs: 100,
      canonicalExternalOrigin: origin,
    },
    logger: createLogger({ sink: () => undefined }),
    openDatabase: () => database,
    createHttpServer: (options) => {
      router = options.router;
      return {
        start: () => Promise.resolve({ address: "127.0.0.1", family: "IPv4", port: 0 }),
        stop: () => Promise.resolve(),
      };
    },
  });
  context.after(() => application.stop());
  await application.start();
  assert.ok(router);
  const route = router;
  async function request(path: string, values?: Record<string, string>): Promise<CapturedResponse> {
    const body =
      values === undefined
        ? ""
        : new URLSearchParams({ _csrf: login.csrfToken!, ...values }).toString();
    const input = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      method: values === undefined ? "GET" : "POST",
      url: path,
      headers: {
        cookie: `tapboard_admin_session=${login.session!}`,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const response = new CapturedResponse();
    await route.handle(input as IncomingMessage, response as unknown as ServerResponse);
    return response;
  }
  const detail = await request(`/admin/taps/${tap.id}`);
  assert.equal(detail.status, 200);
  const detailHtml = detail.chunks.join("");
  assert.match(detailHtml, /name="confirmKick" value="true" required/u);
  assert.match(detailHtml, /name="showIbu" data-inherited-value="true"[\s\S]*?Inherit \(show\)/u);
  assert.match(detailHtml, /class="display-preview tap-public-preview__frame"/u);
  const events = await request("/api/public/events");
  events.chunks.length = 0;
  const featured = await request(`/admin/fills/${fill.id}/featured`, { featured: "true" });
  assert.equal(featured.status, 303);
  assert.match(featured.headers.location ?? "", /notice=/u);
  assert.equal(fills.getFill(fill.id).featured, true);
  assert.deepEqual(events.chunks, [`event: fill.updated\ndata: {"tapId":"${tap.id}"}\n\n`]);

  events.chunks.length = 0;
  const activityCount = database.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM activity_log",
  );
  const beforeInvalidFeatured = activityCount.get()?.count;
  const malformedFeaturedValues: Record<string, string>[] = [{}, { featured: "garbage" }];
  for (const values of malformedFeaturedValues) {
    const invalidFeatured = await request(`/admin/fills/${fill.id}/featured`, values);
    assert.match(invalidFeatured.headers.location ?? "", /error=/u);
    assert.equal(fills.getFill(fill.id).featured, true);
    assert.equal(activityCount.get()?.count, beforeInvalidFeatured);
    assert.deepEqual(events.chunks, []);
  }
  const unconfirmed = await request(`/admin/fills/${fill.id}/kick`, {});
  assert.match(unconfirmed.headers.location ?? "", /error=/u);
  assert.equal(fills.getFill(fill.id).endedAt, null);
  assert.equal(taps.getTap(tap.id).activeAssignment?.fillId, fill.id);
  assert.deepEqual(events.chunks, []);
  const kicked = await request(`/admin/fills/${fill.id}/kick`, { confirmKick: "true" });
  assert.match(kicked.headers.location ?? "", /notice=/u);
  assert.notEqual(fills.getFill(fill.id).endedAt, null);
  assert.equal(taps.getTap(tap.id).activeAssignment, null);

  events.chunks.length = 0;
  const endedUpdate = await request(`/admin/fills/${fill.id}/featured`, { featured: "false" });
  assert.match(endedUpdate.headers.location ?? "", /error=/u);
  assert.equal(fills.getFill(fill.id).featured, true);
  assert.deepEqual(events.chunks, []);
});
