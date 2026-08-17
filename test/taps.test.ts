import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { PublicStoryService } from "../src/features/story/service.ts";
import {
  createTapService,
  registerTapRoutes,
  type AssignmentClosedContext,
  type AssignmentOpenedContext,
  type TapAssignmentExtensionPort,
} from "../src/features/taps/index.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { createLogger } from "../src/shared/logging.ts";
import { listActivity, listDeletionAudits } from "../src/features/activity/repository.ts";

const CANONICAL_ORIGIN = "http://127.0.0.1:3000";
const quietLogger = createLogger({ sink: () => undefined });
const ROOT_KEY = Buffer.alloc(32, 1).toString("base64url");

class MockExtensionPort implements TapAssignmentExtensionPort {
  readonly openedEvents: AssignmentOpenedContext[] = [];
  readonly closedEvents: AssignmentClosedContext[] = [];
  shouldFailOnOpen = false;
  shouldFailOnClose = false;

  onAssignmentOpened(_db: DatabaseExecutor, context: AssignmentOpenedContext): void {
    if (this.shouldFailOnOpen) {
      throw new Error("Simulated extension hook failure on assignment opened");
    }
    this.openedEvents.push(context);
  }

  onAssignmentClosed(_db: DatabaseExecutor, context: AssignmentClosedContext): void {
    if (this.shouldFailOnClose) {
      throw new Error("Simulated extension hook failure on assignment closed");
    }
    this.closedEvents.push(context);
  }
}

function setupTestEnvironment(extensionPort?: TapAssignmentExtensionPort) {
  const database = openDatabase(":memory:");
  const secretsService = createSecretsService(database, { rootKey: ROOT_KEY });
  const authService = createAuthService(database, { canonicalOrigin: CANONICAL_ORIGIN });
  const kegService = createKegService(database);
  const beverageService = createBeverageService(database, { secretsService });
  const tapService = createTapService(database, {
    ...(extensionPort ? { extensionPort } : {}),
  });
  const fillService = createFillService(database, {
    beverageService,
    assignmentPort: tapService.asFillAssignmentPort(),
  });
  const storyService = new PublicStoryService({
    tapService,
    beverageService,
    fillService,
    detectorService: {} as never,
    forecastService: {} as never,
    healthService: {} as never,
  });

  return {
    database,
    secretsService,
    authService,
    kegService,
    beverageService,
    tapService,
    fillService,
    storyService,
  };
}

void test("tap creation validates inputs, enforces unique positive numbers, and records activity", () => {
  const { database, tapService } = setupTestEnvironment();

  // 1. Create tap with valid inputs and serving metadata
  const tap1 = tapService.createTap({
    tapNumber: 1,
    name: "Nitro Tap",
    enabled: true,
    gasType: "Nitro 75/25",
    servingPressureKpa: 240,
    lineLengthMm: 1800,
    lineDiameterMm: 4.76,
    notes: "Stainless forward sealing faucet",
  });

  assert.equal(tap1.tapNumber, 1);
  assert.equal(tap1.name, "Nitro Tap");
  assert.equal(tap1.enabled, true);
  assert.equal(tap1.isRetired, false);
  assert.equal(tap1.isOccupied, false);
  assert.equal(tap1.firstUsedAt, null);
  assert.equal(tap1.retiredAt, null);
  assert.equal(tap1.gasType, "Nitro 75/25");
  assert.equal(tap1.servingPressureKpa, 240);
  assert.equal(tap1.lineLengthMm, 1800);
  assert.equal(tap1.lineDiameterMm, 4.76);
  assert.equal(tap1.notes, "Stainless forward sealing faucet");
  assert.equal(tap1.activeAssignment, null);

  // 2. Gaps in tap numbers are allowed
  const tap5 = tapService.createTap({ tapNumber: 5, name: "Tap 5" });
  assert.equal(tap5.tapNumber, 5);

  // 3. Duplicate tap number is rejected with 409 conflict
  assert.throws(
    () => tapService.createTap({ tapNumber: 1, name: "Duplicate Tap 1" }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.number_conflict",
  );

  // 4. Invalid tap numbers (<= 0, non-integer) are rejected
  assert.throws(
    () => tapService.createTap({ tapNumber: 0 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "tapNumber",
  );
  assert.throws(
    () => tapService.createTap({ tapNumber: -1 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "tapNumber",
  );
  assert.throws(
    () => tapService.createTap({ tapNumber: 1.5 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "tapNumber",
  );

  // 5. Serving metadata invalid bounds are rejected
  assert.throws(
    () => tapService.createTap({ tapNumber: 2, servingPressureKpa: -10 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "servingPressureKpa",
  );
  assert.throws(
    () => tapService.createTap({ tapNumber: 2, lineLengthMm: -5 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "lineLengthMm",
  );
  assert.throws(
    () => tapService.createTap({ tapNumber: 2, lineDiameterMm: 0 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "lineDiameterMm",
  );
  assert.throws(
    () => tapService.createTap({ tapNumber: 2, gasType: "a".repeat(65) }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "gasType",
  );
  assert.throws(
    () => tapService.createTap({ tapNumber: 2, notes: "a".repeat(2049) }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.details?.field === "notes",
  );

  // 6. Unknown fields are rejected
  assert.throws(
    () => tapService.createTap({ tapNumber: 2, extraField: "disallowed" }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "validation.invalid_value",
  );

  // 7. Activity log recorded
  const activities = listActivity(database);
  assert.equal(activities.length, 2);
  assert.equal(activities[1]?.action, "entity_changed");
  assert.equal(activities[1]?.entityType, "tap");
  assert.equal(activities[1]?.entityId, tap1.id);
});

void test("tap update enforces telemetry acknowledgement for renumbering, handles enabled toggle, and checks retired status", () => {
  const { tapService } = setupTestEnvironment();

  const tap = tapService.createTap({ tapNumber: 1, name: "Tap 1", enabled: true });

  // 1. Updating metadata and name without renumbering succeeds
  const updated1 = tapService.updateTap(tap.id, {
    name: "Updated Name",
    servingPressureKpa: 150,
    lineLengthMm: 1500,
  });
  assert.equal(updated1.name, "Updated Name");
  assert.equal(updated1.servingPressureKpa, 150);
  assert.equal(updated1.lineLengthMm, 1500);
  assert.equal(updated1.tapNumber, 1);

  // 2. Renumbering without acknowledgeTelemetryEndpointImpact is rejected with 400 error
  assert.throws(
    () => tapService.updateTap(tap.id, { tapNumber: 10 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "validation.telemetry_impact_acknowledgement_required",
  );

  // 3. Renumbering with acknowledgeTelemetryEndpointImpact: true succeeds
  const renumbered = tapService.updateTap(tap.id, {
    tapNumber: 10,
    acknowledgeTelemetryEndpointImpact: true,
  });
  assert.equal(renumbered.tapNumber, 10);

  // 4. Enabled toggle: disabling tap hides it from public projection but does not retire or alter assignment capability
  const disabledTap = tapService.updateTap(tap.id, { enabled: false });
  assert.equal(disabledTap.enabled, false);
  assert.equal(disabledTap.isRetired, false);

  const publicTaps = tapService.listPublicTaps();
  assert.equal(publicTaps.length, 0);

  // Re-enabling makes it visible again
  tapService.updateTap(tap.id, { enabled: true });
  assert.equal(tapService.listPublicTaps().length, 1);
});

void test("bounded Admin Tap page filters, escapes LIKE wildcards, and caps deterministic pages", () => {
  const { tapService, kegService, beverageService, fillService } = setupTestEnvironment();

  for (let tapNumber = 1; tapNumber <= 27; tapNumber += 1) {
    tapService.createTap({ tapNumber, name: `Tap ${tapNumber}` });
  }
  const disabled = tapService.createTap({ tapNumber: 28, name: "Disabled Tap", enabled: false });
  const retired = tapService.createTap({ tapNumber: 29, name: "Retired Tap" });
  tapService.retireTap(retired.id);
  const literal = tapService.createTap({ tapNumber: 30, name: "Literal %_ Tap" });

  const beverage = beverageService.createCustomBeverage({ name: "Page Ale", beverageType: "beer" });
  const keg = kegService.createKeg({ kegNumber: 30, capacityMl: 19_000 });
  const fill = fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const assigned = tapService.createTap({ tapNumber: 31, name: "Assigned Tap" });
  tapService.assignFill(assigned.id, { fillId: fill.id });

  const first = tapService.listAdminPage({ state: "all", page: 1 });
  assert.equal(first.total, 31);
  assert.equal(first.items.length, 25);
  assert.deepEqual(
    first.items.slice(0, 3).map((item) => item.tapNumber),
    [1, 2, 3],
  );
  const second = tapService.listAdminPage({ state: "all", page: 2 });
  assert.equal(second.items[0]?.tapNumber, 26);
  assert.equal(second.items.at(-1)?.tapNumber, 31);

  assert.equal(tapService.listAdminPage({ state: "assigned" }).total, 1);
  assert.equal(tapService.listAdminPage({ state: "assigned" }).items[0]?.id, assigned.id);
  assert.equal(tapService.listAdminPage({ state: "unassigned" }).total, 30);
  assert.equal(tapService.listAdminPage({ state: "disabled" }).items[0]?.id, disabled.id);
  assert.equal(tapService.listAdminPage({ state: "retired" }).items[0]?.id, retired.id);
  assert.equal(tapService.listAdminPage({ q: "%_" }).items[0]?.id, literal.id);
  assert.equal(tapService.listAdminPage({ q: "x".repeat(120) }).query.length, 80);
});

void test("tap assignment lifecycles: assign, clear on deck, first_used_at monotonicity, unassign, and move", () => {
  const extensionPort = new MockExtensionPort();
  const { kegService, beverageService, fillService, tapService } =
    setupTestEnvironment(extensionPort);

  const keg1 = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const keg2 = kegService.createKeg({ kegNumber: 2, capacityMl: 19000 });
  const bev1 = beverageService.createCustomBeverage({
    name: "IPA",
    beverageType: "beer",
    abv: 6.5,
  });
  const bev2 = beverageService.createCustomBeverage({
    name: "Stout",
    beverageType: "beer",
    abv: 8.0,
  });

  const fill1 = fillService.createFill({ beverageId: bev1.beverage.id, kegId: keg1.id });
  const fill2 = fillService.createFill({ beverageId: bev2.beverage.id, kegId: keg2.id });

  // Place fill1 on deck (order 1) and fill2 on deck (order 2)
  fillService.markOnDeck(fill1.id);
  fillService.markOnDeck(fill2.id);
  assert.equal(fillService.getPublicOnDeck().length, 2);

  const tap1 = tapService.createTap({ tapNumber: 1, name: "Tap 1" });
  const tap2 = tapService.createTap({ tapNumber: 2, name: "Tap 2" });

  assert.equal(tap1.firstUsedAt, null);
  assert.equal(tap2.firstUsedAt, null);

  // 1. Assign fill1 to tap1: clears fill1 from on deck, shifts fill2 to order 1, sets first_used_at on tap1
  const assignResult = tapService.assignFill(tap1.id, { fillId: fill1.id });
  assert.equal(assignResult.requiresFreshBaseline, true);
  assert.equal(assignResult.tap.isOccupied, true);
  assert.ok(assignResult.tap.firstUsedAt !== null);
  assert.equal(assignResult.tap.activeAssignment?.fillId, fill1.id);
  assert.equal(assignResult.tap.activeAssignment?.beverageName, "IPA");

  const firstUsedAtTap1 = assignResult.tap.firstUsedAt;

  // On deck should now only have fill2 at order 1
  const onDeck = fillService.getPublicOnDeck();
  assert.equal(onDeck.length, 1);
  assert.equal(onDeck[0]?.fillId, fill2.id);
  assert.equal(onDeck[0]?.order, 1);
  assert.equal(fillService.getFill(fill2.id).onDeckOrder, 1);

  // Extension hook was called
  assert.equal(extensionPort.openedEvents.length, 1);
  assert.equal(extensionPort.openedEvents[0]?.reason, "assigned");
  assert.equal(extensionPort.openedEvents[0]?.tapId, tap1.id);
  assert.equal(extensionPort.openedEvents[0]?.fillId, fill1.id);

  // 2. Assigning to already-occupied tap1 is rejected with 409 conflict identifying current occupant
  assert.throws(
    () => tapService.assignFill(tap1.id, { fillId: fill2.id }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.occupied" &&
      error.details?.occupiedByFillId === fill1.id,
  );

  // 3. Assigning already-assigned fill1 to another tap is rejected with 409 conflict
  assert.throws(
    () => tapService.assignFill(tap2.id, { fillId: fill1.id }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "fill.already_assigned" &&
      error.details?.assignedToTapId === tap1.id,
  );

  // 4. Move fill1 from tap1 to tap2
  const moveResult = tapService.moveFill({ tapId: tap1.id }, { targetTapId: tap2.id });
  assert.equal(moveResult.requiresFreshBaseline, true);
  assert.equal(moveResult.sourceTap.isOccupied, false);
  assert.equal(moveResult.sourceTap.firstUsedAt, firstUsedAtTap1); // first_used_at is monotonic and preserved
  assert.equal(moveResult.targetTap.isOccupied, true);
  assert.ok(moveResult.targetTap.firstUsedAt !== null); // tap2 first_used_at is now set
  assert.notEqual(moveResult.closedAssignment.id, moveResult.newAssignment.id); // NEW UUID for new lifecycle
  assert.equal(moveResult.closedAssignment.endReason, "moved");
  assert.equal(moveResult.newAssignment.tapId, tap2.id);
  assert.equal(moveResult.newAssignment.fillId, fill1.id);
  assert.equal(moveResult.newAssignment.endedAt, null);
  assert.equal(moveResult.newAssignment.endReason, null);

  // Extension hooks invoked for move
  assert.equal(extensionPort.closedEvents.length, 1);
  assert.equal(extensionPort.closedEvents[0]?.reason, "moved");
  assert.equal(extensionPort.openedEvents.length, 2);
  assert.equal(extensionPort.openedEvents[1]?.reason, "moved");

  // 5. Unassign fill1 from tap2
  const unassignResult = tapService.unassign(tap2.id);
  assert.equal(unassignResult.tap.isOccupied, false);
  assert.equal(unassignResult.closedAssignment.endReason, "unassigned");

  // Fill returns to "available" (not on deck)
  const fill1View = fillService.getFill(fill1.id);
  assert.equal(fill1View.state, "available");
  assert.equal(fill1View.onDeckOrder, null);

  // Tap first_used_at remains set
  const tap2Reloaded = tapService.getTap(tap2.id);
  assert.ok(tap2Reloaded.firstUsedAt !== null);

  // Extension hook invoked for unassign
  assert.equal(extensionPort.closedEvents.length, 2);
  assert.equal(extensionPort.closedEvents[1]?.reason, "unassigned");
});

void test("assignment mystery is active-lifecycle scoped, canonical, and auditable", () => {
  const { database, kegService, beverageService, fillService, tapService } = setupTestEnvironment();
  const keg = kegService.createKeg({ kegNumber: 90, capacityMl: 19000 });
  const secondKeg = kegService.createKeg({ kegNumber: 91, capacityMl: 19000 });
  const beverage = beverageService.createCustomBeverage({ name: "Hidden", beverageType: "beer" });
  const fill = fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const secondFill = fillService.createFill({
    beverageId: beverage.beverage.id,
    kegId: secondKeg.id,
  });
  const tap = tapService.createTap({ tapNumber: 90 });

  assert.deepEqual(tapService.getAssignmentMystery(tap.id), {
    enabled: false,
    revealBeverageType: false,
    revealStyle: false,
    revealAbv: false,
    revealIbu: false,
    revealOg: false,
    revealFg: false,
    revealSrm: false,
    revealDescription: false,
    revealRecipe: false,
    revealSensory: false,
    revealHistory: false,
  });
  assert.throws(
    () => tapService.updateAssignmentMystery(tap.id, { enabled: true }),
    ApplicationError,
  );
  const firstAssignment = tapService.assignFill(tap.id, { fillId: fill.id }).assignment;
  const enabled = tapService.updateAssignmentMystery(tap.id, {
    enabled: true,
    revealBeverageType: true,
    revealStyle: false,
    revealAbv: false,
    revealIbu: false,
    revealOg: false,
    revealFg: false,
    revealSrm: false,
    revealDescription: false,
    revealRecipe: false,
    revealSensory: false,
    revealHistory: false,
  });
  assert.equal(enabled.changed, true);
  assert.equal(tapService.updateAssignmentMystery(tap.id, enabled.config).changed, false);
  assert.equal(tapService.getAssignmentMystery(tap.id).revealBeverageType, true);
  tapService.unassign(tap.id);
  assert.equal(tapService.getAssignmentMystery(tap.id).enabled, false);
  const secondAssignment = tapService.assignFill(tap.id, { fillId: secondFill.id }).assignment;
  assert.notEqual(secondAssignment.id, firstAssignment.id);
  assert.deepEqual(tapService.getAssignmentMystery(tap.id), {
    enabled: false,
    revealBeverageType: false,
    revealStyle: false,
    revealAbv: false,
    revealIbu: false,
    revealOg: false,
    revealFg: false,
    revealSrm: false,
    revealDescription: false,
    revealRecipe: false,
    revealSensory: false,
    revealHistory: false,
  });
  assert.equal(
    database
      .prepare<[string], { readonly assignment_id: string; readonly reveal_beverage_type: number }>(
        "SELECT assignment_id, reveal_beverage_type FROM tap_assignment_mystery WHERE assignment_id = ?",
      )
      .get(firstAssignment.id)?.assignment_id,
    firstAssignment.id,
  );
  assert.equal(
    database
      .prepare<[string], { readonly count: number }>(
        "SELECT count(*) AS count FROM tap_assignment_mystery WHERE assignment_id = ?",
      )
      .get(secondAssignment.id)?.count,
    0,
  );
});

void test("move rollback safety: if target tap fails or hook fails, source assignment remains open", () => {
  const extensionPort = new MockExtensionPort();
  const { kegService, beverageService, fillService, tapService } =
    setupTestEnvironment(extensionPort);

  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const bev = beverageService.createCustomBeverage({ name: "IPA", beverageType: "beer" });
  const fill = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });

  const tap1 = tapService.createTap({ tapNumber: 1, name: "Tap 1" });
  const tap2 = tapService.createTap({ tapNumber: 2, name: "Tap 2" });

  tapService.assignFill(tap1.id, { fillId: fill.id });

  // Simulate extension hook failure on opening target assignment
  extensionPort.shouldFailOnOpen = true;

  assert.throws(
    () => tapService.moveFill({ tapId: tap1.id }, { targetTapId: tap2.id }),
    /Simulated extension hook failure/,
  );

  extensionPort.shouldFailOnOpen = false;

  // Source tap1 is still occupied by fill
  const tap1After = tapService.getTap(tap1.id);
  assert.equal(tap1After.isOccupied, true);
  assert.equal(tap1After.activeAssignment?.fillId, fill.id);

  // Target tap2 remains unoccupied
  const tap2After = tapService.getTap(tap2.id);
  assert.equal(tap2After.isOccupied, false);
});

void test("Promise-like Tap assignment extensions are rejected and roll back assignment state", () => {
  const extensionPort: TapAssignmentExtensionPort = {
    onAssignmentOpened: () => ({ then() {} }),
    onAssignmentClosed: () => undefined,
  };
  const { kegService, beverageService, fillService, tapService } =
    setupTestEnvironment(extensionPort);
  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19_000 });
  const beverage = beverageService.createCustomBeverage({
    name: "Async Hook IPA",
    beverageType: "beer",
  });
  const fill = fillService.createFill({ beverageId: beverage.beverage.id, kegId: keg.id });
  const tap = tapService.createTap({ tapNumber: 1 });

  assert.throws(
    () => tapService.assignFill(tap.id, { fillId: fill.id }),
    /Tap assignment extensions must complete synchronously/,
  );
  assert.equal(tapService.getTap(tap.id).isOccupied, false);
  assert.equal(tapService.getTap(tap.id).firstUsedAt, null);
  assert.equal(fillService.getFill(fill.id).state, "available");
});

void test("tap retirement preserves history, permanently reserves tap number, and refuses retirement if tap is occupied", () => {
  const { kegService, beverageService, fillService, tapService } = setupTestEnvironment();

  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const bev = beverageService.createCustomBeverage({ name: "IPA", beverageType: "beer" });
  const fill = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });

  const tap1 = tapService.createTap({ tapNumber: 1, name: "Tap 1" });
  tapService.assignFill(tap1.id, { fillId: fill.id });

  // 1. Retiring occupied tap is rejected with 409 conflict
  assert.throws(
    () => tapService.retireTap(tap1.id),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.occupied",
  );

  // 2. After unassigning, retiring unoccupied tap succeeds
  tapService.unassign(tap1.id);
  const retiredTap = tapService.retireTap(tap1.id, { reason: "Line decommissioning" });
  assert.equal(retiredTap.isRetired, true);
  assert.ok(retiredTap.retiredAt !== null);

  // 3. Retired tap cannot receive new assignments
  assert.throws(
    () => tapService.assignFill(tap1.id, { fillId: fill.id }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.retired",
  );

  // 4. Retired tap cannot be renumbered
  assert.throws(
    () =>
      tapService.updateTap(tap1.id, {
        tapNumber: 99,
        acknowledgeTelemetryEndpointImpact: true,
      }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.retired_renumber_prohibited",
  );

  // 5. Retired tap reserves its tap number: new tap cannot use tapNumber 1
  assert.throws(
    () => tapService.createTap({ tapNumber: 1, name: "New Tap 1" }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.number_conflict",
  );

  // 6. Retiring an already retired tap is idempotent
  const retiredAgain = tapService.retireTap(tap1.id);
  assert.equal(retiredAgain.retiredAt, retiredTap.retiredAt);
});

void test("tap deletion lifecycle: only never-used taps can be deleted; used or retired taps are rejected", () => {
  const { database, kegService, beverageService, fillService, tapService } = setupTestEnvironment();

  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const bev = beverageService.createCustomBeverage({ name: "IPA", beverageType: "beer" });
  const fill = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });

  // 1. Tap 1 is assigned and then unassigned (historically used)
  const tap1 = tapService.createTap({ tapNumber: 1, name: "Used Tap" });
  tapService.assignFill(tap1.id, { fillId: fill.id });
  tapService.unassign(tap1.id);

  const impact1 = tapService.getTapDeletionImpact(tap1.id);
  assert.equal(impact1.canDelete, false);
  assert.ok(impact1.reasonsCannotDelete.length > 0);

  assert.throws(
    () => tapService.deleteTap(tap1.id, { confirmation: "Tap 1 — Used Tap" }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "conflict" &&
      error.code === "tap.cannot_delete",
  );

  // 2. Tap 2 is retired before use -> cannot delete
  const tap2 = tapService.createTap({ tapNumber: 2, name: "Retired Tap" });
  tapService.retireTap(tap2.id);

  const impact2 = tapService.getTapDeletionImpact(tap2.id);
  assert.equal(impact2.canDelete, false);
  assert.throws(
    () => tapService.deleteTap(tap2.id, { confirmation: "Tap 2 — Retired Tap" }),
    /cannot be deleted/,
  );

  // 3. Tap 3 is never used -> can be deleted cleanly
  const tap3 = tapService.createTap({ tapNumber: 3, name: "Clean Tap" });
  const impact3 = tapService.getTapDeletionImpact(tap3.id);
  assert.equal(impact3.canDelete, true);
  assert.deepEqual(impact3.reasonsCannotDelete, []);

  assert.throws(
    () => tapService.deleteTapConfirmed(tap3.id, undefined),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "tap.confirmation_required",
  );
  assert.throws(
    () => tapService.deleteTapConfirmed(tap3.id, "Wrong visible label"),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "tap.confirmation_mismatch",
  );
  assert.throws(
    () => tapService.deleteTapConfirmed(tap3.id, "Tap 3 — Clean Tap "),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === "validation" &&
      error.code === "tap.confirmation_mismatch",
  );
  tapService.deleteTapConfirmed(tap3.id, "Tap 3 — Clean Tap", { reason: "Mistake creation" });

  assert.throws(() => tapService.getTap(tap3.id), /Tap was not found/);

  // Deletion audit record was created
  const audits = listDeletionAudits(database);
  assert.ok(audits.some((a) => a.entityType === "tap" && a.entityId === tap3.id));

  // Tap number 3 is now reusable
  const reusedTap3 = tapService.createTap({ tapNumber: 3, name: "New Clean Tap 3" });
  assert.equal(reusedTap3.tapNumber, 3);
});

void test("real FillAssignmentLifecyclePort integrates with FillService on kick and fill end", async () => {
  const extensionPort = new MockExtensionPort();
  const { kegService, beverageService, fillService, tapService } =
    setupTestEnvironment(extensionPort);

  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const bev = beverageService.createCustomBeverage({ name: "IPA", beverageType: "beer" });
  const fill = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });

  const tap = tapService.createTap({ tapNumber: 1, name: "Tap 1" });
  tapService.assignFill(tap.id, { fillId: fill.id });

  // Port reflects active assignment
  const port = tapService.asFillAssignmentPort();
  assert.equal(port.hasActiveAssignment(fill.id), true);

  // When Fill is kicked via FillService:
  const kickResult = await fillService.kickFill(fill.id, { reason: "Keg emptied" });
  assert.equal(kickResult.fill.state, "ended");
  assert.equal(kickResult.fill.endReason, "Keg emptied");

  // Port now reflects no active assignment
  assert.equal(port.hasActiveAssignment(fill.id), false);

  // Tap is now unoccupied
  const tapReloaded = tapService.getTap(tap.id);
  assert.equal(tapReloaded.isOccupied, false);

  // Extension hook received "fill_ended"
  assert.equal(extensionPort.closedEvents.length, 1);
  assert.equal(extensionPort.closedEvents[0]?.reason, "fill_ended");
  assert.equal(extensionPort.closedEvents[0]?.fillId, fill.id);
  assert.equal(extensionPort.closedEvents[0]?.tapId, tap.id);
});

void test("HTTP API: full Tap and assignment lifecycle smoke test with auth, CSRF, and unknown field rejection", async (context) => {
  const {
    database,
    authService,
    kegService,
    beverageService,
    fillService,
    tapService,
    storyService,
  } = setupTestEnvironment();
  await authService.setPin("1234");
  const loginResult = await authService.authenticate("1234");
  assert.ok(loginResult.authenticated);
  const cookieHeader = `tapboard_admin_session=${loginResult.session}`;
  const csrfToken = loginResult.csrfToken!;

  const router = new Router(quietLogger);
  registerTapRoutes({ router, tapService, authService, storyService });

  const server = new HttpServer({
    router,
    logger: quietLogger,
    shutdownGraceMs: 500,
  });

  context.after(async () => {
    await server.stop();
    database.close();
  });

  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19000 });
  const bev = beverageService.createCustomBeverage({
    name: "Summer Ale",
    beverageType: "beer",
    abv: 4.8,
  });
  const fill = fillService.createFill({ beverageId: bev.beverage.id, kegId: keg.id });

  // 1. Unauthenticated GET /api/admin/taps -> 401
  const unauthGet = await fetch(`${baseUrl}/api/admin/taps`);
  assert.equal(unauthGet.status, 401);

  // 2. Public projection GET /api/public/taps -> 200, empty
  const publicEmpty = await fetch(`${baseUrl}/api/public/taps`);
  assert.equal(publicEmpty.status, 200);
  assert.deepEqual(await publicEmpty.json(), { taps: [] });

  // 3. POST /api/admin/taps with unknown field -> 400
  const unknownFieldRes = await fetch(`${baseUrl}/api/admin/taps`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tapNumber: 1, invalidField: "bad" }),
  });
  assert.equal(unknownFieldRes.status, 400);

  // 4. Valid POST /api/admin/taps -> 201
  const createTapRes1 = await fetch(`${baseUrl}/api/admin/taps`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tapNumber: 1,
      name: "Main Tap",
      servingPressureKpa: 80,
      lineLengthMm: 1500,
      lineDiameterMm: 5.0,
      notes: "Perlick 630SS",
    }),
  });
  assert.equal(createTapRes1.status, 201);
  const tap1 = (await createTapRes1.json()) as { tap: { id: string; tapNumber: number } };
  assert.equal(tap1.tap.tapNumber, 1);

  const createTapRes2 = await fetch(`${baseUrl}/api/admin/taps`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tapNumber: 2, name: "Secondary Tap" }),
  });
  assert.equal(createTapRes2.status, 201);
  const tap2 = (await createTapRes2.json()) as { tap: { id: string; tapNumber: number } };

  // 5. GET /api/admin/taps/:id
  const getTapRes = await fetch(`${baseUrl}/api/admin/taps/${tap1.tap.id}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getTapRes.status, 200);

  // 6. Assign fill to tap 1 -> POST /api/admin/taps/:id/assign
  const assignRes = await fetch(`${baseUrl}/api/admin/taps/${tap1.tap.id}/assign`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fillId: fill.id }),
  });
  assert.equal(assignRes.status, 200);
  const assignData = (await assignRes.json()) as {
    tap: { isOccupied: boolean; activeAssignment: { beverageName: string } };
    requiresFreshBaseline: boolean;
  };
  assert.equal(assignData.requiresFreshBaseline, true);
  assert.equal(assignData.tap.isOccupied, true);
  assert.equal(assignData.tap.activeAssignment.beverageName, "Summer Ale");

  // 7. Public projection now contains tap 1 with active beverage
  const publicRes = await fetch(`${baseUrl}/api/public/taps`);
  assert.equal(publicRes.status, 200);
  const publicData = (await publicRes.json()) as {
    taps: { tapNumber: number; activeFill: { beverageName: string } }[];
  };
  assert.equal(publicData.taps.length, 2);
  assert.equal(publicData.taps[0]?.activeFill?.beverageName, "Summer Ale");
  assert.equal(publicData.taps[1]?.activeFill, null);

  // 8. Move fill from tap 1 to tap 2 -> POST /api/admin/taps/:id/move
  const moveRes = await fetch(`${baseUrl}/api/admin/taps/${tap1.tap.id}/move`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ targetTapId: tap2.tap.id }),
  });
  assert.equal(moveRes.status, 200);
  const moveData = (await moveRes.json()) as {
    sourceTap: { isOccupied: boolean };
    targetTap: { isOccupied: boolean };
    requiresFreshBaseline: boolean;
  };
  assert.equal(moveData.requiresFreshBaseline, true);
  assert.equal(moveData.sourceTap.isOccupied, false);
  assert.equal(moveData.targetTap.isOccupied, true);

  // 9. Move fill back to tap 1 by fillId -> POST /api/admin/fills/:fillId/move
  const moveByFillRes = await fetch(`${baseUrl}/api/admin/fills/${fill.id}/move`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ targetTapId: tap1.tap.id }),
  });
  assert.equal(moveByFillRes.status, 200);

  // 10. Unassign fill from tap 1 -> POST /api/admin/taps/:id/unassign
  const unassignRes = await fetch(`${baseUrl}/api/admin/taps/${tap1.tap.id}/unassign`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
  });
  assert.equal(unassignRes.status, 200);
  const unassignData = (await unassignRes.json()) as { tap: { isOccupied: boolean } };
  assert.equal(unassignData.tap.isOccupied, false);

  // 11. Retire tap 1 -> POST /api/admin/taps/:id/retire
  const retireRes = await fetch(`${baseUrl}/api/admin/taps/${tap1.tap.id}/retire`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "Faucet upgrade" }),
  });
  assert.equal(retireRes.status, 200);
  const retiredData = (await retireRes.json()) as { tap: { isRetired: boolean } };
  assert.equal(retiredData.tap.isRetired, true);

  // 12. Deletion impact and delete never-used tap 3
  const createTapRes3 = await fetch(`${baseUrl}/api/admin/taps`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tapNumber: 3, name: "Temporary Tap" }),
  });
  assert.equal(createTapRes3.status, 201);
  const tap3 = (await createTapRes3.json()) as { tap: { id: string } };

  const impactRes = await fetch(`${baseUrl}/api/admin/taps/${tap3.tap.id}/deletion-impact`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(impactRes.status, 200);
  const impactData = (await impactRes.json()) as { impact: { canDelete: boolean } };
  assert.equal(impactData.impact.canDelete, true);

  const missingConfirmationDelete = await fetch(`${baseUrl}/api/admin/taps/${tap3.tap.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assert.equal(missingConfirmationDelete.status, 400);

  const emptyConfirmationDelete = await fetch(`${baseUrl}/api/admin/taps/${tap3.tap.id}`, {
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

  const wrongConfirmationDelete = await fetch(`${baseUrl}/api/admin/taps/${tap3.tap.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "Tap 3 — Other Tap" }),
  });
  assert.equal(wrongConfirmationDelete.status, 400);

  const deleteRes = await fetch(`${baseUrl}/api/admin/taps/${tap3.tap.id}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "Tap 3 — Temporary Tap" }),
  });
  assert.equal(deleteRes.status, 200);
  const deleteData = (await deleteRes.json()) as { deleted: boolean; tapId: string };
  assert.equal(deleteData.deleted, true);
  assert.equal(deleteData.tapId, tap3.tap.id);
});

void test("linked beverage tap projections honor 3-state presentation overrides (beverageType override, explicit clear for style and abv)", async () => {
  const {
    database,
    beverageService,
    tapService,
    fillService,
    kegService,
    authService,
    storyService,
  } = setupTestEnvironment();

  // 0. Set up Brewfather account
  beverageService.configureBrewfatherAccount({
    userId: "bf-user-123",
    apiKey: "secret-api-key-xyz",
    enabled: true,
  });

  // 1. Insert a candidate into brewfather_candidate_cache
  database
    .prepare(
      `INSERT INTO brewfather_candidate_cache (
        id, account_id, source_batch_id, batch_name, batch_number, status, brewer,
        recipe_name, style, brew_date, estimated_og, estimated_fg, estimated_abv,
        estimated_ibu, estimated_srm, raw_summary_json, summary_fingerprint, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "c1111111-1111-4111-8111-111111111111",
      "default",
      "batch-source-1",
      "Source IPA",
      42,
      "Fermenting",
      "Brewer Joe",
      "West Coast IPA Recipe",
      "IPA",
      "2026-08-01",
      1.065,
      1.012,
      6.5,
      60,
      6,
      "{}",
      "a".repeat(64),
      "2026-08-14T00:00:00.000Z",
    );

  // 2. Link candidate into a new Beverage
  const linked = beverageService.linkBrewfatherCandidate({
    sourceBatchId: "batch-source-1",
  });
  assert.equal(linked.beverage.ownershipType, "brewfather");

  // 3. Apply local overrides:
  // - beverageType: explicit value different from source ("cider" vs source "beer")
  // - style: explicit CLEAR (clear: true -> style = null)
  // - abv: explicit CLEAR (clear: true -> abv = null)
  // - name: explicit value ("Local Dry Hopped Cider")
  const updatedBeverage = beverageService.updatePresentationOverrides(linked.beverage.id, {
    name: { value: "Local Dry Hopped Cider" },
    beverageType: { value: "cider" },
    style: { clear: true },
    abv: { clear: true },
  });

  const canonicalEffective = updatedBeverage.effectivePresentation;
  assert.equal(canonicalEffective.name, "Local Dry Hopped Cider");
  assert.equal(canonicalEffective.beverageType, "cider");
  assert.equal(canonicalEffective.style, null);
  assert.equal(canonicalEffective.abv, null);

  // 4. Create Keg + Fill and assign to Tap
  const keg = kegService.createKeg({ kegNumber: 50, capacityMl: 19000 });
  const fill = fillService.createFill({ beverageId: linked.beverage.id, kegId: keg.id });
  const tap = tapService.createTap({ tapNumber: 7, name: "Cider Tap" });
  tapService.assignFill(tap.id, { fillId: fill.id });

  // 5. Assert AdminTapView activeAssignment matches canonical effective presentation
  const adminTap = tapService.getTap(tap.id);
  assert.ok(adminTap.activeAssignment !== null);
  assert.equal(adminTap.activeAssignment.beverageName, canonicalEffective.name);
  assert.equal(adminTap.activeAssignment.beverageType, canonicalEffective.beverageType);
  assert.equal(adminTap.activeAssignment.beverageStyle, canonicalEffective.style);
  assert.equal(adminTap.activeAssignment.beverageAbv, canonicalEffective.abv);
  assert.equal(adminTap.activeAssignment.beverageStyle, null); // explicitly proved null
  assert.equal(adminTap.activeAssignment.beverageAbv, null); // explicitly proved null
  assert.equal(adminTap.activeAssignment.beverageType, "cider"); // override honored

  // 6. Assert PublicTapView activeFill matches canonical effective presentation
  const publicTaps = tapService.listPublicTaps();
  const publicTap = publicTaps.find((t) => t.tapNumber === 7);
  assert.ok(publicTap !== undefined);
  assert.ok(publicTap.activeFill !== null);
  assert.equal(publicTap.activeFill.beverageName, canonicalEffective.name);
  assert.equal(publicTap.activeFill.beverageType, canonicalEffective.beverageType);
  assert.equal(publicTap.activeFill.beverageStyle, canonicalEffective.style);
  assert.equal(publicTap.activeFill.beverageAbv, canonicalEffective.abv);
  assert.equal(publicTap.activeFill.beverageStyle, null); // explicitly proved null
  assert.equal(publicTap.activeFill.beverageAbv, null); // explicitly proved null
  assert.equal(publicTap.activeFill.beverageType, "cider"); // override honored

  // 7. Assert HTTP API endpoints match canonical effective presentation
  const router = new Router(quietLogger);
  registerTapRoutes({ router, tapService, authService, storyService });
  const server = new HttpServer({
    router,
    logger: quietLogger,
    shutdownGraceMs: 500,
  });
  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const publicRes = await fetch(`${baseUrl}/api/public/taps`);
    assert.equal(publicRes.status, 200);
    const publicData = (await publicRes.json()) as {
      taps: Array<{
        tapNumber: number;
        activeFill: {
          beverageName: string;
          beverageType: string;
          beverageStyle: string | null;
          beverageAbv: number | null;
        } | null;
      }>;
    };
    const httpPublicTap = publicData.taps.find((t) => t.tapNumber === 7);
    assert.ok(httpPublicTap?.activeFill);
    assert.equal(httpPublicTap.activeFill.beverageName, "Local Dry Hopped Cider");
    assert.equal(httpPublicTap.activeFill.beverageType, "cider");
    assert.equal(httpPublicTap.activeFill.beverageStyle, null);
    assert.equal(httpPublicTap.activeFill.beverageAbv, null);
  } finally {
    await server.stop();
  }
});
