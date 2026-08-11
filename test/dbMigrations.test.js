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
      { version: 4, name: 'theme-accent-overrides' },
      { version: 5, name: 'brewfather-cache' },
      { version: 6, name: 'brew-story' },
      { version: 7, name: 'serving-glass-recommendations' },
      { version: 8, name: 'lifecycle-experiences' },
      { version: 9, name: 'remove-serving-glass-recommendations' }
    ]);
    const settingColumns = db.prepare("SELECT name, dflt_value FROM pragma_table_info('settings')").all();
    assert.deepEqual(
      settingColumns.filter((column) =>
        [
          'layout_mode',
          'ondeck_new_batch_default',
          'primary_color',
          'secondary_color',
          'first_pour_effects',
          'kick_effects',
          'ceremony_sound'
        ].includes(column.name)
      ),
      [
        { name: 'layout_mode', dflt_value: "'cozy'" },
        { name: 'ondeck_new_batch_default', dflt_value: '1' },
        { name: 'primary_color', dflt_value: null },
        { name: 'secondary_color', dflt_value: null },
        { name: 'first_pour_effects', dflt_value: '1' },
        { name: 'kick_effects', dflt_value: '1' },
        { name: 'ceremony_sound', dflt_value: "'pub_bell'" }
      ]
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT name, dflt_value FROM pragma_table_info('taps') WHERE name IN ('graphic', 'kick_threshold_oz')"
        )
        .all(),
      [
        { name: 'graphic', dflt_value: "'corny_keg'" },
        { name: 'kick_threshold_oz', dflt_value: null }
      ]
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lifecycle_milestones'").get());
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

test('removes the legacy serving_glass column without changing tap data', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    db.prepare("INSERT INTO taps(tap_id, batch_id, graphic, enabled) VALUES(1, 'batch-a', 'ipa_glass', 0)").run();
    db.exec("ALTER TABLE taps ADD COLUMN serving_glass TEXT NOT NULL DEFAULT 'auto'; PRAGMA user_version = 8");

    migrateDatabase(db);

    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(db.prepare("SELECT 1 FROM pragma_table_info('taps') WHERE name='serving_glass'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT tap_id, batch_id, graphic, enabled FROM taps WHERE tap_id=1').get(), {
      tap_id: 1,
      batch_id: 'batch-a',
      graphic: 'ipa_glass',
      enabled: 0
    });
    assert.deepEqual(db.prepare('SELECT version, name FROM schema_migrations WHERE version=9').get(), {
      version: 9,
      name: 'remove-serving-glass-recommendations'
    });
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

test('fresh database migration is re-entrant and passes integrity and foreign-key checks', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    const tablesBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    migrateDatabase(db);
    const tablesAfter = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tablesAfter, tablesBefore);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_sync_state').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_history_sync_state').get().count, 0);
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('brewfather_batch_readings') WHERE name='ph'").get());
  } finally {
    db.close();
  }
});

test('v4 to current cache upgrade preserves assignments and immutable lifecycle IDs', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    db.prepare("INSERT INTO settings(id, admin_pin_hash, admin_pin_initialized) VALUES(1, 'hash', 1)").run();
    db.prepare("INSERT INTO taps(tap_id, batch_id, on_tap_at) VALUES(1, 'batch-a', '2026-08-01T00:00:00.000Z')").run();
    db.prepare(
      `INSERT INTO keg_lifecycles(lifecycle_id, tap_id, batch_id, assignment_kind, started_at)
       VALUES(41, 1, 'batch-a', 'brewfather', '2026-08-01T00:00:00.000Z')`
    ).run();
    db.exec(`
      DROP TABLE brewfather_batch_readings;
      DROP TABLE brewfather_batch_details;
      DROP TABLE brewfather_sync_state;
      DROP INDEX batches_brewfather_present_status_date;
      DROP INDEX batches_brewfather_last_seen;
      PRAGMA user_version = 4;
      DELETE FROM schema_migrations WHERE version = 5;
    `);

    migrateDatabase(db);
    assert.deepEqual(db.prepare('SELECT batch_id, on_tap_at FROM taps WHERE tap_id=1').get(), {
      batch_id: 'batch-a',
      on_tap_at: '2026-08-01T00:00:00.000Z'
    });
    assert.deepEqual(db.prepare('SELECT lifecycle_id, batch_id, closed_at FROM keg_lifecycles WHERE tap_id=1').get(), {
      lifecycle_id: 41,
      batch_id: 'batch-a',
      closed_at: null
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('v5 to current migration preserves cached readings and enforces sensory half steps', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    db.prepare("INSERT INTO settings(id, admin_pin_hash, admin_pin_initialized) VALUES(1, 'hash', 1)").run();
    db.prepare("INSERT INTO batches(batch_id, recipe_name, status) VALUES('batch-a', 'Beer', 'Fermenting')").run();
    db.prepare(
      `INSERT INTO brewfather_batch_readings
        (batch_id, reading_key, recorded_at, recorded_at_ms, sg, payload_json)
       VALUES ('batch-a', 'reading-a', '2026-08-09T00:00:00.000Z', 1786233600000, 1.01, '{}')`
    ).run();
    db.exec(`
      DROP INDEX brewfather_history_sync_due;
      DROP TABLE brewfather_sensory_overrides;
      DROP TABLE brewfather_history_sync_state;
      ALTER TABLE brewfather_batch_readings DROP COLUMN ph;
      PRAGMA user_version = 5;
      DELETE FROM schema_migrations WHERE version = 6;
    `);

    migrateDatabase(db);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.deepEqual(
      db.prepare("SELECT reading_key, sg, ph FROM brewfather_batch_readings WHERE batch_id='batch-a'").get(),
      { reading_key: 'reading-a', sg: 1.01, ph: null }
    );
    assert.throws(
      () => db.prepare("INSERT INTO brewfather_sensory_overrides(batch_id, hops) VALUES ('batch-a', 4.3)").run(),
      /CHECK constraint/
    );
  } finally {
    db.close();
  }
});

test('a failed v5 migration rolls back its schema and version atomically', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    db.exec(`
      DROP TABLE brewfather_batch_readings;
      DROP TABLE brewfather_batch_details;
      DROP TABLE brewfather_sync_state;
      DROP INDEX batches_brewfather_present_status_date;
      DROP INDEX batches_brewfather_last_seen;
      CREATE TABLE brewfather_sync_state (id INTEGER PRIMARY KEY);
      PRAGMA user_version = 4;
      DELETE FROM schema_migrations WHERE version = 5;
    `);
    assert.throws(() => migrateDatabase(db), /status|column/);
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='brewfather_batch_details'").get(), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_sync_state').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=5').get().count, 0);
  } finally {
    db.close();
  }
});
