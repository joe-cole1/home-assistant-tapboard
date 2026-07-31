import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'data', 'tapboard.db');
const db = new Database(dbPath);

console.log('=== SQLite Taps Table Rows ===');
console.log(db.prepare('SELECT * FROM taps ORDER BY tap_id ASC').all());
process.exit(0);
