import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase, SCHEMA_VERSION } from '../src/dbMigrations.js';

test('migrates legacy pour rows without changing IDs, volumes, or timestamps', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE taps (tap_id INTEGER PRIMARY KEY); INSERT INTO taps VALUES (1);
      CREATE TABLE pour_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, tap_id INTEGER NOT NULL,
        batch_id TEXT, volume_poured_oz REAL NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO pour_logs (tap_id, batch_id, volume_poured_oz, timestamp) VALUES (1, 'b', 7.5, '2026-08-01 01:02:03');`);
    migrateDatabase(db);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(
      db.prepare('SELECT id, volume_poured_oz, timestamp, lifecycle_id, timestamp_epoch FROM pour_logs').get(),
      {
        id: 1,
        volume_poured_oz: 7.5,
        timestamp: '2026-08-01 01:02:03',
        lifecycle_id: null,
        timestamp_epoch: 1785546123
      }
    );
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'pour_logs_lifecycle_epoch'").get()['1'],
      1
    );
    assert.deepEqual(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all(), [
      { version: 1, name: 'canonical-base-schema' },
      { version: 2, name: 'immutable-keg-lifecycles' },
      { version: 3, name: 'brewfather-ondeck-and-custom-beverage' },
      { version: 4, name: 'theme-accent-overrides' }
    ]);
    const settingColumns = db.prepare("SELECT name, dflt_value FROM pragma_table_info('settings')").all();
    assert.deepEqual(
      settingColumns.filter((column) =>
        ['layout_mode', 'ondeck_new_batch_default', 'primary_color', 'secondary_color'].includes(column.name)
      ),
      [
        { name: 'layout_mode', dflt_value: "'cozy'" },
        { name: 'ondeck_new_batch_default', dflt_value: '1' },
        { name: 'primary_color', dflt_value: null },
        { name: 'secondary_color', dflt_value: null }
      ]
    );
    assert.deepEqual(db.prepare("SELECT name FROM pragma_table_info('brewfather_ondeck_preferences')").all(), [
      { name: 'batch_id' },
      { name: 'visible' },
      { name: 'first_seen_at' },
      { name: 'updated_at' }
    ]);
    assert.deepEqual(
      db.prepare('SELECT id, name, style, abv, ibu, og, fg, srm, description FROM custom_beverage').get(),
      {
        id: 'custom:topo_chico',
        name: 'Topo Chico',
        style: 'Sparkling Water',
        abv: 0,
        ibu: 0,
        og: 1,
        fg: 1,
        srm: 0,
        description: 'Sparkling mineral water'
      }
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO pour_logs
      (tap_id, volume_poured_oz, timestamp, timestamp_epoch) VALUES (99, 1, '2026-08-01 00:00:00', 1785542400)`
          )
          .run(),
      /FOREIGN KEY/
    );
    migrateDatabase(db);
  } finally {
    db.close();
  }
});

test('an invalid legacy timestamp aborts the complete migration transaction', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE taps (tap_id INTEGER PRIMARY KEY); INSERT INTO taps VALUES (1);
      CREATE TABLE pour_logs (id INTEGER PRIMARY KEY, tap_id INTEGER NOT NULL,
        volume_poured_oz REAL NOT NULL, timestamp TEXT);
      INSERT INTO pour_logs VALUES (1, 1, 4, 'not-a-timestamp')`);
    assert.throws(() => migrateDatabase(db), /normalize 1 pour timestamp/);
    assert.equal(db.pragma('user_version', { simple: true }), 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM pour_logs').get().count, 1);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'keg_lifecycles'").get(), undefined);
  } finally {
    db.close();
  }
});

test('rejects future versions and orphaned legacy pours without partial migration', () => {
  const future = new Database(':memory:');
  const orphan = new Database(':memory:');
  try {
    future.pragma('user_version = 999');
    assert.throws(() => migrateDatabase(future), /Unsupported/);
    orphan.exec(`CREATE TABLE taps (tap_id INTEGER PRIMARY KEY);
      CREATE TABLE pour_logs (id INTEGER PRIMARY KEY, tap_id INTEGER, volume_poured_oz REAL, timestamp TEXT);
      INSERT INTO pour_logs VALUES (1, 99, 1, '2026-08-01 00:00:00')`);
    assert.throws(() => migrateDatabase(orphan), /missing tap/);
    assert.equal(orphan.pragma('user_version', { simple: true }), 0);
  } finally {
    future.close();
    orphan.close();
  }
});
