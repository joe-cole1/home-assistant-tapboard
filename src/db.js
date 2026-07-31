import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';

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
    admin_pin_hash TEXT NOT NULL
  )
`);

// 2. Taps Table (1-6)
db.exec(`
  CREATE TABLE IF NOT EXISTS taps (
    tap_id INTEGER PRIMARY KEY CHECK (tap_id BETWEEN 1 AND 6),
    enabled INTEGER DEFAULT 1,
    graphic TEXT DEFAULT 'default',
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
    badge_fresh INTEGER DEFAULT 1
  )
`);

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
    srm_color INTEGER,
    tasting_notes TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 4. Pour Logs Table (Historical Analytics)
db.exec(`
  CREATE TABLE IF NOT EXISTS pour_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tap_id INTEGER NOT NULL,
    volume_poured_oz REAL NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 5. Beverage Catalog Table (Digital Catalog & On-Deck)
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  )
`);

// Seed Default Settings Row if missing (Default PIN: 0000)
const existingSettings = db.prepare('SELECT id FROM settings WHERE id = 1').get();
if (!existingSettings) {
  const defaultPinHash = bcrypt.hashSync('0000', 10);
  db.prepare(`
    INSERT INTO settings (id, theme, volume_format, title, font_title, font_body, show_ondeck, admin_pin_hash)
    VALUES (1, 'modern_dark', 'oz', 'Hazardous Brews', 'Outfit', 'Inter', 1, ?)
  `).run(defaultPinHash);
}

// Seed Default Taps 1-6 Rows if missing
const insertTap = db.prepare(`
  INSERT OR IGNORE INTO taps (tap_id, enabled, graphic, badge_low_keg, badge_fresh)
  VALUES (?, 1, 'default', 20.0, 1)
`);
for (let i = 1; i <= 6; i++) {
  insertTap.run(i);
}

export default db;
