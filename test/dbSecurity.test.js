import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { verifyDatabaseFile } from '../src/databaseMaintenance.js';
import { SCHEMA_VERSION } from '../src/dbMigrations.js';
import {
  tapId,
  validateCatalog,
  validateCustomBeverage,
  validateOndeck,
  validatePinChange,
  validateSettings,
  validateSensoryOverride,
  validateTap
} from '../src/validation.js';

function initialize(dataDir, initialPin = '') {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./src/db.js').then(({default:db}) => db.close())"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        BACKUP_DIR: path.join(dataDir, 'backups'),
        TAPBOARD_EXPECT_EXISTING_DATA: 'false',
        TAPBOARD_INITIAL_ADMIN_PIN: initialPin,
        DOTENV_CONFIG_PATH: path.join(dataDir, '.env-unused')
      },
      encoding: 'utf8'
    }
  );
  assert.equal(result.status, 0, result.stderr);
}

function startDatabase(dataDir, environment = {}) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./src/db.js').then(({default:db}) => db.close())"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        BACKUP_DIR: path.join(dataDir, 'backups'),
        DOTENV_CONFIG_PATH: path.join(dataDir, '.env-unused'),
        ...environment
      },
      encoding: 'utf8'
    }
  );
}

function open(dataDir) {
  return new Database(path.join(dataDir, 'tapboard.db'));
}

function makeLegacySettings(dataDir, pin) {
  const database = open(dataDir);
  database.exec(`CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), theme TEXT DEFAULT 'modern_dark',
    volume_format TEXT DEFAULT 'oz', title TEXT DEFAULT 'Hazardous Brews',
    font_title TEXT DEFAULT 'Outfit', font_body TEXT DEFAULT 'Inter',
    show_ondeck INTEGER DEFAULT 1, admin_pin_hash TEXT NOT NULL
  )`);
  database.prepare('INSERT INTO settings (id, admin_pin_hash) VALUES (1, ?)').run(bcrypt.hashSync(pin, 4));
  database.close();
}

function makeRestorableLegacyDatabase(dataDir, timestamp = '2026-08-01 01:02:03') {
  mkdirSync(dataDir, { recursive: true });
  const database = open(dataDir);
  database.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY, admin_pin_hash TEXT NOT NULL);
    CREATE TABLE taps (tap_id INTEGER PRIMARY KEY);
    CREATE TABLE pour_logs (
      id INTEGER PRIMARY KEY, tap_id INTEGER NOT NULL, volume_poured_oz REAL NOT NULL, timestamp TEXT
    );
  `);
  database.prepare('INSERT INTO settings (id, admin_pin_hash) VALUES (1, ?)').run(bcrypt.hashSync('9753', 4));
  database.prepare('INSERT INTO taps (tap_id) VALUES (1)').run();
  database.prepare('INSERT INTO pour_logs VALUES (1, 1, 6, ?)').run(timestamp);
  database.close();
}

function backupFiles(backupDir) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => /^tapboard-\d{8}T\d{9}Z\.db$/.test(name))
    .map((name) => path.join(backupDir, name));
}

test('validation preserves client numeric strings while enforcing every approved boundary', () => {
  assert.doesNotThrow(() =>
    validateTap({
      graphic: 'mug',
      display_unit: 'pours_custom',
      custom_pour_size: '0.5',
      override_abv: '100',
      override_ibu: '1000',
      override_og: '2.0',
      override_fg: '0.5',
      override_srm: '50',
      badge_low_keg: '100'
    })
  );
  for (const invalid of [
    { graphic: 'evil' },
    { custom_pour_size: '0.49' },
    { override_abv: '100.1' },
    { override_ibu: '1001' },
    { override_og: '2.01' },
    { override_srm: '51' },
    { unknown: true },
    { override_name: 'x\u0000y' },
    { batch_option: 'x'.repeat(513) }
  ])
    assert.throws(() => validateTap(invalid));
  assert.equal(validateSettings({ title: '  Tapboard  ' }).title, 'Tapboard');
  assert.throws(() => validateSettings({ title: '   ' }));
  assert.throws(() => validateSettings({ title: 'x'.repeat(81) }));
  assert.throws(() => validateSettings({ new_pin: '0000' }));
  assert.deepEqual(validateSettings({ primary_color: '#aBc123', secondary_color: null }), {
    primary_color: '#ABC123',
    secondary_color: null
  });
  assert.throws(() => validateSettings({ primary_color: '#abc' }));
  assert.deepEqual(validatePinChange({ current_pin: '2468', new_pin: '1357', confirm_new_pin: '1357' }), {
    current_pin: '2468',
    new_pin: '1357',
    confirm_new_pin: '1357'
  });
  assert.throws(() => validatePinChange({ current_pin: '2468', new_pin: '1357', confirm_new_pin: '2468' }));
  assert.throws(() => validateSettings({ tap_visibilities: { '01': true } }));
  assert.deepEqual(validateOndeck({ batches: [], show_ondeck: true }), { batches: [], show_ondeck: true });
  assert.throws(() => validateOndeck({ batches: [], show_ondeck: 'yes' }));
  assert.doesNotThrow(() => validateCatalog({ name: 'IPA', abv: '100', ibu: '1000', target_tap_id: '2' }));
  assert.throws(() => validateCatalog({ name: '' }));
  assert.doesNotThrow(() => validateCatalog({ name: 'IPA', description: 'line one\nline two\r\nline three' }));
  assert.throws(() => validateCatalog({ name: 'IPA', description: 'tab\tis not accepted' }));
  for (const partial of ['.5', '1.', '+1', '01', '1e2'])
    assert.throws(() => validateTap({ custom_pour_size: partial }));
  for (const invalid of ['0', '01', '7', '-1', '1.0']) assert.throws(() => tapId(invalid));
  assert.deepEqual(validateSensoryOverride({ hidden: true, axis_overrides: { hops: 4.5, roast: null } }), {
    hidden: true,
    axis_overrides: { hops: 4.5, roast: null }
  });
  for (const invalid of [
    {},
    { hidden: 'yes' },
    { axis_overrides: { hops: 4.3 } },
    { axis_overrides: { unknown: 2 } },
    { description_override: 'x'.repeat(2001) }
  ]) {
    assert.throws(() => validateSensoryOverride(invalid));
  }
});

test('custom beverage requires core display values while allowing unknown gravity readings', () => {
  const beverage = validateCustomBeverage({
    name: 'House Soda',
    style: 'Soda',
    abv: 0,
    ibu: 0,
    og: null,
    fg: null,
    srm: 0,
    description: ''
  });
  assert.equal(beverage.og, null);
  assert.equal(beverage.fg, null);
  assert.throws(() => validateCustomBeverage({ ...beverage, abv: null }));
  assert.throws(() => validateCustomBeverage({ ...beverage, srm: null }));
});

test('fresh databases fail closed and valid one-time initialization creates only a bcrypt hash', () => {
  const uninitializedDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-uninitialized-'));
  initialize(uninitializedDir);
  let database = open(uninitializedDir);
  let settings = database.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();
  assert.equal(settings.admin_pin_initialized, 0);
  assert.equal(bcrypt.compareSync('0000', settings.admin_pin_hash), false);
  database.close();

  initialize(uninitializedDir, '2468');
  database = open(uninitializedDir);
  settings = database.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();
  assert.equal(settings.admin_pin_initialized, 1);
  assert.equal(bcrypt.compareSync('2468', settings.admin_pin_hash), true);
  assert.equal(settings.admin_pin_hash.includes('2468'), false);
  database.close();
});

test('production startup refuses an unexpectedly empty data volume', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-empty-volume-'));
  const result = startDatabase(dataDir, { TAPBOARD_EXPECT_EXISTING_DATA: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /data volume is empty/);
});

test('production startup rejects a future schema without creating a migration backup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-future-schema-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  mkdirSync(dataDir);
  const database = open(dataDir);
  database.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY);
    CREATE TABLE taps (tap_id INTEGER PRIMARY KEY);
    PRAGMA user_version = ${SCHEMA_VERSION + 1};
  `);
  database.close();

  const result = startDatabase(dataDir, {
    BACKUP_DIR: backupDir,
    TAPBOARD_EXPECT_EXISTING_DATA: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Unsupported database schema version: ${SCHEMA_VERSION + 1}`));
  assert.deepEqual(backupFiles(backupDir), []);
  assert.equal(existsSync(path.join(dataDir, 'tapboard.db-wal')), false);
  assert.equal(existsSync(path.join(dataDir, 'tapboard.db-shm')), false);

  const unchanged = new Database(path.join(dataDir, 'tapboard.db'), { readonly: true, fileMustExist: true });
  assert.equal(unchanged.pragma('user_version', { simple: true }), SCHEMA_VERSION + 1);
  assert.equal(unchanged.pragma('journal_mode', { simple: true }), 'delete');
  unchanged.close();
});

test('production startup automatically backs up and migrates an older supported schema once', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-auto-migration-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  makeRestorableLegacyDatabase(dataDir);

  let result = startDatabase(dataDir, {
    BACKUP_DIR: backupDir,
    TAPBOARD_EXPECT_EXISTING_DATA: 'true'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified tapboard-\d{8}T\d{9}Z\.db before schema 0 -> 8/);

  const backups = backupFiles(backupDir);
  assert.equal(backups.length, 1);
  const backupSummary = verifyDatabaseFile(backups[0]);
  assert.equal(backupSummary.userVersion, 0);
  assert.equal(backupSummary.counts.pour_logs, 1);

  const migrated = open(dataDir);
  assert.equal(migrated.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM pour_logs').get().count, 1);
  migrated.close();

  result = startDatabase(dataDir, {
    BACKUP_DIR: backupDir,
    TAPBOARD_EXPECT_EXISTING_DATA: 'true'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(backupFiles(backupDir).length, 1);
});

test('an unusable backup directory aborts startup before migration', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-backup-failure-'));
  const dataDir = path.join(root, 'data');
  const backupTarget = path.join(root, 'not-a-directory');
  makeRestorableLegacyDatabase(dataDir);
  writeFileSync(backupTarget, 'occupied');

  const result = startDatabase(dataDir, {
    BACKUP_DIR: backupTarget,
    TAPBOARD_EXPECT_EXISTING_DATA: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Automatic pre-migration backup failed/);

  const unchanged = open(dataDir);
  assert.equal(unchanged.pragma('user_version', { simple: true }), 0);
  assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM pour_logs').get().count, 1);
  assert.equal(
    unchanged
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get().count,
    0
  );
  unchanged.close();
});

test('automatic pre-migration backup captures committed WAL state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-wal-backup-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  makeRestorableLegacyDatabase(dataDir);
  const changed = open(dataDir);
  changed.pragma('journal_mode = WAL');
  changed.pragma('wal_autocheckpoint = 0');
  changed.prepare('UPDATE pour_logs SET volume_poured_oz = 7 WHERE id = 1').run();
  assert.equal(existsSync(path.join(dataDir, 'tapboard.db-wal')), true);

  const result = startDatabase(dataDir, {
    BACKUP_DIR: backupDir,
    TAPBOARD_EXPECT_EXISTING_DATA: 'true'
  });
  changed.close();
  assert.equal(result.status, 0, result.stderr);

  const backups = backupFiles(backupDir);
  assert.equal(backups.length, 1);
  const backup = new Database(backups[0], { readonly: true, fileMustExist: true });
  assert.equal(backup.prepare('SELECT volume_poured_oz FROM pour_logs WHERE id = 1').get().volume_poured_oz, 7);
  backup.close();
  assert.equal(existsSync(`${backups[0]}-wal`), false);
  assert.equal(existsSync(`${backups[0]}-shm`), false);
});

test('failed migration remains uncommitted and retains its verified automatic backup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-failed-migration-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  makeRestorableLegacyDatabase(dataDir, 'not-a-timestamp');

  const result = startDatabase(dataDir, {
    BACKUP_DIR: backupDir,
    TAPBOARD_EXPECT_EXISTING_DATA: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /normalize 1 pour timestamp/);

  const backups = backupFiles(backupDir);
  assert.equal(backups.length, 1);
  const backupSummary = verifyDatabaseFile(backups[0]);
  assert.equal(backupSummary.userVersion, 0);
  assert.equal(backupSummary.counts.pour_logs, 1);

  const unchanged = open(dataDir);
  assert.equal(unchanged.pragma('user_version', { simple: true }), 0);
  assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM pour_logs').get().count, 1);
  unchanged.close();
});

test('legacy default remains disabled while an existing non-default PIN migrates unchanged', () => {
  const defaultDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-default-'));
  makeLegacySettings(defaultDir, '0000');
  initialize(defaultDir);
  let database = open(defaultDir);
  assert.equal(
    database.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get().admin_pin_initialized,
    0
  );
  database.close();

  const configuredDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-configured-'));
  makeLegacySettings(configuredDir, '9753');
  database = open(configuredDir);
  const priorHash = database.prepare('SELECT admin_pin_hash FROM settings WHERE id = 1').get().admin_pin_hash;
  database.close();
  initialize(configuredDir);
  database = open(configuredDir);
  const migrated = database.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();
  assert.equal(migrated.admin_pin_initialized, 1);
  assert.equal(migrated.admin_pin_hash, priorHash);
  database.close();
});

test('invalid initialization stays fail-closed and startup prunes legacy and expired sessions', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-prune-'));
  initialize(dataDir, '0000');
  let database = open(dataDir);
  assert.equal(
    database.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get().admin_pin_initialized,
    0
  );
  database
    .prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '+1 day'))")
    .run('legacy-raw-token');
  database
    .prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '-1 second'))")
    .run('sha256:expired');
  database.close();
  initialize(dataDir);
  database = open(dataDir);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count, 0);
  database.close();
});

test('successful initialization revokes any pre-existing digest sessions', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-init-revoke-'));
  initialize(dataDir);
  let database = open(dataDir);
  database
    .prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '+1 day'))")
    .run(`sha256:${'a'.repeat(64)}`);
  database.close();
  initialize(dataDir, '8642');
  database = open(dataDir);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count, 0);
  database.close();
});
