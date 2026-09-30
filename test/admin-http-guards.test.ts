import assert from "node:assert/strict";
import test from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { registerBeverageRoutes } from "../src/features/beverages/routes.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { registerFillRoutes } from "../src/features/fills/routes.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { registerForecastRoutes } from "../src/features/forecasting/routes.ts";
import { createForecastService } from "../src/features/forecasting/service.ts";
import { registerHealthRoutes } from "../src/features/health/routes.ts";
import { createHealthService } from "../src/features/health/service.ts";
import { registerKegRoutes } from "../src/features/kegs/routes.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { createPublicStoryService } from "../src/features/story/service.ts";
import { registerTapRoutes } from "../src/features/taps/routes.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { registerTelemetryRoutes } from "../src/features/telemetry/routes.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { Router, type RouteHandler } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { createLogger } from "../src/shared/logging.ts";

const ORIGIN = "https://tapboard.example";
const REQUIRED = "Authentication is required.";
const FAILED = "Authentication failed.";
const logger = createLogger({ sink: () => undefined });

interface Endpoint {
  readonly method: string;
  readonly path: string;
}

class RecordingRouter extends Router {
  readonly adminEndpoints: Endpoint[] = [];

  override register(method: string, path: string, handler: RouteHandler): void {
    super.register(method, path, handler);
    if (path.startsWith("/api/admin/")) this.adminEndpoints.push({ method, path });
  }
}

async function assertUnauthorized(response: Response, message: string, label: string) {
  assert.equal(response.status, 401, label);
  assert.deepEqual(await response.json(), { error: { code: "auth.unauthorized", message } }, label);
}

function property(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    assert.ok(value !== null && typeof value === "object");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

void test("every Admin feature route rejects invalid cookies before feature work or parsing", async (context) => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  const database = openDatabase(":memory:");
  const authService = createAuthService(database, {
    canonicalOrigin: ORIGIN,
    now: () => now,
    session: { inactivityMs: 60_000, absoluteMs: 60_000 },
  });
  const router = new RecordingRouter(logger);
  const server = new HttpServer({ router, logger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });

  await authService.setPin("1234");
  const expired = await authService.authenticate("1234");
  assert.ok(expired.session);
  assert.ok(expired.csrfToken);
  now = new Date("2026-09-01T00:01:00.000Z");
  const login = await authService.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const csrfToken = login.csrfToken;
  const revoked = await authService.authenticate("1234");
  assert.ok(revoked.session);
  assert.ok(revoked.csrfToken);
  assert.equal(authService.revoke(revoked.session), true);

  const featureCalls: string[] = [];
  const blockedService = <T extends object>(feature: string): T =>
    new Proxy({} as T, {
      get(_target, method) {
        return () => {
          featureCalls.push(`${feature}.${String(method)}`);
          throw new Error("Unauthorized request reached a feature service");
        };
      },
    });
  const families: {
    name: string;
    mutationMessage: string;
    endpoints: readonly Endpoint[];
  }[] = [];
  const registerFamily = (name: string, register: () => void, mutationMessage = FAILED) => {
    const start = router.adminEndpoints.length;
    register();
    families.push({ name, mutationMessage, endpoints: router.adminEndpoints.slice(start) });
  };

  registerFamily("beverages", () =>
    registerBeverageRoutes({
      router,
      authService,
      beverageService: blockedService("beverages"),
    }),
  );
  registerFamily("fills", () =>
    registerFillRoutes({ router, authService, fillService: blockedService("fills") }),
  );
  registerFamily("kegs", () =>
    registerKegRoutes({ router, authService, kegService: blockedService("kegs") }),
  );
  registerFamily("taps", () =>
    registerTapRoutes({
      router,
      authService,
      tapService: blockedService("taps"),
      storyService: blockedService("story"),
    }),
  );
  registerFamily("telemetry", () =>
    registerTelemetryRoutes({
      router,
      authService,
      telemetryService: blockedService("telemetry"),
      detectorService: blockedService("detector"),
    }),
  );
  registerFamily(
    "forecasting",
    () =>
      registerForecastRoutes({
        router,
        authService,
        forecastService: blockedService("forecasting"),
      }),
    REQUIRED,
  );
  registerFamily(
    "health",
    () => registerHealthRoutes({ router, authService, healthService: blockedService("health") }),
    REQUIRED,
  );

  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `tapboard_admin_session=${login.session}`;
  const cookieCases = [
    { name: "missing cookie", headers: {} },
    { name: "malformed token", headers: { cookie: "tapboard_admin_session=invalid" } },
    { name: "malformed cookie encoding", headers: { cookie: "tapboard_admin_session=%zz" } },
    { name: "duplicate session cookie", headers: { cookie: `${cookie}; ${cookie}` } },
    {
      name: "expired session",
      headers: {
        cookie: `tapboard_admin_session=${expired.session}`,
        "x-csrf-token": expired.csrfToken,
      },
    },
    {
      name: "revoked session",
      headers: {
        cookie: `tapboard_admin_session=${revoked.session}`,
        "x-csrf-token": revoked.csrfToken,
      },
    },
    { name: "bearer cannot replace cookie", headers: { authorization: `Bearer ${login.session}` } },
  ];
  const mutationCases = [
    ...cookieCases.map(({ name, headers }) => ({
      name,
      headers: { origin: ORIGIN, "x-csrf-token": csrfToken, ...headers },
    })),
    { name: "missing Origin", headers: { cookie, "x-csrf-token": csrfToken } },
    {
      name: "wrong Origin",
      headers: { cookie, origin: "https://wrong.example", "x-csrf-token": csrfToken },
    },
    {
      name: "malformed Origin",
      headers: { cookie, origin: `${ORIGIN}/path`, "x-csrf-token": csrfToken },
    },
    { name: "missing CSRF", headers: { cookie, origin: ORIGIN } },
    {
      name: "malformed CSRF",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": "not-a-token" },
    },
    {
      name: "wrong CSRF",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": Buffer.alloc(32).toString("base64url") },
    },
    {
      name: "CSRF cookie cannot replace header",
      headers: { cookie: `${cookie}; tapboard_admin_csrf=${csrfToken}`, origin: ORIGIN },
    },
  ];

  for (const family of families) {
    await context.test(family.name, async () => {
      assert.ok(family.endpoints.some(({ method }) => method === "GET"));
      assert.ok(family.endpoints.some(({ method }) => method !== "GET"));
      for (const endpoint of family.endpoints) {
        const read = endpoint.method === "GET";
        // Invalid ids, query values, and JSON must never get past authentication.
        const path = endpoint.path.replace(/:[^/]+/g, "not-an-id") + "?limit=invalid";
        for (const scenario of read ? cookieCases : mutationCases) {
          const label = `${endpoint.method} ${endpoint.path}: ${scenario.name}`;
          const response = await fetch(`${base}${path}`, {
            method: endpoint.method,
            headers: { "content-type": "application/json", ...scenario.headers },
            ...(read ? {} : { body: "not-json" }),
          });
          await assertUnauthorized(response, read ? REQUIRED : family.mutationMessage, label);
          assert.deepEqual(featureCalls, [], label);
        }
      }
    });
  }
});

void test("all Admin guard families allow valid reads and mutations using Auth's configured origin", async (context) => {
  const database = openDatabase(":memory:");
  const authService = createAuthService(database, { canonicalOrigin: ORIGIN });
  const beverageService = createBeverageService(database);
  const fillService = createFillService(database);
  const kegService = createKegService(database);
  const tapService = createTapService(database);
  const forecastService = createForecastService(database);
  const healthService = createHealthService(database);
  const detectorService = new DetectorService(database);
  const telemetryService = new TelemetryService({
    database,
    machineKeyService: createMachineKeyService(database),
  });
  const storyService = createPublicStoryService({
    tapService,
    beverageService,
    fillService,
    detectorService,
    forecastService,
    healthService,
  });
  const router = new Router(logger);
  registerBeverageRoutes({ router, authService, beverageService });
  registerFillRoutes({ router, authService, fillService });
  registerKegRoutes({ router, authService, kegService });
  registerTapRoutes({ router, authService, tapService, storyService });
  registerTelemetryRoutes({ router, authService, telemetryService, detectorService });
  registerForecastRoutes({ router, authService, forecastService });
  registerHealthRoutes({ router, authService, healthService });
  const server = new HttpServer({ router, logger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });
  await authService.setPin("1234");
  const login = await authService.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const csrfToken = login.csrfToken;
  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `tapboard_admin_session=${login.session}`;

  const cases = [
    {
      path: "/api/admin/beverages/settings",
      body: { fallbackFg: 1.02 },
      result: ["settings", "fallbackFg"],
      expected: 1.02,
    },
    {
      path: "/api/admin/fills/settings",
      body: { autoDeleteBeverageOnLastFill: true },
      result: ["settings", "autoDeleteBeverageOnLastFill"],
      expected: true,
    },
    {
      path: "/api/admin/kegs",
      method: "POST",
      body: { kegNumber: 1, capacityMl: 1000, label: "Guard keg" },
      result: ["keg", "label"],
      readResult: ["kegs", "0", "label"],
      expected: "Guard keg",
    },
    {
      path: "/api/admin/taps",
      method: "POST",
      body: { tapNumber: 1, name: "Guard tap" },
      result: ["tap", "name"],
      readResult: ["taps", "0", "name"],
      expected: "Guard tap",
    },
    {
      path: "/api/admin/telemetry/settings",
      body: { maxBatchSize: 42 },
      result: ["settings", "maxBatchSize"],
      expected: 42,
    },
    {
      path: "/api/admin/forecast/settings",
      body: { servingSizeMl: 355 },
      result: ["settings", "servingSizeMl"],
      expected: 355,
    },
    {
      path: "/api/admin/health/settings",
      body: { low_keg: { enabled: false } },
      result: ["settings", "config", "low_keg", "enabled"],
      expected: false,
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.path, async () => {
      // Routes supply no origin override: Auth's configured origin differs from the HTTP host.
      const mutation = await fetch(`${base}${scenario.path}`, {
        method: scenario.method ?? "PATCH",
        headers: {
          cookie,
          origin: ORIGIN,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(scenario.body),
      });
      assert.equal(mutation.status, scenario.method === "POST" ? 201 : 200);
      assert.equal(property(await mutation.json(), scenario.result), scenario.expected);
      // Read requests do not require Origin or CSRF.
      const read = await fetch(`${base}${scenario.path}`, { headers: { cookie } });
      assert.equal(read.status, 200);
      assert.equal(
        property(await read.json(), scenario.readResult ?? scenario.result),
        scenario.expected,
      );
    });
  }
});

void test("Admin mutation guard fails closed when Auth has no configured canonical origin", async (context) => {
  const database = openDatabase(":memory:");
  const authService = createAuthService(database);
  const fillService = createFillService(database);
  const router = new Router(logger);
  registerFillRoutes({ router, authService, fillService });
  const server = new HttpServer({ router, logger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });
  await authService.setPin("1234");
  const login = await authService.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const csrfToken = login.csrfToken;
  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `tapboard_admin_session=${login.session}`;
  const before = fillService.getSettings();
  const response = await fetch(`${base}/api/admin/fills/settings`, {
    method: "PATCH",
    headers: {
      cookie,
      origin: base,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ autoDeleteBeverageOnLastFill: !before.autoDeleteBeverageOnLastFill }),
  });
  await assertUnauthorized(response, FAILED, "unconfigured canonical origin");
  assert.deepEqual(fillService.getSettings(), before);
});
