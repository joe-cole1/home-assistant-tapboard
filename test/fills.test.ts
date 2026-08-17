import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { BrewfatherSyncCoordinator } from "../src/features/beverages/brewfather/sync.ts";
import {
  createFillService,
  deriveFillState,
  type FillAssignmentLifecyclePort,
  FillService,
  registerFillRoutes,
  validateFillDate,
} from "../src/features/fills/index.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import type { DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { createLogger } from "../src/shared/logging.ts";
import { listActivity, listDeletionAudits } from "../src/features/activity/repository.ts";

const CANONICAL_ORIGIN = "http://127.0.0.1:3000";
const quietLogger = createLogger({ sink: () => undefined });
const ROOT_KEY = Buffer.alloc(32, 1).toString("base64url");

function fixedUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function setupTestEnvironment() {
  const database = openDatabase(":memory:");
  const secretsService = createSecretsService(database, {
    rootKey: ROOT_KEY,
  });
  const authService = createAuthService(database, {
    canonicalOrigin: CANONICAL_ORIGIN,
  });
  const kegService = createKegService(database);
  const beverageService = createBeverageService(database, { secretsService });
  const fillService = createFillService(database, { beverageService });

  return { database, secretsService, authService, kegService, beverageService, fillService };
}

void test("deriveFillState implements exact precedence: ended > on_tap > on_deck > available", () => {
  // Ended takes precedence over everything
  assert.equal(
    deriveFillState({
      endedAt: "2026-08-14T12:00:00.000Z",
      hasActiveAssignment: true,
      onDeckOrder: 1,
    }),
    "ended",
  );
  assert.equal(
    deriveFillState({
      endedAt: "2026-08-14T12:00:00.000Z",
      hasActiveAssignment: false,
      onDeckOrder: 2,
    }),
    "ended",
  );
  assert.equal(
    deriveFillState({
      endedAt: "2026-08-14T12:00:00.000Z",
      hasActiveAssignment: false,
      onDeckOrder: null,
    }),
    "ended",
  );

  // On Tap takes precedence over On Deck and Available when not ended
  assert.equal(
    deriveFillState({ endedAt: null, hasActiveAssignment: true, onDeckOrder: 1 }),
    "on_tap",
  );
  assert.equal(
    deriveFillState({ endedAt: null, hasActiveAssignment: true, onDeckOrder: null }),
    "on_tap",
  );

  // On Deck when not ended and not on tap, with valid order >= 1
  assert.equal(
    deriveFillState({ endedAt: null, hasActiveAssignment: false, onDeckOrder: 1 }),
    "on_deck",
  );
  assert.equal(
    deriveFillState({ endedAt: null, hasActiveAssignment: false, onDeckOrder: 5 }),
    "on_deck",
  );

  // Available when not ended, not on tap, and no on deck order
  assert.equal(
    deriveFillState({ endedAt: null, hasActiveAssignment: false, onDeckOrder: null }),
    "available",
  );
  assert.equal(
    deriveFillState({ endedAt: null, hasActiveAssignment: false, onDeckOrder: 0 }),
    "available",
  );
});

void test("validateFillDate validates exact YYYY-MM-DD calendar dates", () => {
  assert.equal(validateFillDate("2026-08-14"), "2026-08-14");
  assert.equal(validateFillDate("2024-02-29"), "2024-02-29"); // Leap year

  // Invalid calendar dates
  assert.throws(
    () => validateFillDate("2026-02-29"),
    (err: ApplicationError) =>
      err.code === "validation.invalid_value" &&
      err.details?.reason === "must be a valid calendar date",
  );
  assert.throws(
    () => validateFillDate("2026-04-31"),
    (err: ApplicationError) =>
      err.code === "validation.invalid_value" &&
      err.details?.reason === "must be a valid calendar date",
  );
  assert.throws(
    () => validateFillDate("2026-13-01"),
    (err: ApplicationError) =>
      err.code === "validation.invalid_value" &&
      err.details?.reason === "must be a valid calendar date",
  );
  assert.throws(
    () => validateFillDate("invalid-date"),
    (err: ApplicationError) =>
      err.code === "validation.invalid_value" &&
      err.details?.reason === "must be a valid date in YYYY-MM-DD format",
  );
  assert.throws(
    () => validateFillDate("2026/08/14"),
    (err: ApplicationError) =>
      err.code === "validation.invalid_value" &&
      err.details?.reason === "must be a valid date in YYYY-MM-DD format",
  );
  assert.throws(
    () => validateFillDate(123),
    (err: ApplicationError) =>
      err.code === "validation.invalid_value" &&
      err.details?.reason === "must be a string in YYYY-MM-DD format",
  );
});

void test("createFill validates inputs, active keg constraints, and default dates", () => {
  const { database, kegService, beverageService, fillService } = setupTestEnvironment();
  try {
    const keg = kegService.createKeg({
      kegNumber: 1,
      capacityMl: 19000,
      currentTareG: 4200,
      isActive: true,
    });
    const inactiveKeg = kegService.createKeg({
      kegNumber: 2,
      capacityMl: 19000,
      currentTareG: 4200,
      isActive: false,
    });
    const beverage = beverageService.createCustomBeverage({
      name: "Hazy IPA",
      beverageType: "beer",
      style: "NEIPA",
      abv: 6.5,
    });

    // Missing beverage -> 404
    assert.throws(
      () =>
        fillService.createFill({
          beverageId: "00000000-0000-4000-8000-000000000000",
          kegId: keg.id,
        }),
      (err: ApplicationError) => err.code === "beverage.not_found",
    );

    // Missing keg -> 404
    assert.throws(
      () =>
        fillService.createFill({
          beverageId: beverage.beverage.id,
          kegId: "00000000-0000-4000-8000-000000000000",
        }),
      (err: ApplicationError) => err.code === "keg.not_found",
    );

    // Inactive keg -> 409 conflict
    assert.throws(
      () => fillService.createFill({ beverageId: beverage.beverage.id, kegId: inactiveKeg.id }),
      (err: ApplicationError) => err.code === "fill.keg_inactive",
    );

    // Success create with explicit date
    const fill1 = fillService.createFill({
      beverageId: beverage.beverage.id,
      kegId: keg.id,
      fillDate: "2026-08-10",
    });
    assert.equal(fill1.beverageId, beverage.beverage.id);
    assert.equal(fill1.kegId, keg.id);
    assert.equal(fill1.fillDate, "2026-08-10");
    assert.equal(fill1.state, "available");
    assert.equal(fill1.beverageName, "Hazy IPA");
    assert.equal(fill1.kegNumber, 1);

    // Cannot create another fill on occupied active keg -> 409
    assert.throws(
      () => fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id }),
      (err: ApplicationError) => err.code === "fill.keg_occupied",
    );
  } finally {
    database.close();
  }
});

void test("On Deck lifecycle: markOnDeck, removeFromOnDeck, reorderOnDeck", () => {
  const { database, kegService, beverageService, fillService } = setupTestEnvironment();
  try {
    const keg1 = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
    const keg2 = kegService.createKeg({ kegNumber: 2, capacityMl: 19000 });
    const keg3 = kegService.createKeg({ kegNumber: 3, capacityMl: 19000 });
    const bev1 = beverageService.createCustomBeverage({
      name: "Stout",
      beverageType: "beer",
      style: "Dry Stout",
    });
    const bev2 = beverageService.createCustomBeverage({
      name: "Pilsner",
      beverageType: "beer",
      style: "German Pils",
    });
    const bev3 = beverageService.createCustomBeverage({ name: "Cider", beverageType: "cider" });

    const fill1 = fillService.createFill({ beverageId: bev1.beverage.id, kegId: keg1.id });
    const fill2 = fillService.createFill({ beverageId: bev2.beverage.id, kegId: keg2.id });
    const fill3 = fillService.createFill({ beverageId: bev3.beverage.id, kegId: keg3.id });

    // Mark fill 1 on deck -> order 1
    const onDeck1 = fillService.markOnDeck(fill1.id);
    assert.equal(onDeck1.state, "on_deck");
    assert.equal(onDeck1.onDeckOrder, 1);

    // Mark fill 2 on deck -> order 2
    const onDeck2 = fillService.markOnDeck(fill2.id);
    assert.equal(onDeck2.state, "on_deck");
    assert.equal(onDeck2.onDeckOrder, 2);

    // Mark fill 3 on deck -> order 3
    const onDeck3 = fillService.markOnDeck(fill3.id);
    assert.equal(onDeck3.state, "on_deck");
    assert.equal(onDeck3.onDeckOrder, 3);

    // Idempotent mark on deck
    const onDeck1Again = fillService.markOnDeck(fill1.id);
    assert.equal(onDeck1Again.onDeckOrder, 1);

    // Public On Deck projection
    const publicItems = fillService.getPublicOnDeck();
    assert.equal(publicItems.length, 3);
    assert.equal(publicItems[0]!.name, "Stout");
    assert.equal(publicItems[0]!.order, 1);
    assert.equal(publicItems[1]!.name, "Pilsner");
    assert.equal(publicItems[1]!.order, 2);
    assert.equal(publicItems[2]!.name, "Cider");
    assert.equal(publicItems[2]!.order, 3);

    // Update beverage presentation dynamically (#34)
    beverageService.updateCustomBeverage(bev1.beverage.id, {
      name: "Imperial Oatmeal Stout",
      style: "Imperial Stout",
    });

    // Public On Deck projection dynamically resolves the new presentation immediately
    const publicAfterUpdate = fillService.getPublicOnDeck();
    const updatedFill1Public = publicAfterUpdate.find((item) => item.fillId === fill1.id);
    assert.equal(updatedFill1Public?.name, "Imperial Oatmeal Stout");
    assert.equal(updatedFill1Public?.style, "Imperial Stout");

    // Reorder: 3, 1, 2
    const reordered = fillService.reorderOnDeck({ fillIds: [fill3.id, fill1.id, fill2.id] });
    assert.equal(reordered[0]!.id, fill3.id);
    assert.equal(reordered[0]!.onDeckOrder, 1);
    assert.equal(reordered[1]!.id, fill1.id);
    assert.equal(reordered[1]!.onDeckOrder, 2);
    assert.equal(reordered[2]!.id, fill2.id);
    assert.equal(reordered[2]!.onDeckOrder, 3);

    // Invalid reorder (incomplete list) -> 400 validation error
    assert.throws(
      () => fillService.reorderOnDeck({ fillIds: [fill3.id, fill1.id] }),
      (err: ApplicationError) => err.code === "validation.invalid_value",
    );

    // Invalid reorder (contains un-on-deck or duplicate) -> 400
    assert.throws(
      () => fillService.reorderOnDeck({ fillIds: [fill3.id, fill1.id, fill1.id] }),
      (err: ApplicationError) => err.code === "validation.invalid_value",
    );

    // Remove fill 1 from on deck
    const removed1 = fillService.removeFromOnDeck(fill1.id);
    assert.equal(removed1.state, "available");
    assert.equal(removed1.onDeckOrder, null);

    // Idempotent remove from on deck
    const removed1Again = fillService.removeFromOnDeck(fill1.id);
    assert.equal(removed1Again.state, "available");
  } finally {
    database.close();
  }
});

void test("Kick fill closes assignment in port, clears on deck, transitions to ended, and rolls back on port error", async () => {
  const { database, kegService, beverageService } = setupTestEnvironment();
  try {
    let portCloseCalled = false;
    let shouldFailPort = false;

    const mockPort: FillAssignmentLifecyclePort = {
      hasActiveAssignment: () => false,
      closeForFillEnd: (_db: DatabaseExecutor, _fillId: string, _endedAt: string) => {
        portCloseCalled = true;
        if (shouldFailPort) {
          throw new Error("Port close failed intentionally");
        }
      },
    };

    const fillService = new FillService(database, { beverageService, assignmentPort: mockPort });

    const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
    const bev = beverageService.createCustomBeverage({ name: "Pale Ale", beverageType: "beer" });

    const fill = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });
    fillService.markOnDeck(fill.id);

    // Test port failure causes rollback
    shouldFailPort = true;
    await assert.rejects(
      async () => fillService.kickFill(fill.id, { reason: "test fail" }),
      /Port close failed intentionally/,
    );

    // Verify fill is still active and on deck
    const unchangedFill = fillService.getFill(fill.id);
    assert.equal(unchangedFill.state, "on_deck");
    assert.equal(unchangedFill.endedAt, null);

    // Now test successful kick
    shouldFailPort = false;
    portCloseCalled = false;

    const kickResult = await fillService.kickFill(fill.id, { reason: "kicked dry" });
    assert.equal(portCloseCalled, true);
    assert.equal(kickResult.fill.state, "ended");
    assert.equal(kickResult.fill.endReason, "kicked dry");
    assert.notEqual(kickResult.fill.endedAt, null);
    assert.equal(kickResult.fill.onDeckOrder, null);
    assert.equal(kickResult.brewfatherOutcome, "not_applicable"); // Not a Brewfather beverage

    // Kicking already ended fill -> 409 conflict
    await assert.rejects(
      async () => fillService.kickFill(fill.id),
      (err: ApplicationError) => err.code === "fill.already_ended",
    );
  } finally {
    database.close();
  }
});

void test("Brewfather completion coordination: never, ask, completed, and error handling", async () => {
  const { database, kegService, beverageService, secretsService } = setupTestEnvironment();
  try {
    const patchLog: { call: { batchId: string; status: string } | null } = { call: null };
    const getLog: { calledWith: string | null } = { calledWith: null };
    let mockBatchStatus = "Fermenting";

    const customFetch: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v2/batches/batch-123") && init?.method === "GET") {
        getLog.calledWith = "batch-123";
        return new Response(
          JSON.stringify({ _id: "batch-123", name: "BF Batch", status: mockBatchStatus }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/v2/batches/batch-123") && init?.method === "PATCH") {
        const bodyStr = typeof init.body === "string" ? init.body : "";
        const body = JSON.parse(bodyStr) as { status: string };
        patchLog.call = { batchId: "batch-123", status: body.status };
        // Brewfather API legitimately returns plain text "Updated"
        return new Response("Updated", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const fillService = new FillService(database, {
      beverageService,
      fetchFn: customFetch,
    });

    // Configure Brewfather account and secret
    beverageService.configureBrewfatherAccount({
      accountId: "default",
      userId: "bf-user-1",
      apiKey: "bf-api-key-secret-123",
      enabled: true,
    });

    // Seed candidate and link beverage
    database.execute(`
      INSERT INTO brewfather_candidate_cache (
        id, account_id, source_batch_id, batch_name, batch_number, status, brewer,
        recipe_name, style, brew_date, estimated_og, estimated_fg, estimated_abv,
        estimated_ibu, estimated_srm, raw_summary_json, summary_fingerprint, synced_at
      ) VALUES (
        'c1111111-1111-4111-8111-111111111111', 'default', 'batch-123', 'BF Batch', '1', 'Fermenting', 'Brewer',
        'BF Recipe', 'IPA', '2026-08-01', 1.050, 1.010, 5.2, 40, 6, '{}', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-08-14T00:00:00.000Z'
      );
    `);

    const linkedBev = beverageService.linkBrewfatherCandidate({
      accountId: "default",
      sourceBatchId: "batch-123",
    });

    const keg1 = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
    const keg2 = kegService.createKeg({ kegNumber: 2, capacityMl: 19000 });

    // Test 1: Beverage has multiple active fills -> kicking first active fill is not_applicable
    const fill1 = fillService.createFill({ beverageId: linkedBev.beverage.id, kegId: keg1.id });
    const fill2 = fillService.createFill({ beverageId: linkedBev.beverage.id, kegId: keg2.id });

    // Set policy to completed
    beverageService.updateSettings({ brewfatherCompletionPolicy: "completed" });

    const kick1 = await fillService.kickFill(fill1.id);
    assert.equal(kick1.brewfatherOutcome, "not_applicable"); // Still had another active fill (fill2)
    assert.equal(patchLog.call, null);

    // Test 2: Policy is "never" -> not_requested
    beverageService.updateSettings({ brewfatherCompletionPolicy: "never" });
    const kickNever = await fillService.kickFill(fill2.id);
    assert.equal(kickNever.brewfatherOutcome, "not_requested");
    assert.equal(patchLog.call, null);

    // Test 3: Policy is "ask" -> confirmation_required
    const fill3 = fillService.createFill({ beverageId: linkedBev.beverage.id, kegId: keg1.id });
    beverageService.updateSettings({ brewfatherCompletionPolicy: "ask" });
    const kickAsk = await fillService.kickFill(fill3.id);
    assert.equal(kickAsk.brewfatherOutcome, "confirmation_required");
    assert.equal(patchLog.call, null);

    // Now call manual completion endpoint for fill3
    const manualComplete = await fillService.completeBrewfatherBatch(fill3.id, {
      fetchFn: customFetch,
    });
    assert.equal(manualComplete.outcome, "completed");
    assert.equal(getLog.calledWith, "batch-123");
    const patchResult = patchLog.call as { batchId: string; status: string } | null;
    assert.equal(patchResult?.batchId, "batch-123");
    assert.equal(patchResult?.status, "Completed");

    // Test 4: Already terminal status (Completed/Archived) returns already_terminal without error
    patchLog.call = null;
    mockBatchStatus = "Completed";
    const fill4 = fillService.createFill({ beverageId: linkedBev.beverage.id, kegId: keg1.id });
    beverageService.updateSettings({ brewfatherCompletionPolicy: "completed" });
    const kickTerminal = await fillService.kickFill(fill4.id);
    assert.equal(kickTerminal.brewfatherOutcome, "already_terminal");
    assert.equal(patchLog.call, null); // Did not issue unnecessary PATCH

    // Test 4a: GET batch returns HTTP 200 plain text -> completion fails safely, ZERO PATCH
    let plainTextPatchEmitted = false;
    const plainTextGetFetch: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v2/batches/batch-123") && init?.method === "GET") {
        return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.includes("/v2/batches/batch-123") && init?.method === "PATCH") {
        plainTextPatchEmitted = true;
        return new Response("Updated", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };
    const fillPlainText = fillService.createFill({
      beverageId: linkedBev.beverage.id,
      kegId: keg1.id,
    });
    const kickPlainText = await fillService.kickFill(
      fillPlainText.id,
      {},
      { fetchFn: plainTextGetFetch },
    );
    assert.equal(kickPlainText.brewfatherOutcome, "failed");
    assert.equal(plainTextPatchEmitted, false);

    // Test 4b: GET batch returns HTTP 200 malformed JSON -> completion fails safely, ZERO PATCH
    let malformedPatchEmitted = false;
    const malformedGetFetch: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v2/batches/batch-123") && init?.method === "GET") {
        return new Response("{not-valid-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v2/batches/batch-123") && init?.method === "PATCH") {
        malformedPatchEmitted = true;
        return new Response("Updated", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };
    const fillMalformed = fillService.createFill({
      beverageId: linkedBev.beverage.id,
      kegId: keg1.id,
    });
    const kickMalformed = await fillService.kickFill(
      fillMalformed.id,
      {},
      { fetchFn: malformedGetFetch },
    );
    assert.equal(kickMalformed.brewfatherOutcome, "failed");
    assert.equal(malformedPatchEmitted, false);

    // Test 4c: GET batch returns JSON with unknown / missing status -> completion fails safely, ZERO PATCH
    let unknownStatusPatchEmitted = false;
    const unknownStatusGetFetch: typeof fetch = async (input, init) => {
      await Promise.resolve();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v2/batches/batch-123") && init?.method === "GET") {
        return new Response(JSON.stringify({ _id: "batch-123", status: "InvalidStatusXYZ" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/v2/batches/batch-123") && init?.method === "PATCH") {
        unknownStatusPatchEmitted = true;
        return new Response("Updated", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };
    const fillUnknownStatus = fillService.createFill({
      beverageId: linkedBev.beverage.id,
      kegId: keg1.id,
    });
    const kickUnknownStatus = await fillService.kickFill(
      fillUnknownStatus.id,
      {},
      { fetchFn: unknownStatusGetFetch },
    );
    assert.equal(kickUnknownStatus.brewfatherOutcome, "failed");
    assert.equal(unknownStatusPatchEmitted, false);

    // Test 5: 429 Backoff sharing: normal Brewfather operation encounters 429 -> completion fails locally without network call
    let networkCalls = 0;
    let return429 = true;
    const rateLimitedFetch: typeof fetch = async () => {
      await Promise.resolve();
      networkCalls++;
      if (return429) {
        return new Response(JSON.stringify({ message: "Too many requests" }), {
          status: 429,
          headers: { "retry-after": "60", "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ _id: "batch-123", status: "Fermenting" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const rateLimitedFillService = new FillService(database, {
      beverageService,
      fetchFn: rateLimitedFetch,
    });

    const fill5 = rateLimitedFillService.createFill({
      beverageId: linkedBev.beverage.id,
      kegId: keg1.id,
    });
    beverageService.updateSettings({ brewfatherCompletionPolicy: "completed" });

    // Initial kick triggers Brewfather call which receives 429
    const kick429 = await rateLimitedFillService.kickFill(fill5.id);
    assert.equal(kick429.brewfatherOutcome, "failed");
    assert.match(kick429.brewfatherMessage ?? "", /rate limit/i);
    const networkCallsAfterFirst = networkCalls;
    assert.equal(networkCallsAfterFirst > 0, true);

    // Second call while still in backoff:
    // Even if upstream is now ready, local cached adapter backoff blocks request before fetch
    return429 = false;
    const fill6 = rateLimitedFillService.createFill({
      beverageId: linkedBev.beverage.id,
      kegId: keg1.id,
    });
    const kickWhileBlocked = await rateLimitedFillService.kickFill(fill6.id);
    assert.equal(kickWhileBlocked.brewfatherOutcome, "failed");
    assert.match(kickWhileBlocked.brewfatherMessage ?? "", /rate limit/i);
    // Verified: zero extra network requests emitted
    assert.equal(networkCalls, networkCallsAfterFirst);

    // Test 6: Shared Request Budget: consuming account budget via coordinator/adapter causes completion to reject locally without extra network calls
    let budgetNetworkCalls = 0;
    const budgetFetch: typeof fetch = async () => {
      await Promise.resolve();
      budgetNetworkCalls++;
      return new Response(JSON.stringify({ _id: "batch-123", status: "Fermenting" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const budgetCoordinator = new BrewfatherSyncCoordinator({ fetchFn: budgetFetch });
    const budgetBeverageService = createBeverageService(database, {
      secretsService,
      syncCoordinator: budgetCoordinator,
    });
    const budgetFillService = new FillService(database, {
      beverageService: budgetBeverageService,
      fetchFn: budgetFetch,
    });

    budgetBeverageService.updateSettings({ brewfatherCompletionPolicy: "completed" });

    // Exhaust default budget (100 requests / 50 kick completions)
    for (let i = 0; i < 50; i++) {
      const f = budgetFillService.createFill({
        beverageId: linkedBev.beverage.id,
        kegId: keg1.id,
      });
      await budgetFillService.kickFill(f.id);
    }
    assert.equal(budgetNetworkCalls, 100);

    // 51st completion attempt: budget is exhausted for the account
    const fExhausted = budgetFillService.createFill({
      beverageId: linkedBev.beverage.id,
      kegId: keg1.id,
    });
    const kickExhausted = await budgetFillService.kickFill(fExhausted.id);
    assert.equal(kickExhausted.brewfatherOutcome, "failed");
    assert.match(kickExhausted.brewfatherMessage ?? "", /rate limit|budget/i);
    // Verified: zero extra network requests emitted
    assert.equal(budgetNetworkCalls, 100);
  } finally {
    database.close();
  }
});

void test("Fill deletion impact and isolated beverage auto-deletion", () => {
  const { database, kegService, beverageService, fillService } = setupTestEnvironment();
  try {
    const keg1 = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
    const keg2 = kegService.createKeg({ kegNumber: 2, capacityMl: 19000 });
    const bev = beverageService.createCustomBeverage({ name: "Blonde Ale", beverageType: "beer" });

    const fill1 = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg1.id });
    const fill2 = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg2.id });

    // HTTP/Admin-facing Beverage deletion remains confirmation-bound even
    // when the last-Fill lifecycle cascade is authorized separately.
    assert.throws(
      () => beverageService.deleteBeverage(bev.beverage.id),
      (err: ApplicationError) => err.code === "beverage.delete_confirmation_required",
    );

    // Case 1: Default setting (autoDeleteBeverageOnLastFill = false)
    assert.equal(fillService.getSettings().autoDeleteBeverageOnLastFill, false);

    const impact1 = fillService.getDeletionImpact(fill1.id);
    assert.equal(impact1.isLastFillForBeverage, false);
    assert.equal(impact1.beverageAutoDeleted, false);

    assert.throws(
      () => fillService.deleteFill(fill1.id, { confirmation: "Wrong visible label" }),
      (err: ApplicationError) => err.code === "fill.confirmation_mismatch",
    );

    // Delete fill1
    fillService.deleteFill(fill1.id, {
      reason: "cleanup",
      confirmation: "Blonde Ale — Keg 1",
    });
    assert.equal(fillService.listFills().length, 1);
    assert.notEqual(beverageService.getBeverage(bev.beverage.id), undefined);

    // Deletion impact on last fill when setting is false
    const impact2 = fillService.getDeletionImpact(fill2.id);
    assert.equal(impact2.isLastFillForBeverage, true);
    assert.equal(impact2.beverageAutoDeleted, false);

    assert.throws(
      () => fillService.deleteFill(fill2.id),
      (err: ApplicationError) => err.code === "fill.confirmation_required",
    );
    assert.throws(
      () => fillService.deleteFill(fill2.id, { confirmation: "" }),
      (err: ApplicationError) => err.code === "fill.confirmation_required",
    );

    // Turn setting ON
    fillService.updateSettings({ autoDeleteBeverageOnLastFill: true });
    assert.equal(fillService.getSettings().autoDeleteBeverageOnLastFill, true);

    const impact3 = fillService.getDeletionImpact(fill2.id);
    assert.equal(impact3.isLastFillForBeverage, true);
    assert.equal(impact3.beverageAutoDeleted, true);
    assert.deepEqual(impact3.impacts, [
      { code: "fills", count: 1 },
      { code: "beverages", count: 1 },
    ]);

    // Delete last fill -> beverage is auto-deleted atomically with one audit
    // and one activity record inside the same transaction.
    const auditsBeforeAutoDelete = listDeletionAudits(database);
    const activityBeforeAutoDelete = listActivity(database);
    fillService.deleteFill(fill2.id, {
      reason: "final delete",
      confirmation: "Blonde Ale — Keg 2",
    });
    assert.equal(fillService.listFills().length, 0);
    const beverageAudits = listDeletionAudits(database).filter(
      (audit) => audit.entityType === "beverage" && audit.entityId === bev.beverage.id,
    );
    const beverageDeletionActivities = listActivity(database).filter(
      (activity) =>
        activity.entityType === "beverage" &&
        activity.entityId === bev.beverage.id &&
        activity.action === "deletion",
    );
    assert.equal(listDeletionAudits(database).length, auditsBeforeAutoDelete.length + 2);
    assert.equal(listActivity(database).length, activityBeforeAutoDelete.length + 2);
    assert.equal(beverageAudits.length, 1);
    assert.equal(beverageDeletionActivities.length, 1);
    assert.throws(
      () => beverageService.getBeverage(bev.beverage.id),
      (err: ApplicationError) => err.code === "beverage.not_found",
    );

    // Injected rollback test: autoDeleteBeverageOnLastFill = true, failure during beverage deletion rolls back everything
    const kegRollback = kegService.createKeg({ kegNumber: 99, capacityMl: 19000 });
    const bevRollback = beverageService.createCustomBeverage({
      name: "Rollback Beer",
      beverageType: "beer",
    });
    const fillRollback = fillService.createFill({
      beverageId: bevRollback.beverage.id,
      kegId: kegRollback.id,
    });

    const auditsBefore = listDeletionAudits(database);
    const activityBefore = listActivity(database);

    // Injected trigger on beverage delete to cause mid-transaction failure
    database.execute(
      "CREATE TRIGGER fail_bev_delete BEFORE DELETE ON beverages BEGIN SELECT RAISE(FAIL, 'injected beverage delete failure'); END;",
    );

    try {
      assert.throws(
        () =>
          fillService.deleteFill(fillRollback.id, {
            reason: "test fail",
            confirmation: "Rollback Beer — Keg 99",
          }),
        (err: Error) => err.message.includes("injected beverage delete failure"),
      );

      // Verify complete rollback:
      // 1. Fill is still present
      const fills = fillService.listFills();
      assert.equal(
        fills.some((f) => f.id === fillRollback.id),
        true,
      );
      // 2. Beverage is still present
      assert.notEqual(beverageService.getBeverage(bevRollback.beverage.id), undefined);
      // 3. Keg is still present
      assert.notEqual(kegService.getKeg(kegRollback.id), undefined);
      // 4. No Fill deletion audit or Beverage deletion audit committed
      const auditsAfter = listDeletionAudits(database);
      assert.equal(auditsAfter.length, auditsBefore.length);
      // 5. No false deletion Activity committed
      const activityAfter = listActivity(database);
      assert.equal(activityAfter.length, activityBefore.length);
    } finally {
      database.execute("DROP TRIGGER IF EXISTS fail_bev_delete;");
    }
  } finally {
    database.close();
  }
});

void test("admin Fill pages use bounded SQL search, filters, and deterministic 25-row windows", () => {
  const { database, kegService, beverageService, fillService } = setupTestEnvironment();
  try {
    const specialBeverage = beverageService.createCustomBeverage({
      id: fixedUuid(1),
      name: "Percent%_ Lager",
      beverageType: "beer",
    });
    const plainBeverage = beverageService.createCustomBeverage({
      id: fixedUuid(2),
      name: "Plain Lager",
      beverageType: "beer",
    });

    for (let index = 1; index <= 27; index += 1) {
      const keg = kegService.createKeg({
        id: fixedUuid(100 + index),
        kegNumber: index,
        capacityMl: 19_000,
      });
      fillService.createFill({
        id: fixedUuid(200 + index),
        beverageId: index === 27 ? plainBeverage.beverage.id : specialBeverage.beverage.id,
        kegId: keg.id,
        fillDate: "2026-08-14",
      });
    }

    const firstPage = fillService.listAdminPage({ state: "active", sort: "keg", page: 1 });
    assert.equal(firstPage.total, 27);
    assert.equal(firstPage.pageSize, 25);
    assert.equal(firstPage.pageCount, 2);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.items.length, 25);
    assert.equal(firstPage.items[0]?.kegNumber, 1);
    assert.equal(firstPage.items[24]?.kegNumber, 25);

    const secondPage = fillService.listAdminPage({ state: "active", sort: "keg", page: 2 });
    assert.equal(secondPage.items.length, 2);
    assert.deepEqual(
      secondPage.items.map((item) => item.kegNumber),
      [26, 27],
    );

    // Wildcards are literal operator search text, not unbounded LIKE syntax.
    const escapedSearch = fillService.listAdminPage({ q: "%_", state: "active", sort: "keg" });
    assert.equal(escapedSearch.total, 26);
    assert.equal(
      escapedSearch.items.every((item) => item.beverageName === "Percent%_ Lager"),
      true,
    );

    fillService.markOnDeck(fixedUuid(201));
    const onDeck = fillService.listAdminPage({ state: "on_deck", sort: "state" });
    assert.equal(onDeck.total, 1);
    assert.equal(onDeck.items[0]?.id, fixedUuid(201));
  } finally {
    database.close();
  }
});

void test("Keg deletion impact includes fills count", async () => {
  const { database, kegService, beverageService, fillService } = setupTestEnvironment();
  try {
    const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
    const bev = beverageService.createCustomBeverage({ name: "Kolsch", beverageType: "beer" });

    const fill1 = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });
    await fillService.kickFill(fill1.id);
    const fill2 = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });
    assert.notEqual(fill2.id, null);

    const impact = kegService.getDeletionImpact(keg.id);
    assert.equal(impact?.fills, 2);
    const fillImpactEntry = impact?.impacts.find((i) => i.code === "fills");
    assert.equal(fillImpactEntry?.count, 2);

    // Beverage deletion impact includes fills count
    const bevImpact = beverageService.getDeletionImpact(bev.beverage.id);
    const bevFillImpactEntry = bevImpact.impacts.find((i) => i.code === "fills");
    assert.equal(bevFillImpactEntry?.count, 2);
  } finally {
    database.close();
  }
});

void test("HTTP Admin API: fills and on deck full lifecycle smoke test with auth, CSRF, and unknown field rejection", async (context) => {
  const { database, authService, kegService, beverageService, fillService } =
    setupTestEnvironment();
  await authService.setPin("1234");
  const loginResult = await authService.authenticate("1234");
  assert.ok(loginResult.authenticated);
  const cookieHeader = `tapboard_admin_session=${loginResult.session}`;
  const csrfToken = loginResult.csrfToken!;

  const router = new Router(quietLogger);
  registerFillRoutes({ router, fillService, authService });

  const server = new HttpServer({
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

  const keg1 = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const keg2 = kegService.createKeg({ kegNumber: 2, capacityMl: 19000 });
  const bev1 = beverageService.createCustomBeverage({ name: "Helles", beverageType: "beer" });
  const bev2 = beverageService.createCustomBeverage({ name: "Stout", beverageType: "beer" });

  // 1. Unauthenticated GET /api/admin/fills -> 401
  const unauthGet = await fetch(`${baseUrl}/api/admin/fills`);
  assert.equal(unauthGet.status, 401);

  // 2. Authenticated GET /api/admin/fills -> 200, empty
  const authGet = await fetch(`${baseUrl}/api/admin/fills`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(authGet.status, 200);
  const emptyList = (await authGet.json()) as { fills: unknown[] };
  assert.deepEqual(emptyList.fills, []);

  // 3. POST /api/admin/fills with unknown field -> 400
  const unknownFieldPost = await fetch(`${baseUrl}/api/admin/fills`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      beverageId: bev1.beverage.id,
      kegId: keg1.id,
      extraField: "illegal",
    }),
  });
  assert.equal(unknownFieldPost.status, 400);

  // 4. Valid POST /api/admin/fills -> 201
  const createRes1 = await fetch(`${baseUrl}/api/admin/fills`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      beverageId: bev1.beverage.id,
      kegId: keg1.id,
    }),
  });
  assert.equal(createRes1.status, 201);
  const fill1 = (await createRes1.json()) as { fill: { id: string; state: string } };
  assert.equal(fill1.fill.state, "available");

  const createRes2 = await fetch(`${baseUrl}/api/admin/fills`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      beverageId: bev2.beverage.id,
      kegId: keg2.id,
    }),
  });
  assert.equal(createRes2.status, 201);
  const fill2 = (await createRes2.json()) as { fill: { id: string; state: string } };

  // 5. Mark on deck -> POST /api/admin/fills/:id/on-deck
  const markDeckRes = await fetch(`${baseUrl}/api/admin/fills/${fill1.fill.id}/on-deck`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
    },
  });
  assert.equal(markDeckRes.status, 200);
  const markedDeck = (await markDeckRes.json()) as { fill: { state: string; onDeckOrder: number } };
  assert.equal(markedDeck.fill.state, "on_deck");
  assert.equal(markedDeck.fill.onDeckOrder, 1);

  // 6. Public projection -> GET /api/on-deck (no auth required)
  const onDeckRes = await fetch(`${baseUrl}/api/on-deck`);
  assert.equal(onDeckRes.status, 200);
  const onDeckList = (await onDeckRes.json()) as {
    onDeck: { fillId: string; order: number; name: string; style: string | null }[];
  };
  assert.equal(onDeckList.onDeck.length, 1);
  assert.equal(onDeckList.onDeck[0]?.name, "Helles");

  // 6b. Admin on-deck -> GET /api/admin/fills/on-deck (with session)
  const adminOnDeckRes = await fetch(`${baseUrl}/api/admin/fills/on-deck`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(adminOnDeckRes.status, 200);

  // 7. Settings: GET and PATCH /api/admin/fills/settings
  const getSettingsRes = await fetch(`${baseUrl}/api/admin/fills/settings`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getSettingsRes.status, 200);
  const settingsBefore = (await getSettingsRes.json()) as {
    settings: { autoDeleteBeverageOnLastFill: boolean };
  };
  assert.equal(settingsBefore.settings.autoDeleteBeverageOnLastFill, false);

  const patchSettingsRes = await fetch(`${baseUrl}/api/admin/fills/settings`, {
    method: "PATCH",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ autoDeleteBeverageOnLastFill: true }),
  });
  assert.equal(patchSettingsRes.status, 200);

  // 8. Kick fill -> POST /api/admin/fills/:id/kick
  const kickRes = await fetch(`${baseUrl}/api/admin/fills/${fill1.fill.id}/kick`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "Tapped out" }),
  });
  assert.equal(kickRes.status, 200);
  const kicked = (await kickRes.json()) as { fill: { state: string; endReason: string } };
  assert.equal(kicked.fill.state, "ended");
  assert.equal(kicked.fill.endReason, "Tapped out");

  // 9. Deletion impact and delete -> DELETE /api/admin/fills/:id
  const impactRes = await fetch(`${baseUrl}/api/admin/fills/${fill2.fill.id}/deletion-impact`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(impactRes.status, 200);

  const missingConfirmationDelete = await fetch(`${baseUrl}/api/admin/fills/${fill2.fill.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "Mistake fill" }),
  });
  assert.equal(missingConfirmationDelete.status, 400);

  const emptyConfirmationDelete = await fetch(`${baseUrl}/api/admin/fills/${fill2.fill.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "" }),
  });
  assert.equal(emptyConfirmationDelete.status, 400);

  const wrongConfirmationDelete = await fetch(`${baseUrl}/api/admin/fills/${fill2.fill.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "Stout — Keg 3" }),
  });
  assert.equal(wrongConfirmationDelete.status, 400);

  const deleteRes = await fetch(`${baseUrl}/api/admin/fills/${fill2.fill.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "Mistake fill", confirmation: "Stout — Keg 2" }),
  });
  assert.equal(deleteRes.status, 200);
  const deleteBody = (await deleteRes.json()) as { impact: { beverageAutoDeleted: boolean } };
  assert.equal(deleteBody.impact.beverageAutoDeleted, true);
});
