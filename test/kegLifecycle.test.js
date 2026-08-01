import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import {
  activeLifecycle,
  assignKegLifecycle,
  captureActiveLifecycle,
  closeKegLifecycle,
  recordPour
} from '../src/kegLifecycle.js';
import { calculateKegKickForecast } from '../src/kegForecast.js';

function database() {
  const db = new Database(':memory:');
  migrateDatabase(db);
  for (let tapId = 1; tapId <= 2; tapId++) db.prepare('INSERT INTO taps (tap_id) VALUES (?)').run(tapId);
  return db;
}

test('assignment, reassignment, and close preserve immutable lifecycle history', () => {
  const db = database();
  try {
    const first = assignKegLifecycle(db, { tapId: 1, batchId: 'same-batch', startedAt: '2026-08-01T00:00:00.000Z' });
    recordPour(db, {
      tapId: 1,
      lifecycleId: first.lifecycle_id,
      volumePouredOz: 10,
      timestamp: '2026-08-01T01:00:00.000Z'
    });
    const second = assignKegLifecycle(db, { tapId: 1, batchId: 'same-batch', startedAt: '2026-08-02T00:00:00.000Z' });
    recordPour(db, {
      tapId: 1,
      lifecycleId: second.lifecycle_id,
      volumePouredOz: 5,
      timestamp: '2026-08-02T01:00:00.000Z'
    });
    assert.notEqual(first.lifecycle_id, second.lifecycle_id);
    assert.equal(
      db
        .prepare('SELECT closed_at IS NOT NULL AS closed FROM keg_lifecycles WHERE lifecycle_id = ?')
        .get(first.lifecycle_id).closed,
      1
    );
    assert.deepEqual(db.prepare('SELECT lifecycle_id, volume_poured_oz FROM pour_logs ORDER BY id').all(), [
      { lifecycle_id: first.lifecycle_id, volume_poured_oz: 10 },
      { lifecycle_id: second.lifecycle_id, volume_poured_oz: 5 }
    ]);
    closeKegLifecycle(db, { tapId: 1, closedAt: '2026-08-03T00:00:00.000Z' });
    assert.equal(activeLifecycle(db, 1), null);
  } finally {
    db.close();
  }
});

test('a pour completing after reassignment remains attributed to its start-time lifecycle', () => {
  const db = database();
  try {
    const first = assignKegLifecycle(db, { tapId: 1, batchId: 'first', startedAt: '2026-08-01T00:00:00.000Z' });
    const captured = captureActiveLifecycle(db, 1);
    const second = assignKegLifecycle(db, { tapId: 1, batchId: 'second', startedAt: '2026-08-01T00:00:05.000Z' });
    recordPour(db, {
      tapId: 1,
      lifecycleId: captured.lifecycle_id,
      volumePouredOz: 6,
      timestamp: '2026-08-01T00:00:10.000Z'
    });
    assert.notEqual(first.lifecycle_id, second.lifecycle_id);
    assert.deepEqual(db.prepare('SELECT lifecycle_id, batch_id FROM pour_logs').get(), {
      lifecycle_id: first.lifecycle_id,
      batch_id: 'first'
    });
  } finally {
    db.close();
  }
});

test('a pour without an assignment is durable and explicitly unscoped', () => {
  const db = database();
  try {
    recordPour(db, { tapId: 2, volumePouredOz: 4, timestamp: '2026-08-01T00:00:00.000Z' });
    assert.deepEqual(db.prepare('SELECT volume_poured_oz, lifecycle_id, timestamp_epoch FROM pour_logs').get(), {
      volume_poured_oz: 4,
      lifecycle_id: null,
      timestamp_epoch: 1785542400
    });
  } finally {
    db.close();
  }
});

test('forecast includes only the open lifecycle, even for successive same-batch kegs', () => {
  const db = database();
  try {
    assignKegLifecycle(db, { tapId: 1, batchId: 'same', startedAt: '2026-07-20T00:00:00.000Z' });
    recordPour(db, {
      tapId: 1,
      lifecycleId: activeLifecycle(db, 1).lifecycle_id,
      volumePouredOz: 120,
      timestamp: '2026-07-30T00:00:00.000Z'
    });
    assignKegLifecycle(db, { tapId: 1, batchId: 'same', startedAt: '2026-08-01T00:00:00.000Z' });
    recordPour(db, {
      tapId: 1,
      lifecycleId: activeLifecycle(db, 1).lifecycle_id,
      volumePouredOz: 12,
      timestamp: '2026-08-01T12:00:00.000Z'
    });
    assert.deepEqual(
      calculateKegKickForecast({ db, tapId: 1, currentOz: 120, nowMs: Date.parse('2026-08-02T00:00:00.000Z') }),
      { avgDailyOz: 12, estimatedDaysRemaining: 10, hasUsageData: true }
    );
    assert.match(
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT SUM(volume_poured_oz) FROM pour_logs
      WHERE lifecycle_id = ? AND timestamp_epoch >= ?`
        )
        .all(activeLifecycle(db, 1).lifecycle_id, 0)
        .map((row) => row.detail)
        .join(' '),
      /pour_logs_lifecycle_epoch/
    );
  } finally {
    db.close();
  }
});
