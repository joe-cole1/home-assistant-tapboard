import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import { BrewfatherSync } from '../src/brewfatherSync.js';

function database({ visible = 0 } = {}) {
  const db = new Database(':memory:');
  migrateDatabase(db);
  db.prepare(
    `INSERT INTO settings (id, admin_pin_hash, admin_pin_initialized, ondeck_new_batch_default)
     VALUES (1, 'hash', 1, ?)`
  ).run(visible);
  for (let tapId = 1; tapId <= 6; tapId++) db.prepare('INSERT INTO taps (tap_id) VALUES (?)').run(tapId);
  return db;
}

function budgetClient(overrides = {}) {
  let used = 0;
  return {
    getBudgetStatus: () => ({ used }),
    listBatchesByStatuses: async () => {
      used += 1;
      return { batches: [{ id: 'one', status: 'Planning', name: 'One' }], failures: [] };
    },
    getBatch: async () => {
      used += 1;
      return { id: 'one', status: 'Planning', recipe: { name: 'One' } };
    },
    getLatestReading: async () => {
      used += 1;
      return null;
    },
    getReadings: async () => {
      used += 1;
      return [];
    },
    ...overrides
  };
}

test('sync coalesces overlapping callers and reports one shared successful cycle', async () => {
  const db = database();
  let resolve;
  const client = budgetClient({
    listBatchesByStatuses: () => new Promise((done) => (resolve = done))
  });
  try {
    const sync = new BrewfatherSync({ db, client, now: () => 1_700_000_000_000 });
    const one = sync.refresh({ reason: 'manual' });
    const two = sync.refresh({ reason: 'scheduled' });
    assert.equal(one.requestStatus, 'started');
    assert.equal(two.requestStatus, 'coalesced');
    assert.equal(one.promise, two.promise);
    resolve({ batches: [{ id: 'one', status: 'Planning' }], failures: [] });
    assert.equal((await one.promise).outcome, 'succeeded');
    assert.equal(db.prepare('SELECT status FROM brewfather_sync_state WHERE id=1').get().status, 'ok');
  } finally {
    db.close();
  }
});

test('status/page failure keeps last-known-good cache and does not mark absent rows', async () => {
  const db = database();
  const client = budgetClient();
  try {
    const sync = new BrewfatherSync({ db, client, now: () => 1_700_000_000_000 });
    assert.equal((await sync.refresh().promise).outcome, 'succeeded');
    client.listBatchesByStatuses = async () => ({
      batches: [],
      failures: [{ status: 'Planning', error: { category: 'network' } }]
    });
    const failed = await sync.refresh().promise;
    assert.equal(failed.outcome, 'stale_cache');
    assert.equal(failed.errorCategory, 'network');
    assert.equal(db.prepare('SELECT present FROM batches WHERE batch_id=?').get('one').present, 1);
    assert.equal(db.prepare('SELECT status FROM brewfather_sync_state WHERE id=1').get().status, 'stale_cache');
  } finally {
    db.close();
  }
});

test('unconfigured coordinator starts safely and distinguishes empty from stale cache', async () => {
  const db = database();
  try {
    const sync = new BrewfatherSync({ db, client: null, now: () => 1_700_000_000_000 });
    assert.deepEqual(await sync.refresh().promise, {
      outcome: 'failed',
      errorCategory: 'configuration',
      reason: 'manual',
      summaries: 0,
      requestCount: 0
    });
    db.prepare("INSERT INTO batches(batch_id, recipe_name, status) VALUES('cached', 'Cached', 'Completed')").run();
    assert.equal((await sync.refresh().promise).outcome, 'stale_cache');
  } finally {
    db.close();
  }
});

test('latest readings are polled only for visible active On Deck batches and history is lazy', async () => {
  const db = database({ visible: 1 });
  const calls = [];
  const client = budgetClient({
    listBatchesByStatuses: async () => ({
      batches: [{ id: 'one', status: 'Fermenting', name: 'One' }],
      failures: []
    }),
    getBatch: async () => ({ id: 'one', status: 'Fermenting', recipe: { name: 'One' } }),
    getLatestReading: async (id) => {
      calls.push(`latest:${id}`);
      return { timestamp: '2026-08-09T00:00:00Z', gravity: 1.02 };
    },
    getReadings: async (id) => {
      calls.push(`history:${id}`);
      return [
        { timestamp: '2026-08-08T00:00:00Z', gravity: 1.03 },
        { timestamp: '2026-08-09T00:00:00Z', gravity: 1.02 }
      ];
    }
  });
  try {
    const sync = new BrewfatherSync({ db, client, now: () => 1_700_000_000_000 });
    await sync.refresh().promise;
    assert.deepEqual(calls, ['latest:one']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_batch_readings').get().count, 1);
    assert.deepEqual(await sync.loadHistory('one'), { outcome: 'succeeded', errorCategory: null, readings: 2 });
    assert.deepEqual(calls, ['latest:one', 'history:one']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_batch_readings').get().count, 2);
  } finally {
    db.close();
  }
});
