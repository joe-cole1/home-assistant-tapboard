import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'tapboard.db');
const db = new Database(dbPath);

const res = db.prepare('UPDATE taps SET enabled = 1 WHERE tap_id = 4').run();
console.log('[Tap 4 Enable] Updated Tap 4 enabled = 1 in database:', res);
process.exit(0);
