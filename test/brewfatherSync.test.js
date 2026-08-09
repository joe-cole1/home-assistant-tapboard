import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import { BrewfatherSync } from '../src/brewfatherSync.js';

const silentLogger = { error() {} };

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
    const sync = new BrewfatherSync({ db, client, logger: { error() {} }, now: () => 1_700_000_000_000 });
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

test('configured failed response cycle logs one sanitized structured error', async () => {
  const db = database();
  const logs = [];
  const logger = { error: (line) => logs.push(line) };
  const secret = 'do-not-log-this-brewfather-error';
  const client = budgetClient({
    listBatchesByStatuses: async () => ({
      batches: [],
      failures: [{ status: 'Planning', error: { category: 'network', message: secret, retryAfter: 60_000 } }]
    })
  });
  try {
    const sync = new BrewfatherSync({ db, client, logger, now: () => 1_700_000_000_000 });
    assert.equal((await sync.refresh({ reason: 'scheduled' }).promise).outcome, 'failed');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes(secret), false);
    assert.deepEqual(JSON.parse(logs[0]), {
      event: 'brewfather_sync_cycle_failed',
      reason: 'scheduled',
      outcome: 'failed',
      errorCategory: 'network',
      summaryCount: 0,
      requestCount: 0,
      retryAt: '2023-11-14T22:14:20.000Z'
    });
  } finally {
    db.close();
  }
});

test('successful and unconfigured cycles do not emit failure logs', async () => {
  const successDb = database();
  const unconfiguredDb = database();
  const logs = [];
  const logger = { error: (line) => logs.push(line) };
  try {
    const success = new BrewfatherSync({ db: successDb, client: budgetClient(), logger, now: () => 1_700_000_000_000 });
    const unconfigured = new BrewfatherSync({ db: unconfiguredDb, logger, now: () => 1_700_000_000_000 });
    assert.equal((await success.refresh().promise).outcome, 'succeeded');
    assert.equal((await unconfigured.refresh().promise).outcome, 'failed');
    assert.deepEqual(logs, []);
  } finally {
    successDb.close();
    unconfiguredDb.close();
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

test('notifies on the first actionable completed sync failure', async () => {
  const db = database();
  const calls = [];
  const client = budgetClient({
    listBatchesByStatuses: async () => ({
      batches: [],
      failures: [{ error: { category: 'network', retryAfter: 60_000 } }]
    })
  });
  try {
    const sync = new BrewfatherSync({
      db,
      client,
      now: () => 1_700_000_000_000,
      logger: silentLogger,
      onFailure: (result) => calls.push(result)
    });
    assert.equal((await sync.refresh().promise).outcome, 'failed');
    assert.deepEqual(calls, [
      {
        outcome: 'failed',
        errorCategory: 'network',
        reason: 'manual',
        summaries: 0,
        requestCount: 0,
        retryAt: '2023-11-14T22:14:20.000Z'
      }
    ]);
  } finally {
    db.close();
  }
});

test('suppresses duplicate failure categories across manual and scheduled retries', async () => {
  const db = database();
  const calls = [];
  const client = budgetClient({
    listBatchesByStatuses: async () => ({ batches: [], failures: [{ error: { category: 'network' } }] })
  });
  try {
    const sync = new BrewfatherSync({ db, client, logger: silentLogger, onFailure: (result) => calls.push(result) });
    await sync.refresh({ reason: 'manual' }).promise;
    await sync.refresh({ reason: 'scheduled' }).promise;
    assert.equal(calls.length, 1);
  } finally {
    db.close();
  }
});

test('notifies when the actionable failure category changes', async () => {
  const db = database();
  const calls = [];
  let failureCategory = 'network';
  const client = budgetClient({
    listBatchesByStatuses: async () => ({ batches: [], failures: [{ error: { category: failureCategory } }] })
  });
  try {
    const sync = new BrewfatherSync({
      db,
      client,
      logger: silentLogger,
      onFailure: (result) => calls.push(result.errorCategory)
    });
    await sync.refresh().promise;
    failureCategory = 'auth';
    await sync.refresh().promise;
    assert.deepEqual(calls, ['network', 'auth']);
  } finally {
    db.close();
  }
});

test('a successful cycle resets failure notification suppression', async () => {
  const db = database();
  const calls = [];
  let failing = true;
  const client = budgetClient({
    listBatchesByStatuses: async () =>
      failing ? { batches: [], failures: [{ error: { category: 'network' } }] } : { batches: [], failures: [] }
  });
  try {
    const sync = new BrewfatherSync({
      db,
      client,
      logger: silentLogger,
      onFailure: (result) => calls.push(result.errorCategory)
    });
    await sync.refresh().promise;
    failing = false;
    await sync.refresh().promise;
    failing = true;
    await sync.refresh().promise;
    assert.deepEqual(calls, ['network', 'network']);
  } finally {
    db.close();
  }
});

test('seeds duplicate failure suppression from persisted sync state after restart', async () => {
  const db = database();
  const calls = [];
  const client = budgetClient({
    listBatchesByStatuses: async () => ({ batches: [], failures: [{ error: { category: 'network' } }] })
  });
  try {
    await new BrewfatherSync({ db, client, logger: silentLogger, onFailure: (result) => calls.push(result) }).refresh()
      .promise;
    await new BrewfatherSync({ db, client, logger: silentLogger, onFailure: (result) => calls.push(result) }).refresh()
      .promise;
    assert.equal(calls.length, 1);
  } finally {
    db.close();
  }
});

test('does not notify for unconfigured synchronization', async () => {
  const db = database();
  const calls = [];
  try {
    const sync = new BrewfatherSync({ db, onFailure: (result) => calls.push(result) });
    await sync.refresh().promise;
    assert.deepEqual(calls, []);
  } finally {
    db.close();
  }
});

test('failure notification callback errors do not affect the sync outcome', async () => {
  for (const onFailure of [
    () => {
      throw new Error('secret synchronous callback failure');
    },
    () => Promise.reject(new Error('secret asynchronous callback failure'))
  ]) {
    const db = database();
    const client = budgetClient({
      listBatchesByStatuses: async () => ({ batches: [], failures: [{ error: { category: 'network' } }] })
    });
    try {
      const sync = new BrewfatherSync({ db, client, logger: silentLogger, onFailure });
      assert.equal((await sync.refresh().promise).outcome, 'failed');
    } finally {
      db.close();
    }
  }
});

test('a missing optional latest reading remains successful and emits no failure notification', async () => {
  const db = database({ visible: 1 });
  const calls = [];
  const client = budgetClient({
    listBatchesByStatuses: async () => ({
      batches: [{ id: 'one', status: 'Fermenting', name: 'One' }],
      failures: []
    }),
    getBatch: async () => ({ id: 'one', status: 'Fermenting', recipe: { name: 'One' } }),
    getLatestReading: async () => null
  });
  try {
    const sync = new BrewfatherSync({ db, client, logger: silentLogger, onFailure: (result) => calls.push(result) });
    assert.equal((await sync.refresh().promise).outcome, 'succeeded');
    assert.deepEqual(calls, []);
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
