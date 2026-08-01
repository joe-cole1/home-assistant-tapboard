#!/usr/bin/env node
import path from 'node:path';
import {
  backupThenPrunePourHistory,
  createOnlineBackup,
  restoreBackup,
  rotateBackups,
  verifyDatabaseFile
} from '../src/databaseMaintenance.js';

const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const backupDirectory = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const databaseFile = path.join(dataDirectory, 'tapboard.db');
const [command, ...args] = process.argv.slice(2);

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}

try {
  if (command === 'backup') {
    const result = await createOnlineBackup({ sourceFile: databaseFile, backupDirectory });
    const removed = rotateBackups(backupDirectory);
    print({ ...result, removedBackups: removed.length });
  } else if (command === 'verify') {
    if (!args[0]) throw new Error('Usage: db-maintenance verify <database-file>');
    print(verifyDatabaseFile(path.resolve(args[0])));
  } else if (command === 'restore') {
    if (!args[0] || !args[1]) throw new Error('Usage: db-maintenance restore <backup-file> <empty-data-directory>');
    print(await restoreBackup({ backupFile: path.resolve(args[0]), targetDataDirectory: path.resolve(args[1]) }));
  } else if (command === 'prune-pours') {
    const result = await backupThenPrunePourHistory({ sourceFile: databaseFile, backupDirectory });
    const removed = rotateBackups(backupDirectory);
    print({ ...result, removedBackups: removed.length });
  } else {
    throw new Error('Usage: db-maintenance <backup|verify|restore|prune-pours>');
  }
} catch (error) {
  console.error(`[Database maintenance] ${error.message}`);
  process.exitCode = 1;
}
