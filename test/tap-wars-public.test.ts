import assert from "node:assert/strict";
import test from "node:test";

import { PublicTapWarsService } from "../src/features/tap-wars/public.ts";
import type { TapWar } from "../src/features/tap-wars/types.ts";

const SECRET = "MYSTERY_SENTINEL_TAP_WARS_NEVER_PUBLIC";
const firstTapId = "00000000-0000-4000-8000-000000000001";
const secondTapId = "00000000-0000-4000-8000-000000000002";
const firstAssignmentId = "00000000-0000-4000-8000-000000000011";
const secondAssignmentId = "00000000-0000-4000-8000-000000000012";

function war(status: TapWar["status"] = "active"): TapWar {
  return {
    id: "00000000-0000-4000-8000-000000000078",
    status,
    result: status === "completed" ? "side1" : null,
    startedAt: "2026-08-17T12:00:00.000Z",
    pausedAt: status === "paused" ? "2026-08-17T12:01:00.000Z" : null,
    pausedReason: status === "paused" ? "disabled" : null,
    completedAt: status === "completed" ? "2026-08-17T12:02:00.000Z" : null,
    publishedAt: status === "completed" ? "2026-08-17T12:02:00.000Z" : null,
    dismissedAt: null,
    completionPublicTitleSide1: `${SECRET} old public title`,
    completionPublicTitleSide2: "Old public title two",
    completionAdminTitleSide1: `${SECRET} real admin title`,
    completionAdminTitleSide2: "Admin title two",
    competitors: [
      {
        side: 1,
        assignmentId: firstAssignmentId,
        tapId: firstTapId,
        fillId: `${SECRET}-fill`,
        beverageId: `${SECRET}-beverage`,
        tapNumber: 1,
        adminBeverageTitle: `${SECRET} real beverage`,
        voteCount: 7,
        finalVoteCount: status === "completed" ? 7 : null,
        eligibility: { eligible: true, reason: null },
      },
      {
        side: 2,
        assignmentId: secondAssignmentId,
        tapId: secondTapId,
        fillId: "fill-two",
        beverageId: "beverage-two",
        tapNumber: 2,
        adminBeverageTitle: "Admin title two",
        voteCount: 3,
        finalVoteCount: status === "completed" ? 3 : null,
        eligibility: { eligible: true, reason: null },
      },
    ],
  };
}

function projection(input: TapWar, firstTitle: string, assignmentCurrent = true) {
  const tapWarsService = {
    getVisible: () => input,
    listEligibleParticipants: () => [],
  };
  const tapService = {
    getTap: (tapId: string) => ({
      enabled: true,
      isRetired: false,
      activeAssignment: {
        id:
          tapId === firstTapId
            ? assignmentCurrent
              ? firstAssignmentId
              : "00000000-0000-4000-8000-000000000099"
            : secondAssignmentId,
      },
    }),
  };
  const storyService = {
    getCard: (tapId: string) => ({ title: tapId === firstTapId ? firstTitle : "Public Two" }),
  };
  return new PublicTapWarsService({
    tapWarsService: tapWarsService as never,
    tapService: tapService as never,
    storyService: storyService as never,
  }).getVisible();
}

void test("public Tap Wars projection strips assignment, Fill, Beverage, and Admin identity", () => {
  const view = projection(war(), "Mystery Tap");
  assert.equal(view?.side1.title, "Mystery Tap");
  assert.deepEqual([view?.side1.percentage, view?.side2.percentage], [70, 30]);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(SECRET), false);
  for (const forbidden of [
    "assignmentId",
    "fillId",
    "beverageId",
    "adminBeverageTitle",
    "completionPublicTitle",
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});

void test("completed public result uses current Mystery-safe identity while final votes stay frozen", () => {
  const hidden = projection(war("completed"), "Mystery Tap");
  assert.equal(hidden?.side1.title, "Mystery Tap");
  assert.deepEqual([hidden?.side1.voteCount, hidden?.side2.voteCount], [7, 3]);
  assert.equal(JSON.stringify(hidden).includes(SECRET), false);

  const revealed = projection(war("completed"), "Currently Public Name");
  assert.equal(revealed?.side1.title, "Currently Public Name");
  assert.deepEqual([revealed?.side1.voteCount, revealed?.side2.voteCount], [7, 3]);

  const replaced = projection(war("completed"), "Replacement Name", false);
  assert.equal(replaced?.side1.title, "Mystery Tap");
  assert.equal(replaced?.side1.isCardParticipant, false);
  assert.equal(JSON.stringify(replaced).includes("Replacement Name"), false);
});
