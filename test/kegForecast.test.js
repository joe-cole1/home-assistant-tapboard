import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { calculateKegKickForecast } from '../src/kegForecast.js';

const NOW = Date.parse('2026-08-01T16:00:00.000Z');

function databaseWithPours(rows = []) {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE pour_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tap_id INTEGER NOT NULL,
      volume_poured_oz REAL NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      lifecycle_id INTEGER,
      timestamp_epoch INTEGER
    );
    CREATE TABLE keg_lifecycles (
      lifecycle_id INTEGER PRIMARY KEY, tap_id INTEGER NOT NULL, closed_at TEXT
    );
  `);
  const lifecycle = database.prepare('INSERT INTO keg_lifecycles (lifecycle_id, tap_id) VALUES (?, ?)');
  const insert = database.prepare(`INSERT INTO pour_logs
    (tap_id, volume_poured_oz, timestamp, lifecycle_id, timestamp_epoch) VALUES (?, ?, ?, ?, unixepoch(?))`);
  const lifecycleIds = new Map();
  let nextLifecycleId = 1;
  rows.forEach((row) => {
    if (!lifecycleIds.has(row.tapId)) {
      lifecycleIds.set(row.tapId, nextLifecycleId);
      lifecycle.run(nextLifecycleId++, row.tapId);
    }
    insert.run(row.tapId, row.volumeOz, row.timestamp, lifecycleIds.get(row.tapId), row.timestamp);
  });
  return database;
}

test('forecast is absent when the active tap has no usage data', () => {
  const database = databaseWithPours([{ tapId: 1, volumeOz: 12, timestamp: '2026-08-01 12:00:00' }]);
  try {
    assert.deepEqual(calculateKegKickForecast({ db: database, tapId: 3, currentOz: 640, nowMs: NOW }), {
      avgDailyOz: null,
      estimatedDaysRemaining: null,
      hasUsageData: false
    });
  } finally {
    database.close();
  }
});

test('forecast averages the full lifecycle across drinking days only', () => {
  const database = databaseWithPours([
    { tapId: 2, volumeOz: 10, timestamp: '2026-06-01 12:00:00' },
    { tapId: 2, volumeOz: 14, timestamp: '2026-06-01T20:00:00.000Z' },
    { tapId: 2, volumeOz: 36, timestamp: '2026-06-06T16:00:00.000Z' }
  ]);
  try {
    assert.deepEqual(calculateKegKickForecast({ db: database, tapId: 2, currentOz: 210, nowMs: NOW }), {
      avgDailyOz: 6,
      avgDrinkingDayOz: 30,
      avgDrinkingIntervalDays: 5,
      estimatedDaysRemaining: 35,
      hasUsageData: true,
      isFallback: false
    });
  } finally {
    database.close();
  }
});

test('forecast ignores non-positive rows and empty elapsed days', () => {
  const database = databaseWithPours([
    { tapId: 1, volumeOz: 12, timestamp: '2026-01-01T12:00:00.000Z' },
    { tapId: 1, volumeOz: 0, timestamp: '2026-02-01T12:00:00.000Z' },
    { tapId: 1, volumeOz: -4, timestamp: '2026-03-01T12:00:00.000Z' }
  ]);
  try {
    assert.deepEqual(calculateKegKickForecast({ db: database, tapId: 1, currentOz: 30 }), {
      avgDailyOz: 3,
      avgDrinkingDayOz: 12,
      avgDrinkingIntervalDays: 4,
      estimatedDaysRemaining: 10,
      hasUsageData: true,
      isFallback: false
    });
  } finally {
    database.close();
  }
});

test('active lifecycle without usage uses the labeled two-pours-every-four-days default', () => {
  const database = databaseWithPours([{ tapId: 1, volumeOz: 0, timestamp: '2026-08-01T12:00:00.000Z' }]);
  try {
    assert.deepEqual(calculateKegKickForecast({ db: database, tapId: 1, currentOz: 120 }), {
      avgDailyOz: 6,
      avgDrinkingDayOz: 24,
      avgDrinkingIntervalDays: 4,
      estimatedDaysRemaining: 20,
      hasUsageData: false,
      isFallback: true
    });
  } finally {
    database.close();
  }
});
