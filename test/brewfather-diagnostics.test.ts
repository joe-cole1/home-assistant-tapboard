import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { upsertCandidate, readBeverageLink } from "../src/features/beverages/repository.ts";
import { sanitizeBatchSummary } from "../src/features/beverages/brewfather/sanitizer.ts";
import { listActivity } from "../src/features/activity/repository.ts";
import { BrewfatherError } from "../src/features/beverages/brewfather/adapter.ts";
import { describeBrewfatherFailure } from "../src/features/beverages/brewfather/diagnostics.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import {
  BrewfatherSyncCoordinator,
  type SyncResult,
} from "../src/features/beverages/brewfather/sync.ts";

const SENTINEL = "private-provider-payload";
void test("provider classifications use fixed messages and bounded metadata", () => {
  for (const [category, status] of [
    ["auth", 401],
    ["forbidden", 403],
    ["rate_limited", 429],
    ["network", null],
  ] as const) {
    const failure = describeBrewfatherFailure(
      new BrewfatherError(category, SENTINEL, { status, retryAfterMs: 9_000_000 }),
    );
    assert.equal(failure.category, "unavailable");
    assert.equal(failure.providerStatus, status);
    assert.equal(failure.retryAfterMs, 3_600_000);
    assert.ok(!JSON.stringify(failure).includes(SENTINEL));
  }
  assert.match(
    describeBrewfatherFailure(new BrewfatherError("forbidden", SENTINEL)).message,
    /Read Batches/,
  );
  assert.ok(!JSON.stringify(describeBrewfatherFailure(new Error(SENTINEL))).includes(SENTINEL));
  const curated = describeBrewfatherFailure(
    new ApplicationError({
      category: "unavailable",
      code: "secrets.key_missing",
      clientMessage: "Set the root key.",
      details: { private: SENTINEL },
      cause: new Error(SENTINEL),
    }),
  );
  assert.equal(curated.message, "Set the root key.");
  assert.ok(!JSON.stringify(curated).includes(SENTINEL));
});

void test("local credential storage failures do not contact Brewfather", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  let requests = 0;
  const secretsService = createSecretsService(database);
  const syncCoordinator = new BrewfatherSyncCoordinator({
    fetchFn: () => {
      requests++;
      return Promise.resolve(new Response("[]"));
    },
  });
  const service = createBeverageService(database, { secretsService, syncCoordinator });
  context.after(() => service.dispose());
  service.configureBrewfatherAccount({ userId: "local-user", discoveryStatuses: ["Fermenting"] });
  const [result] = await service.syncBrewfather();
  assert.equal(requests, 0);
  assert.equal(result?.failures?.[0]?.code, "secrets.key_missing");
  assert.equal(service.getBrewfatherStatus().credentialStorage?.available, false);
});

void test("periodic failures deduplicate, recover and isolate failing loggers", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const secretsService = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 7).toString("base64url"),
  });
  const coordinator = new BrewfatherSyncCoordinator();
  const failure = describeBrewfatherFailure(new BrewfatherError("auth", SENTINEL, { status: 401 }));
  let result: SyncResult = {
    accountId: "default",
    linkedSynced: 0,
    linkedErrors: 0,
    candidatesFound: 0,
    durationMs: 0,
    error: failure.message,
    failures: [failure],
  };
  coordinator.sync = () => Promise.resolve([result]);
  const logs: unknown[] = [];
  const logger = {
    debug() {},
    info() {},
    warn(_message: string, context?: unknown) {
      logs.push(context);
      throw new Error(SENTINEL);
    },
    error(_message: string, context?: unknown) {
      logs.push(context);
    },
  };
  const service = createBeverageService(database, {
    secretsService,
    syncCoordinator: coordinator,
    logger,
  });
  context.after(() => service.dispose());
  service.configureBrewfatherAccount({
    userId: "local-user",
    apiKey: "local-api-key",
    discoveryStatuses: ["Fermenting"],
  });
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  service.startPeriodicSync({ initialDelayMs: 0, intervalMs: 10 });
  context.mock.timers.tick(45);
  await flush();
  assert.equal(logs.length, 1);
  result = { ...result, failures: [], linkedErrors: 1 };
  context.mock.timers.tick(10);
  await flush();
  assert.equal(logs.length, 2);
  const { error: _error, ...recovered } = result;
  result = { ...recovered, linkedErrors: 0, failures: [], connectionVerified: true };
  context.mock.timers.tick(25);
  await flush();
  result = { ...result, error: failure.message, failures: [failure], connectionVerified: false };
  context.mock.timers.tick(25);
  await flush();
  assert.equal(logs.length, 3);
  service.dispose();
  context.mock.timers.tick(25);
  await flush();
  assert.equal(logs.length, 3);
  assert.ok(!JSON.stringify(logs).includes(SENTINEL));
});

for (const rootKey of [undefined, "invalid-root-key"]) {
  void test(`saving credentials with ${rootKey === undefined ? "missing" : "invalid"} root key fails locally`, (context) => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    let requests = 0;
    if (rootKey !== undefined) {
      assert.throws(
        () => createSecretsService(database, { rootKey }),
        (error: unknown) => error instanceof ApplicationError && error.category === "unavailable",
      );
      assert.equal(requests, 0);
      return;
    }
    const secretsService = createSecretsService(database, { rootKey });
    const service = createBeverageService(database, {
      secretsService,
      syncCoordinator: new BrewfatherSyncCoordinator({
        fetchFn: () => {
          requests++;
          return Promise.resolve(new Response("[]"));
        },
      }),
    });
    context.after(() => service.dispose());
    assert.throws(
      () =>
        service.configureBrewfatherAccount({
          userId: "local-user",
          apiKey: SENTINEL,
          discoveryStatuses: ["Fermenting"],
        }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === "secrets.key_missing" &&
        !error.message.includes(SENTINEL),
    );
    assert.equal(requests, 0);
    assert.equal(service.getBrewfatherStatus().configured, false);
  });
}

void test("periodic thrown unknown failures are safe and stopped late work stays quiet", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const secretsService = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 7).toString("base64url"),
  });
  const coordinator = new BrewfatherSyncCoordinator();
  coordinator.sync = () => Promise.reject(new Error(SENTINEL));
  const logs: unknown[] = [];
  const logger = {
    debug() {},
    info() {},
    warn(_message: string, value?: unknown) {
      logs.push(value);
    },
    error(_message: string, value?: unknown) {
      logs.push(value);
    },
  };
  const service = createBeverageService(database, {
    secretsService,
    syncCoordinator: coordinator,
    logger,
  });
  context.after(() => service.dispose());
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  service.startPeriodicSync({ initialDelayMs: 0, intervalMs: 10 });
  context.mock.timers.tick(35);
  await flush();
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes(SENTINEL));
  service.stopPeriodicSync();
  let rejectWork: ((error: Error) => void) | undefined;
  coordinator.sync = () =>
    new Promise((_resolve, reject) => {
      rejectWork = reject;
    });
  service.startPeriodicSync({ initialDelayMs: 0, intervalMs: 1000 });
  context.mock.timers.tick(15);
  await flush();
  service.stopPeriodicSync();
  rejectWork?.(new Error("different-private-payload"));
  context.mock.timers.tick(15);
  await flush();
  assert.equal(logs.length, 1);
});

void test("a missing stored provider key is distinct from server key unavailability", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const secretsService = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 7).toString("base64url"),
  });
  const service = createBeverageService(database, {
    secretsService,
    syncCoordinator: new BrewfatherSyncCoordinator({
      fetchFn: () => {
        throw new Error("transport must not run");
      },
    }),
  });
  context.after(() => service.dispose());
  service.configureBrewfatherAccount({ userId: "local-user", discoveryStatuses: ["Fermenting"] });
  const [result] = await service.syncBrewfather();
  assert.equal(result?.failures?.[0]?.code, "brewfather.key_missing");
  assert.equal(result?.failures?.[0]?.category, "unavailable");
  assert.match(result?.error ?? "", /No Brewfather API key/);
});

for (const status of [401, 403, 429]) {
  void test(`sync preserves safe provider HTTP ${status} fields from transport`, async (context) => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    const secretsService = createSecretsService(database, {
      rootKey: Buffer.alloc(32, 7).toString("base64url"),
    });
    const coordinator = new BrewfatherSyncCoordinator({
      fetchFn: () =>
        Promise.resolve(new Response(SENTINEL, { status, headers: { "Retry-After": "2" } })),
    });
    const service = createBeverageService(database, {
      secretsService,
      syncCoordinator: coordinator,
    });
    context.after(() => service.dispose());
    service.configureBrewfatherAccount({
      userId: "local-user",
      apiKey: "local-key",
      discoveryStatuses: ["Fermenting"],
    });
    const results = await service.syncBrewfather();
    assert.equal(results[0]?.failures?.[0]?.providerStatus, status);
    assert.equal(results[0]?.failures?.[0]?.category, "unavailable");
    assert.equal(results[0]?.failures?.[0]?.retryAfterMs, status === 429 ? 2000 : null);
    assert.ok(!JSON.stringify(results).includes(SENTINEL));
    assert.ok(!JSON.stringify(listActivity(database)).includes(SENTINEL));
  });
}

void test("unknown linked persistence failures never leak into results, link state or activity", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const secretsService = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 7).toString("base64url"),
  });
  const batch = {
    _id: "diagnostic-batch",
    name: "Test batch",
    status: "Fermenting",
    estimatedFg: 1.018,
  };
  const coordinator = new BrewfatherSyncCoordinator({
    fetchFn: () => Promise.resolve(Response.json({ ...batch, measuredFg: 1.01 })),
  });
  let injectFailure = false;
  const service = createBeverageService(database, {
    secretsService,
    syncCoordinator: coordinator,
    densityExtensionPort: {
      onEffectiveDensityChanged() {
        if (injectFailure) throw new Error(SENTINEL);
      },
    },
  });
  context.after(() => service.dispose());
  service.configureBrewfatherAccount({
    userId: "local-user",
    apiKey: "local-key",
    discoveryStatuses: [],
  });
  const summary = sanitizeBatchSummary(batch);
  assert.ok(summary);
  upsertCandidate(database, {
    ...summary,
    accountId: "default",
    sourceBatchId: batch._id,
    syncedAt: new Date().toISOString(),
  });
  const linked = service.linkBrewfatherCandidate({ sourceBatchId: batch._id });
  injectFailure = true;
  const results = await service.syncBrewfather();
  assert.equal(results[0]?.linkedErrors, 1);
  assert.equal(results[0]?.failures?.[0]?.code, "brewfather.unexpected");
  const persistedLink = readBeverageLink(database, linked.beverage.id);
  assert.equal(persistedLink?.lastErrorMessage, results[0]?.failures?.[0]?.message);
  assert.ok(!JSON.stringify([results, persistedLink, listActivity(database)]).includes(SENTINEL));
});

void test("completion authorization guidance includes both required permissions", () => {
  const error = new BrewfatherError("forbidden", SENTINEL, { status: 403 });
  assert.match(
    describeBrewfatherFailure(error, "complete").message,
    /Read Batches and Edit Batches/,
  );
  assert.ok(!describeBrewfatherFailure(error).message.includes("Edit Batches"));
});
