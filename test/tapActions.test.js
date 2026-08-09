import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import { assignKegLifecycle } from '../src/kegLifecycle.js';
import { TapMutationCoordinator } from '../src/tapActions.js';

function database() {
  const db = new Database(':memory:');
  migrateDatabase(db);
  db.prepare("INSERT INTO settings (id, admin_pin_hash, admin_pin_initialized) VALUES(1, 'hash', 1)").run();
  for (let tapId = 1; tapId <= 6; tapId++) db.prepare('INSERT INTO taps (tap_id) VALUES (?)').run(tapId);
  db.prepare(
    "INSERT INTO batches(batch_id, recipe_name, style, status) VALUES('batch-a', 'IPA', 'American IPA', 'Conditioning')"
  ).run();
  return db;
}

function assign(db, batchId = 'batch-a', startedAt = '2026-08-01T00:00:00.000Z') {
  return assignKegLifecycle(db, {
    tapId: 1,
    batchId,
    assignmentKind: batchId.startsWith('custom:') ? 'custom' : 'brewfather',
    startedAt,
    updateTap: () => db.prepare('UPDATE taps SET batch_id=?, on_tap_at=? WHERE tap_id=1').run(batchId, startedAt)
  });
}

test('End Batch performs one exact remote completion before closing local state', async () => {
  const db = database();
  const lifecycle = assign(db);
  const calls = [];
  try {
    const actions = new TapMutationCoordinator({
      db,
      completeBatch: async (batchId) => calls.push(batchId),
      now: () => new Date('2026-08-09T12:00:00.000Z')
    });
    const result = await actions.endBatch(1);
    assert.deepEqual(calls, ['batch-a']);
    assert.equal(result.lifecycle.lifecycle_id, lifecycle.lifecycle_id);
    assert.equal(db.prepare('SELECT batch_id FROM taps WHERE tap_id=1').get().batch_id, null);
    assert.deepEqual(
      db.prepare('SELECT closed_at, close_reason FROM keg_lifecycles WHERE lifecycle_id=?').get(lifecycle.lifecycle_id),
      { closed_at: '2026-08-09T12:00:00.000Z', close_reason: 'end_batch' }
    );
    assert.equal(db.prepare("SELECT status FROM batches WHERE batch_id='batch-a'").get().status, 'Completed');
  } finally {
    db.close();
  }
});

test('failed completion leaves the assignment and lifecycle unchanged', async () => {
  const db = database();
  const lifecycle = assign(db);
  try {
    const actions = new TapMutationCoordinator({
      db,
      completeBatch: async () => {
        throw new Error('offline');
      }
    });
    await assert.rejects(actions.endBatch(1), /offline/);
    assert.equal(db.prepare('SELECT batch_id FROM taps WHERE tap_id=1').get().batch_id, 'batch-a');
    assert.equal(
      db.prepare('SELECT closed_at FROM keg_lifecycles WHERE lifecycle_id=?').get(lifecycle.lifecycle_id).closed_at,
      null
    );
  } finally {
    db.close();
  }
});

test('End Keg is local-only and the same batch can open a new immutable lifecycle', async () => {
  const db = database();
  const first = assign(db);
  let completionCalls = 0;
  try {
    const actions = new TapMutationCoordinator({
      db,
      completeBatch: async () => {
        completionCalls += 1;
      },
      now: () => new Date('2026-08-09T12:00:00.000Z')
    });
    await actions.endKeg(1);
    const second = assign(db, 'batch-a', '2026-08-10T00:00:00.000Z');
    assert.equal(completionCalls, 0);
    assert.notEqual(second.lifecycle_id, first.lifecycle_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM keg_lifecycles WHERE batch_id=?').get('batch-a').count, 2);
  } finally {
    db.close();
  }
});

test('custom beverages can end locally but can never invoke Brewfather completion', async () => {
  const db = database();
  assign(db, 'custom:topo_chico');
  let completionCalls = 0;
  try {
    const actions = new TapMutationCoordinator({
      db,
      completeBatch: async () => {
        completionCalls += 1;
      }
    });
    await assert.rejects(actions.endBatch(1), /Custom beverages/);
    assert.equal(completionCalls, 0);
    await actions.endKeg(1);
    assert.equal(completionCalls, 0);
  } finally {
    db.close();
  }
});
