import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { TapWarService, tapWarPercentages } from "../src/features/tap-wars/service.ts";
import { requireSides } from "../src/features/tap-wars/validators.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const at = "2026-08-17T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup(options: ConstructorParameters<typeof TapWarService>[1] = {}) {
  const database = openDatabase(":memory:");
  let ids = 900;
  const service = new TapWarService(database, {
    now: () => new Date(at),
    idFactory: () => uuid(ids++),
    ...options,
  });
  const add = (n: number, state: { enabled?: number; retired?: boolean; ended?: boolean } = {}) => {
    const tap = uuid(n),
      beverage = uuid(n + 100),
      keg = uuid(n + 200),
      fill = uuid(n + 300),
      assignment = uuid(n + 400);
    database
      .prepare(
        "INSERT INTO taps (id,tap_number,enabled,retired_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(tap, n, state.enabled ?? 1, state.retired ? at : null, at, at);
    database
      .prepare(
        "INSERT INTO beverages (id,ownership_type,created_at,updated_at) VALUES (?,'custom',?,?)",
      )
      .run(beverage, at, at);
    database
      .prepare(
        "INSERT INTO custom_beverage_profiles (beverage_id,name,beverage_type,created_at,updated_at) VALUES (?,?,'beer',?,?)",
      )
      .run(beverage, `Admin Beer ${n}`, at, at);
    database
      .prepare(
        "INSERT INTO kegs (id,keg_number,capacity_ml,current_tare_g,created_at,updated_at) VALUES (?,?,19000,4000,?,?)",
      )
      .run(keg, n, at, at);
    database
      .prepare(
        "INSERT INTO fills (id,beverage_id,keg_id,fill_date,ended_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(fill, beverage, keg, "2026-08-17", state.ended ? at : null, at, at);
    database
      .prepare(
        "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,ended_at,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(assignment, tap, fill, at, state.ended ? at : null, at);
    return { tap, fill, assignment };
  };
  return { database, service, add };
}
function conflict(code: string) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.category === "conflict" && error.code === code;
}

void test("Tap War display percentages are deterministic and total one hundred", () => {
  assert.equal(tapWarPercentages(0, 0), null);
  assert.deepEqual(tapWarPercentages(1, 2), { side1: 33, side2: 67 });
  assert.deepEqual(tapWarPercentages(2, 1), { side1: 67, side2: 33 });
  assert.deepEqual(tapWarPercentages(1, 1), { side1: 50, side2: 50 });
  assert.throws(() => tapWarPercentages(-1, 1), RangeError);
  assert.throws(() => tapWarPercentages(1.5, 1), RangeError);
});

void test("Tap War start input requires two distinct assignment UUIDs", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(
    requireSides({ competitor1AssignmentId: first, competitor2AssignmentId: second }),
    [first, second],
  );
  assert.throws(() =>
    requireSides({ competitor1AssignmentId: first, competitor2AssignmentId: first }),
  );
});

void test("start lists eligible participants, snapshots admin data, and rejects unfinished or ineligible wars", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      disabled = add(3, { enabled: 0 }),
      retired = add(4, { retired: true }),
      ended = add(5, { ended: true });
    assert.deepEqual(
      service.listEligibleParticipants().map((p) => p.assignmentId),
      [one.assignment, two.assignment],
    );
    const war = service.start([one.assignment, two.assignment], { actorId: "admin-identity" });
    assert.equal(war.status, "active");
    assert.deepEqual(
      war.competitors.map((c) => c.adminBeverageTitle),
      ["Admin Beer 1", "Admin Beer 2"],
    );
    assert.deepEqual(
      war.competitors.map((c) => c.publicTitleFallback),
      ["Mystery Tap", "Mystery Tap"],
    );
    assert.throws(
      () => service.start([one.assignment, two.assignment]),
      conflict("tap_war.unfinished_exists"),
    );
    for (const invalid of [disabled.assignment, retired.assignment, ended.assignment])
      assert.throws(
        () => new TapWarService(database).start([one.assignment, invalid]),
        conflict("tap_war.unfinished_exists"),
      );
  } finally {
    database.close();
  }
});

void test("start rejects disabled, retired, ended, duplicate, and same-tap competitors before a war exists", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      disabled = add(2, { enabled: 0 }),
      retired = add(3, { retired: true }),
      ended = add(4, { ended: true });
    assert.throws(() => service.start([one.assignment, one.assignment]));
    for (const invalid of [disabled.assignment, retired.assignment, ended.assignment])
      assert.throws(
        () => service.start([one.assignment, invalid]),
        conflict("tap_war.ineligible_competitor"),
      );
  } finally {
    database.close();
  }
});

void test("vote increments only requested side, serializes repeated calls, and rejects invalid current state", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    for (let i = 0; i < 20; i++) service.vote(war.id, 1);
    assert.deepEqual(
      service.vote(war.id, 2).competitors.map((c) => c.voteCount),
      [20, 1],
    );
    assert.throws(() => service.vote(uuid(777), 1), conflict("tap_war.not_current"));
    assert.throws(() => service.vote(war.id, 3), conflict("tap_war.invalid_side"));
    service.pauseForTapUnavailable(database, one.tap, at);
    assert.throws(() => service.vote(war.id, 1), conflict("tap_war.not_active"));
  } finally {
    database.close();
  }
});

void test("database triggers reject arbitrary vote deltas, decrements, and completed mutations", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    assert.throws(() =>
      database
        .prepare("UPDATE tap_war_competitors SET vote_count=vote_count+2 WHERE war_id=? AND side=1")
        .run(war.id),
    );
    assert.throws(() =>
      database
        .prepare("UPDATE tap_war_competitors SET vote_count=vote_count-1 WHERE war_id=? AND side=1")
        .run(war.id),
    );
    assert.throws(() =>
      database
        .prepare(
          "UPDATE tap_war_competitors SET vote_count=vote_count+1, final_vote_count=vote_count WHERE war_id=? AND side=1",
        )
        .run(war.id),
    );
    const done = service.stop(war.id);
    assert.equal(done.result, "tie");
    assert.deepEqual(
      done.competitors.map((c) => c.finalVoteCount),
      [0, 0],
    );
    assert.throws(() => service.stop(war.id), conflict("tap_war.completed"));
    assert.throws(() => service.vote(war.id, 1), conflict("tap_war.not_current"));
    assert.throws(() =>
      database
        .prepare("UPDATE tap_war_competitors SET vote_count=vote_count+1 WHERE war_id=? AND side=1")
        .run(war.id),
    );
    assert.throws(() =>
      database.prepare("UPDATE tap_wars SET result='side1' WHERE id=?").run(war.id),
    );
    assert.throws(() =>
      database.prepare("UPDATE tap_wars SET started_at=? WHERE id=?").run("2030-01-01", war.id),
    );
    service.dismissPublicResult(war.id);
    assert.throws(() =>
      database.prepare("UPDATE tap_wars SET dismissed_at=NULL WHERE id=?").run(war.id),
    );
  } finally {
    database.close();
  }
});

void test("pause hooks persist activity and pause state; re-enable does not resume and stop remains allowed", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    database.withTransaction(() => {
      service.pauseForAssignmentClose(database, one.assignment, at);
      database
        .prepare("UPDATE tap_assignment_lifecycles SET ended_at=? WHERE id=?")
        .run(at, one.assignment);
    });
    assert.equal(service.getById(war.id)!.pausedReason, "original_assignment_ended_or_replaced");
    assert.equal(
      database
        .prepare<[string], { readonly n: number }>(
          "SELECT count(*) AS n FROM activity_log WHERE entity_id=?",
        )
        .get(war.id)!.n,
      2,
    );
    database.prepare("UPDATE taps SET enabled=0 WHERE id=?").run(two.tap);
    database.prepare("UPDATE taps SET enabled=1 WHERE id=?").run(two.tap);
    assert.throws(() => service.resume(war.id), conflict("tap_war.cannot_resume"));
    assert.equal(service.stop(war.id).status, "completed");
  } finally {
    database.close();
  }
});

void test("assignment loss preserves the last safe public title and frozen votes", () => {
  let currentTitle: string | null = "House IPA";
  const { database, service, add } = setup({ publicTitleResolver: () => currentTitle });
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    service.vote(war.id, 1);
    database.withTransaction(() => {
      service.pauseForAssignmentClose(database, one.assignment, at);
      database
        .prepare("UPDATE tap_assignment_lifecycles SET ended_at=? WHERE id=?")
        .run(at, one.assignment);
    });
    currentTitle = null;

    const stopped = service.stop(war.id);
    assert.equal(stopped.completionPublicTitleSide1, "House IPA");
    assert.deepEqual(
      stopped.competitors.map((competitor) => competitor.finalVoteCount),
      [1, 0],
    );
    assert.equal(stopped.competitors[0].publicTitleFallback, "House IPA");
  } finally {
    database.close();
  }
});

void test("fallback refresh is limited to the current or still-published war", () => {
  let currentTitle: string | null = "House IPA";
  const { database, service, add } = setup({ publicTitleResolver: () => currentTitle });
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    const stopped = service.stop(war.id);
    currentTitle = "Updated House IPA";
    service.refreshPublicTitleFallback(database, one.tap, one.assignment);
    assert.equal(service.getById(war.id)!.competitors[0].publicTitleFallback, "Updated House IPA");
    assert.equal(stopped.completionPublicTitleSide1, "House IPA");

    service.dismissPublicResult(war.id);
    currentTitle = "Should Not Persist";
    service.refreshPublicTitleFallback(database, one.tap, one.assignment);
    assert.equal(service.getById(war.id)!.competitors[0].publicTitleFallback, "Updated House IPA");
  } finally {
    database.close();
  }
});

void test("Mystery changes refresh the visible fallback in-transaction before assignment loss", () => {
  let currentTitle: string | null = "House IPA";
  const { database, service, add } = setup({ publicTitleResolver: () => currentTitle });
  try {
    const one = add(1),
      two = add(2),
      warService = service,
      war = warService.start([one.assignment, two.assignment]);
    let mysteryChangedCalls = 0;
    const tapService = createTapService(database, {
      now: () => new Date(at),
      extensionPort: {
        onAssignmentOpened: () => undefined,
        onAssignmentClosed: (db, context) => {
          warService.pauseForAssignmentClose(db, context.assignmentId, context.occurredAt);
        },
        onAssignmentMysteryChanged: (db, context) => {
          mysteryChangedCalls += 1;
          warService.refreshPublicTitleFallback(db, context.tapId, context.assignmentId);
        },
      },
    });

    currentTitle = "Mystery Tap";
    const mysteryInput = {
      enabled: true,
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
    };
    const changed = tapService.updateAssignmentMystery(one.tap, mysteryInput);
    assert.equal(changed.changed, true);
    assert.equal(mysteryChangedCalls, 1);
    assert.equal(warService.getById(war.id)!.competitors[0].publicTitleFallback, "Mystery Tap");
    assert.equal(tapService.updateAssignmentMystery(one.tap, mysteryInput).changed, false);
    assert.equal(mysteryChangedCalls, 1);

    tapService.unassign(one.tap);
    currentTitle = null;
    const stopped = warService.stop(war.id);
    assert.equal(stopped.completionPublicTitleSide1, "Mystery Tap");
    assert.deepEqual(
      stopped.competitors.map((competitor) => competitor.finalVoteCount),
      [0, 0],
    );
  } finally {
    database.close();
  }
});

void test("completion snapshots callback-safe public titles, freezes results, dismisses publication, and preserves history", () => {
  const { database, service, add } = setup({
    publicTitleResolver: (tap) => (tap === uuid(1) ? "Public One" : "Mystery Tap"),
  });
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    service.vote(war.id, 1);
    const complete = service.stop(war.id, { actorId: "admin-identity" });
    assert.equal(complete.result, "side1");
    assert.deepEqual(
      complete.competitors.map((c) => c.finalVoteCount),
      [1, 0],
    );
    assert.equal(complete.completionPublicTitleSide1, "Public One");
    assert.equal(complete.completionPublicTitleSide2, "Mystery Tap");
    assert.deepEqual(
      [complete.completionAdminTitleSide1, complete.completionAdminTitleSide2],
      ["Admin Beer 1", "Admin Beer 2"],
    );
    service.dismissPublicResult(war.id);
    assert.equal(service.getPublishedResult(), undefined);
    assert.equal(service.getVisible(), undefined);
    assert.equal(service.listHistory().length, 1);
  } finally {
    database.close();
  }
});

void test("new start supersedes published completion and completed history is newest first", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      three = add(3),
      four = add(4);
    const old = service.start([one.assignment, two.assignment]);
    service.stop(old.id);
    const next = service.start([three.assignment, four.assignment]);
    assert.equal(service.getById(old.id)!.dismissedAt, at);
    assert.equal(service.getVisible()!.id, next.id);
    service.stop(next.id);
    assert.deepEqual(
      service.listCompletedHistory().map((war) => war.id),
      [next.id, old.id],
    );
  } finally {
    database.close();
  }
});

void test("disabled participant pauses, re-enable keeps paused, and explicit resume restores voting", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      war = service.start([one.assignment, two.assignment]);
    database.prepare("UPDATE taps SET enabled=0 WHERE id=?").run(one.tap);
    assert.throws(() => service.vote(war.id, 1), conflict("tap_war.ineligible"));
    assert.equal(service.getById(war.id)!.pausedReason, "disabled");
    database.prepare("UPDATE taps SET enabled=1 WHERE id=?").run(one.tap);
    assert.equal(service.getById(war.id)!.status, "paused");
    assert.equal(service.resume(war.id).status, "active");
    assert.deepEqual(
      service.vote(war.id, 2).competitors.map((competitor) => competitor.voteCount),
      [0, 1],
    );
  } finally {
    database.close();
  }
});

void test("ended and replaced assignment cannot resume or inherit its prior votes", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      replacement = add(3),
      war = service.start([one.assignment, two.assignment]);
    service.vote(war.id, 1);
    database.withTransaction(() => {
      service.pauseForAssignmentClose(database, one.assignment, at);
      database
        .prepare("UPDATE tap_assignment_lifecycles SET ended_at=? WHERE id=?")
        .run(at, one.assignment);
      database
        .prepare("UPDATE tap_assignment_lifecycles SET ended_at=? WHERE id=?")
        .run(at, replacement.assignment);
      database
        .prepare(
          "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?,?,?,?,?)",
        )
        .run(uuid(888), one.tap, replacement.fill, at, at);
    });
    assert.throws(() => service.resume(war.id), conflict("tap_war.cannot_resume"));
    const paused = service.getById(war.id)!;
    assert.deepEqual(
      paused.competitors.map((competitor) => competitor.voteCount),
      [1, 0],
    );
    assert.equal(paused.competitors[0].assignmentId, one.assignment);
  } finally {
    database.close();
  }
});

void test("source deletion leaves copied active and completed Tap War snapshots readable", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      active = service.start([one.assignment, two.assignment]);
    database.prepare("DELETE FROM beverages WHERE id=?").run(uuid(101));
    const surviving = service.getById(active.id)!;
    assert.equal(surviving.competitors[0].fillId, one.fill);
    assert.equal(surviving.competitors[0].eligibility.eligible, false);
    assert.throws(() => service.vote(active.id, 1), conflict("tap_war.ineligible"));
    const completed = service.stop(active.id);
    assert.equal(service.listHistory()[0]!.id, completed.id);
    assert.equal(service.getById(completed.id)!.competitors[0].adminBeverageTitle, "Admin Beer 1");
  } finally {
    database.close();
  }
});

void test("stop freezes each positive winner and tie outcome at the exact ordering boundary", () => {
  const { database, service, add } = setup();
  try {
    const one = add(1),
      two = add(2),
      three = add(3),
      four = add(4),
      five = add(5),
      six = add(6);
    const side1 = service.start([one.assignment, two.assignment]);
    service.vote(side1.id, 1);
    service.vote(side1.id, 1);
    service.vote(side1.id, 2);
    assert.equal(service.stop(side1.id).result, "side1");
    const side2 = service.start([three.assignment, four.assignment]);
    service.vote(side2.id, 2);
    assert.equal(service.stop(side2.id).result, "side2");
    const tie = service.start([five.assignment, six.assignment]);
    service.vote(tie.id, 1);
    service.vote(tie.id, 2);
    const done = service.stop(tie.id);
    assert.equal(done.result, "tie");
    assert.deepEqual(
      done.competitors.map((competitor) => competitor.finalVoteCount),
      [1, 1],
    );
    assert.throws(() => service.vote(done.id, 1), conflict("tap_war.not_current"));
  } finally {
    database.close();
  }
});
