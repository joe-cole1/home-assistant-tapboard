import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createApplication } from "../src/application.ts";
import { appendActivity, listActivities } from "../src/features/activity/index.ts";
import { createAuthService, type AuthService } from "../src/features/auth/index.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
} from "../src/infrastructure/http/security/cookie.ts";
import { createLogger } from "../src/shared/logging.ts";

const ORIGIN = "http://tapboard.test";
const PRIVATE_NOTE = "PRIVATE_SYSTEM_ACTIVITY_NOTE";
const PRIVATE_ENDPOINT = "https://system-private.invalid/PRIVATE_ENDPOINT";
const PRIVATE_ACTOR = "PRIVATE_SYSTEM_ACTIVITY_ACTOR";
const PRIVATE_SESSION = "PRIVATE_SYSTEM_ACTIVITY_SESSION";
const PRIVATE_ENTITY = "PRIVATE_SYSTEM_ACTIVITY_ENTITY";

interface Fixture {
  readonly base: string;
  readonly databasePath: string;
  readonly database: DatabaseConnection;
  readonly auth: AuthService;
  readonly logs: readonly string[];
}

interface AdminBrowser {
  readonly cookie: string;
  readonly csrf: string;
  readonly token: string;
  readonly id: string;
}

async function fixture(context: TestContext): Promise<Fixture> {
  const directory = mkdtempSync("/tmp/tapboard-system-web-");
  const databasePath = join(directory, "PRIVATE_SYSTEM_DATABASE.sqlite3");
  const database = openDatabase(databasePath);
  const auth = createAuthService(database, { canonicalOrigin: ORIGIN });
  await auth.resetOperatorPin("1234");
  const logs: string[] = [];
  const application = createApplication({
    config: {
      host: "127.0.0.1",
      port: 0,
      databasePath,
      shutdownGraceMs: 100,
      canonicalExternalOrigin: ORIGIN,
      trustedProxies: [],
      sessionInactivityMs: 86_400_000,
      sessionAbsoluteMs: 86_400_000,
    },
    logger: createLogger({ sink: (line) => logs.push(line) }),
  });
  context.after(async () => {
    try {
      await application.stop();
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const address = await application.start();
  return {
    base: `http://127.0.0.1:${address.port}`,
    databasePath,
    database,
    auth,
    logs,
  };
}

function browserFromResponse(f: Fixture, response: Response): AdminBrowser {
  const cookies = new Map<string, string>();
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    assert.ok(pair);
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const token = cookies.get(ADMIN_SESSION_COOKIE);
  const csrf = cookies.get(ADMIN_CSRF_COOKIE);
  assert.ok(token && csrf, "successful login/switch must set both authentication cookies");
  const current = f.auth.validateSession(token);
  assert.ok(current, "the normal authentication authority must recognize the session");
  return {
    cookie: `${ADMIN_SESSION_COOKIE}=${token}; ${ADMIN_CSRF_COOKIE}=${csrf}`,
    csrf,
    token,
    id: current.id,
  };
}

async function login(f: Fixture, pin = "1234"): Promise<AdminBrowser> {
  const response = await fetch(`${f.base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/overview");
  return browserFromResponse(f, response);
}

function get(f: Fixture, path: string, browser?: AdminBrowser): Promise<Response> {
  return fetch(`${f.base}${path}`, {
    redirect: "manual",
    ...(browser === undefined ? {} : { headers: { cookie: browser.cookie } }),
  });
}

function post(
  f: Fixture,
  path: string,
  fields: Readonly<Record<string, string>>,
  browser: AdminBrowser,
  options: {
    readonly origin?: string | null;
    readonly csrf?: string | null;
    readonly cookie?: null;
  } = {},
): Promise<Response> {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const csrf = options.csrf === undefined ? browser.csrf : options.csrf;
  return fetch(`${f.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(options.cookie === null ? {} : { cookie: browser.cookie }),
      ...(origin === null ? {} : { origin }),
    },
    body: new URLSearchParams({ ...fields, ...(csrf === null ? {} : { _csrf: csrf }) }),
  });
}

function location(response: Response): URL {
  assert.equal(response.status, 303);
  const value = response.headers.get("location");
  assert.ok(value);
  return new URL(value, ORIGIN);
}

function assertRejected(response: Response, message?: RegExp): void {
  const redirect = location(response);
  assert.equal(redirect.pathname, "/admin/system");
  assert.ok(redirect.searchParams.has("error"));
  assert.equal(redirect.searchParams.has("notice"), false);
  if (message !== undefined) assert.match(redirect.searchParams.get("error") ?? "", message);
}

function settings(f: Fixture): unknown[] {
  return [
    "beverage_settings",
    "forecast_settings",
    "activity_retention",
    "telemetry_settings",
    "outbox_retention",
    "auth_session_settings",
  ].map((table) => f.database.prepare<[], Record<string, unknown>>(`SELECT * FROM ${table}`).get());
}

function activityCount(f: Fixture): number {
  return f.database
    .prepare<[], { count: number }>("SELECT count(*) AS count FROM activity_log")
    .get()!.count;
}

function inputValue(html: string, name: string): string {
  const value = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "u").exec(html)?.[1];
  assert.notEqual(value, undefined, `missing rendered ${name} input`);
  return value!;
}

function activitySection(html: string): string {
  const section = /<section id="activity"[\s\S]*?<\/section>/u.exec(html)?.[0];
  assert.ok(section);
  return section;
}

function activityTimes(html: string): string[] {
  return [...activitySection(html).matchAll(/<time datetime="([^"]+)"/gu)].map(
    (match) => match[1]!,
  );
}

async function assertSignedOut(f: Fixture, browser: AdminBrowser): Promise<void> {
  const response = await get(f, "/admin/system", browser);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/login");
  assert.equal(f.auth.validateSession(browser.token), undefined);
}

void test("System is authenticated SSR with bounded Activity pagination and private diagnostics", async (context) => {
  const f = await fixture(context);
  const anonymous = await get(f, "/admin/system");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/admin/login");
  const now = Date.now();
  for (let index = 0; index < 55; index += 1) {
    appendActivity(f.database, {
      category: "domain",
      action: "transition",
      actorType: "admin",
      actorId: PRIVATE_ACTOR,
      sessionId: PRIVATE_SESSION,
      entityType: index === 0 ? PRIVATE_ENTITY : "tap",
      entityId: PRIVATE_ENDPOINT,
      details: { note: PRIVATE_NOTE },
      occurredAt: new Date(now + index).toISOString(),
    });
  }
  const browser = await login(f);
  const response = await get(f, "/admin/system?category=domain", browser);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  for (const heading of [
    "System status",
    "Application version",
    "Schema version",
    "Diagnostics",
    "Activity Log",
  ]) {
    assert.ok(html.includes(heading));
  }
  for (const privateValue of [
    PRIVATE_NOTE,
    PRIVATE_ENDPOINT,
    PRIVATE_ACTOR,
    PRIVATE_SESSION,
    PRIVATE_ENTITY,
    "PRIVATE_SYSTEM_DATABASE.sqlite3",
    f.databasePath,
    browser.token,
  ]) {
    assert.ok(
      !html.includes(privateValue),
      "System HTML must exclude private metadata and session tokens",
    );
  }
  assert.doesNotMatch(html, /session_digest|csrf_digest|details_json/u);
  assert.equal(activityTimes(html).length, 50);
  const olderHref = /href="([^"]+)"[^>]*>Older activity<\/a>/u.exec(activitySection(html))?.[1];
  assert.ok(olderHref);
  const olderPath = olderHref.replaceAll("&amp;", "&");
  const olderUrl = new URL(olderPath, ORIGIN);
  assert.equal(olderUrl.searchParams.get("category"), "domain");
  assert.ok(olderUrl.searchParams.get("cursor"));
  const secondResponse = await get(f, olderPath, browser);
  assert.equal(secondResponse.status, 200);
  const secondHtml = await secondResponse.text();
  const firstTimes = activityTimes(html);
  const secondTimes = activityTimes(secondHtml);
  assert.equal(secondTimes.length, 5);
  assert.equal(new Set([...firstTimes, ...secondTimes]).size, 55);
  assert.ok(!secondHtml.includes(PRIVATE_ENTITY));
  for (const query of ["?category=unsupported", "?cursor=not-a-valid-cursor"]) {
    const invalid = await get(f, `/admin/system${query}`, browser);
    assert.equal(invalid.status, 400);
  }
  const publicHtml = await (await get(f, "/")).text();
  assert.ok(!publicHtml.includes(PRIVATE_NOTE));
  assert.ok(!publicHtml.includes("system-diagnostics-heading"));
});

void test("System rejects Origin/CSRF failures and unsupported form fields without mutation", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  const other = await login(f);
  const baseline = settings(f);
  const auditCount = activityCount(f);
  const credential = f.auth.getCredentialStatus();
  const calculation = { fallbackFg: "1.020", servingSizeMl: "300" };
  for (const options of [
    { origin: null },
    { origin: "http://other.invalid" },
    { origin: "null" },
    { csrf: null },
    { csrf: "invalid" },
    { cookie: null },
  ]) {
    assertRejected(
      await post(f, "/admin/system/calculation", calculation, browser, options),
      /authorized/u,
    );
    assert.deepEqual(settings(f), baseline);
    assert.equal(activityCount(f), auditCount);
  }
  const attempts: readonly [string, Record<string, string>][] = [
    ["/admin/system/calculation", calculation],
    [
      "/admin/system/retention",
      {
        activityDays: "14",
        rawSeconds: "300",
        receiptSeconds: "3600",
        reconnectSeconds: "60",
        outboxDays: "7",
      },
    ],
    [
      "/admin/system/session-policy",
      { inactivityMinutes: "30", absoluteMinutes: "60", expectedRevision: "0" },
    ],
    [`/admin/system/sessions/${other.id}/revoke`, { confirm: "revoke" }],
    ["/admin/system/pin", { currentPin: "1234", newPin: "2345", confirmPin: "2345" }],
  ];
  for (const [path, fields] of attempts) {
    assertRejected(
      await post(f, path, { ...fields, unsupported: "must-not-be-used" }, browser),
      /unsupported field/u,
    );
    assert.deepEqual(settings(f), baseline);
    assert.equal(activityCount(f), auditCount);
    assert.deepEqual(f.auth.getCredentialStatus(), credential);
    assert.ok(f.auth.validateSession(browser.token));
    assert.ok(f.auth.validateSession(other.token));
  }
});

void test("invalid retention horizons reject every setting atomically while valid saves persist", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  const baseline = settings(f);
  const count = activityCount(f);
  const valid = {
    activityDays: "14",
    rawSeconds: "300",
    receiptSeconds: "3600",
    reconnectSeconds: "60",
    outboxDays: "7",
  };
  for (const invalid of [
    { ...valid, rawSeconds: "7200" },
    { ...valid, reconnectSeconds: "7200" },
  ]) {
    assertRejected(await post(f, "/admin/system/retention", invalid, browser));
    assert.deepEqual(settings(f), baseline);
    assert.equal(activityCount(f), count);
  }
  const saved = await post(f, "/admin/system/retention", valid, browser);
  assert.ok(location(saved).searchParams.has("notice"));
  const html = await (await get(f, "/admin/system", browser)).text();
  for (const [name, value] of Object.entries(valid)) assert.equal(inputValue(html, name), value);
  assert.ok(activityCount(f) > count);
});

void test("valid calculation defaults save through the real System form and survive a fresh read", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  const count = activityCount(f);
  const response = await post(
    f,
    "/admin/system/calculation",
    { fallbackFg: "1.012", servingSizeMl: "375" },
    browser,
  );
  assert.ok(location(response).searchParams.has("notice"));
  const html = await (await get(f, "/admin/system", browser)).text();
  assert.equal(inputValue(html, "fallbackFg"), "1.012");
  assert.equal(inputValue(html, "servingSizeMl"), "375");
  assert.ok(activityCount(f) > count);
  const repeated = await post(
    f,
    "/admin/system/calculation",
    {
      fallbackFg: inputValue(html, "fallbackFg"),
      servingSizeMl: inputValue(html, "servingSizeMl"),
    },
    browser,
  );
  assert.ok(location(repeated).searchParams.has("notice"));
  const refreshed = await (await get(f, "/admin/system", browser)).text();
  assert.equal(inputValue(refreshed, "fallbackFg"), "1.012");
  assert.equal(inputValue(refreshed, "servingSizeMl"), "375");
});

void test("System session-policy forms enforce expected revision and keep the saved policy on conflict", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  const initial = await (await get(f, "/admin/system", browser)).text();
  const expectedRevision = inputValue(initial, "expectedRevision");
  const first = await post(
    f,
    "/admin/system/session-policy",
    {
      inactivityMinutes: "120",
      absoluteMinutes: "240",
      expectedRevision,
    },
    browser,
  );
  assert.ok(location(first).searchParams.has("notice"));
  const saved = f.auth.getSessionPolicy();
  assert.equal(saved.revision, Number(expectedRevision) + 1);
  assert.equal(saved.inactivityMs, 120 * 60_000);
  assert.equal(saved.absoluteMs, 240 * 60_000);
  const count = activityCount(f);
  const stale = await post(
    f,
    "/admin/system/session-policy",
    {
      inactivityMinutes: "180",
      absoluteMinutes: "360",
      expectedRevision,
    },
    browser,
  );
  assertRejected(stale, /concurrently/u);
  assert.deepEqual(f.auth.getSessionPolicy(), saved);
  assert.equal(activityCount(f), count);
  const refreshed = await (await get(f, "/admin/system", browser)).text();
  assert.equal(inputValue(refreshed, "expectedRevision"), String(saved.revision));
  assert.equal(inputValue(refreshed, "inactivityMinutes"), "120");
  assert.equal(inputValue(refreshed, "absoluteMinutes"), "240");
});

void test("System session-policy minute forms round-trip whole milliseconds and reject genuinely fractional milliseconds", async (context) => {
  const f = await fixture(context);
  const browser = await login(f);
  const initial = await (await get(f, "/admin/system", browser)).text();
  const saved = await post(
    f,
    "/admin/system/session-policy",
    {
      inactivityMinutes: String(61_337 / 60_000),
      absoluteMinutes: String(123_457 / 60_000),
      expectedRevision: inputValue(initial, "expectedRevision"),
    },
    browser,
  );
  assert.ok(location(saved).searchParams.has("notice"));
  assert.equal(f.auth.getSessionPolicy().inactivityMs, 61_337);
  assert.equal(f.auth.getSessionPolicy().absoluteMs, 123_457);
  const html = await (await get(f, "/admin/system", browser)).text();
  const rendered = {
    inactivityMinutes: inputValue(html, "inactivityMinutes"),
    absoluteMinutes: inputValue(html, "absoluteMinutes"),
    expectedRevision: inputValue(html, "expectedRevision"),
  };
  const policy = f.auth.getSessionPolicy();
  const count = activityCount(f);
  const roundTrip = await post(f, "/admin/system/session-policy", rendered, browser);
  assert.ok(location(roundTrip).searchParams.has("notice"));
  assert.deepEqual(f.auth.getSessionPolicy(), policy);
  assert.equal(activityCount(f), count);

  const decimal = await post(
    f,
    "/admin/system/session-policy",
    { ...rendered, inactivityMinutes: "1.001" },
    browser,
  );
  assert.ok(location(decimal).searchParams.has("notice"));
  const exact = f.auth.getSessionPolicy();
  assert.equal(exact.inactivityMs, 60_060);
  assert.equal(exact.absoluteMs, 123_457);
  assert.equal(exact.revision, policy.revision + 1);
  const exactCount = activityCount(f);
  for (const invalid of [
    { inactivityMinutes: "1.000001", absoluteMinutes: rendered.absoluteMinutes },
    { inactivityMinutes: "1.001", absoluteMinutes: "2.000001" },
  ]) {
    assertRejected(
      await post(
        f,
        "/admin/system/session-policy",
        { ...invalid, expectedRevision: String(exact.revision) },
        browser,
      ),
    );
    assert.deepEqual(f.auth.getSessionPolicy(), exact);
    assert.equal(activityCount(f), exactCount);
  }
});

void test("System revokes selected and current sessions without revoking other browsers", async (context) => {
  const f = await fixture(context);
  const current = await login(f);
  const selected = await login(f);
  const other = await login(f);
  assertRejected(await post(f, `/admin/system/sessions/${selected.id}/revoke`, {}, current));
  assert.ok(f.auth.validateSession(selected.token));
  const selectedResult = await post(
    f,
    `/admin/system/sessions/${selected.id}/revoke`,
    { confirm: "revoke" },
    current,
  );
  assert.equal(location(selectedResult).pathname, "/admin/system");
  await assertSignedOut(f, selected);
  assert.equal((await get(f, "/admin/system", current)).status, 200);
  assert.equal((await get(f, "/admin/system", other)).status, 200);
  const audit = listActivities(f.database).find(
    (row) => row.entityId === selected.id && row.action === "session_revoked",
  );
  assert.equal(audit?.sessionId, current.id);
  assert.equal(audit?.entityType, "admin_session");
  const selfResult = await post(
    f,
    `/admin/system/sessions/${current.id}/revoke`,
    { confirm: "revoke" },
    current,
  );
  assert.equal(location(selfResult).pathname, "/admin/login");
  await assertSignedOut(f, current);
  assert.equal((await get(f, "/admin/system", other)).status, 200);
});

void test("changing the PIN through System revokes every previous session and never renders/logs PINs", async (context) => {
  const f = await fixture(context);
  const browsers = [await login(f), await login(f), await login(f)];
  const current = browsers[0]!;
  const baselineRevision = f.auth.getCredentialStatus().revision;
  const mismatch = await post(
    f,
    "/admin/system/pin",
    { currentPin: "1234", newPin: "2345", confirmPin: "2346" },
    current,
  );
  assertRejected(mismatch, /match/u);
  assert.equal(f.auth.getCredentialStatus().revision, baselineRevision);
  const changed = await post(
    f,
    "/admin/system/pin",
    { currentPin: "1234", newPin: "2345", confirmPin: "2345" },
    current,
  );
  assert.equal(location(changed).pathname, "/admin/login");
  assert.equal(f.auth.getCredentialStatus().revision, (baselineRevision ?? 0) + 1);
  for (const browser of browsers) await assertSignedOut(f, browser);
  const newBrowser = await login(f, "2345");
  const html = await (await get(f, "/admin/system", newBrowser)).text();
  assert.doesNotMatch(html, /value="(?:1234|2345)"/u);
  assert.doesNotMatch(f.logs.join("\n"), /1234|2345/u);
});

void test("System in Simulation uses normal authentication policy and revokes normal-authority sessions", async (context) => {
  const f = await fixture(context);
  let current = await login(f);
  const prior = await login(f);
  const enabled = await post(f, "/admin/simulation/enable", {}, current);
  assert.equal(location(enabled).pathname, "/admin/simulator");
  current = browserFromResponse(f, enabled);
  await assertSignedOut(f, prior);
  const simulationPage = await (await get(f, "/admin/system", current)).text();
  assert.ok(simulationPage.includes("SIMULATION"));
  const saved = await post(
    f,
    "/admin/system/session-policy",
    {
      inactivityMinutes: "120",
      absoluteMinutes: "180",
      expectedRevision: inputValue(simulationPage, "expectedRevision"),
    },
    current,
  );
  assert.ok(location(saved).searchParams.has("notice"));
  assert.equal(f.auth.getSessionPolicy().inactivityMs, 120 * 60_000);
  assert.equal(f.auth.getSessionPolicy().absoluteMs, 180 * 60_000);
  const simulationDatabase = openDatabase(`${f.databasePath}.simulation.sqlite3`);
  try {
    assert.deepEqual(
      simulationDatabase
        .prepare<[], Record<string, unknown>>(
          "SELECT inactivity_ms, absolute_ms, revision FROM auth_session_settings WHERE id = 1",
        )
        .get(),
      {
        inactivity_ms: null,
        absolute_ms: null,
        revision: 0,
      },
    );
    assert.equal(
      simulationDatabase
        .prepare<[], { count: number }>("SELECT count(*) AS count FROM admin_sessions")
        .get()?.count,
      0,
    );
  } finally {
    simulationDatabase.close();
  }
  const selected = await login(f);
  assert.ok(f.auth.validateSession(selected.token));
  assert.equal(
    location(
      await post(f, `/admin/system/sessions/${selected.id}/revoke`, { confirm: "revoke" }, current),
    ).pathname,
    "/admin/system",
  );
  await assertSignedOut(f, selected);
  const disabled = await post(f, "/admin/simulation/disable", {}, current);
  assert.equal(location(disabled).pathname, "/admin/system");
  current = browserFromResponse(f, disabled);
  const normalPage = await (await get(f, "/admin/system", current)).text();
  assert.ok(!normalPage.includes('aria-label="Simulation mode"'));
  assert.equal(inputValue(normalPage, "inactivityMinutes"), "120");
  assert.equal(inputValue(normalPage, "absoluteMinutes"), "180");
  assert.equal(inputValue(normalPage, "expectedRevision"), "1");
});
