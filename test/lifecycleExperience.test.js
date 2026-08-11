import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import {
  calculateConservativeReceipt,
  claimKickMilestone,
  recordQualifyingPourWithMilestones
} from '../src/lifecycleExperience.js';
import { assignKegLifecycle } from '../src/kegLifecycle.js';

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  db.prepare('INSERT INTO taps (tap_id) VALUES (1)').run();
  db.prepare('INSERT INTO taps (tap_id) VALUES (2)').run();
  return db;
}

function lifecycle(db, tapId = 1, at = '2026-08-01T00:00:00.000Z') {
  const row = assignKegLifecycle(db, { tapId, batchId: `batch-${tapId}`, startedAt: at });
  db.prepare('INSERT INTO lifecycle_milestones (lifecycle_id) VALUES (?)').run(row.lifecycle_id);
  return row;
}

test('first pour milestone is claimed once only', () => {
  const db = database();
  try {
    const active = lifecycle(db);
    const first = recordQualifyingPourWithMilestones(db, {
      tapId: 1,
      lifecycleId: active.lifecycle_id,
      volumePouredOz: 10,
      timestamp: '2026-08-01T01:00:00Z'
    });
    const second = recordQualifyingPourWithMilestones(db, {
      tapId: 1,
      lifecycleId: active.lifecycle_id,
      volumePouredOz: 6,
      timestamp: '2026-08-01T02:00:00Z'
    });
    assert.equal(first.firstPourClaimed, true);
    assert.equal(second.firstPourClaimed, false);
    assert.equal(db.prepare('SELECT first_pour_id FROM lifecycle_milestones').get().first_pour_id, first.pourId);
  } finally {
    db.close();
  }
});

test('a pour keeps its captured lifecycle after reassignment', () => {
  const db = database();
  try {
    const first = lifecycle(db);
    const second = assignKegLifecycle(db, { tapId: 1, batchId: 'new', startedAt: '2026-08-01T00:01:00Z' });
    db.prepare('INSERT INTO lifecycle_milestones (lifecycle_id) VALUES (?)').run(second.lifecycle_id);
    const result = recordQualifyingPourWithMilestones(db, {
      tapId: 1,
      lifecycleId: first.lifecycle_id,
      volumePouredOz: 5,
      timestamp: '2026-08-01T00:02:00Z'
    });
    assert.equal(result.lifecycleId, first.lifecycle_id);
    assert.equal(
      db.prepare('SELECT lifecycle_id FROM pour_logs WHERE id = ?').get(result.pourId).lifecycle_id,
      first.lifecycle_id
    );
  } finally {
    db.close();
  }
});

test('unassigned pours remain unscoped and cannot claim a milestone', () => {
  const db = database();
  try {
    const result = recordQualifyingPourWithMilestones(db, {
      tapId: 2,
      volumePouredOz: 4,
      timestamp: '2026-08-01T00:00:00Z'
    });
    assert.deepEqual(
      { lifecycleId: result.lifecycleId, firstPourClaimed: result.firstPourClaimed },
      { lifecycleId: null, firstPourClaimed: false }
    );
    assert.equal(db.prepare('SELECT lifecycle_id FROM pour_logs WHERE id = ?').get(result.pourId).lifecycle_id, null);
  } finally {
    db.close();
  }
});

test('failed tap clear rolls back an automatic kick and lifecycle close', () => {
  const db = database();
  try {
    const active = lifecycle(db);
    assert.throws(
      () =>
        claimKickMilestone(db, {
          tapId: 1,
          lifecycleId: active.lifecycle_id,
          trigger: 'automatic',
          thresholdOz: 2,
          timestamp: '2026-08-01T03:00:00Z',
          closeLifecycle: true,
          clearTap: () => {
            throw new Error('tap clear failed');
          }
        }),
      /tap clear failed/
    );
    assert.equal(db.prepare('SELECT kicked_at FROM lifecycle_milestones').get().kicked_at, null);
    assert.equal(
      db.prepare('SELECT closed_at FROM keg_lifecycles WHERE lifecycle_id = ?').get(active.lifecycle_id).closed_at,
      null
    );
  } finally {
    db.close();
  }
});

test('kick claim is idempotent and retains the first trigger', () => {
  const db = database();
  try {
    const active = lifecycle(db);
    const first = claimKickMilestone(db, {
      tapId: 1,
      lifecycleId: active.lifecycle_id,
      trigger: 'manual',
      timestamp: '2026-08-01T03:00:00Z'
    });
    const second = claimKickMilestone(db, {
      tapId: 1,
      lifecycleId: active.lifecycle_id,
      trigger: 'automatic',
      thresholdOz: 1,
      timestamp: '2026-08-01T04:00:00Z'
    });
    assert.equal(first.claimed, true);
    assert.deepEqual({ claimed: second.claimed, idempotent: second.idempotent }, { claimed: false, idempotent: true });
    assert.equal(second.milestone.kick_trigger, 'manual');
  } finally {
    db.close();
  }
});

test('receipt is conservative across estimate, measurement, capacity, and serving display', () => {
  assert.deepEqual(
    calculateConservativeReceipt({
      startVolumeOz: 100,
      volumePouredOz: 12,
      currentMeasuredOz: 91,
      capacityOz: 96,
      displayUnit: 'pours_custom',
      customServingSizeOz: 12
    }),
    {
      displayUnit: 'pours_custom',
      servingSizeOz: 12,
      provisional: { remainingOz: 88, servings: 88 / 12 },
      final: { remainingOz: 88, servings: 88 / 12 }
    }
  );
});
