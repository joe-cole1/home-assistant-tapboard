import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DAILY_BACKUPS = 14;
export const DEFAULT_WEEKLY_BACKUPS = 8;
export const POUR_RETENTION_YEARS = 2;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(database, table, column) {
  return database.pragma(`table_info(${quoteIdentifier(table)})`).some((info) => info.name === column);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // mkdirSync already applied the requested mode when chmod is unavailable.
  }
}

function removeSQLiteSidecars(file) {
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    try {
      fs.unlinkSync(sidecar);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function backupStamp(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function isoWeekKey(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value - yearStart) / 86_400_000 + 1) / 7);
  return `${value.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

export function summarizeDatabase(database) {
  const tableNames = database
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `
    )
    .all()
    .map((row) => row.name);
  const counts = Object.fromEntries(
    tableNames.map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count
    ])
  );

  let adminPinInitialized = null;
  if (tableExists(database, 'settings') && columnExists(database, 'settings', 'admin_pin_initialized')) {
    adminPinInitialized =
      database.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get()?.admin_pin_initialized ?? null;
  }

  let invalidSessionDigests = null;
  if (tableExists(database, 'admin_sessions')) {
    invalidSessionDigests = database
      .prepare(
        `SELECT COUNT(*) AS count FROM admin_sessions
      WHERE token NOT LIKE 'sha256:%' OR length(token) <> 71 OR substr(token, 8) GLOB '*[^0-9a-f]*'`
      )
      .get().count;
  }

  return {
    integrity: database.pragma('integrity_check', { simple: true }),
    foreignKeyViolations: database.pragma('foreign_key_check').length,
    userVersion: database.pragma('user_version', { simple: true }),
    counts,
    adminPinInitialized,
    invalidSessionDigests
  };
}

export function verifyDatabaseFile(file, { expectedVersion, expectedCounts } = {}) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    database.pragma('foreign_keys = ON');
    const summary = summarizeDatabase(database);
    if (summary.integrity !== 'ok') throw new Error(`Database integrity check failed: ${summary.integrity}`);
    if (summary.foreignKeyViolations !== 0)
      throw new Error(`Database has ${summary.foreignKeyViolations} foreign-key violation(s)`);
    if (expectedVersion !== undefined && summary.userVersion !== expectedVersion) {
      throw new Error(`Expected schema version ${expectedVersion}, found ${summary.userVersion}`);
    }
    for (const [table, count] of Object.entries(expectedCounts || {})) {
      if (summary.counts[table] !== count)
        throw new Error(`Expected ${count} row(s) in ${table}, found ${summary.counts[table]}`);
    }
    return summary;
  } finally {
    database.close();
  }
}

export async function createOnlineBackup({
  sourceFile,
  backupDirectory,
  now = new Date(),
  setFileMode = fs.chmodSync
}) {
  ensureDirectory(backupDirectory);
  const filename = `tapboard-${backupStamp(now)}.db`;
  const finalPath = path.join(backupDirectory, filename);
  const temporaryPath = `${finalPath}.partial-${process.pid}`;
  if (fs.existsSync(finalPath) || fs.existsSync(temporaryPath))
    throw new Error(`Backup target already exists: ${filename}`);

  const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
  try {
    source.pragma('foreign_keys = ON');
    await source.backup(temporaryPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The partial backup may not have been created.
    }
    throw error;
  } finally {
    source.close();
  }

  try {
    const standalone = new Database(temporaryPath, { fileMustExist: true });
    try {
      standalone.pragma('journal_mode = DELETE');
    } finally {
      standalone.close();
    }
    setFileMode(temporaryPath, 0o600);
    const summary = verifyDatabaseFile(temporaryPath);
    removeSQLiteSidecars(temporaryPath);
    fs.renameSync(temporaryPath, finalPath);
    try {
      setFileMode(finalPath, 0o600);
    } catch (error) {
      fs.unlinkSync(finalPath);
      throw error;
    }
    return { file: finalPath, summary };
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The partial backup may already have been removed.
    }
    try {
      removeSQLiteSidecars(temporaryPath);
    } catch {
      // Sidecar cleanup is best-effort after a failed backup.
    }
    try {
      removeSQLiteSidecars(finalPath);
    } catch {
      // The final backup was not published, or its sidecars are unavailable.
    }
    throw error;
  }
}

export async function backupThenMigrateDatabase({
  database,
  sourceFile,
  backupDirectory,
  fromVersion,
  toVersion,
  migrate
}) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const lockedVersion = database.pragma('user_version', { simple: true });
    if (lockedVersion > toVersion) {
      throw new Error(`Unsupported database schema version: ${lockedVersion}`);
    }
    if (lockedVersion !== fromVersion) {
      throw new Error(`Database schema changed during startup: expected ${fromVersion}, found ${lockedVersion}`);
    }
    let backup;
    try {
      backup = await createOnlineBackup({ sourceFile, backupDirectory });
    } catch (error) {
      throw new Error(`Automatic pre-migration backup failed: ${error.message}`, { cause: error });
    }
    if (backup.summary.userVersion !== fromVersion) {
      throw new Error('Automatic pre-migration backup does not match the source schema version');
    }
    await migrate(database);
    database.exec('COMMIT');
    return backup;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function rotateBackups(
  backupDirectory,
  { daily = DEFAULT_DAILY_BACKUPS, weekly = DEFAULT_WEEKLY_BACKUPS } = {}
) {
  if (!fs.existsSync(backupDirectory)) return [];
  const candidates = fs
    .readdirSync(backupDirectory)
    .filter((name) => /^tapboard-\d{8}T\d{9}Z\.db$/.test(name))
    .map((name) => {
      const file = path.join(backupDirectory, name);
      const stat = fs.statSync(file);
      return { file, name, modifiedAt: stat.mtime };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  const keep = new Set(candidates.slice(0, daily).map((candidate) => candidate.file));
  const weeklyKeys = new Set();
  for (const candidate of candidates.slice(daily)) {
    const key = isoWeekKey(candidate.modifiedAt);
    if (weeklyKeys.size < weekly && !weeklyKeys.has(key)) {
      weeklyKeys.add(key);
      keep.add(candidate.file);
    }
  }

  const removed = [];
  for (const candidate of candidates) {
    if (keep.has(candidate.file)) continue;
    fs.unlinkSync(candidate.file);
    removed.push(candidate.file);
  }
  return removed;
}

export async function restoreBackup({ backupFile, targetDataDirectory }) {
  const sourceSummary = verifyDatabaseFile(backupFile);
  ensureDirectory(targetDataDirectory);
  const targetFile = path.join(targetDataDirectory, 'tapboard.db');
  const temporaryPath = `${targetFile}.partial-${process.pid}`;
  for (const candidate of [targetFile, `${targetFile}-wal`, `${targetFile}-shm`, temporaryPath]) {
    if (fs.existsSync(candidate)) throw new Error(`Restore target is not empty: ${path.basename(candidate)}`);
  }

  const source = new Database(backupFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(temporaryPath);
    fs.chmodSync(temporaryPath, 0o600);
    verifyDatabaseFile(temporaryPath, {
      expectedVersion: sourceSummary.userVersion,
      expectedCounts: sourceSummary.counts
    });
    fs.renameSync(temporaryPath, targetFile);
    fs.chmodSync(targetFile, 0o600);
    const summary = verifyDatabaseFile(targetFile, {
      expectedVersion: sourceSummary.userVersion,
      expectedCounts: sourceSummary.counts
    });
    removeSQLiteSidecars(targetFile);
    return { file: targetFile, summary };
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The partial restore may not have been created.
    }
    try {
      fs.unlinkSync(targetFile);
    } catch {
      // The restore target was not published.
    }
    throw error;
  } finally {
    source.close();
  }
}

export function retentionCutoffEpoch(now = new Date(), years = POUR_RETENTION_YEARS) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return Math.floor(cutoff.getTime() / 1000);
}

export async function backupThenPrunePourHistory({
  sourceFile,
  backupDirectory,
  now = new Date(),
  years = POUR_RETENTION_YEARS
}) {
  const backup = await createOnlineBackup({ sourceFile, backupDirectory, now });
  const database = new Database(sourceFile, { fileMustExist: true });
  try {
    database.pragma('foreign_keys = ON');
    if (!columnExists(database, 'pour_logs', 'timestamp_epoch'))
      throw new Error('Current schema does not support retention pruning');
    const cutoffEpoch = retentionCutoffEpoch(now, years);
    const { result, summary } = database.transaction(() => {
      const result = database.prepare('DELETE FROM pour_logs WHERE timestamp_epoch < ?').run(cutoffEpoch);
      const summary = summarizeDatabase(database);
      if (summary.integrity !== 'ok' || summary.foreignKeyViolations !== 0)
        throw new Error('Post-retention database verification failed');
      return { result, summary };
    })();
    return { backup, cutoffEpoch, deletedRows: result.changes, summary };
  } finally {
    database.close();
  }
}
