import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { createOnlineBackup, MIGRATION_APPROVAL_FILE, restoreBackup } from '../src/databaseMaintenance.js';
import {
  tapId,
  validateCatalog,
  validateCustomBeverage,
  validateOndeck,
  validateSettings,
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
        TAPBOARD_EXPECT_EXISTING_DATA: 'false',
        TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'false',
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
      env: { ...process.env, DATA_DIR: dataDir, DOTENV_CONFIG_PATH: path.join(dataDir, '.env-unused'), ...environment },
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

test('production startup refuses a legacy schema without a verified restore marker', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-no-marker-'));
  const database = open(dataDir);
  database.exec('CREATE TABLE settings (id INTEGER PRIMARY KEY); CREATE TABLE taps (tap_id INTEGER PRIMARY KEY);');
  database.close();

  const result = startDatabase(dataDir, {
    TAPBOARD_EXPECT_EXISTING_DATA: 'true',
    TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a verified restore marker/);
  const unchanged = open(dataDir);
  assert.equal(unchanged.pragma('user_version', { simple: true }), 0);
  assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, 2);
  unchanged.close();
});

test('verified restore marker permits migration, is consumed after success, and is not needed on restart', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-approved-migration-'));
  const sourceDir = path.join(root, 'source');
  const restoredDir = path.join(root, 'restored');
  const backupDir = path.join(root, 'backups');
  makeRestorableLegacyDatabase(sourceDir);
  const backup = await createOnlineBackup({
    sourceFile: path.join(sourceDir, 'tapboard.db'),
    backupDirectory: backupDir
  });
  await restoreBackup({ backupFile: backup.file, targetDataDirectory: restoredDir });
  const approvalFile = path.join(restoredDir, MIGRATION_APPROVAL_FILE);
  assert.equal(existsSync(approvalFile), true);

  let result = startDatabase(restoredDir, {
    TAPBOARD_EXPECT_EXISTING_DATA: 'true',
    TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'true'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(approvalFile), false);
  assert.equal(existsSync(path.join(restoredDir, '.tapboard-migration-v3.json')), true);
  let migrated = open(restoredDir);
  assert.equal(migrated.pragma('user_version', { simple: true }), 3);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM pour_logs').get().count, 1);
  migrated.close();

  result = startDatabase(restoredDir, {
    TAPBOARD_EXPECT_EXISTING_DATA: 'true',
    TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'true'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('restore marker is rejected when same-count database contents change', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-marker-binding-'));
  const sourceDir = path.join(root, 'source');
  const restoredDir = path.join(root, 'restored');
  makeRestorableLegacyDatabase(sourceDir);
  const backup = await createOnlineBackup({
    sourceFile: path.join(sourceDir, 'tapboard.db'),
    backupDirectory: path.join(root, 'backups')
  });
  await restoreBackup({ backupFile: backup.file, targetDataDirectory: restoredDir });
  const changed = open(restoredDir);
  changed.prepare('UPDATE pour_logs SET volume_poured_oz = 7 WHERE id = 1').run();
  changed.close();

  const result = startDatabase(restoredDir, {
    TAPBOARD_EXPECT_EXISTING_DATA: 'true',
    TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restore marker does not match/);
  assert.equal(existsSync(path.join(restoredDir, MIGRATION_APPROVAL_FILE)), true);
});

test('restore marker is rejected when a same-count change exists only in WAL state', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-marker-wal-binding-'));
  const sourceDir = path.join(root, 'source');
  const restoredDir = path.join(root, 'restored');
  makeRestorableLegacyDatabase(sourceDir);
  const backup = await createOnlineBackup({
    sourceFile: path.join(sourceDir, 'tapboard.db'),
    backupDirectory: path.join(root, 'backups')
  });
  await restoreBackup({ backupFile: backup.file, targetDataDirectory: restoredDir });
  const changed = open(restoredDir);
  changed.pragma('journal_mode = WAL');
  changed.pragma('wal_autocheckpoint = 0');
  changed.prepare('UPDATE pour_logs SET volume_poured_oz = 7 WHERE id = 1').run();
  assert.equal(existsSync(path.join(restoredDir, 'tapboard.db-wal')), true);

  const result = startDatabase(restoredDir, {
    TAPBOARD_EXPECT_EXISTING_DATA: 'true',
    TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'true'
  });
  changed.close();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restore marker does not match/);
  assert.equal(existsSync(path.join(restoredDir, MIGRATION_APPROVAL_FILE)), true);
});

test('failed approved migration remains uncommitted and retains its restore marker', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-failed-migration-'));
  const sourceDir = path.join(root, 'source');
  const restoredDir = path.join(root, 'restored');
  const backupDir = path.join(root, 'backups');
  makeRestorableLegacyDatabase(sourceDir, 'not-a-timestamp');
  const backup = await createOnlineBackup({
    sourceFile: path.join(sourceDir, 'tapboard.db'),
    backupDirectory: backupDir
  });
  await restoreBackup({ backupFile: backup.file, targetDataDirectory: restoredDir });

  const result = startDatabase(restoredDir, {
    TAPBOARD_EXPECT_EXISTING_DATA: 'true',
    TAPBOARD_REQUIRE_MIGRATION_APPROVAL: 'true'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /normalize 1 pour timestamp/);
  assert.equal(existsSync(path.join(restoredDir, MIGRATION_APPROVAL_FILE)), true);
  const unchanged = open(restoredDir);
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
