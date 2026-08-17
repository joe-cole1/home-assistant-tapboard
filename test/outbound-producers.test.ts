import assert from "node:assert/strict";
import test from "node:test";

import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createOutboundService } from "../src/features/outbound/service.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createHealthService } from "../src/features/health/service.ts";
import { findActiveAssignmentByFillId } from "../src/features/taps/repository.ts";
import { createTapService } from "../src/features/taps/service.ts";
import type {
  AssignmentClosedContext,
  AssignmentOpenedContext,
  TapAssignmentExtensionPort,
} from "../src/features/taps/types.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const ROOT_KEY = Buffer.alloc(32, 7).toString("base64url");

function ids(): () => string {
  let next = 1;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function countEvents(database: ReturnType<typeof openDatabase>, eventType?: string): number {
  return database
    .prepare<[string?], { readonly count: number }>(
      eventType === undefined
        ? "SELECT count(*) AS count FROM outbound_events"
        : "SELECT count(*) AS count FROM outbound_events WHERE event_type = ?",
    )
    .get(...(eventType === undefined ? [] : [eventType]))!.count;
}

function producerHarness() {
  const database = openDatabase(":memory:");
  const nextId = ids();
  const secrets = createSecretsService(database, { rootKey: ROOT_KEY, idFactory: nextId });
  const outbound = createOutboundService(database, {
    secrets,
    now: () => new Date(NOW),
    idFactory: nextId,
  });
  outbound.create({
    id: nextId(),
    label: "Producer hook",
    transport: "webhook",
    webhookUrl: "https://example.test/events",
  });
  const extension: TapAssignmentExtensionPort = {
    onAssignmentOpened: (db: ReturnType<typeof openDatabase>, context: AssignmentOpenedContext) => {
      outbound.assignmentOpened(db, context);
    },
    onAssignmentClosed: (
      _db: ReturnType<typeof openDatabase>,
      _context: AssignmentClosedContext,
    ) => {
      // Unassign/move closure is intentionally not fill.ended.
    },
  };
  const tapService = createTapService(database, {
    extensionPort: extension,
    now: () => new Date(NOW),
    idFactory: nextId,
  });
  const kegService = createKegService(database, {
    now: () => new Date(NOW),
    idFactory: nextId,
  });
  const beverageService = createBeverageService(database, {
    now: () => new Date(NOW),
    idFactory: nextId,
  });
  let throwOnEnd = false;
  const tapAssignmentPort = tapService.asFillAssignmentPort();
  const fillService = createFillService(database, {
    beverageService,
    assignmentPort: {
      hasActiveAssignment: (fillId) => tapAssignmentPort.hasActiveAssignment(fillId),
      closeForFillEnd: (db, fillId, endedAt) => {
        const active = findActiveAssignmentByFillId(db, fillId);
        tapAssignmentPort.closeForFillEnd(db, fillId, endedAt);
        return active === undefined
          ? undefined
          : { assignmentId: active.id, tapId: active.tapId, fillId: active.fillId, endedAt };
      },
    },
    onFillEnded: (db, context) => {
      if (context.assignmentId !== null && context.tapId !== null) {
        outbound.assignmentClosed(
          db,
          {
            assignmentId: context.assignmentId,
            tapId: context.tapId,
            fillId: context.fillId,
            occurredAt: context.occurredAt,
            reason: "fill_ended",
          },
          context.reason,
        );
      }
      if (throwOnEnd) throw new Error("producer callback failed");
    },
    now: () => new Date(NOW),
    idFactory: nextId,
  });
  return {
    database,
    outbound,
    tapService,
    kegService,
    beverageService,
    fillService,
    setThrowOnEnd: (value: boolean) => {
      throwOnEnd = value;
    },
  };
}

void test("assignment and fill-end producers remain transaction-local and do not duplicate closure events", async () => {
  const harness = producerHarness();
  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const keg = harness.kegService.createKeg({ kegNumber: 1, capacityMl: 1_000 });
    const beverage = harness.beverageService.createCustomBeverage({
      name: "Producer Lager",
      beverageType: "beer",
    });
    const fill = harness.fillService.createFill({
      beverageId: beverage.beverage.id,
      kegId: keg.id,
    });
    harness.tapService.assignFill(tap.id, { fillId: fill.id });
    assert.equal(countEvents(harness.database, "fill.assigned"), 1);

    await harness.fillService.kickFill(fill.id, { reason: "kicked" });
    assert.equal(countEvents(harness.database, "fill.ended"), 1);
    assert.equal(countEvents(harness.database), 2);

    const secondKeg = harness.kegService.createKeg({ kegNumber: 2, capacityMl: 1_000 });
    const secondFill = harness.fillService.createFill({
      beverageId: beverage.beverage.id,
      kegId: secondKeg.id,
    });
    harness.tapService.assignFill(tap.id, { fillId: secondFill.id });
    const beforeRollback = countEvents(harness.database);
    harness.setThrowOnEnd(true);
    await assert.rejects(harness.fillService.kickFill(secondFill.id), /producer callback failed/);
    assert.equal(countEvents(harness.database), beforeRollback);
    assert.ok(findActiveAssignmentByFillId(harness.database, secondFill.id));
    assert.equal(harness.fillService.getFill(secondFill.id).endedAt, null);
  } finally {
    harness.database.close();
  }
});

void test("health producer callback is emitted only for semantic state/severity changes", () => {
  const database = openDatabase(":memory:");
  const transitions: { readonly checkId: string; readonly state: string }[] = [];
  try {
    const tapService = createTapService(database, { idFactory: ids() });
    const tap = tapService.createTap({ tapNumber: 1, name: "Health tap" });
    const health = createHealthService(database, {
      now: () => new Date(NOW),
      idFactory: ids(),
      onHealthTransition: (_db, context) => {
        transitions.push({ checkId: context.checkId, state: context.current.state });
      },
    });
    health.onTapCreated(database, tap.id, NOW);
    health.evaluateTap(tap.id, NOW);
    const afterFirst = transitions.length;
    health.evaluateTap(tap.id, NOW);
    assert.equal(transitions.length, afterFirst);
    assert.ok(transitions.every((transition) => transition.state !== "not_configured"));
  } finally {
    database.close();
  }
});
