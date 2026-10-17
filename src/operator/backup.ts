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

const NAME_TAKEN = "a backup with this name already exists";
const DISK_FULL = "the target filesystem is full";
const NOT_WRITABLE = "the target is not a writable directory";

/** A failure whose reason is fixed text, so it is safe to print. */
class BackupFailure extends Error {}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

/** Run one step, replacing any error with a fixed reason chosen from the error's code. */
function step<Result>(work: () => Result, reason: (code: string) => string): Result {
  try {
    return work();
  } catch (error) {
    throw new BackupFailure(reason(errorCode(error)));
  }
}

function targetArgument(argv: readonly string[]): string | undefined {
  const target = argv[2];
  if (argv.length > 3 || target?.length === 0 || target?.startsWith("-") === true) {
    throw new BackupFailure("usage is npm run operator:backup [target-directory]");
  }
  return target;
}

/** Create only the final directory, so a mistyped parent fails instead of growing a tree. */
function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

/** Basic ISO 8601 UTC, such as 20261017T031500Z: sortable and portable in file names. */
function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(/[-:]/gu, "") + "Z";
}

function snapshotFailure(subject: string, code: string): string {
  if (code.startsWith("SQLITE_BUSY")) return `${subject} stayed locked for 5 seconds`;
  if (code === "SQLITE_FULL" || code === "ENOSPC") return DISK_FULL;
  if (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB") return `${subject} is corrupt`;
  return `${subject} could not be copied`;
}

/** A copy gets its final name only after it passes the integrity check, and never replaces one. */
function writeCopy(
  sourcePath: string,
  targetPath: string,
  subject: string,
  snapshot: (sourcePath: string, targetPath: string) => void,
): number {
  const partialPath = `${targetPath}.partial`;
  // Exclusive creation fixes the private mode before any data exists; SQLite fills the empty file.
  step(
    () => closeSync(openSync(partialPath, "wx", 0o600)),
    (code) => (code === "EEXIST" ? NAME_TAKEN : code === "ENOSPC" ? DISK_FULL : NOT_WRITABLE),
  );
  try {
    step(
      () => snapshot(sourcePath, partialPath),
      (code) => snapshotFailure(subject, code),
    );
    step(
      () => verifyDatabaseFile(partialPath),
      () => `the copy of ${subject} failed its integrity check`,
    );
    step(
      () => linkSync(partialPath, targetPath),
      (code) =>
        code === "EEXIST"
          ? NAME_TAKEN
          : `the copy of ${subject} could not be given its final name; the target filesystem must support hard links`,
    );
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
    const target = targetArgument(argv);
    // Copies keep credentials encrypted, so this command never needs or parses the root key.
    const config =
      options.config ??
      step(
        () => loadConfig({ env: { ...process.env, TAPBOARD_SECRET_KEY: undefined } }),
        () => "the configuration is invalid",
      );
    const databasePath = resolve(config.databasePath);
    // A mistyped database path fails before anything is created.
    if (!existsSync(databasePath)) throw new BackupFailure("the database file does not exist");
    const directory =
      target === undefined ? join(dirname(databasePath), "backups") : resolve(target);
    const stamp = utcStamp((options.now ?? (() => new Date()))());
    const backupPath = join(directory, `tapboard-v2-${stamp}.sqlite3`);
    const copies: (readonly [string, string, string])[] = [
      [databasePath, backupPath, "the database"],
    ];
    const simulationPath = simulationDatabasePath(databasePath);
    if (existsSync(simulationPath)) {
      copies.push([simulationPath, simulationDatabasePath(backupPath), "the Simulation database"]);
    }
    step(
      () => ensurePrivateDirectory(directory),
      (code) => (code === "ENOENT" ? "the target directory's parent does not exist" : NOT_WRITABLE),
    );
    for (const [sourcePath, targetPath, subject] of copies) {
      const size = writeCopy(
        sourcePath,
        targetPath,
        subject,
        options.snapshotDatabase ?? snapshotDatabase,
      );
      stdout.write(`${targetPath} (${size} bytes)\n`);
    }
    return 0;
  } catch (error) {
    safeFailure(stderr, error instanceof BackupFailure ? error.message : undefined);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runBackup();
}
