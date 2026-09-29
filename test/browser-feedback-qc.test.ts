import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

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
  let router: Router | undefined;
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
