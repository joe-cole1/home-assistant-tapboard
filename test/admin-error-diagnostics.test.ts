import assert from "node:assert/strict";
import test from "node:test";

import { registerWebRoutes, type WebRouteDependencies } from "../src/features/web/routes.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { createLogger } from "../src/shared/logging.ts";

const origin = "http://localhost:3000";
const cookie = "tapboard_admin_session=" + "s".repeat(43);
const sentinel = "PRIVATE_EXCEPTION_TOKEN";

void test("Admin errors authenticate before parsing, preserve statuses and correlate sanitized logs", async (t) => {
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line) });
  let error: unknown = new ApplicationError({
    category: "unavailable",
    code: "secrets.not_configured",
    clientMessage: "Configure TAPBOARD_SECRET_KEY on the server.",
  });
  let calls = 0;
  let disclosureFails = false;
  let pageFails = false;
  let results: unknown[] = [];
  let connectionState = "unknown";
  const renderer = createRenderer();
  const settings = {
    revision: 1,
    tapboardName: "Tapboard",
    theme: "dark",
    font: "system",
    accent: "amber",
  };
  const dependencies = {
    router: new Router(logger),
    logger,
    canonicalOrigin: origin,
    renderer: {
      render: (view: string, data: Readonly<Record<string, unknown>>) => {
        if (view === "/admin/machine-key" && disclosureFails) throw new Error(sentinel);
        return renderer.render(view, data);
      },
    },
    authService: {
      authenticateSession: (token: string) =>
        token === "s".repeat(43) ? { id: "admin" } : undefined,
      authorizeCookieMutation: (input: {
        cookieHeader?: string;
        originHeader?: string;
        csrfHeader?: string;
      }) =>
        input.cookieHeader === cookie &&
        input.originHeader === origin &&
        input.csrfHeader === "csrf"
          ? { id: "admin" }
          : undefined,
    },
    displayService: {
      getSettings: () => settings,
      updateSettings: () => {
        calls++;
        throw error;
      },
    },
    beverageService: {
      configureBrewfatherAccount: () => {
        calls++;
        throw error;
      },
      syncBrewfather: () => Promise.resolve(results),
      getBrewfatherStatus: () => {
        if (pageFails) throw error;
        return {
          configured: true,
          account: { enabled: true },
          apiKeyConfigured: true,
          connectionState,
          totalCandidates: 0,
          totalLinkedBeverages: 0,
          lastDataUpdateAt: null,
          credentialStorage: { configured: false, available: false, count: 0 },
        };
      },
    },
    telemetryService: {
      createSource: () => {
        calls++;
        return { source: { name: "Sensor" }, initialToken: sentinel };
      },
      rotateSourceKey: () => {
        calls++;
        return { source: { name: "Sensor" }, replacementToken: sentinel };
      },
    },
  } as unknown as WebRouteDependencies;
  registerWebRoutes(dependencies);
  const server = new HttpServer({ router: dependencies.router, logger, shutdownGraceMs: 250 });
  t.after(() => server.stop());
  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body = "_csrf=csrf", authenticated = true) =>
    fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        ...(authenticated ? { cookie } : {}),
      },
      body,
    });
  const location = (response: Response) =>
    decodeURIComponent(response.headers.get("location") ?? "");

  let response = await post("/admin/integrations/brewfather");
  assert.match(location(response), /Configure TAPBOARD_SECRET_KEY/);
  assert.match(location(response), /Reference:/);
  assert.equal(logs.length, 1);
  response = await post("/admin/integrations/brewfather", "%ZZ", false);
  assert.match(location(response), /could not be authorized/);
  assert.doesNotMatch(location(response), /TAPBOARD_SECRET_KEY/);
  assert.equal(calls, 1);
  response = await post("/admin/integrations/brewfather", "_csrf=wrong");
  assert.equal(calls, 1);
  assert.match(location(response), /could not be authorized/);

  for (const [category, status] of [
    ["unavailable", 503],
    ["internal", 500],
    ["not_found", 404],
    ["too_large", 413],
    ["validation", 422],
    ["conflict", 409],
  ] as const) {
    error = new ApplicationError({
      category,
      code: `fixture.${category}`,
      clientMessage: "Safe fixture failure.",
    });
    response = await fetch(base + "/admin/display/shared", {
      method: "POST",
      headers: {
        cookie,
        origin,
        "x-csrf-token": "csrf",
        "content-type": "application/json",
        accept: "application/json",
        "x-tapboard-enhancement": "autosave",
      },
      body: JSON.stringify({ expectedRevision: "1" }),
    });
    assert.equal(response.status, status, category);
    const body = (await response.json()) as {
      message: string;
      fields?: unknown;
      current?: unknown;
      revision?: unknown;
    };
    assert.match(body.message, /Safe fixture failure/);
    if (category === "validation") assert.ok(body.fields);
    if (category === "conflict") assert.ok("current" in body && "revision" in body);
  }

  error = new Error(sentinel);
  const prior = logs.length;
  response = await post("/admin/integrations/brewfather");
  assert.match(location(response), /The change could not be completed.*Reference:/);
  assert.doesNotMatch(location(response), new RegExp(sentinel));
  assert.equal(logs.length, prior + 1);
  assert.doesNotMatch(logs.join("\n"), new RegExp(sentinel));
  pageFails = true;
  response = await fetch(base + "/admin/integrations/brewfather", { headers: { cookie } });
  assert.equal(response.status, 500);
  assert.match(await response.text(), /Admin page could not be loaded.*Reference:/);
  error = new ApplicationError({
    category: "unavailable",
    code: "fixture.page_unavailable",
    clientMessage: "The integration is unavailable.",
  });
  response = await fetch(base + "/admin/integrations/brewfather", { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /The integration is unavailable/);
  response = await fetch(base + "/admin/integrations/brewfather", { redirect: "manual" });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin/login");
  pageFails = false;

  disclosureFails = true;
  for (const path of [
    "/admin/integrations/telemetry-sources/create",
    "/admin/integrations/telemetry-sources/source/rotate",
  ]) {
    const logsBeforeDisclosure: number = logs.length;
    response = await post(path);
    assert.match(location(response), /token could not be shown/);
    assert.match(location(response), /rotation invalidates the previous key/);
    assert.doesNotMatch(location(response), new RegExp(sentinel));
    assert.equal(logs.length, logsBeforeDisclosure + 1);
    const event = JSON.parse(logs[logsBeforeDisclosure]!) as { context: { reference: string } };
    assert.match(
      event.context.reference,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    assert.ok(location(response).endsWith(`Reference: ${event.context.reference}.`));
  }

  response = await post("/admin/integrations/brewfather/sync");
  assert.match(location(response), /was not verified/);
  assert.doesNotMatch(location(response), /refresh completed/);
  results = [
    {
      error: sentinel,
      linkedErrors: 1,
      failures: [
        {
          category: "unavailable",
          code: "brewfather.rate_limited",
          message: "Try again later.",
          providerStatus: 429,
          retryAfterMs: 1000,
        },
      ],
    },
  ];
  response = await post("/admin/integrations/brewfather/sync");
  assert.match(location(response), /refresh incomplete/);
  assert.doesNotMatch(location(response), new RegExp(sentinel));
  results = [{ connectionVerified: true, linkedErrors: 0 }];
  response = await post("/admin/integrations/brewfather/sync");
  assert.match(location(response), /refresh completed/);

  for (const [state, label] of [
    ["unknown", "Awaiting verification"],
    ["healthy", "Connected"],
    ["partial", "Refresh incomplete"],
    ["disconnected", "Disconnected"],
  ]) {
    connectionState = state!;
    response = await fetch(base + "/admin/integrations/brewfather", { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`>${label}</span>`));
    assert.match(html, /Configure a valid TAPBOARD_SECRET_KEY on the server/);
  }
});
