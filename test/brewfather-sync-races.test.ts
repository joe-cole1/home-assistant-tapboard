import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { readActivities } from "../src/features/activity/operations.ts";
import { BrewfatherSyncCoordinator } from "../src/features/beverages/brewfather/sync.ts";
import {
  sanitizeBatchSummary,
  sanitizeRecipeSnapshot,
} from "../src/features/beverages/brewfather/sanitizer.ts";
import {
  insertBeverageLink,
  readBeverage,
  readBeverageLink,
  readCandidate,
  readCustomProfile,
  readPresentationOverrides,
  readRecipeSnapshots,
  readSourceProfile,
  saveRecipeSnapshot,
  updateBeverageLinkState,
  upsertCandidate,
} from "../src/features/beverages/repository.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import type { EffectiveDensityChangedEvent } from "../src/features/beverages/types.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";

const CREATED_AT = "2026-09-30T10:00:00.000Z";
const SYNC_AT = "2026-09-30T11:00:00.000Z";
const CHANGED_AT = "2026-09-30T11:01:00.000Z";
const INITIAL_BATCH = {
  _id: "race-batch",
  name: "Original batch",
  status: "Fermenting",
  estimatedFg: 1.018,
  recipe: { _id: "original-recipe", name: "Original recipe", fg: 1.018 },
};
const UPDATED_BATCH = {
  ...INITIAL_BATCH,
  measuredFg: 1.01,
  recipe: { _id: "updated-recipe", name: "Updated recipe", fg: 1.01 },
};

function seedCandidate(
  database: DatabaseExecutor,
  sourceBatchId = INITIAL_BATCH._id,
  accountId = "default",
) {
  const summary = sanitizeBatchSummary({ ...INITIAL_BATCH, _id: sourceBatchId });
  assert.ok(summary);
  upsertCandidate(database, {
    ...summary,
    accountId,
    sourceBatchId,
    syncedAt: CREATED_AT,
  });
  const candidate = readCandidate(database, accountId, sourceBatchId);
  assert.ok(candidate);
  return candidate;
}

function readPersistedBeverage(database: DatabaseExecutor, beverageId: string) {
  return {
    beverage: readBeverage(database, beverageId),
    link: readBeverageLink(database, beverageId),
    sourceProfile: readSourceProfile(database, beverageId),
    overrides: readPresentationOverrides(database, beverageId),
    customProfile: readCustomProfile(database, beverageId),
    snapshots: readRecipeSnapshots(database, beverageId),
  };
}

function createRaceContext(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "tapboard-brewfather-sync-races-"));
  const path = join(directory, "race.sqlite3");
  const database = openDatabase(path);
  const concurrentDatabase = openDatabase(path);
  context.after(() => {
    concurrentDatabase.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // A mutation on this independent connection must never wait for remote I/O.
  concurrentDatabase.pragma("busy_timeout = 0");
  const secretsService = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 3).toString("base64url"),
  });
  const beverageService = createBeverageService(database, {
    secretsService,
    now: () => new Date(CREATED_AT),
  });
  const concurrentService = createBeverageService(concurrentDatabase, {
    now: () => new Date(CHANGED_AT),
  });
  beverageService.configureBrewfatherAccount({
    userId: "sync-race-user",
    apiKey: "sync-race-test-key",
    enabled: true,
    discoveryStatuses: [],
  });
  seedCandidate(database);
  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: INITIAL_BATCH._id,
  });
  const beverageId = linked.beverage.id;
  const recipe = sanitizeRecipeSnapshot(INITIAL_BATCH.recipe);
  assert.ok(recipe);
  saveRecipeSnapshot(database, {
    ...recipe,
    beverageId,
    accountId: "default",
    sourceBatchId: INITIAL_BATCH._id,
    state: "linked_current",
    createdAt: CREATED_AT,
  });
  updateBeverageLinkState(database, beverageId, "synced", null, CREATED_AT);
  const densityEvents: EffectiveDensityChangedEvent[] = [];
  const syncOptions = {
    accountId: "default",
    now: () => new Date(SYNC_AT),
    densityExtensionPort: {
      onEffectiveDensityChanged: (
        _database: DatabaseExecutor,
        event: EffectiveDensityChangedEvent,
      ) => {
        densityEvents.push(event);
      },
    },
  };
  return {
    database,
    concurrentDatabase,
    beverageService,
    concurrentService,
    secretsService,
    beverageId,
    densityEvents,
    syncOptions,
  };
}

function createDeferredTransport(expectedPath = `/v2/batches/${INITIAL_BATCH._id}`) {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  const fetchFn: typeof fetch = (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    assert.equal(url.pathname, expectedPath);
    requests += 1;
    started.resolve();
    return response.promise;
  };
  return {
    fetchFn,
    started: started.promise,
    respond: response.resolve,
    requests: () => requests,
  };
}

const OUTCOMES = [
  { label: "success", status: 200 },
  { label: "404", status: 404 },
  { label: "ordinary error", status: 400 },
  { label: "authentication error", status: 401 },
  { label: "authorization error", status: 403 },
] as const;

function upstreamResponse(status: number) {
  return new Response(status === 200 ? JSON.stringify(UPDATED_BATCH) : "Private upstream body", {
    status,
  });
}

const MUTATIONS = [
  "unlink",
  "delete",
  "ownership change",
  "replace account",
  "replace source batch",
  "replace link creation time",
] as const;

function mutateInFlightLink(
  race: ReturnType<typeof createRaceContext>,
  mutation: (typeof MUTATIONS)[number],
) {
  const { concurrentDatabase, concurrentService, beverageId } = race;
  if (mutation === "unlink") {
    concurrentService.unlinkBeverage(beverageId);
  } else if (mutation === "delete") {
    concurrentService.deleteBeverage(beverageId, { confirmationName: INITIAL_BATCH.name });
  } else if (mutation === "ownership change") {
    // Exercise the ownership check independently of the link identity checks.
    concurrentDatabase
      .prepare("UPDATE beverages SET ownership_type = 'custom' WHERE id = ?")
      .run(beverageId);
  } else {
    if (mutation === "replace account") {
      concurrentService.configureBrewfatherAccount({
        accountId: "replacement-account",
        userId: "replacement-user",
        enabled: false,
      });
    }
    concurrentDatabase.withTransaction(() => {
      const link = readBeverageLink(concurrentDatabase, beverageId);
      assert.ok(link);
      concurrentDatabase
        .prepare("DELETE FROM brewfather_beverage_links WHERE beverage_id = ?")
        .run(beverageId);
      insertBeverageLink(concurrentDatabase, {
        ...link,
        ...(mutation === "replace account" ? { accountId: "replacement-account" } : {}),
        ...(mutation === "replace source batch" ? { sourceBatchId: "replacement-batch" } : {}),
        ...(mutation === "replace link creation time" ? { createdAt: CHANGED_AT } : {}),
        syncState: "pending",
        lastSyncedAt: null,
        lastErrorMessage: null,
        updatedAt: CHANGED_AT,
      });
    });
  }
}

for (const mutation of MUTATIONS) {
  for (const outcome of OUTCOMES) {
    void test(`Brewfather ignores obsolete linked ${outcome.label} after ${mutation}`, async (context) => {
      const race = createRaceContext(context);
      const transport = createDeferredTransport();
      const coordinator = new BrewfatherSyncCoordinator({ fetchFn: transport.fetchFn });
      const pending = coordinator.sync(race.database, race.secretsService, race.syncOptions);
      await transport.started;

      mutateInFlightLink(race, mutation);
      const expected = readPersistedBeverage(race.concurrentDatabase, race.beverageId);
      transport.respond(upstreamResponse(outcome.status));
      const results = await pending;

      assert.equal(transport.requests(), 1);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.linkedSynced, 0);
      assert.equal(results[0]?.linkedErrors, 0);
      assert.equal(results[0]?.error, undefined);
      assert.equal(results[0]?.connectionVerified, outcome.status === 200);
      assert.equal(
        results[0]?.authenticationFailed ?? false,
        outcome.status === 401 || outcome.status === 403,
      );
      assert.deepEqual(readPersistedBeverage(race.database, race.beverageId), expected);
      assert.deepEqual(race.densityEvents, []);
      if (mutation === "unlink") {
        assert.equal(expected.beverage?.ownershipType, "custom");
        assert.equal(expected.sourceProfile, undefined);
        assert.equal(expected.snapshots[0]?.state, "detached");
      }
      if (mutation === "delete") {
        assert.equal(expected.beverage, undefined);
        assert.deepEqual(expected.snapshots, []);
      }
      const activity = readActivities(race.database).find(
        (entry) => entry.entityType === "brewfather_account" && entry.details?.change === "synced",
      );
      assert.ok(activity);
      assert.equal(activity.details?.linked_synced, 0);
      assert.equal(activity.details?.linked_errors, 0);
    });
  }
}

void test("Brewfather commits a current source profile, recipe, link, and density together", async (context) => {
  const race = createRaceContext(context);
  const before = readPersistedBeverage(race.database, race.beverageId);
  const transport = createDeferredTransport();
  const coordinator = new BrewfatherSyncCoordinator({ fetchFn: transport.fetchFn });
  const pending = coordinator.sync(race.database, race.secretsService, {
    ...race.syncOptions,
    densityExtensionPort: {
      onEffectiveDensityChanged: (database, event) => {
        assert.equal(database, race.database);
        assert.equal(readSourceProfile(database, race.beverageId)?.fg, 1.01);
        // Other connections still see the previous complete state until this transaction commits.
        assert.deepEqual(readPersistedBeverage(race.concurrentDatabase, race.beverageId), before);
        race.densityEvents.push(event);
      },
    },
  });
  await transport.started;
  assert.deepEqual(readPersistedBeverage(race.concurrentDatabase, race.beverageId), before);
  transport.respond(upstreamResponse(200));
  const results = await pending;

  assert.equal(results[0]?.linkedSynced, 1);
  assert.equal(results[0]?.linkedErrors, 0);
  assert.equal(results[0]?.connectionVerified, true);
  assert.equal(results[0]?.authenticationFailed, undefined);
  const after = readPersistedBeverage(race.concurrentDatabase, race.beverageId);
  assert.equal(after.sourceProfile?.name, UPDATED_BATCH.recipe.name);
  assert.equal(after.sourceProfile?.fg, 1.01);
  assert.equal(after.sourceProfile?.updatedAt, SYNC_AT);
  assert.equal(after.link?.syncState, "synced");
  assert.equal(after.link?.lastSyncedAt, SYNC_AT);
  assert.equal(after.link?.lastErrorMessage, null);
  assert.deepEqual(
    after.snapshots.map(({ version, state, sourceRecipeId }) => ({
      version,
      state,
      sourceRecipeId,
    })),
    [
      { version: 2, state: "linked_current", sourceRecipeId: UPDATED_BATCH.recipe._id },
      { version: 1, state: "superseded", sourceRecipeId: INITIAL_BATCH.recipe._id },
    ],
  );
  assert.deepEqual(race.densityEvents, [
    {
      beverageId: race.beverageId,
      previousDensity: { densityGPerMl: 1.018, specificGravity: 1.018, source: "fg_derived" },
      newDensity: { densityGPerMl: 1.01, specificGravity: 1.01, source: "fg_derived" },
      changedAt: SYNC_AT,
    },
  ]);
});

for (const outcome of OUTCOMES.filter(({ status }) => status !== 200)) {
  void test(`Brewfather records a current linked ${outcome.label} without changing successful data`, async (context) => {
    const race = createRaceContext(context);
    const before = readPersistedBeverage(race.database, race.beverageId);
    const transport = createDeferredTransport();
    const coordinator = new BrewfatherSyncCoordinator({ fetchFn: transport.fetchFn });
    const pending = coordinator.sync(race.database, race.secretsService, race.syncOptions);
    await transport.started;
    transport.respond(upstreamResponse(outcome.status));
    const results = await pending;

    assert.equal(results[0]?.linkedSynced, 0);
    assert.equal(results[0]?.linkedErrors, 1);
    assert.equal(results[0]?.connectionVerified, false);
    assert.equal(
      results[0]?.authenticationFailed ?? false,
      outcome.status === 401 || outcome.status === 403,
    );
    const after = readPersistedBeverage(race.concurrentDatabase, race.beverageId);
    assert.equal(after.link?.syncState, outcome.status === 404 ? "stale" : "error");
    assert.equal(after.link?.lastSyncedAt, CREATED_AT);
    assert.equal(after.link?.updatedAt, SYNC_AT);
    assert.match(after.link?.lastErrorMessage ?? "", new RegExp(String(outcome.status)));
    assert.equal(after.link?.lastErrorMessage?.includes("Private upstream body"), false);
    assert.deepEqual(after.sourceProfile, before.sourceProfile);
    assert.deepEqual(after.snapshots, before.snapshots);
    assert.deepEqual(race.densityEvents, []);
  });
}

void test("Brewfather pruning preserves links created during discovery and respects account scope", async (context) => {
  const race = createRaceContext(context);
  race.beverageService.configureBrewfatherAccount({
    userId: "sync-race-user",
    discoveryStatuses: ["Fermenting"],
  });
  race.concurrentService.configureBrewfatherAccount({
    accountId: "other-account",
    userId: "other-user",
    enabled: false,
  });
  const newCandidate = seedCandidate(race.database, "newly-linked");
  seedCandidate(race.database, "unlinked-stale");
  seedCandidate(race.database, "shared-batch-id");
  const otherAccountCandidate = seedCandidate(race.database, "shared-batch-id", "other-account");
  race.concurrentService.linkBrewfatherCandidate({
    accountId: "other-account",
    sourceBatchId: "shared-batch-id",
  });
  const discovery = createDeferredTransport("/v2/batches");
  const coordinator = new BrewfatherSyncCoordinator({
    fetchFn: (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      return url.pathname === `/v2/batches/${INITIAL_BATCH._id}`
        ? Promise.resolve(upstreamResponse(200))
        : discovery.fetchFn(input, init);
    },
  });
  const pending = coordinator.sync(race.database, race.secretsService, race.syncOptions);
  await discovery.started;
  const newLinked = race.concurrentService.linkBrewfatherCandidate({
    sourceBatchId: "newly-linked",
  });
  discovery.respond(new Response("[]", { status: 200 }));
  const results = await pending;

  assert.equal(results[0]?.linkedSynced, 1);
  assert.equal(results[0]?.linkedErrors, 0);
  assert.equal(results[0]?.candidatesFound, 0);
  assert.ok(readCandidate(race.database, "default", INITIAL_BATCH._id));
  assert.deepEqual(readCandidate(race.database, "default", "newly-linked"), newCandidate);
  assert.equal(readBeverageLink(race.database, newLinked.beverage.id)?.syncState, "pending");
  assert.equal(readCandidate(race.database, "default", "unlinked-stale"), undefined);
  assert.equal(readCandidate(race.database, "default", "shared-batch-id"), undefined);
  assert.deepEqual(
    readCandidate(race.database, "other-account", "shared-batch-id"),
    otherAccountCandidate,
  );
});
