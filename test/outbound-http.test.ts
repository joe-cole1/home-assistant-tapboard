import assert from "node:assert/strict";
import test from "node:test";

import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";
import { createLogger } from "../src/shared/logging.ts";
import { registerWebRoutes, type WebRouteDependencies } from "../src/features/web/routes.ts";

const ORIGIN = "http://127.0.0.1:3000";
const SESSION_TOKEN = "s".repeat(43);
const CSRF_TOKEN = "c".repeat(43);
const SESSION_ID = "outbound-http-session";
const DESTINATION_ID = "00000000-0000-4000-8000-000000000079";
const VERSION_ID = "00000000-0000-4000-8000-000000000080";
const DELIVERY_ID = "00000000-0000-4000-8000-000000000081";
const EVENT_ID = "00000000-0000-4000-8000-000000000082";
const ENDPOINT_SENTINEL = "https://endpoint-secret.invalid/private-hook";
const TOKEN_SENTINEL = "ha-token-sentinel-do-not-render";
const HEADER_SENTINEL = "header-secret-sentinel-do-not-render";

const EVENT_FIELDS = [
  "fill.assigned",
  "fill.ended",
  "pour.completed",
  "keg.low",
  "health.transitioned",
  "integration.status_changed",
] as const;

type LooseRecord = Record<string, unknown>;

function destination(): LooseRecord {
  return {
    id: DESTINATION_ID,
    label: "Kitchen Home Assistant",
    transport: "home_assistant",
    enabled: false,
    required: false,
    retiredAt: null,
    disabledAt: "2026-08-17T12:00:00.000Z",
    disabledReason: "operator_disabled",
    createdAt: "2026-08-17T11:00:00.000Z",
    updatedAt: "2026-08-17T12:00:00.000Z",
    state: "disabled",
    failure: null,
    subscriptions: [...EVENT_FIELDS],
    currentVersion: {
      id: VERSION_ID,
      destinationId: DESTINATION_ID,
      versionNumber: 1,
      createdAt: "2026-08-17T11:00:00.000Z",
      config: {
        transport: "home_assistant",
        baseUrl: ENDPOINT_SENTINEL,
        urlSummary: { scheme: "https", host: "endpoint-secret.invalid", port: null },
        authConfigured: true,
        authAvailable: true,
        staticHeaders: [{ name: "X-Source", value: "safe-static-value" }],
        secretHeaders: [
          { name: "Authorization", slot: "ha-token", configured: true, available: true },
          { name: "X-Secret", slot: "x-secret", configured: true, available: true },
        ],
      },
    },
  };
}

function buildDependencies(): {
  readonly dependencies: WebRouteDependencies;
  readonly logger: ReturnType<typeof createLogger>;
  readonly logs: unknown[];
  readonly calls: {
    readonly creates: LooseRecord[];
    readonly edits: LooseRecord[];
    readonly tokens: string[];
    readonly headerSecrets: string[];
    readonly enabled: boolean[];
    readonly required: boolean[];
    readonly removedTokens: number;
    readonly removedHeaders: string[];
    readonly retired: number;
  };
} {
  const logs: unknown[] = [];
  const logger = createLogger({ sink: (entry) => logs.push(entry) });
  let current = destination();
  const calls = {
    creates: [] as LooseRecord[],
    edits: [] as LooseRecord[],
    tokens: [] as string[],
    headerSecrets: [] as string[],
    enabled: [] as boolean[],
    required: [] as boolean[],
    removedTokens: 0,
    removedHeaders: [] as string[],
    retired: 0,
  };
  const database = {
    prepare: () => ({ run: () => ({ changes: 1 }) }),
  };
  const outboundService = {
    get: (id: string) => (id === DESTINATION_ID ? current : undefined),
    listPage: () => [current],
    listDeliveries: () => [
      {
        id: DELIVERY_ID,
        eventId: EVENT_ID,
        eventType: "pour.completed",
        destinationId: DESTINATION_ID,
        destinationVersionId: VERSION_ID,
        state: "terminal",
        attemptCount: 2,
        lastAttemptAt: "2026-08-17T12:03:00.000Z",
        nextAttemptAt: "2026-08-17T12:05:00.000Z",
        revision: 3,
        lastErrorCode: "webhook_http_503",
        envelopeBytes: 300,
        createdAt: "2026-08-17T12:00:00.000Z",
        updatedAt: "2026-08-17T12:04:00.000Z",
        terminalAt: "2026-08-17T12:04:00.000Z",
      },
    ],
    database,
    create: (input: unknown) => {
      const record = input as LooseRecord;
      calls.creates.push(record);
      if (typeof input === "object" && input !== null && "secret" in input) {
        const secret = record.secret;
        if (typeof secret === "string") calls.tokens.push(secret);
      }
      current = { ...current, enabled: record.enabled === true };
      return current;
    },
    edit: (_id: string, input: unknown) => {
      const record = input as LooseRecord;
      calls.edits.push(record);
      current = {
        ...current,
        label: record.label ?? current.label,
        required: record.required ?? current.required,
        subscriptions: record.subscriptions ?? current.subscriptions,
      };
      return current;
    },
    setToken: (_id: string, value: string) => {
      calls.tokens.push(value);
      return current;
    },
    removeToken: () => {
      calls.removedTokens += 1;
      return current;
    },
    setHeaderSecret: (_id: string, _slot: string, value: string) => {
      calls.headerSecrets.push(value);
      return current;
    },
    removeHeaderSecret: (_id: string, slot: string) => {
      calls.removedHeaders.push(slot);
      return current;
    },
    setEnabled: (_id: string, enabled: boolean) => {
      calls.enabled.push(enabled);
      current = { ...current, enabled };
      return current;
    },
    enable: (_id: string) => {
      calls.enabled.push(true);
      current = { ...current, enabled: true };
      return current;
    },
    disable: (_id: string) => {
      calls.enabled.push(false);
      current = { ...current, enabled: false };
      return current;
    },
    setRequired: (_id: string, required: boolean) => {
      calls.required.push(required);
      current = { ...current, required };
      return current;
    },
    retire: () => {
      calls.retired += 1;
      current = { ...current, retiredAt: "2026-08-17T13:00:00.000Z", enabled: false };
      return current;
    },
  };
  const session = {
    id: SESSION_ID,
    credentialRevision: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    lastUsedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2027-08-17T00:00:00.000Z",
    absoluteExpiresAt: "2027-08-17T00:00:00.000Z",
  };
  const authService = {
    authenticateSession: (token: string) => (token === SESSION_TOKEN ? session : undefined),
    authorizeCookieMutation: (input: LooseRecord) => {
      const cookieHeader = input.cookieHeader;
      const cookie =
        typeof cookieHeader === "string"
          ? cookieHeader
          : Array.isArray(cookieHeader)
            ? cookieHeader.filter((value): value is string => typeof value === "string").join(";")
            : "";
      const originHeader = input.originHeader;
      const origin =
        typeof originHeader === "string"
          ? originHeader
          : Array.isArray(originHeader) && typeof originHeader[0] === "string"
            ? originHeader[0]
            : undefined;
      const csrf = typeof input.csrfHeader === "string" ? input.csrfHeader : undefined;
      return cookie.includes(`tapboard_admin_session=${SESSION_TOKEN}`) &&
        origin === ORIGIN &&
        csrf === CSRF_TOKEN
        ? session
        : undefined;
    },
  };
  const display = {
    revision: 1,
    tapboardName: "Outbound HTTP test",
    theme: "modern_dark",
    font: "system",
    accent: "amber",
    unitSystem: "metric",
    showServingTemperature: true,
    layoutMode: "scroll",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
  const dependencies = {
    router: new Router(logger),
    renderer: createRenderer(),
    canonicalOrigin: ORIGIN,
    authService,
    outboundService,
    displayService: { getSettings: () => display },
    beverageService: {
      getBrewfatherStatus: () => ({
        configured: false,
        apiKeyConfigured: false,
        account: null,
        totalLinkedBeverages: 0,
        totalCandidates: 0,
      }),
    },
    telemetryService: { listSources: () => [] },
    dashboardService: {
      getDashboard: () => ({}),
      getHeader: () => ({}),
      getDisplayDefaults: () => ({}),
    },
    storyService: { getStory: () => undefined },
    kegService: {},
    fillService: {},
    tapService: {},
    detectorService: {},
    healthService: {},
    liveUpdates: {},
    tapWarsService: {},
    publicTapWarsService: {},
  } as unknown as WebRouteDependencies;
  registerWebRoutes(dependencies);
  return { dependencies, calls, logger, logs };
}

async function request(
  base: string,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: URLSearchParams;
    readonly auth?: boolean;
    readonly origin?: string;
  } = {},
): Promise<Response> {
  const headers = {
    ...(options.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    ...(options.auth === false
      ? {}
      : { cookie: `tapboard_admin_session=${SESSION_TOKEN}; tapboard_admin_csrf=${CSRF_TOKEN}` }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  };
  return fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    redirect: "manual",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function form(values: Record<string, string> = {}): URLSearchParams {
  const result = new URLSearchParams({ _csrf: CSRF_TOKEN, ...values });
  return result;
}

void test("outbound Admin HTTP surface protects mutations and redacts endpoints/secrets", async (context) => {
  const { dependencies, calls, logger, logs } = buildDependencies();
  const server = new HttpServer({
    router: dependencies.router,
    logger,
    shutdownGraceMs: 250,
  });
  context.after(() => server.stop());
  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;

  const unauthenticated = await request(base, "/admin/integrations/outbound", { auth: false });
  assert.equal(unauthenticated.status, 303);
  assert.equal(unauthenticated.headers.get("location"), "/admin/login");

  const list = await request(base, "/admin/integrations/outbound");
  assert.equal(list.status, 200);
  const listHtml = await list.text();
  assert.match(listHtml, /Kitchen Home Assistant/u);
  assert.doesNotMatch(listHtml, new RegExp(ENDPOINT_SENTINEL, "u"));
  assert.doesNotMatch(listHtml, new RegExp(TOKEN_SENTINEL, "u"));
  assert.doesNotMatch(listHtml, new RegExp(HEADER_SENTINEL, "u"));

  const createBody = form({
    transport: "home_assistant",
    label: "Created destination",
    baseUrl: ENDPOINT_SENTINEL,
    token: TOKEN_SENTINEL,
    static_header_0_name: "X-Source",
    static_header_0_value: "tapboard",
    secret_header_0_name: "X-Secret",
    secret_header_0_slot: "x-secret",
    secret_header_0_value: HEADER_SENTINEL,
  });
  for (const field of [
    "subscription_fill_assigned",
    "subscription_fill_ended",
    "subscription_pour_completed",
    "subscription_keg_low",
    "subscription_health_transitioned",
    "subscription_integration_status_changed",
  ])
    createBody.set(field, "on");
  const create = await request(base, "/admin/integrations/outbound/create", {
    method: "POST",
    body: createBody,
    origin: ORIGIN,
  });
  assert.equal(create.status, 303);
  assert.doesNotMatch(create.headers.get("location") ?? "", /sentinel/u);
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0]?.["required"], false);
  assert.equal(calls.creates[0]?.["enabled"], false);
  assert.deepEqual(calls.creates[0]?.["subscriptions"], [...EVENT_FIELDS]);
  assert.deepEqual(calls.tokens, [TOKEN_SENTINEL]);
  assert.deepEqual(calls.headerSecrets, [HEADER_SENTINEL]);

  const detail = await request(base, `/admin/integrations/outbound/${DESTINATION_ID}`);
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Delivery history/u);
  assert.match(detailHtml, /Pour completed/u);
  assert.match(detailHtml, /00000000…082/u);
  assert.doesNotMatch(detailHtml, new RegExp(ENDPOINT_SENTINEL, "u"));
  assert.doesNotMatch(detailHtml, new RegExp(TOKEN_SENTINEL, "u"));
  assert.doesNotMatch(detailHtml, new RegExp(HEADER_SENTINEL, "u"));

  const edit = await request(base, `/admin/integrations/outbound/${DESTINATION_ID}/edit`, {
    method: "POST",
    body: form({
      transport: "home_assistant",
      label: "Edited destination",
      required: "on",
      enabled: "on",
      subscription_fill_assigned: "on",
      subscription_pour_completed: "on",
      static_header_0_name: "X-Source",
      static_header_0_value: "",
      secret_header_0_name: "X-Secret",
      secret_header_0_slot: "x-secret",
      secret_header_0_value: HEADER_SENTINEL,
      token: TOKEN_SENTINEL,
    }),
    origin: ORIGIN,
  });
  assert.equal(edit.status, 303);
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0]?.["required"], true);
  assert.deepEqual(calls.edits[0]?.["subscriptions"], ["fill.assigned", "pour.completed"]);
  assert.deepEqual(calls.tokens.at(-1), TOKEN_SENTINEL);
  assert.deepEqual(calls.enabled.at(-1), true);

  const forbidden = await request(base, `/admin/integrations/outbound/${DESTINATION_ID}/disable`, {
    method: "POST",
    body: form(),
  });
  assert.equal(forbidden.status, 303);
  assert.match(forbidden.headers.get("location") ?? "", /error=/u);
  assert.equal(calls.enabled.at(-1), true);

  for (const [path, expected] of [
    [`/admin/integrations/outbound/${DESTINATION_ID}/disable`, false],
    [`/admin/integrations/outbound/${DESTINATION_ID}/enable`, true],
  ] as const) {
    const response = await request(base, path, { method: "POST", body: form(), origin: ORIGIN });
    assert.equal(response.status, 303);
    assert.equal(calls.enabled.at(-1), expected);
  }
  for (const [path, body] of [
    [`/admin/integrations/outbound/${DESTINATION_ID}/required`, form({ required: "false" })],
    [`/admin/integrations/outbound/${DESTINATION_ID}/token`, form({ token: TOKEN_SENTINEL })],
    [
      `/admin/integrations/outbound/${DESTINATION_ID}/header-secret`,
      form({ slot: "x-secret", secret: HEADER_SENTINEL }),
    ],
  ] as const) {
    const response = await request(base, path, { method: "POST", body, origin: ORIGIN });
    assert.equal(response.status, 303);
  }
  assert.deepEqual(calls.required.at(-1), false);

  for (const path of [
    `/admin/integrations/outbound/${DESTINATION_ID}/token/remove`,
    `/admin/integrations/outbound/${DESTINATION_ID}/header-secret/remove`,
    `/admin/integrations/outbound/${DESTINATION_ID}/retire`,
    `/admin/integrations/outbound/${DESTINATION_ID}/deliveries/${DELIVERY_ID}/retry`,
    `/admin/integrations/outbound/${DESTINATION_ID}/deliveries/${DELIVERY_ID}/dismiss`,
  ]) {
    const body = path.endsWith("header-secret/remove") ? form({ slot: "x-secret" }) : form();
    const response = await request(base, path, { method: "POST", body, origin: ORIGIN });
    assert.equal(response.status, 303, path);
  }
  assert.equal(calls.removedTokens, 1);
  assert.deepEqual(calls.removedHeaders, ["x-secret"]);
  assert.equal(calls.retired, 1);

  const webhookCreate = await request(base, "/admin/integrations/outbound/create", {
    method: "POST",
    body: form({
      transport: "webhook",
      label: "Disabled Discord webhook",
      webhookUrl: ENDPOINT_SENTINEL,
      payloadFormat: "discord",
    }),
    origin: ORIGIN,
  });
  assert.equal(webhookCreate.status, 303);
  const webhookInput = calls.creates.at(-1);
  assert.equal(webhookInput?.["transport"], "webhook");
  assert.equal(webhookInput?.["payloadFormat"], "discord");
  assert.equal(webhookInput?.["enabled"], false);

  const malformed = await request(base, "/admin/integrations/outbound/create", {
    method: "POST",
    body: form({
      transport: "invalid",
      label: "Malformed secret form",
      baseUrl: ENDPOINT_SENTINEL,
      token: TOKEN_SENTINEL,
      secret_header_0_name: "X-Secret",
      secret_header_0_value: HEADER_SENTINEL,
    }),
    origin: ORIGIN,
  });
  assert.equal(malformed.status, 303);
  const malformedLocation = malformed.headers.get("location") ?? "";
  assert.doesNotMatch(malformedLocation, /sentinel|private-hook/iu);
  const malformedPage = await request(base, malformedLocation);
  const malformedHtml = await malformedPage.text();
  for (const sentinel of [ENDPOINT_SENTINEL, TOKEN_SENTINEL, HEADER_SENTINEL]) {
    assert.equal(malformedHtml.includes(sentinel), false);
    assert.equal(JSON.stringify(logs).includes(sentinel), false);
  }

  const createCount = calls.creates.length;
  for (const malformedSecretBody of [
    form({
      transport: "home_assistant",
      label: "Malformed HA secret",
      baseUrl: "http://home-assistant.test",
      token: `${TOKEN_SENTINEL}\n`,
    }),
    form({
      transport: "webhook",
      label: "Malformed header secret",
      webhookUrl: "https://example.test/hook",
      secret_header_0_name: "Authorization",
      secret_header_0_value: `${HEADER_SENTINEL}\n`,
    }),
  ]) {
    const response = await request(base, "/admin/integrations/outbound/create", {
      method: "POST",
      body: malformedSecretBody,
      origin: ORIGIN,
    });
    assert.equal(response.status, 303);
    const location = response.headers.get("location") ?? "";
    assert.doesNotMatch(location, /sentinel/iu);
    const page = await request(base, location);
    const html = await page.text();
    assert.equal(html.includes(TOKEN_SENTINEL), false);
    assert.equal(html.includes(HEADER_SENTINEL), false);
    assert.equal(JSON.stringify(logs).includes(TOKEN_SENTINEL), false);
    assert.equal(JSON.stringify(logs).includes(HEADER_SENTINEL), false);
  }
  assert.equal(calls.creates.length, createCount);
});
