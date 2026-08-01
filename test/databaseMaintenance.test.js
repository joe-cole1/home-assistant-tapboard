import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  backupThenPrunePourHistory,
  createOnlineBackup,
  MIGRATION_APPROVAL_FILE,
  restoreBackup,
  retentionCutoffEpoch,
  verifyDatabaseFile
} from '../src/databaseMaintenance.js';

function makeDatabase(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'tapboard.db');
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE taps (tap_id INTEGER PRIMARY KEY);
    CREATE TABLE keg_lifecycles (
      lifecycle_id INTEGER PRIMARY KEY,
      tap_id INTEGER NOT NULL,
      UNIQUE(lifecycle_id, tap_id),
      FOREIGN KEY(tap_id) REFERENCES taps(tap_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE TABLE pour_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tap_id INTEGER NOT NULL,
      lifecycle_id INTEGER,
      volume_poured_oz REAL NOT NULL,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      FOREIGN KEY(tap_id) REFERENCES taps(tap_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY(lifecycle_id, tap_id) REFERENCES keg_lifecycles(lifecycle_id, tap_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE TABLE settings (id INTEGER PRIMARY KEY, admin_pin_initialized INTEGER NOT NULL);
    CREATE TABLE admin_sessions (token TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
  database.prepare('INSERT INTO taps (tap_id) VALUES (1)').run();
  database.prepare('INSERT INTO keg_lifecycles (lifecycle_id, tap_id) VALUES (10, 1)').run();
  database.prepare('INSERT INTO settings (id, admin_pin_initialized) VALUES (1, 1)').run();
  database
    .prepare('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)')
    .run(`sha256:${'a'.repeat(64)}`, '2099-01-01T00:00:00.000Z');
  return { database, file };
}

test('online backup and disposable restore preserve schema, counts, integrity, and relationships', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapboard-maintenance-'));
  const source = makeDatabase(path.join(root, 'source'));
  source.database
    .prepare(
      'INSERT INTO pour_logs (tap_id, lifecycle_id, volume_poured_oz, timestamp, timestamp_epoch) VALUES (1, 10, 12, ?, ?)'
    )
    .run('2026-08-01 12:00:00', 1_754_048_000);
  source.database.close();

  const backup = await createOnlineBackup({
    sourceFile: source.file,
    backupDirectory: path.join(root, 'backups'),
    now: new Date('2026-08-01T16:00:00.000Z')
  });
  assert.equal(backup.summary.integrity, 'ok');
  assert.equal(backup.summary.foreignKeyViolations, 0);
  assert.equal(backup.summary.userVersion, 2);
  assert.equal(backup.summary.counts.pour_logs, 1);
  assert.equal(fs.existsSync(`${backup.file}-wal`), false);
  assert.equal(fs.existsSync(`${backup.file}-shm`), false);

  const restored = await restoreBackup({ backupFile: backup.file, targetDataDirectory: path.join(root, 'restored') });
  assert.equal(restored.summary.integrity, 'ok');
  assert.equal(restored.summary.counts.pour_logs, 1);
  assert.equal(restored.summary.adminPinInitialized, 1);
  assert.equal(restored.summary.invalidSessionDigests, 0);
  assert.equal(path.basename(restored.approvalFile), MIGRATION_APPROVAL_FILE);
  assert.equal(fs.statSync(restored.approvalFile).mode & 0o777, 0o600);
  const approval = JSON.parse(fs.readFileSync(restored.approvalFile, 'utf8'));
  assert.deepEqual(approval.counts, backup.summary.counts);
  assert.match(approval.databaseSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(`${restored.file}-wal`), false);
  assert.equal(fs.existsSync(`${restored.file}-shm`), false);
  assert.deepEqual(
    verifyDatabaseFile(restored.file, { expectedVersion: 2, expectedCounts: backup.summary.counts }),
    restored.summary
  );
});

test('two-calendar-year pruning is backup-gated and preserves recent pours', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapboard-retention-'));
  const source = makeDatabase(path.join(root, 'source'));
  const insert = source.database.prepare(
    'INSERT INTO pour_logs (tap_id, lifecycle_id, volume_poured_oz, timestamp, timestamp_epoch) VALUES (1, 10, 8, ?, ?)'
  );
  insert.run('2024-07-31T15:59:59.000Z', Math.floor(Date.parse('2024-07-31T15:59:59.000Z') / 1000));
  insert.run('2024-08-01T16:00:00.000Z', Math.floor(Date.parse('2024-08-01T16:00:00.000Z') / 1000));
  source.database.close();

  const now = new Date('2026-08-01T16:00:00.000Z');
  assert.equal(retentionCutoffEpoch(now), Math.floor(Date.parse('2024-08-01T16:00:00.000Z') / 1000));
  const result = await backupThenPrunePourHistory({
    sourceFile: source.file,
    backupDirectory: path.join(root, 'backups'),
    now
  });
  assert.equal(result.backup.summary.counts.pour_logs, 2);
  assert.equal(result.deletedRows, 1);
  assert.equal(result.summary.counts.pour_logs, 1);
  assert.equal(verifyDatabaseFile(result.backup.file).counts.pour_logs, 2);
});
