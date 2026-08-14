import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { resolveBeverageDensity } from "../src/features/beverages/density.ts";
import { resolveLinkedPresentation } from "../src/features/beverages/presentation.ts";
import {
  BrewfatherAdapter,
  BrewfatherError,
  parseRetryAfter,
} from "../src/features/beverages/brewfather/adapter.ts";
import {
  sanitizeBatchSummary,
  sanitizeRecipeSnapshot,
} from "../src/features/beverages/brewfather/sanitizer.ts";
import { BrewfatherSyncCoordinator } from "../src/features/beverages/brewfather/sync.ts";
import { readActivities } from "../src/features/activity/operations.ts";
import { readDeletionAudits } from "../src/features/activity/deletion-audit.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { registerBeverageRoutes } from "../src/features/beverages/routes.ts";
import { createLogger } from "../src/shared/logging.ts";

const ROOT_KEY = Buffer.alloc(32, 1).toString("base64url");
const quietLogger = createLogger({ sink: () => undefined });

function createTestContext() {
  const database = openDatabase(":memory:");
  const secretsService = createSecretsService(database, { rootKey: ROOT_KEY });
  const authService = createAuthService(database);
  const beverageService = createBeverageService(database, { secretsService });
  return { database, secretsService, authService, beverageService };
}

void test("density resolution strictly follows frozen precedence", () => {
  // 1. Manual override wins over FG
  const withBoth = resolveBeverageDensity({ manualDensityOverride: 1.015, fg: 1.006 }, 1.008);
  assert.equal(withBoth.densityGPerMl, 1.015);
  assert.equal(withBoth.source, "manual_override");

  // 2. FG wins when manual override is null
  const withFgOnly = resolveBeverageDensity({ manualDensityOverride: null, fg: 1.012 }, 1.008);
  assert.equal(withFgOnly.densityGPerMl, 1.012);
  assert.equal(withFgOnly.source, "fg_derived");

  // 3. Fallback FG wins when both are null
  const withNeither = resolveBeverageDensity({ manualDensityOverride: null, fg: null }, 1.008);
  assert.equal(withNeither.densityGPerMl, 1.008);
  assert.equal(withNeither.source, "fallback_fg");

  // 4. Custom configured fallback
  const withCustomFallback = resolveBeverageDensity(
    { manualDensityOverride: null, fg: null },
    1.01,
  );
  assert.equal(withCustomFallback.densityGPerMl, 1.01);
  assert.equal(withCustomFallback.source, "fallback_fg");
});

void test("presentation resolution handles 3-state overrides correctly", () => {
  const source = {
    beverageId: "test-id",
    name: "Source IPA",
    beverageType: "beer" as const,
    style: "American IPA",
    abv: 6.5,
    ibu: 55,
    og: 1.06,
    fg: 1.01,
    srm: 6.0,
    displayColor: null,
    description: "Source description",
    rawSourceJson: "{}",
    sourceFingerprint: "fingerprint",
    updatedAt: new Date().toISOString(),
  };

  // Inherited (no overrides)
  const inherited = resolveLinkedPresentation(source, null);
  assert.equal(inherited.name, "Source IPA");
  assert.equal(inherited.abv, 6.5);
  assert.equal(inherited.description, "Source description");

  // Explicit override with value
  const withOverride = resolveLinkedPresentation(source, {
    beverageId: "test-id",
    overrideNamePresent: true,
    name: "Custom Renamed IPA",
    overrideBeverageTypePresent: false,
    beverageType: null,
    overrideStylePresent: false,
    style: null,
    overrideAbvPresent: true,
    abv: 7.0,
    overrideIbuPresent: false,
    ibu: null,
    overrideOgPresent: false,
    og: null,
    overrideFgPresent: false,
    fg: null,
    overrideSrmPresent: false,
    srm: null,
    overrideDisplayColorPresent: false,
    displayColor: null,
    overrideDescriptionPresent: true,
    description: null, // explicit clear
    overrideFillGlassPresent: true,
    fillGlass: "pint",
    overrideManualDensityOverridePresent: true,
    manualDensityOverride: 1.014,
    updatedAt: new Date().toISOString(),
  });

  assert.equal(withOverride.name, "Custom Renamed IPA");
  assert.equal(withOverride.abv, 7.0);
  assert.equal(withOverride.description, null); // cleared
  assert.equal(withOverride.fillGlass, "pint");
  assert.equal(withOverride.manualDensityOverride, 1.014);
});

void test("custom beverage lifecycle: create, recipe, sensory, update, delete", () => {
  const { database, beverageService } = createTestContext();

  // 1. Create custom beverage
  const created = beverageService.createCustomBeverage({
    name: "House Pale Ale",
    beverageType: "beer",
    style: "American Pale Ale",
    abv: 5.2,
    ibu: 35,
    og: 1.05,
    fg: 1.01,
    recipe: {
      notes: "Mash at 66C for 60 min",
      ingredients: [
        { name: "Pale 2-Row", amount: 4.5, unit: "kg", note: "Base malt" },
        { name: "Cascade Hops", amount: 50, unit: "g", note: "60 min" },
      ],
      steps: [
        { name: "Mash in", temperatureC: 66, timeMinutes: 60, note: "Single infusion" },
        { name: "Boil", temperatureC: 100, timeMinutes: 60, note: "Vigorous boil" },
      ],
    },
    sensoryOverrides: {
      bitterness: 3,
      sweetness: 2,
      body: 3,
      roast: 1,
      tartness: 1,
      alcohol: 2,
    },
  });

  assert.ok(created.beverage.id);
  assert.equal(created.beverage.ownershipType, "custom");
  assert.equal(created.effectivePresentation.name, "House Pale Ale");
  assert.equal(created.density.densityGPerMl, 1.01);
  assert.equal(created.density.source, "fg_derived");
  assert.equal(created.customRecipe?.ingredients.length, 2);
  assert.equal(created.customRecipe?.steps.length, 2);
  assert.equal(created.sensoryOverrides?.bitterness, 3);

  // 2. Read back
  const read = beverageService.getBeverage(created.beverage.id);
  assert.equal(read.effectivePresentation.name, "House Pale Ale");
  assert.equal(read.customRecipe?.ingredients[0]?.name, "Pale 2-Row");

  // 3. Update
  const updated = beverageService.updateCustomBeverage(created.beverage.id, {
    name: "House Pale Ale (Special Edition)",
    abv: 5.5,
    manualDensityOverride: 1.014,
  });
  assert.equal(updated.effectivePresentation.name, "House Pale Ale (Special Edition)");
  assert.equal(updated.density.densityGPerMl, 1.014);
  assert.equal(updated.density.source, "manual_override");

  // 4. Deletion impact and destructive delete
  const impact = beverageService.getDeletionImpact(created.beverage.id);
  assert.equal(impact.beverageId, created.beverage.id);
  assert.ok(impact.impacts.some((i) => i.code === "beverages"));
  assert.ok(impact.impacts.some((i) => i.code === "custom_recipes"));

  const deletion = beverageService.deleteBeverage(created.beverage.id, {
    reason: "Batch finished",
  });
  assert.equal(deletion.beverageId, created.beverage.id);

  // Verify deletion audit
  const audits = readDeletionAudits(database);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.entityType, "beverage");
  assert.equal(audits[0]?.entityId, created.beverage.id);
  assert.equal(audits[0]?.reason, "Batch finished");

  // Verify activity log
  const activities = readActivities(database);
  assert.ok(activities.some((a) => a.action === "deletion" && a.entityId === created.beverage.id));

  // Verify not found after delete
  assert.throws(() => beverageService.getBeverage(created.beverage.id), /not found/i);
});

void test("updateCustomBeverage persists updated_at to beverages table and is visible in getBeverage", () => {
  const { beverageService } = createTestContext();
  const t1 = new Date("2026-08-14T10:00:00.000Z");
  const created = beverageService.createCustomBeverage(
    {
      name: "Timestamp Test Ale",
      beverageType: "beer",
      style: "Pale Ale",
    },
    { now: () => t1 },
  );
  assert.equal(created.beverage.createdAt, t1.toISOString());
  assert.equal(created.beverage.updatedAt, t1.toISOString());

  const t2 = new Date("2026-08-14T11:00:00.000Z");
  const updated = beverageService.updateCustomBeverage(
    created.beverage.id,
    {
      name: "Timestamp Test Ale (Updated)",
    },
    { now: () => t2 },
  );
  assert.equal(updated.beverage.updatedAt, t2.toISOString());

  // Fresh read from database must show updated timestamp
  const freshRead = beverageService.getBeverage(created.beverage.id);
  assert.equal(freshRead.beverage.updatedAt, t2.toISOString());
});

void test("Brewfather candidate linking, snapshot versioning, and atomic unlink", () => {
  const { database, beverageService } = createTestContext();

  // 1. Configure Brewfather account
  const account = beverageService.configureBrewfatherAccount({
    userId: "bf-user-123",
    apiKey: "secret-api-key-xyz",
    enabled: true,
  });
  assert.equal(account.userId, "bf-user-123");

  const status = beverageService.getBrewfatherStatus();
  assert.equal(status.configured, true);
  assert.equal(status.apiKeyConfigured, true);

  // 2. Insert candidate batch into candidate cache (simulating discovery sync)
  const rawBatchData = {
    _id: "batch-abc-123",
    name: "Brewfather Hazy IPA",
    status: "Fermenting",
    brewer: "Brewmaster Joe",
    estimatedOg: 1.065,
    estimatedFg: 1.012,
    measuredOg: 1.066,
    measuredFg: 1.013,
    estimatedAbv: 6.8,
    measuredAbv: 7.0,
    estimatedIbu: 45,
    estimatedColor: 5.5,
    recipe: {
      _id: "recipe-xyz-789",
      name: "Hazy IPA Recipe",
      style: { name: "New England IPA" },
      description: "Juicy tropical hazy IPA",
      fermentables: [
        { name: "Pilsner Malt", amount: 5, unit: "kg" },
        { name: "Flaked Oats", amount: 1.5, unit: "kg" },
      ],
      hops: [{ name: "Citra", amount: 100, unit: "g", use: "Dry Hop" }],
    },
  };

  const sanitizedSummary = sanitizeBatchSummary(rawBatchData)!;
  assert.ok(sanitizedSummary);

  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, batch_number, status,
        brewer, recipe_name, style, brew_date, estimated_og, estimated_fg,
        estimated_abv, estimated_ibu, estimated_srm, raw_summary_json,
        summary_fingerprint, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      "default",
      sanitizedSummary.batchId,
      sanitizedSummary.batchName,
      sanitizedSummary.batchNumber,
      sanitizedSummary.status,
      sanitizedSummary.brewer,
      sanitizedSummary.recipeName,
      sanitizedSummary.style,
      sanitizedSummary.brewDate,
      sanitizedSummary.estimatedOg,
      sanitizedSummary.estimatedFg,
      sanitizedSummary.estimatedAbv,
      sanitizedSummary.estimatedIbu,
      sanitizedSummary.estimatedSrm,
      sanitizedSummary.rawSummaryJson,
      sanitizedSummary.summaryFingerprint,
      new Date().toISOString(),
    );

  // 3. Link candidate into a new Beverage
  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-abc-123",
    overrides: {
      name: { value: "Taproom NEIPA (Overrides Applied)" },
      fillGlass: { value: "tulip" },
    },
    sensoryOverrides: {
      bitterness: 2,
      sweetness: 3,
      body: 4,
    },
  });

  assert.equal(linked.beverage.ownershipType, "brewfather");
  assert.equal(linked.effectivePresentation.name, "Taproom NEIPA (Overrides Applied)");
  assert.equal(linked.effectivePresentation.style, "New England IPA");
  assert.equal(linked.effectivePresentation.fillGlass, "tulip");
  assert.equal(linked.sensoryOverrides?.body, 4);

  // 4. Save recipe snapshot
  const sanitizedRecipe = sanitizeRecipeSnapshot(rawBatchData.recipe)!;
  database
    .prepare(
      `INSERT INTO beverage_source_recipe_snapshots
       (id, beverage_id, account_id, source_batch_id, source_recipe_id,
        state, version, recipe_json, recipe_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      linked.beverage.id,
      "default",
      "batch-abc-123",
      sanitizedRecipe.sourceRecipeId,
      "linked_current",
      1,
      sanitizedRecipe.recipeJson,
      sanitizedRecipe.recipeFingerprint,
      new Date().toISOString(),
    );

  // Verify duplicate link attempt is rejected with 409 conflict
  assert.throws(
    () => beverageService.linkBrewfatherCandidate({ sourceBatchId: "batch-abc-123" }),
    /already linked/i,
  );

  // Test that name clear: true is rejected
  assert.throws(
    () =>
      beverageService.updatePresentationOverrides(linked.beverage.id, {
        name: { clear: true },
      }),
    /cannot be cleared to empty/i,
  );

  // Test that inherit: true reverts an override back to source
  const reverted = beverageService.updatePresentationOverrides(linked.beverage.id, {
    style: { inherit: true },
  });
  assert.equal(reverted.effectivePresentation.style, "New England IPA"); // Reverted to source style
  assert.equal(reverted.effectivePresentation.name, "Taproom NEIPA (Overrides Applied)");

  // 5. Atomic Unlink to Custom
  const unlinked = beverageService.unlinkBeverage(linked.beverage.id);

  assert.equal(unlinked.beverage.id, linked.beverage.id); // UUID preserved
  assert.equal(unlinked.beverage.ownershipType, "custom");
  assert.equal(unlinked.customProfile?.name, "Taproom NEIPA (Overrides Applied)"); // Materialized
  assert.equal(unlinked.customProfile?.fillGlass, "tulip");
  assert.equal(unlinked.sensoryOverrides?.body, 4); // Sensory preserved
  assert.equal(unlinked.recipeSnapshot?.state, "detached"); // Snapshot transitioned to detached

  // Verify Brewfather tables are cleared for this beverage
  const linkRow = database
    .prepare("SELECT * FROM brewfather_beverage_links WHERE beverage_id = ?")
    .get(linked.beverage.id);
  assert.equal(linkRow, undefined);

  const sourceRow = database
    .prepare("SELECT * FROM brewfather_source_profiles WHERE beverage_id = ?")
    .get(linked.beverage.id);
  assert.equal(sourceRow, undefined);

  const overrideRow = database
    .prepare("SELECT * FROM brewfather_presentation_overrides WHERE beverage_id = ?")
    .get(linked.beverage.id);
  assert.equal(overrideRow, undefined);

  // Verify activity log recorded unlink
  const activities = readActivities(database);
  assert.ok(activities.some((a) => a.action === "transition" && a.entityId === linked.beverage.id));
});

void test("Brewfather adapter handles pagination with start_after, budget limits, retry-after backoff, transient retry, and auth rejection", async () => {
  const requestedUrls: string[] = [];
  let transientAttempts = 0;
  const mockFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    requestedUrls.push(urlStr);

    if (urlStr.includes("/v2/batches") && !urlStr.includes("start_after")) {
      // Page 1: 50 items (full page)
      const batches = Array.from({ length: 50 }, (_, i) => ({
        _id: `batch-${i + 1}`,
        name: `Batch ${i + 1}`,
      }));
      return Promise.resolve(
        new Response(JSON.stringify(batches), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (urlStr.includes("start_after=batch-50")) {
      // Page 2: 1 item (terminal short page)
      return Promise.resolve(
        new Response(JSON.stringify([{ _id: "batch-51", name: "Batch 51" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (urlStr.includes("/transient-test")) {
      transientAttempts += 1;
      if (transientAttempts === 1) {
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (urlStr.includes("/auth-fail")) {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    }

    if (urlStr.includes("/rate-limited-test")) {
      return Promise.resolve(
        new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      );
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  };

  const adapter = new BrewfatherAdapter({
    userId: "user-1",
    apiKey: "key-1",
    fetchFn: mockFetch,
    requestBudget: 10,
    maxRetries: 1,
    retryDelayMs: 1,
  });

  // 1. Multi-page start_after pagination + terminal short page termination
  const result = await adapter.listBatchesByStatuses(["Planning"]);
  assert.equal(result.batches.length, 51);
  assert.ok(requestedUrls.some((u) => u.includes("start_after=batch-50")));

  // 2. Bounded transient retry: 500 error retries and succeeds on attempt 2
  const transientResult = await adapter.request<{ ok: boolean }>("GET", "/transient-test");
  assert.equal(transientResult?.ok, true);
  assert.equal(transientAttempts, 2);

  // 3. 401 Authentication failure is rejected immediately without retry
  await assert.rejects(
    () => adapter.request("GET", "/auth-fail"),
    (err: unknown) => err instanceof BrewfatherError && err.category === "auth",
  );

  // 4. 429 Retry-After parsing and subsequent blocking
  await assert.rejects(
    () => adapter.request("GET", "/rate-limited-test"),
    (err: unknown) =>
      err instanceof BrewfatherError &&
      err.category === "rate_limited" &&
      err.retryAfterMs === 30_000,
  );

  // Subsequent call is blocked by Retry-After before making fetch
  const callsBefore = requestedUrls.length;
  await assert.rejects(
    () => adapter.request("GET", "/any-path"),
    (err: unknown) => err instanceof BrewfatherError && err.category === "rate_limited",
  );
  assert.equal(requestedUrls.length, callsBefore); // No new network call
});

void test("parseRetryAfter safely parses and clamps values to min 1s and max 1h", () => {
  const now = 1_000_000;
  // 1. Zero / below-minimum clamped to MIN_RETRY_AFTER_MS (1000ms)
  assert.equal(parseRetryAfter("0", now), 1000);
  assert.equal(parseRetryAfter("-10", now), 1000);

  // 2. Normal integer seconds
  assert.equal(parseRetryAfter("30", now), 30_000);
  assert.equal(parseRetryAfter("120", now), 120_000);

  // 3. Over-maximum clamped to MAX_RETRY_AFTER_MS (3600000ms = 1 hour)
  assert.equal(parseRetryAfter("10000", now), 3_600_000);

  // 4. HTTP-date format
  const normalDate = new Date(now + 45_000).toUTCString();
  assert.equal(parseRetryAfter(normalDate, now), 45_000);

  const pastDate = new Date(now - 10_000).toUTCString();
  assert.equal(parseRetryAfter(pastDate, now), 1000); // clamped to min 1s

  const farFutureDate = new Date(now + 10_000_000).toUTCString();
  assert.equal(parseRetryAfter(farFutureDate, now), 3_600_000); // clamped to max 1h

  // 5. Malformed / empty returns null
  assert.equal(parseRetryAfter("", now), null);
  assert.equal(parseRetryAfter("invalid-date-string", now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
});

void test("Brewfather adapter request budget exhaustion rejects locally and resumes after window advances", async () => {
  let mockClock = 1_000_000;
  let networkCalls = 0;
  const mockFetch: typeof fetch = () => {
    networkCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const adapter = new BrewfatherAdapter({
    userId: "user-budget",
    apiKey: "key-budget",
    fetchFn: mockFetch,
    requestBudget: 3,
    budgetWindowMs: 60_000,
    now: () => mockClock,
  });

  // Consume 3 budget slots
  await adapter.request("GET", "/test1");
  await adapter.request("GET", "/test2");
  await adapter.request("GET", "/test3");
  assert.equal(networkCalls, 3);

  // 4th request must fail locally as rate_limited without making a network call
  await assert.rejects(
    () => adapter.request("GET", "/test4"),
    (err: unknown) =>
      err instanceof BrewfatherError &&
      err.category === "rate_limited" &&
      typeof err.retryAfterMs === "number",
  );
  assert.equal(networkCalls, 3); // No extra network call!

  // Advance time past budget window
  mockClock += 60_001;

  // 5th request succeeds
  await adapter.request("GET", "/test5");
  assert.equal(networkCalls, 4);
});

void test("Brewfather sync coordinator retains persistent rate-limit budget and backoff per account", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    accountId: "acc-persisted",
    userId: "user-p",
    apiKey: "key-p",
    enabled: true,
    discoveryStatuses: ["Fermenting"],
  });

  let fetchCalls = 0;
  const mockFetch: typeof fetch = () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return Promise.resolve(
        new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const coordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });

  // Sync 1: receives 429 and sets backoff on the account's persistent adapter
  const result1 = await coordinator.sync(database, secretsService, { accountId: "acc-persisted" });
  assert.ok(result1[0]?.error?.includes("429") || result1[0]?.error?.includes("rate limit"));
  assert.equal(fetchCalls, 1);

  // Sync 2: next sync on same coordinator uses persistent adapter, which blocks before fetch
  const result2 = await coordinator.sync(database, secretsService, { accountId: "acc-persisted" });
  assert.ok(result2[0]?.error?.includes("rate limited") || result2[0]?.error?.includes("Retry in"));
  assert.equal(fetchCalls, 1); // No new fetch made!
});

void test("Brewfather sync coalescing merges concurrent sync invocations", async () => {
  const { database, secretsService, beverageService } = createTestContext();

  beverageService.configureBrewfatherAccount({
    userId: "user-test",
    apiKey: "key-test",
    enabled: true,
  });

  let networkCalls = 0;
  const mockFetch: typeof fetch = async () => {
    networkCalls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const coordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });

  // Trigger 3 concurrent sync calls
  const [res1, res2, res3] = await Promise.all([
    coordinator.sync(database, secretsService),
    coordinator.sync(database, secretsService),
    coordinator.sync(database, secretsService),
  ]);

  assert.strictEqual(res1, res2);
  assert.strictEqual(res2, res3);
  // 1 coalesced sync across 5 default discovery statuses = 5 fetch calls
  assert.equal(networkCalls, 5);
});

void test("BeverageService periodic and startup sync manages timers cleanly", async () => {
  const { database, secretsService } = createTestContext();
  let syncTriggered = 0;
  const mockFetch: typeof fetch = () => {
    syncTriggered += 1;
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const syncCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });
  const beverageService = createBeverageService(database, {
    secretsService,
    syncCoordinator,
  });

  beverageService.configureBrewfatherAccount({
    userId: "user-test",
    apiKey: "key-test",
    enabled: true,
  });

  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 2000,
    intervalMs = 10,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    if (!predicate()) throw new Error("Timed out waiting for predicate");
  }

  // Start periodic sync with fast test intervals
  beverageService.startPeriodicSync({ initialDelayMs: 10, intervalMs: 25 });

  // Wait for initial startup sync
  await waitFor(() => syncTriggered >= 1);
  assert.ok(syncTriggered >= 1);

  // Wait for at least one periodic tick
  const beforeTick = syncTriggered;
  await waitFor(() => syncTriggered > beforeTick);
  assert.ok(syncTriggered > beforeTick);

  // Stop periodic sync and verify no further triggers
  beverageService.stopPeriodicSync();
  const afterStop = syncTriggered;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(syncTriggered, afterStop);
});

void test("duplicate custom beverage names are allowed and all frozen beverage types are valid", () => {
  const { beverageService } = createTestContext();
  const types = [
    "beer",
    "cider",
    "mead",
    "seltzer",
    "soda",
    "water",
    "cocktail",
    "kombucha",
    "coffee",
    "other",
  ] as const;

  for (const bevType of types) {
    const bev = beverageService.createCustomBeverage({
      name: "House Special",
      beverageType: bevType,
      style: `${bevType} style`,
      abv: 5.0,
      fg: 1.01,
    });
    assert.equal(bev.effectivePresentation.name, "House Special");
    assert.equal(bev.effectivePresentation.beverageType, bevType);
  }
});

void test("different account namespaces can link the same source batch id", () => {
  const { database, beverageService } = createTestContext();

  beverageService.configureBrewfatherAccount({
    accountId: "acc-1",
    userId: "user-1",
    apiKey: "key-1",
    enabled: true,
  });

  beverageService.configureBrewfatherAccount({
    accountId: "acc-2",
    userId: "user-2",
    apiKey: "key-2",
    enabled: true,
  });

  const dummyFingerprint = "a".repeat(64);

  // Populate candidate cache for same source_batch_id under both accounts
  for (const accId of ["acc-1", "acc-2"]) {
    database
      .prepare(
        `
      INSERT INTO brewfather_candidate_cache
      (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
      VALUES (?, ?, 'shared-batch-100', 'Shared Batch', 'Fermenting', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')
    `,
      )
      .run(randomUUID(), accId, dummyFingerprint);
  }

  // Link under acc-1
  const link1 = beverageService.linkBrewfatherCandidate({
    accountId: "acc-1",
    sourceBatchId: "shared-batch-100",
  });
  assert.equal(link1.beverage.ownershipType, "brewfather");

  // Link under acc-2 (must succeed)
  const link2 = beverageService.linkBrewfatherCandidate({
    accountId: "acc-2",
    sourceBatchId: "shared-batch-100",
  });
  assert.equal(link2.beverage.ownershipType, "brewfather");
  assert.notEqual(link1.beverage.id, link2.beverage.id);
});

void test("unlink transaction rolls back completely on late-injected failure", () => {
  const { database, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    userId: "user-1",
    apiKey: "key-1",
    enabled: true,
  });

  const dummyFingerprint = "b".repeat(64);

  database
    .prepare(
      `
    INSERT INTO brewfather_candidate_cache
    (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
    VALUES (?, 'default', 'batch-fail-test', 'Rollback IPA', 'Fermenting', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')
  `,
    )
    .run(randomUUID(), dummyFingerprint);

  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-fail-test",
    overrides: { name: { value: "Overridden Name" } },
  });

  database
    .prepare(
      `INSERT INTO beverage_source_recipe_snapshots
       (id, beverage_id, account_id, source_batch_id, source_recipe_id, state, version, recipe_json, recipe_fingerprint, created_at)
       VALUES (?, ?, 'default', 'batch-fail-test', 'rec-unlink', 'linked_current', 1, '{"name":"Unlink Recipe"}', ?, '2026-08-14T00:00:00Z')`,
    )
    .run(randomUUID(), linked.beverage.id, "a".repeat(64));

  // Inject trigger failure on the final step (DELETE FROM brewfather_beverage_links)
  // proving that previous steps (insert custom_profile, update beverage, update snapshot, delete overrides/source) are all rolled back!
  database
    .prepare(
      `
    CREATE TRIGGER fail_unlink_test
    BEFORE DELETE ON brewfather_beverage_links
    BEGIN
      SELECT RAISE(ABORT, 'Injected late unlink failure');
    END;
  `,
    )
    .run();

  // Unlink must throw and rollback
  assert.throws(
    () => beverageService.unlinkBeverage(linked.beverage.id),
    /Injected late unlink failure/,
  );

  // Clean up trigger
  database.prepare("DROP TRIGGER fail_unlink_test").run();

  // Verify full rollback: ownership is still brewfather, link and override remain intact, snapshot still linked_current
  const bev = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bev.beverage.ownershipType, "brewfather");
  assert.equal(bev.brewfatherLink?.sourceBatchId, "batch-fail-test");
  assert.equal(bev.presentationOverrides?.name, "Overridden Name");
  assert.equal(bev.recipeSnapshot?.state, "linked_current");
  assert.equal(bev.customProfile, undefined);
});

void test("candidate link materializes initial source presentation directly from candidate without overrides", () => {
  const { database, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    userId: "user-initial",
    apiKey: "key-initial",
    enabled: true,
  });

  const dummyFingerprint = "f".repeat(64);
  const candidateSummary = {
    batchId: "batch-cand-init",
    batchName: "Citra Sun Hazy IPA",
    batchNumber: "42",
    beverageType: "beer",
    status: "Fermenting",
    brewer: "Alice",
    recipeName: "Citra Sun",
    style: "New England IPA",
    estimatedAbv: 6.7,
    estimatedIbu: 48,
    estimatedOg: 1.064,
    estimatedFg: 1.013,
    estimatedSrm: 4.5,
    description: "Juicy citrus aromas",
  };

  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, batch_number, status,
        brewer, recipe_name, style, estimated_og, estimated_fg, estimated_abv,
        estimated_ibu, estimated_srm, raw_summary_json, summary_fingerprint, synced_at)
       VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-14T00:00:00Z')`,
    )
    .run(
      randomUUID(),
      candidateSummary.batchId,
      candidateSummary.batchName,
      candidateSummary.batchNumber,
      candidateSummary.status,
      candidateSummary.brewer,
      candidateSummary.recipeName,
      candidateSummary.style,
      candidateSummary.estimatedOg,
      candidateSummary.estimatedFg,
      candidateSummary.estimatedAbv,
      candidateSummary.estimatedIbu,
      candidateSummary.estimatedSrm,
      JSON.stringify(candidateSummary),
      dummyFingerprint,
    );

  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-cand-init",
  });

  // Assert immediate effective presentation matches candidate data before any remote sync
  assert.equal(linked.effectivePresentation.name, "Citra Sun Hazy IPA");
  assert.equal(linked.effectivePresentation.beverageType, "beer");
  assert.equal(linked.effectivePresentation.style, "New England IPA");
  assert.equal(linked.effectivePresentation.abv, 6.7);
  assert.equal(linked.effectivePresentation.ibu, 48);
  assert.equal(linked.effectivePresentation.og, 1.064);
  assert.equal(linked.effectivePresentation.fg, 1.013);
  assert.equal(linked.effectivePresentation.description, "Juicy citrus aromas");
  assert.equal(linked.brewfatherLink?.lastSyncedAt, null); // Pending link has null lastSyncedAt
});

void test("candidate discovery distinguishes complete discovery from truncated discovery and prunes only on completion", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  const allStatuses = [
    "Planning",
    "Brewing",
    "Fermenting",
    "Conditioning",
    "Completed",
    "Archived",
  ];
  beverageService.configureBrewfatherAccount({
    accountId: "acc-discovery",
    userId: "user-disc",
    apiKey: "key-disc",
    enabled: true,
    discoveryStatuses: allStatuses,
  });

  const dummyFingerprint = "9".repeat(64);
  // Pre-populate candidate cache with cand-stale (Planning, unlinked) and cand-linked (Archived, linked)
  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
       VALUES (?, 'acc-discovery', 'cand-stale', 'Stale Batch', 'Planning', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')`,
    )
    .run(randomUUID(), dummyFingerprint);

  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
       VALUES (?, 'acc-discovery', 'cand-linked', 'Linked Batch', 'Archived', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')`,
    )
    .run(randomUUID(), dummyFingerprint);

  beverageService.linkBrewfatherCandidate({
    accountId: "acc-discovery",
    sourceBatchId: "cand-linked",
  });

  // Test 1: All 6 statuses queried in naturally bounded cycle
  const queriedStatuses: string[] = [];
  const mockAllFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    for (const st of allStatuses) {
      if (urlStr.includes(`status=${st}`)) {
        queriedStatuses.push(st);
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify([{ _id: "b-live", name: "Live Batch" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const adapter = new BrewfatherAdapter({
    userId: "user-disc",
    apiKey: "key-disc",
    fetchFn: mockAllFetch,
    maxPages: 5,
  });
  const resAll = await adapter.listBatchesByStatuses(allStatuses);
  assert.equal(resAll.complete, true);
  assert.equal(queriedStatuses.length, 6);
  assert.deepEqual(queriedStatuses, allStatuses);

  // Test 2: Incomplete discovery (hitting page cap) does NOT prune candidate cache
  const full50Batches = Array.from({ length: 50 }, (_, i) => ({ _id: `page-batch-${i + 1}` }));
  const mockTruncatedFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/cand-linked")) {
      return Promise.resolve(
        new Response(JSON.stringify({ _id: "cand-linked", name: "Linked Batch" }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(full50Batches), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const truncCoordinator = new BrewfatherSyncCoordinator({
    fetchFn: mockTruncatedFetch,
  });
  await truncCoordinator.sync(database, secretsService, { accountId: "acc-discovery" });

  // Verify: cand-stale was NOT pruned because discovery hit page cap (incomplete)
  const candidatesAfterTrunc = beverageService.listCandidates("acc-discovery");
  assert.ok(candidatesAfterTrunc.some((c) => c.sourceBatchId === "cand-stale"));
  assert.ok(candidatesAfterTrunc.some((c) => c.sourceBatchId === "cand-linked"));

  // Test 3: Complete discovery (short page < 50 items) DOES prune stale unlinked candidates
  const mockCompleteFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/cand-linked")) {
      return Promise.resolve(
        new Response(JSON.stringify({ _id: "cand-linked", name: "Linked Batch" }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify([{ _id: "b-fresh", name: "Fresh Batch" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const completeCoordinator = new BrewfatherSyncCoordinator({
    fetchFn: mockCompleteFetch,
  });
  await completeCoordinator.sync(database, secretsService, { accountId: "acc-discovery" });

  // Verify: cand-stale is now pruned, cand-linked is preserved, b-fresh is discovered
  const candidatesAfterComplete = beverageService.listCandidates("acc-discovery");
  assert.equal(
    candidatesAfterComplete.some((c) => c.sourceBatchId === "cand-stale"),
    false,
  );
  assert.ok(candidatesAfterComplete.some((c) => c.sourceBatchId === "cand-linked"));
  assert.ok(candidatesAfterComplete.some((c) => c.sourceBatchId === "b-fresh"));
});

void test("multi-status 5xx failures resolve gracefully with bounded error metadata and append Activity without throwing", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    accountId: "acc-5xx",
    userId: "user-5xx",
    apiKey: "secret-key-that-must-be-redacted",
    enabled: true,
    discoveryStatuses: [
      "Planning",
      "Brewing",
      "Fermenting",
      "Conditioning",
      "Completed",
      "Archived",
    ],
  });

  const hugeErrorMessage = `Server Error at endpoint: Basic ${Buffer.from("user-5xx:secret-key-that-must-be-redacted").toString("base64")} - ${"X".repeat(500)}`;
  const mock5xxFetch: typeof fetch = () => {
    return Promise.resolve(
      new Response(hugeErrorMessage, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );
  };

  const coordinator = new BrewfatherSyncCoordinator({ fetchFn: mock5xxFetch });
  const results = await coordinator.sync(database, secretsService, { accountId: "acc-5xx" });

  // 1. Sync resolves with an error result rather than throwing
  assert.equal(results.length, 1);
  const res = results[0]!;
  assert.ok(res.error !== undefined);
  assert.ok(Buffer.byteLength(res.error, "utf8") <= 255);
  assert.equal(res.error.includes("secret-key-that-must-be-redacted"), false);

  // 2. Activity was appended successfully without throwing
  const activities = readActivities(database);
  const syncActivity = activities.find((a) => a.entityId === "acc-5xx");
  assert.ok(syncActivity);
  const errorDetail = String(syncActivity?.details?.error ?? "");
  assert.ok(Buffer.byteLength(errorDetail, "utf8") <= 255);
  assert.equal(errorDetail.includes("secret-key-that-must-be-redacted"), false);
});

void test("brewfather link last_synced_at preserves last successful sync timestamp across error and stale transitions", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    userId: "user-sync-ts",
    apiKey: "key-sync-ts",
    enabled: true,
  });

  const dummyFingerprint = "7".repeat(64);
  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
       VALUES (?, 'default', 'batch-ts-test', 'Timestamp IPA', 'Fermenting', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')`,
    )
    .run(randomUUID(), dummyFingerprint);

  // 1. Initial link -> pending (lastSyncedAt is null)
  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-ts-test",
  });
  assert.equal(linked.brewfatherLink?.syncState, "pending");
  assert.equal(linked.brewfatherLink?.lastSyncedAt, null);

  // 2. Successful sync -> lastSyncedAt becomes T1
  const t1 = "2026-08-14T12:00:00.000Z";
  const mockSuccessFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/batch-ts-test")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ _id: "batch-ts-test", name: "Timestamp IPA", status: "Fermenting" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const coordinator = new BrewfatherSyncCoordinator({ fetchFn: mockSuccessFetch });
  await coordinator.sync(database, secretsService, { now: () => new Date(t1) });

  const bevT1 = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bevT1.brewfatherLink?.syncState, "synced");
  assert.equal(bevT1.brewfatherLink?.lastSyncedAt, t1);

  // 3. Sync failure (e.g. 500 server error) at T2 -> syncState="error", lastSyncedAt remains T1!
  const t2 = "2026-08-14T13:00:00.000Z";
  const mock500Fetch: typeof fetch = () => {
    return Promise.resolve(new Response("Internal Error", { status: 500 }));
  };
  const failCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mock500Fetch });
  await failCoordinator.sync(database, secretsService, { now: () => new Date(t2) });

  const bevT2 = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bevT2.brewfatherLink?.syncState, "error");
  assert.equal(bevT2.brewfatherLink?.lastSyncedAt, t1); // Preserved T1!

  // 4. Stale transition (404 Not Found) at T3 -> syncState="stale", lastSyncedAt remains T1!
  const t3 = "2026-08-14T14:00:00.000Z";
  const mock404Fetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/batch-ts-test")) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  const staleCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mock404Fetch });
  await staleCoordinator.sync(database, secretsService, { now: () => new Date(t3) });

  const bevT3 = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bevT3.brewfatherLink?.syncState, "stale");
  assert.equal(bevT3.brewfatherLink?.lastSyncedAt, t1); // Preserved T1!
});

void test("configureBrewfatherAccount is atomic across account metadata and secret storage", () => {
  const database = openDatabase(":memory:");
  const failingSecretsService = {
    list: () => [],
    get: () => undefined,
    revealPrivileged: () => {
      throw new Error("Secret retrieval error");
    },
    upsert: () => {
      throw new Error("Simulated secret storage failure");
    },
    delete: () => undefined,
    rotateRootKey: () => ({ reencrypted: 0, removed: 0 }),
  } as unknown as ReturnType<typeof createSecretsService>;

  const beverageService = createBeverageService(database, {
    secretsService: failingSecretsService,
  });

  assert.throws(
    () =>
      beverageService.configureBrewfatherAccount({
        accountId: "acc-atomic",
        userId: "user-atomic",
        apiKey: "secret-key",
        enabled: true,
      }),
    /Simulated secret storage failure/,
  );

  // Assert account row was rolled back and does not exist
  const status = beverageService.getBrewfatherStatus("acc-atomic");
  assert.equal(status.configured, false);
});

void test("linked-sync persistence rolls back atomically on injected failure and preserves coherent state", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    userId: "user-sync-rollback",
    apiKey: "key-sync-rollback",
    enabled: true,
  });

  const dummyFingerprint = "e".repeat(64);
  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
       VALUES (?, 'default', 'batch-atomic-test', 'Initial Batch Name', 'Fermenting', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')`,
    )
    .run(randomUUID(), dummyFingerprint);

  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-atomic-test",
  });

  // Save initial recipe snapshot version 1
  database
    .prepare(
      `INSERT INTO beverage_source_recipe_snapshots
       (id, beverage_id, account_id, source_batch_id, source_recipe_id, state, version, recipe_json, recipe_fingerprint, created_at)
       VALUES (?, ?, 'default', 'batch-atomic-test', 'rec-1', 'linked_current', 1, '{"name":"V1"}', ?, '2026-08-14T00:00:00Z')`,
    )
    .run(randomUUID(), linked.beverage.id, "b".repeat(64));

  // Mock remote sync returning updated batch (Name: "Updated Remote Name", ABV: 8.0) and new recipe V2
  const mockFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/batch-atomic-test")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "batch-atomic-test",
            name: "Updated Remote Name",
            status: "Fermenting",
            recipe: {
              _id: "rec-2",
              name: "V2 Recipe",
              abv: 8.0,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  // Inject failure on link state update AFTER source profile and snapshot write would have executed in transaction
  database
    .prepare(
      `CREATE TRIGGER fail_link_sync_update
       BEFORE UPDATE OF sync_state ON brewfather_beverage_links
       WHEN NEW.sync_state = 'synced'
       BEGIN
         SELECT RAISE(ABORT, 'Injected sync write failure');
       END;`,
    )
    .run();

  const syncCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });
  await syncCoordinator.sync(database, secretsService);

  database.prepare("DROP TRIGGER fail_link_sync_update").run();

  // Verify full rollback: old source profile, old recipe snapshot, and old link state remain coherent
  const bev = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bev.brewfatherSourceProfile?.name, "Initial Batch Name"); // Not updated to "Updated Remote Name"
  assert.equal(bev.recipeSnapshot?.version, 1); // Not superseded
  assert.equal(bev.recipeSnapshot?.state, "linked_current");
  assert.equal(bev.brewfatherLink?.syncState, "error"); // Error state recorded upon failure
});

void test("source sync updates underlying source while override remains effective, and restoring inheritance reveals updated source", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    userId: "user-sync",
    apiKey: "key-sync",
    enabled: true,
  });

  const dummyFingerprint = "c".repeat(64);

  database
    .prepare(
      `
    INSERT INTO brewfather_candidate_cache
    (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
    VALUES (?, 'default', 'batch-override-sync', 'Original Source Name', 'Fermenting', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')
  `,
    )
    .run(randomUUID(), dummyFingerprint);

  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-override-sync",
    overrides: {
      name: { value: "My Permanent Override" },
      abv: { value: 7.5 },
    },
  });

  // Mock Brewfather updated source batch
  const sourceAbv = 6.0;
  const sourceStyle = "West Coast IPA";
  const mockFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/batch-override-sync")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "batch-override-sync",
            name: "Updated Source Name",
            status: "Conditioning",
            recipe: {
              name: "Updated Recipe",
              style: { name: sourceStyle },
              abv: sourceAbv,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const syncCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });
  await syncCoordinator.sync(database, secretsService);

  // Verify: effective name and abv remain the overrides, while inherited style updated to West Coast IPA
  const afterSync = beverageService.getBeverage(linked.beverage.id);
  assert.equal(afterSync.effectivePresentation.name, "My Permanent Override"); // Override kept
  assert.equal(afterSync.effectivePresentation.abv, 7.5); // Override kept
  assert.equal(afterSync.effectivePresentation.style, "West Coast IPA"); // Inherited source updated!

  // Now restore inheritance for abv
  const reverted = beverageService.updatePresentationOverrides(linked.beverage.id, {
    abv: { inherit: true },
  });
  assert.equal(reverted.effectivePresentation.abv, 6.0); // Immediately reveals current source value!
});

void test("recipe snapshot fingerprint stability, semantic change, and payload size bounds", () => {
  const recipeA = {
    _id: "rec-1",
    name: "Recipe Alpha",
    style: { name: "IPA" },
    hops: [{ name: "Citra", amount: 50, unit: "g" }],
  };
  const recipeASame = {
    _id: "rec-1",
    name: "Recipe Alpha",
    style: { name: "IPA" },
    hops: [{ name: "Citra", amount: 50, unit: "g" }],
  };
  const recipeBChanged = {
    _id: "rec-1",
    name: "Recipe Alpha (V2)",
    style: { name: "IPA" },
    hops: [{ name: "Citra", amount: 60, unit: "g" }],
  };

  const snapA = sanitizeRecipeSnapshot(recipeA)!;
  const snapASame = sanitizeRecipeSnapshot(recipeASame)!;
  const snapB = sanitizeRecipeSnapshot(recipeBChanged)!;

  assert.equal(snapA.recipeFingerprint, snapASame.recipeFingerprint);
  assert.notEqual(snapA.recipeFingerprint, snapB.recipeFingerprint);

  // Oversized recipe test: truncated / bounded to safe limits
  const oversizedRecipe = {
    _id: "rec-huge",
    name: "Huge Recipe",
    notes: "X".repeat(50_000),
  };
  const sanitizedHuge = sanitizeRecipeSnapshot(oversizedRecipe)!;
  assert.ok(sanitizedHuge.recipeJson.length < 30_000);
});

void test("linked batch syncs outside discovery status filter and preserves last-known state on external 404", async () => {
  const { database, secretsService, beverageService } = createTestContext();
  beverageService.configureBrewfatherAccount({
    userId: "user-linked",
    apiKey: "key-linked",
    enabled: true,
    discoveryStatuses: ["Fermenting"], // Only fermenting discovered
  });

  const dummyFingerprint = "d".repeat(64);

  database
    .prepare(
      `
    INSERT INTO brewfather_candidate_cache
    (id, account_id, source_batch_id, batch_name, status, raw_summary_json, summary_fingerprint, synced_at)
    VALUES (?, 'default', 'batch-archived-99', 'Archived Batch', 'Archived', '{"beverageType":"beer"}', ?, '2026-08-14T00:00:00Z')
  `,
    )
    .run(randomUUID(), dummyFingerprint);

  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-archived-99",
  });

  // Step 1: Mock fetch returns batch with status Archived and abv 8.5
  let return404 = false;
  const mockFetch: typeof fetch = (url) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("/v2/batches/batch-archived-99")) {
      if (return404) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            _id: "batch-archived-99",
            name: "Archived Barleywine",
            status: "Archived", // Outside discovery status list!
            recipe: {
              style: { name: "English Barleywine" },
              abv: 10.5,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    // Candidate list (only Fermenting) returns empty
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const syncCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });
  await syncCoordinator.sync(database, secretsService);

  // Verify: synced successfully despite status being "Archived"
  const bevSynced = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bevSynced.brewfatherLink?.syncState, "synced");
  assert.equal(bevSynced.effectivePresentation.name, "Archived Barleywine");
  assert.equal(bevSynced.effectivePresentation.abv, 10.5);

  // Step 2: Now external source returns 404 (deleted on Brewfather)
  return404 = true;
  await syncCoordinator.sync(database, secretsService);

  // Verify: link marked stale, but source profile preserved and beverage still readable
  const bevStale = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bevStale.brewfatherLink?.syncState, "stale");
  assert.equal(bevStale.effectivePresentation.name, "Archived Barleywine");
  assert.equal(bevStale.effectivePresentation.abv, 10.5);
});

void test("multi-account partial sync failure isolates errors and candidate discovery is lazy regarding recipe fetches", async () => {
  const { database, secretsService, beverageService } = createTestContext();

  beverageService.configureBrewfatherAccount({
    accountId: "acc-good",
    userId: "user-good",
    apiKey: "good-key",
    enabled: true,
    discoveryStatuses: ["Fermenting"],
  });

  beverageService.configureBrewfatherAccount({
    accountId: "acc-bad",
    userId: "user-bad",
    apiKey: "bad-key",
    enabled: true,
    discoveryStatuses: ["Fermenting"],
  });

  let recipeCalls = 0;
  const mockFetch: typeof fetch = (url, init) => {
    const authHeader = (init?.headers as Record<string, string>)?.Authorization ?? "";
    const isGood = authHeader.includes(Buffer.from("user-good:good-key").toString("base64"));
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

    if (urlStr.includes("/v2/recipes/")) {
      recipeCalls += 1;
    }

    if (!isGood) {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    }

    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            _id: "batch-discovery-1",
            name: "Discovered Candidate Batch",
            status: "Fermenting",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const syncCoordinator = new BrewfatherSyncCoordinator({ fetchFn: mockFetch });
  const results = await syncCoordinator.sync(database, secretsService);

  assert.equal(results.length, 2);
  const goodRes = results.find((r) => r.accountId === "acc-good")!;
  const badRes = results.find((r) => r.accountId === "acc-bad")!;

  assert.equal(goodRes.error, undefined);
  assert.equal(goodRes.candidatesFound, 1);
  assert.ok(badRes.error !== undefined); // Honest error reporting

  // Lazy recipe verification: candidate discovery did NOT fetch recipe endpoints
  assert.equal(recipeCalls, 0);

  // Custom beverage operations still work completely fine despite Brewfather account failure
  const customBev = beverageService.createCustomBeverage({
    name: "Independent Stout",
    beverageType: "beer",
    style: "Stout",
    abv: 6.0,
    fg: 1.015,
  });
  assert.equal(customBev.effectivePresentation.name, "Independent Stout");
});

void test("HTTP Admin API: full lifecycle smoke test with cookie auth, CSRF, overrides, and delete validation", async (context) => {
  const database = openDatabase(":memory:");
  const canonicalOrigin = "http://127.0.0.1:3000";
  const authService = createAuthService(database, { canonicalOrigin });
  await authService.setPin("1234");
  const loginResult = await authService.authenticate("1234");
  assert.ok(loginResult.authenticated);
  const cookieHeader = `tapboard_admin_session=${loginResult.session}`;
  const csrfToken = loginResult.csrfToken!;

  const secretsService = createSecretsService(database, { rootKey: ROOT_KEY });
  const beverageService = createBeverageService(database, { secretsService });
  const router = new Router(quietLogger);
  registerBeverageRoutes({ router, beverageService, authService });

  const server = new (await import("../src/infrastructure/http/server.ts")).HttpServer({
    router,
    logger: quietLogger,
    shutdownGraceMs: 100,
  });
  context.after(async () => {
    await server.stop();
    database.close();
  });

  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // 1. Unauthenticated GET -> 401
  const unauthGet = await fetch(`${baseUrl}/api/admin/beverages`);
  assert.equal(unauthGet.status, 401);

  // 2. Bearer token rejection for Admin session -> 401 (cookie-only)
  const bearerGet = await fetch(`${baseUrl}/api/admin/beverages`, {
    headers: { authorization: `Bearer ${loginResult.session}` },
  });
  assert.equal(bearerGet.status, 401);

  // 3. Authenticated GET -> 200 empty list
  const authGet = await fetch(`${baseUrl}/api/admin/beverages`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(authGet.status, 200);
  const listBody = (await authGet.json()) as { beverages: unknown[] };
  assert.deepEqual(listBody.beverages, []);

  // 4. POST custom beverage with CSRF
  const createPost = await fetch(`${baseUrl}/api/admin/beverages`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "API Test Stout",
      beverageType: "beer",
      style: "Dry Stout",
      abv: 4.5,
      fg: 1.01,
    }),
  });
  assert.equal(createPost.status, 201);
  const createdBody = (await createPost.json()) as {
    beverage: { beverage: { id: string }; effectivePresentation: { name: string } };
  };
  const beverageId = createdBody.beverage.beverage.id;
  assert.equal(createdBody.beverage.effectivePresentation.name, "API Test Stout");

  // 5. GET /api/admin/beverages/:id
  const getDetail = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getDetail.status, 200);

  // 6. PATCH /api/admin/beverages/:id
  const patchRes = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    method: "PATCH",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "API Test Stout (Updated)",
      abv: 4.8,
    }),
  });
  assert.equal(patchRes.status, 200);
  const patchedBody = (await patchRes.json()) as {
    beverage: { effectivePresentation: { name: string; abv: number } };
  };
  assert.equal(patchedBody.beverage.effectivePresentation.name, "API Test Stout (Updated)");
  assert.equal(patchedBody.beverage.effectivePresentation.abv, 4.8);

  // 7. GET settings & PATCH settings
  const getSettings = await fetch(`${baseUrl}/api/admin/beverages/settings`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getSettings.status, 200);

  const patchSettings = await fetch(`${baseUrl}/api/admin/beverages/settings`, {
    method: "PATCH",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      fallbackFg: 1.01,
      brewfatherCompletionPolicy: "ask",
    }),
  });
  assert.equal(patchSettings.status, 200);
  const updatedSettingsBody = (await patchSettings.json()) as {
    settings: { fallbackFg: number; brewfatherCompletionPolicy: string };
  };
  assert.equal(updatedSettingsBody.settings.fallbackFg, 1.01);
  assert.equal(updatedSettingsBody.settings.brewfatherCompletionPolicy, "ask");

  // 8. GET deletion impact
  const impactRes = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}/deletion-impact`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(impactRes.status, 200);

  // 9. DELETE validation: Malformed JSON body returns 400 and DOES NOT delete
  const malformedDelete = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: "{ malformed json",
  });
  assert.equal(malformedDelete.status, 400);

  // 10. DELETE validation: Unknown fields return 400 and DO NOT delete
  const unknownFieldDelete = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ unknownField: "bad" }),
  });
  assert.equal(unknownFieldDelete.status, 400);

  // Verify beverage is still alive
  const stillAlive = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(stillAlive.status, 200);

  // 11. DELETE with valid reason body -> 200 deleted
  const deleteRes = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "API Deletion Test" }),
  });
  assert.equal(deleteRes.status, 200);

  // 12. GET after delete -> 404
  const getAfterDelete = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getAfterDelete.status, 404);

  // 13. Create second beverage and delete with EMPTY body -> 200 deleted
  const createSecond = await fetch(`${baseUrl}/api/admin/beverages`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Empty Body Delete Test",
      beverageType: "beer",
    }),
  });
  assert.equal(createSecond.status, 201);
  const secondId = ((await createSecond.json()) as { beverage: { beverage: { id: string } } })
    .beverage.beverage.id;

  const emptyDelete = await fetch(`${baseUrl}/api/admin/beverages/${secondId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: canonicalOrigin,
      "x-csrf-token": csrfToken,
    },
  });
  assert.equal(emptyDelete.status, 200);
});
