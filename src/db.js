import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { migrateDatabase, SCHEMA_VERSION } from './dbMigrations.js';
import { backupThenMigrateDatabase } from './databaseMaintenance.js';

dotenv.config({
  quiet: true,
  ...(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {})
});

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const backupDir = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'tapboard.db');
const expectExistingData = process.env.TAPBOARD_EXPECT_EXISTING_DATA === 'true';
if (expectExistingData && (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0)) {
  throw new Error('Expected an existing Tapboard database, but the data volume is empty');
}

function inspectExistingDatabase() {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
    return { appSchemaExists: false, version: 0 };
  }
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const appSchemaExists = Boolean(
      probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() &&
      probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'taps'").get()
    );
    return { appSchemaExists, version: probe.pragma('user_version', { simple: true }) };
  } finally {
    probe.close();
  }
}

const inspected = inspectExistingDatabase();
if (expectExistingData && !inspected.appSchemaExists) {
  throw new Error('Expected an existing Tapboard database, but the application schema is missing');
}
if (inspected.version > SCHEMA_VERSION) {
  throw new Error(`Unsupported database schema version: ${inspected.version}`);
}
const migrationNeedsBackup = inspected.appSchemaExists && inspected.version < SCHEMA_VERSION;

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// This is recorded before migration so a pre-v1 configured PIN can be
// distinguished from the deliberately disabled first-run credential.
const settingsHadPinInitializationState = Boolean(
  db.prepare("SELECT 1 FROM pragma_table_info('settings') WHERE name = 'admin_pin_initialized'").get()
);
try {
  if (migrationNeedsBackup) {
    const backup = await backupThenMigrateDatabase({
      database: db,
      sourceFile: dbPath,
      backupDirectory: backupDir,
      fromVersion: inspected.version,
      toVersion: SCHEMA_VERSION,
      migrate: migrateDatabase
    });
    console.log(
      `[Database migration] Verified ${path.basename(backup.file)} before schema ${inspected.version} -> ${SCHEMA_VERSION}`
    );
  } else {
    migrateDatabase(db);
  }
} catch (error) {
  db.close();
  throw error;
}
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

const unusablePinHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const existingSettings = db.prepare('SELECT id FROM settings WHERE id = 1').get();
if (!existingSettings) {
  db.prepare(
    `INSERT INTO settings
    (id, theme, volume_format, title, font_title, font_body, show_ondeck, layout_mode, ondeck_new_batch_default, admin_pin_hash, admin_pin_initialized)
    VALUES (1, 'modern_dark', 'oz', 'Hazardous Brews', 'Outfit', 'Inter', 1, 'cozy', 1, ?, 0)`
  ).run(unusablePinHash);
} else {
  const settings = db.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();
  if (
    !settingsHadPinInitializationState &&
    settings.admin_pin_initialized !== 1 &&
    !bcrypt.compareSync('0000', settings.admin_pin_hash)
  ) {
    db.prepare('UPDATE settings SET admin_pin_initialized = 1 WHERE id = 1').run();
  }
}

const initialPin = process.env.TAPBOARD_INITIAL_ADMIN_PIN;
if (initialPin !== undefined && initialPin !== '') {
  if (!/^\d{4}$/.test(initialPin) || initialPin === '0000') {
    console.error('[SECURITY] Invalid initial admin PIN configuration; administrator access remains disabled.');
  } else if (db.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get().admin_pin_initialized !== 1) {
    db.transaction(() => {
      db.prepare('UPDATE settings SET admin_pin_hash = ?, admin_pin_initialized = 1 WHERE id = 1').run(
        bcrypt.hashSync(initialPin, 10)
      );
      db.prepare('DELETE FROM admin_sessions').run();
    })();
  }
}

db.prepare(
  "DELETE FROM admin_sessions WHERE datetime(expires_at) <= datetime('now') OR token NOT LIKE 'sha256:%'"
).run();

if (db.prepare('SELECT COUNT(*) AS count FROM taps').get().count === 0) {
  const insertTap = db.prepare(`INSERT INTO taps
    (tap_id, enabled, graphic, override_enabled, badge_low_keg, badge_fresh, display_unit, custom_pour_size)
    VALUES (?, ?, ?, 0, 20.0, 1, 'percent', 12.0)`);
  for (let tapId = 1; tapId <= 6; tapId++) insertTap.run(tapId, tapId <= 3 ? 1 : 0, tapId % 2 ? 'pint_glass' : 'mug');
}

export default db;
