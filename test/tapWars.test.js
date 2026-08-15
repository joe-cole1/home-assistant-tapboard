import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import { assignKegLifecycle, closeKegLifecycle } from '../src/kegLifecycle.js';
import {
  createBattleDraft,
  startBattle,
  recordVote,
  endBattle,
  revealBattle,
  checkActiveBattleLifecycleInvalidation,
  getActiveBattle,
  getBattleHistory
} from '../src/tapWars.js';

function database() {
  const db = new Database(':memory:');
  migrateDatabase(db);
  for (let tapId = 1; tapId <= 6; tapId++) {
    db.prepare('INSERT INTO taps (tap_id, enabled) VALUES (?, 1)').run(tapId);
    assignKegLifecycle(db, { tapId, batchId: `batch-${tapId}`, startedAt: '2026-08-12T00:00:00.000Z' });
  }
  return db;
}

test('tap wars full state machine lifecycle: draft -> active -> voting -> end -> reveal', () => {
  const db = database();
  try {
    // 1. Create Draft
    const draft = createBattleDraft(db, {
      contestant_a_tap_id: 1,
      contestant_b_tap_id: 2,
      title: 'IPA Showdown',
      description_copy: 'Hazy vs West Coast',
      theme: 'ipa_showdown'
    });
    assert.equal(draft.state, 'draft');
    assert.equal(draft.contestantATapId, 1);
    assert.equal(draft.contestantBTapId, 2);

    // 2. Start Battle
    let startedEventFired = false;
    const active = startBattle(db, draft.battleId, {
      onStarted: () => {
        startedEventFired = true;
      }
    });
    assert.equal(active.state, 'active');
    assert.equal(startedEventFired, true);

    // Only 1 battle can be active concurrently
    const draft2 = createBattleDraft(db, {
      contestant_a_tap_id: 3,
      contestant_b_tap_id: 4,
      title: 'Lager Clash'
    });
    assert.throws(() => {
      startBattle(db, draft2.battleId);
    }, /Another Tap War is already active/i);

    // 3. Record Votes
    const vote1 = recordVote(db, { battleId: active.battleId, contestantSide: 'A' });
    const vote2 = recordVote(db, { battleId: active.battleId, contestantSide: 'A' });
    const vote3 = recordVote(db, { battleId: active.battleId, contestantSide: 'B' });
    assert.equal(vote1.contestantAVoteCount, 1);
    assert.equal(vote2.contestantAVoteCount, 2);
    assert.equal(vote3.contestantBVoteCount, 1);

    // 4. End Battle
    let endedEventFired = false;
    const ended = endBattle(db, active.battleId, {
      reason: 'admin_ended',
      onEnded: () => {
        endedEventFired = true;
      }
    });
    assert.equal(ended.state, 'ended');
    assert.equal(endedEventFired, true);

    // Cannot vote when ended
    assert.throws(() => {
      recordVote(db, { battleId: active.battleId, contestantSide: 'A' });
    }, /Voting has ended/i);

    // 5. Reveal Battle
    const revealed = revealBattle(db, active.battleId);
    assert.equal(revealed.state, 'revealed');
    assert.equal(revealed.winnerSide, 'A');
    assert.equal(revealed.contestantA.voteCount, 2);
    assert.equal(revealed.contestantB.voteCount, 1);
  } finally {
    db.close();
  }
});

test('tap reassignment or keg end auto-ends active battle with lifecycle invalidation', () => {
  const db = database();
  try {
    const draft = createBattleDraft(db, { contestant_a_tap_id: 1, contestant_b_tap_id: 2, title: 'Test Battle' });
    const active = startBattle(db, draft.battleId);
    assert.equal(active.state, 'active');

    recordVote(db, { battleId: active.battleId, contestantSide: 'B' });

    // End keg on Tap 1
    const lc = closeKegLifecycle(db, { tapId: 1, closedAt: '2026-08-12T12:00:00.000Z', closeReason: 'kicked' });
    let endedEventFired = false;
    checkActiveBattleLifecycleInvalidation(db, {
      tapId: 1,
      lifecycleId: lc.lifecycle_id,
      reason: 'kicked',
      onEnded: () => {
        endedEventFired = true;
      }
    });

    const current = getActiveBattle(db, { isAdmin: true });
    assert.equal(current.state, 'ended');

    const history = getBattleHistory(db, { isAdmin: true });
    assert.equal(history.length, 1);
    assert.equal(history[0].state, 'ended');
    assert.equal(history[0].end_reason, 'keg_ended');
    assert.equal(history[0].contestant_b_votes, 1);
    assert.equal(endedEventFired, true);
  } finally {
    db.close();
  }
});
