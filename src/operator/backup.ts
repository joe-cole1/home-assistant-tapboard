import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, simulationDatabasePath, type ApplicationConfig } from "../config.ts";
import { snapshotDatabase, verifyDatabaseFile } from "../infrastructure/database/connection.ts";
import { safeFailure, type OperatorOutput } from "./input.ts";

export interface BackupCommandOptions {
  readonly argv?: readonly string[];
  readonly stdout?: OperatorOutput;
  readonly stderr?: OperatorOutput;
  readonly config?: ApplicationConfig;
  readonly now?: () => Date;
  readonly snapshotDatabase?: (sourcePath: string, targetPath: string) => void;
}

const processOutput = process.stdout as unknown as OperatorOutput;
const processError = process.stderr as unknown as OperatorOutput;

function targetDirectory(argv: readonly string[], databasePath: string): string {
  if (argv.length > 3) throw new Error("Backup accepts at most one target directory");
  const target = argv[2];
  if (target === undefined) return join(dirname(databasePath), "backups");
  if (target.length === 0 || target.startsWith("-")) throw new Error("Backup target is invalid");
  return resolve(target);
}

/** Create only the final directory, so a mistyped parent fails instead of growing a tree. */
function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

/** Basic ISO 8601 UTC, such as 20261017T031500Z: sortable and portable in file names. */
function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(/[-:]/gu, "") + "Z";
}

/** A copy gets its final name only after it passes the integrity check, and never replaces one. */
function writeCopy(
  sourcePath: string,
  targetPath: string,
  snapshot: (sourcePath: string, targetPath: string) => void,
): number {
  const partialPath = `${targetPath}.partial`;
  // Exclusive creation fixes the private mode before any data exists; SQLite fills the empty file.
  closeSync(openSync(partialPath, "wx", 0o600));
  try {
    snapshot(sourcePath, partialPath);
    verifyDatabaseFile(partialPath);
    linkSync(partialPath, targetPath);
  } finally {
    unlinkSync(partialPath);
  }
  return statSync(targetPath).size;
}

export function runBackup(options: BackupCommandOptions = {}): number {
  const argv = options.argv ?? process.argv;
  const stdout = options.stdout ?? processOutput;
  const stderr = options.stderr ?? processError;
  try {
    // Copies keep credentials encrypted, so this command never needs or parses the root key.
    const config =
      options.config ?? loadConfig({ env: { ...process.env, TAPBOARD_SECRET_KEY: undefined } });
    const databasePath = resolve(config.databasePath);
    // A mistyped database path fails before anything is created.
    if (!existsSync(databasePath)) throw new Error("Database is missing");
    const directory = targetDirectory(argv, databasePath);
    const stamp = utcStamp((options.now ?? (() => new Date()))());
    const backupPath = join(directory, `tapboard-v2-${stamp}.sqlite3`);
    const copies: (readonly [string, string])[] = [[databasePath, backupPath]];
    const simulationPath = simulationDatabasePath(databasePath);
    if (existsSync(simulationPath))
      copies.push([simulationPath, simulationDatabasePath(backupPath)]);
    ensurePrivateDirectory(directory);
    for (const [sourcePath, targetPath] of copies) {
      const size = writeCopy(sourcePath, targetPath, options.snapshotDatabase ?? snapshotDatabase);
      stdout.write(`${targetPath} (${size} bytes)\n`);
    }
    return 0;
  } catch {
    safeFailure(stderr);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runBackup();
}
