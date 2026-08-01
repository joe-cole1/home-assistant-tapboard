import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

// This module is imported before server.js runs (ESM imports are evaluated
// first), so load configuration here before reading DATA_DIR.
dotenv.config(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : undefined);

// Ensure data directory exists
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'tapboard.db');
const db = new Database(dbPath);

// Enable Write-Ahead Logging (WAL) for non-blocking concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// 1. Settings Table
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    theme TEXT DEFAULT 'modern_dark',
    volume_format TEXT DEFAULT 'oz',
    title TEXT DEFAULT 'Hazardous Brews',
    font_title TEXT DEFAULT 'Outfit',
    font_body TEXT DEFAULT 'Inter',
    show_ondeck INTEGER DEFAULT 1,
    admin_pin_hash TEXT NOT NULL,
    admin_pin_initialized INTEGER NOT NULL DEFAULT 0
  )
`);

// Capture whether this database already had the explicit initialization flag
// before applying migrations. This distinguishes a legacy configured PIN from
// the intentionally unusable random hash stored by a new, uninitialized DB.
const settingsHadPinInitializationState = Boolean(
  db.prepare("SELECT 1 FROM pragma_table_info('settings') WHERE name = 'admin_pin_initialized'").get()
);

// 2. Taps Table (1-6)
db.exec(`
  CREATE TABLE IF NOT EXISTS taps (
    tap_id INTEGER PRIMARY KEY CHECK (tap_id BETWEEN 1 AND 6),
    enabled INTEGER DEFAULT 1,
    batch_id TEXT,
    graphic TEXT DEFAULT 'corny_keg',
    override_enabled INTEGER DEFAULT 0,
    override_name TEXT,
    override_style TEXT,
    override_abv REAL,
    override_ibu INTEGER,
    override_og REAL,
    override_fg REAL,
    override_srm INTEGER,
    override_description TEXT,
    badge_low_keg REAL DEFAULT 20.0,
    badge_fresh INTEGER DEFAULT 1,
    on_tap_at TEXT,
    display_unit TEXT DEFAULT 'percent',
    custom_pour_size REAL DEFAULT 12.0
  )
`);

// Safely alter existing database tables if columns don't exist
try { db.exec(`ALTER TABLE taps ADD COLUMN batch_id TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE taps ADD COLUMN display_unit TEXT DEFAULT 'percent';`); } catch (e) {}
try { db.exec(`ALTER TABLE taps ADD COLUMN custom_pour_size REAL DEFAULT 12.0;`); } catch (e) {}
try { db.exec(`ALTER TABLE taps ADD COLUMN on_tap_at TEXT;`); } catch (e) {}
db.prepare(`
  UPDATE taps SET on_tap_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE on_tap_at IS NULL AND batch_id IS NOT NULL AND trim(batch_id) <> ''
`).run();

// 3. Batches Table (Brewfather & Recipe Details)
db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    batch_id TEXT PRIMARY KEY,
    recipe_name TEXT,
    style TEXT,
    brew_date TEXT,
    og REAL,
    fg REAL,
    abv REAL,
    ibu INTEGER,
    srm INTEGER,
    status TEXT,
    last_synced_at TEXT
  )
`);

try { db.exec(`ALTER TABLE batches ADD COLUMN srm INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE batches ADD COLUMN og REAL;`); } catch (e) {}
try { db.exec(`ALTER TABLE batches ADD COLUMN fg REAL;`); } catch (e) {}
try { db.exec(`ALTER TABLE batches ADD COLUMN abv REAL;`); } catch (e) {}
try { db.exec(`ALTER TABLE batches ADD COLUMN ibu INTEGER;`); } catch (e) {}
try { db.exec(`ALTER TABLE batches ADD COLUMN status TEXT;`); } catch (e) {}
try { db.exec(`ALTER TABLE batches ADD COLUMN last_synced_at TEXT;`); } catch (e) {}

// Existing installations predate the explicit first-run PIN state.  A legacy
// 0000 hash deliberately remains uninitialized (and therefore cannot log in)
// until an operator supplies TAPBOARD_INITIAL_ADMIN_PIN on startup.  Existing
// non-default pins continue to work.
try { db.exec(`ALTER TABLE settings ADD COLUMN admin_pin_initialized INTEGER NOT NULL DEFAULT 0;`); } catch (e) {}

// 4. Pour Logs Table
db.exec(`
  CREATE TABLE IF NOT EXISTS pour_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tap_id INTEGER NOT NULL,
    batch_id TEXT,
    volume_poured_oz REAL NOT NULL,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(tap_id) REFERENCES taps(tap_id)
  )
`);

// 5. Beverage Catalog / On-Deck Pipeline
db.exec(`
  CREATE TABLE IF NOT EXISTS beverage_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    style TEXT,
    abv REAL,
    ibu INTEGER,
    srm_color INTEGER,
    description TEXT,
    on_deck INTEGER DEFAULT 0,
    target_tap_id INTEGER
  )
`);

// 6. Admin Sessions Table
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  )
`);

// Seed without a usable default credential. The random secret is discarded
// after hashing, while admin_pin_initialized makes the state explicit.
const unusablePinHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const existingSettings = db.prepare('SELECT id FROM settings WHERE id = 1').get();

if (!existingSettings) {
  db.prepare(`
    INSERT INTO settings (id, theme, volume_format, title, font_title, font_body, show_ondeck, admin_pin_hash, admin_pin_initialized)
    VALUES (1, 'modern_dark', 'oz', 'Hazardous Brews', 'Outfit', 'Inter', 1, ?, 0)
  `).run(unusablePinHash);
} else {
  const settings = db.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();
  // A non-default legacy PIN is already deliberately configured.  Never mark
  // a default hash initialized merely because the migration runs.
  if (!settingsHadPinInitializationState && settings.admin_pin_initialized !== 1 && !bcrypt.compareSync('0000', settings.admin_pin_hash)) {
    db.prepare('UPDATE settings SET admin_pin_initialized = 1 WHERE id = 1').run();
  }
}

const initialPin = process.env.TAPBOARD_INITIAL_ADMIN_PIN;
if (initialPin !== undefined && initialPin !== '') {
  if (!/^\d{4}$/.test(initialPin) || initialPin === '0000') {
    console.error('[SECURITY] Invalid initial admin PIN configuration; administrator access remains disabled.');
  } else {
    const settings = db.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get();
    if (settings.admin_pin_initialized !== 1) {
      db.transaction(() => {
        db.prepare('UPDATE settings SET admin_pin_hash = ?, admin_pin_initialized = 1 WHERE id = 1')
          .run(bcrypt.hashSync(initialPin, 10));
        db.prepare('DELETE FROM admin_sessions').run();
      })();
    }
  }
}

// Session tokens are hashes, so legacy plaintext sessions are revoked during
// migration rather than left as sensitive database contents.
db.prepare("DELETE FROM admin_sessions WHERE datetime(expires_at) <= datetime('now') OR token NOT LIKE 'sha256:%'").run();

// Seed Default Taps 1-6 if not present
const tapCount = db.prepare('SELECT COUNT(*) as count FROM taps').get().count;
if (tapCount === 0) {
  const insertTap = db.prepare(`
    INSERT INTO taps (tap_id, enabled, graphic, override_enabled, badge_low_keg, badge_fresh, display_unit, custom_pour_size)
    VALUES (?, ?, ?, 0, 20.0, 1, 'percent', 12.0)
  `);

  for (let i = 1; i <= 6; i++) {
    const graphicStyle = i % 2 === 1 ? 'pint_glass' : 'mug';
    insertTap.run(i, i <= 3 ? 1 : 0, graphicStyle);
  }
}

export default db;
