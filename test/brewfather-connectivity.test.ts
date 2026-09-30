import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import {
  BrewfatherSyncCoordinator,
  type SyncResult,
} from "../src/features/beverages/brewfather/sync.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";

const ROOT_KEY = Buffer.alloc(32, 7).toString("base64url");
const CONFIGURATION = {
  userId: "test-user",
  apiKey: "test-api-key",
  discoveryStatuses: ["Fermenting"],
};
const SUCCESS: SyncResult = {
  accountId: "default",
  linkedSynced: 0,
  linkedErrors: 0,
  candidatesFound: 0,
  durationMs: 0,
  connectionVerified: true,
};

function createContext(context: TestContext) {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  let nowMs = Date.parse("2026-09-30T12:00:00.000Z");
  const now = () => new Date(nowMs);
  const secretsService = createSecretsService(database, { rootKey: ROOT_KEY });
  const syncCoordinator = new BrewfatherSyncCoordinator({
    fetchFn: () => Promise.resolve(new Response("[]", { status: 200 })),
  });
  const beverageService = createBeverageService(database, {
    secretsService,
    syncCoordinator,
    now,
  });
  return {
    database,
    secretsService,
    syncCoordinator,
    beverageService,
    now,
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
}

void test("Brewfather needs a completed sync and accepts an empty successful account", async (context) => {
  const { database, beverageService, secretsService, syncCoordinator, now } =
    createContext(context);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disabled");
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");

  let requests = 0;
  const results = await beverageService.syncBrewfather({
    fetchFn: () => {
      requests += 1;
      return Promise.resolve(new Response("[]", { status: 200 }));
    },
  });
  assert.equal(requests, 1);
  assert.equal(results[0]?.error, undefined);
  assert.equal(results[0]?.connectionVerified, true);
  const status = beverageService.getBrewfatherStatus();
  assert.equal(status.connectionState, "healthy");
  assert.equal(status.totalCandidates, 0);
  assert.equal(status.totalLinkedBeverages, 0);
  assert.equal(status.lastDataUpdateAt, null);

  const restartedService = createBeverageService(database, {
    secretsService,
    syncCoordinator,
    now,
  });
  assert.equal(restartedService.getBrewfatherStatus().connectionState, "unknown");
});

void test("Brewfather cannot establish connectivity when no discovery or linked requests run", async (context) => {
  const { beverageService } = createContext(context);
  beverageService.configureBrewfatherAccount({ ...CONFIGURATION, discoveryStatuses: [] });
  let requests = 0;
  const fetchFn: typeof fetch = () => {
    requests += 1;
    return Promise.resolve(new Response("[]", { status: 200 }));
  };
  const results = await beverageService.syncBrewfather({ fetchFn });
  assert.equal(requests, 0);
  assert.equal(results[0]?.error, undefined);
  assert.equal(results[0]?.connectionVerified, false);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");

  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather({ fetchFn });
  assert.equal(requests, 1);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");

  beverageService.configureBrewfatherAccount({ ...CONFIGURATION, discoveryStatuses: [] });
  await beverageService.syncBrewfather({ fetchFn });
  assert.equal(requests, 1);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");
});

void test("Brewfather verifies linked requests without discovery and becomes unknown once no requests remain", async (context) => {
  const { beverageService } = createContext(context);
  const batch = { _id: "only-linked-batch", name: "Linked", status: "Fermenting" };
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather({
    fetchFn: () => Promise.resolve(new Response(JSON.stringify([batch]), { status: 200 })),
  });
  const linked = beverageService.linkBrewfatherCandidate({ sourceBatchId: batch._id });
  beverageService.configureBrewfatherAccount({ ...CONFIGURATION, discoveryStatuses: [] });
  let requests = 0;
  const fetchFn: typeof fetch = () => {
    requests += 1;
    return Promise.resolve(new Response(JSON.stringify(batch), { status: 200 }));
  };
  const linkedResults = await beverageService.syncBrewfather({ fetchFn });
  assert.equal(requests, 1);
  assert.equal(linkedResults[0]?.connectionVerified, true);
  assert.equal(linkedResults[0]?.linkedSynced, 1);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");

  beverageService.unlinkBeverage(linked.beverage.id);
  const emptyResults = await beverageService.syncBrewfather({ fetchFn });
  assert.equal(requests, 1);
  assert.equal(emptyResults[0]?.connectionVerified, false);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");
});

void test("Brewfather status lists include every configured account and keep default lookup compatible", async (context) => {
  const { beverageService } = createContext(context);
  assert.deepEqual(beverageService.listBrewfatherStatuses(), []);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  beverageService.configureBrewfatherAccount({ ...CONFIGURATION, accountId: "secondary" });
  beverageService.configureBrewfatherAccount({ ...CONFIGURATION, accountId: "waiting" });
  beverageService.configureBrewfatherAccount({
    accountId: "disabled",
    userId: CONFIGURATION.userId,
    enabled: false,
  });
  await beverageService.syncBrewfather({ accountId: "default" });
  await beverageService.syncBrewfather({
    accountId: "secondary",
    fetchFn: () => Promise.resolve(new Response("private authentication failure", { status: 401 })),
  });

  const statuses = beverageService.listBrewfatherStatuses();
  assert.deepEqual(
    statuses.map((status) => ({
      accountId: status.account?.id,
      connectionState: status.connectionState,
    })),
    [
      { accountId: "default", connectionState: "healthy" },
      { accountId: "disabled", connectionState: "disabled" },
      { accountId: "secondary", connectionState: "disconnected" },
      { accountId: "waiting", connectionState: "unknown" },
    ],
  );
  assert.equal(
    statuses.every((status) => status.configured),
    true,
  );
  assert.deepEqual(beverageService.getBrewfatherStatus(), statuses[0]);
  assert.equal(JSON.stringify(statuses).includes(CONFIGURATION.apiKey), false);
  assert.equal(JSON.stringify(statuses).includes("private authentication failure"), false);
});

void test("Brewfather account failures turn red after five continuous minutes and recover", async (context) => {
  const { beverageService, syncCoordinator, advance } = createContext(context);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  let result = SUCCESS;
  context.mock.method(syncCoordinator, "sync", () => Promise.resolve([result]));
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");

  result = { ...SUCCESS, error: "private upstream failure detail" };
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "partial");
  advance(299_999);
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "partial");
  advance(1);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
  assert.equal(
    JSON.stringify(beverageService.getBrewfatherStatus()).includes(result.error!),
    false,
  );
  assert.equal(
    JSON.stringify(beverageService.getBrewfatherStatus()).includes(CONFIGURATION.apiKey),
    false,
  );

  result = SUCCESS;
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
  result = { ...SUCCESS, error: "another failure" };
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "partial");
});

void test("Brewfather per-link failures remain partial and clear account failure timing", async (context) => {
  const { beverageService, syncCoordinator, advance } = createContext(context);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  let result: SyncResult = { ...SUCCESS, error: "account failure" };
  context.mock.method(syncCoordinator, "sync", () => Promise.resolve([result]));
  await beverageService.syncBrewfather();
  advance(300_000);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");

  result = { ...SUCCESS, linkedErrors: 1 };
  await beverageService.syncBrewfather();
  advance(3_600_000);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "partial");

  result = SUCCESS;
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
});

for (const status of [401, 403]) {
  void test(`Brewfather discovery HTTP ${status} is immediately disconnected until recovery`, async (context) => {
    const { beverageService, syncCoordinator } = createContext(context);
    beverageService.configureBrewfatherAccount(CONFIGURATION);
    await beverageService.syncBrewfather();
    const results = await beverageService.syncBrewfather({
      fetchFn: () => Promise.resolve(new Response("private response body", { status })),
    });
    assert.equal(results[0]?.authenticationFailed, true);
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");

    const sync = context.mock.method(syncCoordinator, "sync", () =>
      Promise.resolve([{ ...SUCCESS, error: "generic transient failure" }]),
    );
    await beverageService.syncBrewfather();
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
    sync.mock.restore();
    await beverageService.syncBrewfather();
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
  });
}

void test("a Brewfather linked-batch authorization failure is major even when discovery succeeds", async (context) => {
  const { beverageService } = createContext(context);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather({
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify([{ _id: "linked-batch", name: "Linked", status: "Fermenting" }]),
          { status: 200 },
        ),
      ),
  });
  beverageService.linkBrewfatherCandidate({ sourceBatchId: "linked-batch" });
  const results = await beverageService.syncBrewfather({
    fetchFn: (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      return Promise.resolve(
        url.pathname.endsWith("/linked-batch")
          ? new Response("Forbidden", { status: 403 })
          : new Response("[]", { status: 200 }),
      );
    },
  });
  assert.equal(results[0]?.error, undefined);
  assert.equal(results[0]?.linkedErrors, 1);
  assert.equal(results[0]?.authenticationFailed, true);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
});

void test("an unverified linked-only failure cannot clear a prior Brewfather authentication failure", async (context) => {
  const { beverageService } = createContext(context);
  const batch = { _id: "linked-only", name: "Linked", status: "Fermenting" };
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather({
    fetchFn: () => Promise.resolve(new Response(JSON.stringify([batch]), { status: 200 })),
  });
  beverageService.linkBrewfatherCandidate({ sourceBatchId: batch._id });
  beverageService.configureBrewfatherAccount({ ...CONFIGURATION, discoveryStatuses: [] });
  await beverageService.syncBrewfather({
    fetchFn: () => Promise.resolve(new Response("Unauthorized", { status: 401 })),
  });
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");

  const results = await beverageService.syncBrewfather({
    fetchFn: () => Promise.resolve(new Response("Bad request", { status: 400 })),
  });
  assert.equal(results[0]?.connectionVerified, false);
  assert.equal(results[0]?.linkedErrors, 1);
  assert.equal(results[0]?.error, undefined);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");

  await beverageService.syncBrewfather({
    fetchFn: () => Promise.resolve(new Response(JSON.stringify(batch), { status: 200 })),
  });
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
});

void test("enabled Brewfather accounts with missing or unavailable keys are disconnected", async (context) => {
  const { database, beverageService, secretsService, now } = createContext(context);
  beverageService.configureBrewfatherAccount({ userId: CONFIGURATION.userId });
  assert.equal(beverageService.getBrewfatherStatus().apiKeyConfigured, false);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");

  const unavailableService = createBeverageService(database, {
    secretsService: createSecretsService(database),
    now,
  });
  assert.equal(unavailableService.getBrewfatherStatus().apiKeyConfigured, true);
  assert.equal(unavailableService.getBrewfatherStatus().connectionState, "disconnected");
  const noSecretsService = createBeverageService(database, { now });
  assert.equal(noSecretsService.getBrewfatherStatus().connectionState, "disconnected");

  context.mock.method(secretsService, "list", () => {
    throw new Error("unavailable storage");
  });
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
  beverageService.configureBrewfatherAccount({ userId: CONFIGURATION.userId, enabled: false });
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disabled");
});

const CONFIGURATION_CHANGES = [
  { label: "user ID", input: { userId: "new-user", discoveryStatuses: ["Fermenting"] } },
  { label: "API key", input: { ...CONFIGURATION, apiKey: "replacement-test-key" } },
  { label: "discovery filter", input: { ...CONFIGURATION, discoveryStatuses: ["Completed"] } },
  {
    label: "identical configuration at the same timestamp",
    input: { userId: CONFIGURATION.userId, discoveryStatuses: CONFIGURATION.discoveryStatuses },
  },
];

for (const change of CONFIGURATION_CHANGES) {
  void test(`Brewfather rejects a stale in-flight success after changing ${change.label}`, async (context) => {
    const { beverageService, syncCoordinator } = createContext(context);
    beverageService.configureBrewfatherAccount(CONFIGURATION);
    await beverageService.syncBrewfather();
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");

    let complete!: (results: readonly SyncResult[]) => void;
    const pending = new Promise<readonly SyncResult[]>((resolve) => {
      complete = resolve;
    });
    const sync = context.mock.method(syncCoordinator, "sync", () => pending);
    const oldRun = beverageService.syncBrewfather();
    beverageService.configureBrewfatherAccount(change.input);
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");
    const coalescedRun = beverageService.syncBrewfather();
    complete([SUCCESS]);
    await Promise.all([oldRun, coalescedRun]);
    assert.equal(sync.mock.callCount(), 1);
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");

    await beverageService.syncBrewfather();
    assert.equal(sync.mock.callCount(), 2);
    assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
  });
}

void test("removing a Brewfather key invalidates cached and in-flight connection evidence", async (context) => {
  const { beverageService, syncCoordinator } = createContext(context);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather();

  let complete!: (results: readonly SyncResult[]) => void;
  const pending = new Promise<readonly SyncResult[]>((resolve) => {
    complete = resolve;
  });
  context.mock.method(syncCoordinator, "sync", () => pending);
  const oldRun = beverageService.syncBrewfather();
  assert.equal(beverageService.removeBrewfatherApiKey(), true);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
  complete([SUCCESS]);
  await oldRun;
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");
  await beverageService.syncBrewfather();
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
});

void test("cached Brewfather candidates and a new secret revision do not prove current connectivity", async (context) => {
  const { database, beverageService, secretsService, syncCoordinator, now } =
    createContext(context);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather({
    fetchFn: () =>
      Promise.resolve(
        new Response(
          JSON.stringify([{ _id: "cached-batch", name: "Cached", status: "Fermenting" }]),
          {
            status: 200,
          },
        ),
      ),
  });
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "healthy");
  assert.equal(beverageService.getBrewfatherStatus().totalCandidates, 1);
  assert.notEqual(beverageService.getBrewfatherStatus().lastDataUpdateAt, null);

  const restartedService = createBeverageService(database, {
    secretsService,
    syncCoordinator,
    now,
  });
  assert.equal(restartedService.getBrewfatherStatus().connectionState, "unknown");
  secretsService.upsert("brewfather", "default", "api_key", "directly-replaced-test-key");
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "unknown");
});

void test("a rejected Brewfather sync records failure without retaining its error details", async (context) => {
  const { beverageService, syncCoordinator, advance } = createContext(context);
  beverageService.configureBrewfatherAccount(CONFIGURATION);
  await beverageService.syncBrewfather();
  context.mock.method(syncCoordinator, "sync", () => Promise.reject(new Error("private failure")));
  await assert.rejects(beverageService.syncBrewfather(), /private failure/);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "partial");
  advance(300_000);
  assert.equal(beverageService.getBrewfatherStatus().connectionState, "disconnected");
  assert.equal(
    JSON.stringify(beverageService.getBrewfatherStatus()).includes("private failure"),
    false,
  );
});
