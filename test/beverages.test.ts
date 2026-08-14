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

void test("Brewfather adapter handles rate limits, errors, and backoff", async () => {
  let callCount = 0;
  const mockFetch: typeof fetch = (_url, _init) => {
    callCount += 1;
    if (callCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify([{ _id: "b1", name: "Batch 1" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (callCount === 2) {
      return Promise.resolve(
        new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "2" },
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
  });

  const page1 = await adapter.listBatches({ status: "Planning" });
  assert.equal(page1.length, 1);

  await assert.rejects(
    () => adapter.listBatches({ status: "Planning" }),
    (error: unknown) => error instanceof BrewfatherError && error.category === "rate_limited",
  );
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

  // Start periodic sync with fast test intervals
  beverageService.startPeriodicSync({ initialDelayMs: 10, intervalMs: 25 });

  // Wait for initial startup sync
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(syncTriggered >= 1);

  // Wait for at least one periodic tick
  const beforeTick = syncTriggered;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(syncTriggered > beforeTick);

  // Stop periodic sync and verify no further triggers
  beverageService.stopPeriodicSync();
  const afterStop = syncTriggered;
  await new Promise((resolve) => setTimeout(resolve, 40));
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
      VALUES (?, ?, 'shared-batch-100', 'Shared Batch', 'Fermenting', '{}', ?, '2026-08-14T00:00:00Z')
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

void test("unlink transaction rolls back completely on injected failure", () => {
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
    VALUES (?, 'default', 'batch-fail-test', 'Rollback IPA', 'Fermenting', '{}', ?, '2026-08-14T00:00:00Z')
  `,
    )
    .run(randomUUID(), dummyFingerprint);

  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-fail-test",
    overrides: { name: { value: "Overridden Name" } },
  });

  // Inject trigger failure on custom_beverage_profiles insert
  database
    .prepare(
      `
    CREATE TRIGGER fail_unlink_test
    BEFORE INSERT ON custom_beverage_profiles
    BEGIN
      SELECT RAISE(ABORT, 'Injected unlink failure');
    END;
  `,
    )
    .run();

  // Unlink must throw and rollback
  assert.throws(
    () => beverageService.unlinkBeverage(linked.beverage.id),
    /Injected unlink failure/,
  );

  // Clean up trigger
  database.prepare("DROP TRIGGER fail_unlink_test").run();

  // Verify full rollback: ownership is still brewfather, link and override remain intact
  const bev = beverageService.getBeverage(linked.beverage.id);
  assert.equal(bev.beverage.ownershipType, "brewfather");
  assert.equal(bev.brewfatherLink?.sourceBatchId, "batch-fail-test");
  assert.equal(bev.presentationOverrides?.name, "Overridden Name");
  assert.equal(bev.customProfile, undefined);
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
    VALUES (?, 'default', 'batch-override-sync', 'Original Source Name', 'Fermenting', '{}', ?, '2026-08-14T00:00:00Z')
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
    VALUES (?, 'default', 'batch-archived-99', 'Archived Batch', 'Archived', '{}', ?, '2026-08-14T00:00:00Z')
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

void test("HTTP Admin API: full lifecycle smoke test with cookie auth, CSRF, overrides, and delete", async (context) => {
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

  // 9. DELETE beverage
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

  // 10. GET after delete -> 404
  const getAfterDelete = await fetch(`${baseUrl}/api/admin/beverages/${beverageId}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getAfterDelete.status, 404);
});
