import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { tapId, validateCatalog, validateSettings, validateTap } from '../src/validation.js';

function initialize(dataDir, initialPin = '') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./src/db.js').then(({default:db}) => db.close())"], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dataDir, TAPBOARD_INITIAL_ADMIN_PIN: initialPin, DOTENV_CONFIG_PATH: path.join(dataDir, '.env-unused') },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
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

test('validation preserves client numeric strings while enforcing every approved boundary', () => {
  assert.doesNotThrow(() => validateTap({ graphic: 'mug', display_unit: 'pours_custom', custom_pour_size: '0.5', override_abv: '100', override_ibu: '1000', override_og: '2.0', override_fg: '0.5', override_srm: '50', badge_low_keg: '100' }));
  for (const invalid of [{ graphic: 'evil' }, { custom_pour_size: '0.49' }, { override_abv: '100.1' }, { override_ibu: '1001' }, { override_og: '2.01' }, { override_srm: '51' }, { unknown: true }, { override_name: 'x\u0000y' }, { batch_option: 'x'.repeat(513) }]) assert.throws(() => validateTap(invalid));
  assert.equal(validateSettings({ title: '  Tapboard  ' }).title, 'Tapboard');
  assert.throws(() => validateSettings({ title: '   ' }));
  assert.throws(() => validateSettings({ title: 'x'.repeat(81) }));
  assert.throws(() => validateSettings({ new_pin: '0000' }));
  assert.throws(() => validateSettings({ tap_visibilities: { '01': true } }));
  assert.doesNotThrow(() => validateCatalog({ name: 'IPA', abv: '100', ibu: '1000', target_tap_id: '2' }));
  assert.throws(() => validateCatalog({ name: '' }));
  assert.doesNotThrow(() => validateCatalog({ name: 'IPA', description: 'line one\nline two\r\nline three' }));
  assert.throws(() => validateCatalog({ name: 'IPA', description: 'tab\tis not accepted' }));
  for (const partial of ['.5', '1.', '+1', '01', '1e2']) assert.throws(() => validateTap({ custom_pour_size: partial }));
  for (const invalid of ['0', '01', '7', '-1', '1.0']) assert.throws(() => tapId(invalid));
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

test('legacy default remains disabled while an existing non-default PIN migrates unchanged', () => {
  const defaultDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-db-default-'));
  makeLegacySettings(defaultDir, '0000');
  initialize(defaultDir);
  let database = open(defaultDir);
  assert.equal(database.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get().admin_pin_initialized, 0);
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
  assert.equal(database.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get().admin_pin_initialized, 0);
  database.prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '+1 day'))").run('legacy-raw-token');
  database.prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '-1 second'))").run('sha256:expired');
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
  database.prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '+1 day'))").run(`sha256:${'a'.repeat(64)}`);
  database.close();
  initialize(dataDir, '8642');
  database = open(dataDir);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count, 0);
  database.close();
});
