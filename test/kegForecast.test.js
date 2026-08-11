import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { calculateKegKickForecast } from '../src/kegForecast.js';

const NOW = Date.parse('2026-08-01T16:00:00.000Z');

function databaseWithLifecycle({
  tapId = 1,
  startedAt = '2026-07-01T00:00:00.000Z',
  pours = [],
  extraLifecycles = []
} = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE keg_lifecycles (lifecycle_id INTEGER PRIMARY KEY, tap_id INTEGER, batch_id TEXT, started_at TEXT, closed_at TEXT);
    CREATE TABLE pour_logs (id INTEGER PRIMARY KEY, lifecycle_id INTEGER, volume_poured_oz REAL, timestamp_epoch INTEGER, timestamp TEXT);`);
  db.prepare('INSERT INTO keg_lifecycles VALUES (1, ?, ?, ?, NULL)').run(tapId, 'current', startedAt);
  for (const lifecycle of extraLifecycles)
    db.prepare('INSERT INTO keg_lifecycles VALUES (?, ?, ?, ?, ?)').run(...lifecycle);
  const insert = db.prepare(
    'INSERT INTO pour_logs (lifecycle_id, volume_poured_oz, timestamp_epoch, timestamp) VALUES (?, ?, ?, ?)'
  );
  for (const pour of pours)
    insert.run(pour.lifecycleId ?? 1, pour.oz, pour.epoch ?? Math.floor(Date.parse(pour.at) / 1000), pour.at);
  return db;
}

test('returns a structured unavailable result without an active lifecycle', () => {
  const db = databaseWithLifecycle();
  db.exec('DELETE FROM keg_lifecycles');
  try {
    const forecast = calculateKegKickForecast({ db, tapId: 1, currentOz: 100, nowMs: NOW });
    assert.equal(forecast.schemaVersion, 1);
    assert.equal(forecast.status, 'unavailable');
    assert.equal(forecast.estimatedDaysRemaining, null);
  } finally {
    db.close();
  }
});

test('uses UTC lifecycle days, including zero-pour days, and fallback uncertainty', () => {
  const db = databaseWithLifecycle({
    startedAt: '2026-07-30T23:00:00.000Z',
    pours: [{ oz: 12, at: '2026-08-01T00:30:00.000Z' }]
  });
  try {
    const forecast = calculateKegKickForecast({ db, tapId: 1, currentOz: 120, nowMs: NOW });
    assert.deepEqual(forecast.range, { startDate: '2026-07-30', endDate: '2026-08-01', observationDays: 3 });
    assert.deepEqual(forecast.evidence.dailyRatesOz, [0, 0, 12]);
    assert.equal(forecast.evidence.method, 'fallback_24oz_per_4d');
    assert.equal(forecast.depletion.medianDaysRemaining, 20);
    assert.equal(forecast.depletion.earliestDaysRemaining, 10);
    assert.equal(forecast.depletion.latestDaysRemaining, 40);
    assert.equal(forecast.confidence.level, 'low');
  } finally {
    db.close();
  }
});

test('bootstrap forecast is deterministic and qualifies only current lifecycle pours', () => {
  const pours = Array.from({ length: 9 }, (_, index) => ({
    oz: 8 + index,
    at: `2026-07-${String(index * 3 + 1).padStart(2, '0')}T12:00:00.000Z`
  }));
  pours.push({ lifecycleId: 2, oz: 500, at: '2026-07-20T12:00:00.000Z' });
  const db = databaseWithLifecycle({
    pours,
    extraLifecycles: [[2, 1, 'old', '2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']]
  });
  try {
    const args = { db, tapId: 1, currentOz: 150, nowMs: NOW };
    const first = calculateKegKickForecast(args);
    const second = calculateKegKickForecast(args);
    assert.deepEqual(first, second);
    assert.equal(first.evidence.method, 'circular_moving_block_bootstrap_7d');
    assert.equal(first.evidence.bootstrapSamples, 512);
    assert.equal(first.evidence.qualifyingPours, 9);
    assert.equal(first.confidence.level, 'high');
  } finally {
    db.close();
  }
});

test('stale, invalid/future timestamps, and capacity inconsistency lower confidence', () => {
  const db = databaseWithLifecycle({
    pours: [
      { oz: 10, at: '2026-07-02T12:00:00.000Z' },
      { oz: 10, at: '2026-07-08T12:00:00.000Z' },
      { oz: 10, at: '2026-07-15T12:00:00.000Z' },
      { oz: 4, at: '2099-01-01T12:00:00.000Z' },
      { oz: 4, at: 'not-a-date', epoch: null }
    ]
  });
  try {
    const forecast = calculateKegKickForecast({
      db,
      tapId: 1,
      currentOz: 110,
      capacityOz: 100,
      volumeStatus: 'stale',
      nowMs: NOW
    });
    assert.equal(forecast.status, 'anomaly');
    assert.equal(forecast.reason, 'capacity_inconsistency');
    assert.equal(forecast.confidence.level, 'low');
    assert.equal(forecast.evidence.futureTimestampCount, 1);
    assert.equal(forecast.evidence.invalidTimestampCount, 1);
  } finally {
    db.close();
  }
});

test('empty volume kicks now while invalid lifecycle dates fail closed', () => {
  const db = databaseWithLifecycle({ startedAt: 'not-a-date' });
  try {
    assert.equal(calculateKegKickForecast({ db, tapId: 1, currentOz: 10, nowMs: NOW }).status, 'anomaly');
    db.prepare('UPDATE keg_lifecycles SET started_at=? WHERE lifecycle_id=1').run('2026-07-01T00:00:00.000Z');
    const empty = calculateKegKickForecast({ db, tapId: 1, currentOz: 0, nowMs: NOW });
    assert.equal(empty.status, 'depleted');
    assert.equal(empty.depletion.medianDate, new Date(NOW).toISOString());
    assert.equal(empty.depletion.medianDaysRemaining, 0);
  } finally {
    db.close();
  }
});
