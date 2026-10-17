import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { simulationDatabasePath, type ApplicationConfig } from "../src/config.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import {
  openDatabase,
  snapshotDatabase,
  verifyDatabaseFile,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/infrastructure/database/migrations.ts";
import { runBackup, type BackupCommandOptions } from "../src/operator/backup.ts";

const writerFixture = fileURLToPath(new URL("./fixtures/backup-writer.ts", import.meta.url));
const checkModes = process.platform !== "win32";

interface Workspace {
  readonly root: string;
  readonly databasePath: string;
  readonly backups: string;
}

function workspace(context: TestContext): Workspace {
  const root = mkdtempSync(join(tmpdir(), "tapboard-backup-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, databasePath: join(root, "tapboard-v2.sqlite3"), backups: join(root, "backups") };
}

function config(databasePath: string, extra: Partial<ApplicationConfig> = {}): ApplicationConfig {
  return { host: "127.0.0.1", port: 3000, shutdownGraceMs: 5000, databasePath, ...extra };
}

function backup(
  databasePath: string,
  options: Omit<BackupCommandOptions, "stdout" | "stderr"> = {},
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runBackup({
    argv: ["node", "backup.ts"],
    config: config(databasePath),
    ...options,
    stdout: { write: (value) => void (stdout += value) },
    stderr: { write: (value) => void (stderr += value) },
  });
  return { code, stdout, stderr };
}

/** Parse the command's only output shape: one "<absolute path> (<size> bytes)" line per copy. */
function copiesIn(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(.+) \((\d+) bytes\)$/u.exec(line);
      assert.ok(match, "output line is a path and size");
      const [, path = "", size = ""] = match;
      assert.ok(isAbsolute(path));
      assert.equal(statSync(path).size, Number(size));
      return path;
    });
}

function failed(reason: string): {
  readonly code: 1;
  readonly stdout: "";
  readonly stderr: string;
} {
  return { code: 1, stdout: "", stderr: `Operator command failed: ${reason}.\n` };
}

function rawUserVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

function kegNumbers(database: DatabaseConnection): number[] {
  return createKegService(database)
    .listKegs()
    .map((keg) => keg.kegNumber)
    .sort((left, right) => left - right);
}

function withDatabase<Result>(path: string, work: (database: DatabaseConnection) => Result) {
  const database = openDatabase(path);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

void test("backup snapshots a database another process is writing; the copy opens at the current schema", async (context) => {
  const ws = workspace(context);
  // Held open for the whole test, like the running application.
  const application = openDatabase(ws.databasePath);
  context.after(() => application.close());
  createKegService(application).createKeg({ kegNumber: 1, capacityMl: 19_500 });

  const writer = spawn(process.execPath, [writerFixture, ws.databasePath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  context.after(() => {
    if (writer.exitCode === null) writer.kill("SIGKILL");
  });
  const exited = new Promise<number | null>((resolve) => writer.on("exit", resolve));
  const lines = createInterface({ input: writer.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, "ready");

  const result = backup(ws.databasePath);
  writer.stdin.end();
  const written = Number((await lines.next()).value);
  assert.equal(await exited, 0);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const [copy, ...others] = copiesIn(result.stdout);
  assert.deepEqual(others, []);
  assert.equal(dirname(copy ?? ""), ws.backups);
  assert.match(basename(copy ?? ""), /^tapboard-v2-\d{8}T\d{6}Z\.sqlite3$/u);
  assert.equal(rawUserVersion(copy ?? ""), CURRENT_SCHEMA_VERSION);
  const copied = withDatabase(copy ?? "", kegNumbers);
  // The snapshot is one committed state: the seed plus a prefix of the writer's Kegs.
  const expectedPrefix = [1, ...Array.from({ length: copied.length - 1 }, (_, i) => 1_000 + i)];
  assert.deepEqual(copied, expectedPrefix);
  assert.ok(copied.length >= 11 && copied.length <= written + 1);
  assert.equal(kegNumbers(application).length, written + 1);
  assert.deepEqual(readdirSync(ws.backups), [basename(copy ?? "")]);
  if (checkModes) {
    assert.equal(statSync(ws.backups).mode & 0o777, 0o700);
    assert.equal(statSync(copy ?? "").mode & 0o777, 0o600);
  }
});

void test("an open write transaction neither blocks the backup nor reaches the copy", (context) => {
  const ws = workspace(context);
  const application = openDatabase(ws.databasePath);
  context.after(() => application.close());
  const kegs = createKegService(application);
  kegs.createKeg({ kegNumber: 1, capacityMl: 19_500 });
  application.execute("BEGIN IMMEDIATE");
  kegs.createKeg({ kegNumber: 2, capacityMl: 19_500 });

  const result = backup(ws.databasePath);
  application.execute("COMMIT");

  assert.equal(result.code, 0);
  const [copy] = copiesIn(result.stdout);
  assert.deepEqual(withDatabase(copy ?? "", kegNumbers), [1]);
  assert.deepEqual(kegNumbers(application), [1, 2]);
});

void test("backup refuses, instead of copying, while uncommitted pages are in the database file", (context) => {
  const ws = workspace(context);
  const application = openDatabase(ws.databasePath);
  context.after(() => application.close());
  const committedSize = statSync(ws.databasePath).size;
  // A tiny page cache makes the open transaction spill its uncommitted pages into the file.
  application.pragma("cache_size = 2");
  application.execute("BEGIN IMMEDIATE");
  const kegs = createKegService(application);
  for (let kegNumber = 1; kegNumber <= 200; kegNumber += 1) {
    kegs.createKeg({ kegNumber, capacityMl: 19_500 });
  }
  assert.ok(statSync(ws.databasePath).size > committedSize);

  // The read-only snapshot waits out its 5-second busy timeout rather than read a torn file.
  const result = backup(ws.databasePath);
  application.execute("ROLLBACK");

  assert.deepEqual(result, failed("the database stayed locked for 5 seconds"));
  assert.deepEqual(readdirSync(ws.backups), []);
  assert.deepEqual(kegNumbers(application), []);
});

void test("backup includes the saved Simulation database only when it exists", (context) => {
  const ws = workspace(context);
  withDatabase(ws.databasePath, (database) =>
    createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19_500 }),
  );

  const absent = backup(ws.databasePath, { now: () => new Date("2026-10-17T03:15:00.000Z") });
  assert.equal(absent.code, 0);
  assert.deepEqual(copiesIn(absent.stdout), [
    join(ws.backups, "tapboard-v2-20261017T031500Z.sqlite3"),
  ]);

  withDatabase(simulationDatabasePath(ws.databasePath), (database) =>
    createKegService(database).createKeg({ kegNumber: 7, capacityMl: 19_500 }),
  );
  const present = backup(ws.databasePath, { now: () => new Date("2026-10-17T03:16:00.000Z") });
  assert.equal(present.code, 0);
  const main = join(ws.backups, "tapboard-v2-20261017T031600Z.sqlite3");
  const simulation = simulationDatabasePath(main);
  assert.equal(simulation, `${main}.simulation.sqlite3`);
  assert.deepEqual(copiesIn(present.stdout), [main, simulation]);
  assert.deepEqual(withDatabase(main, kegNumbers), [1]);
  assert.deepEqual(withDatabase(simulation, kegNumbers), [7]);
  if (checkModes) assert.equal(statSync(simulation).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(ws.backups).sort(), [
    "tapboard-v2-20261017T031500Z.sqlite3",
    "tapboard-v2-20261017T031600Z.sqlite3",
    "tapboard-v2-20261017T031600Z.sqlite3.simulation.sqlite3",
  ]);
});

void test("backup never overwrites an existing file", (context) => {
  const ws = workspace(context);
  openDatabase(ws.databasePath).close();
  const now = () => new Date("2026-10-17T03:15:00.000Z");
  const first = backup(ws.databasePath, { now });
  assert.equal(first.code, 0);
  const [copy] = copiesIn(first.stdout);
  const original = readFileSync(copy ?? "");

  withDatabase(ws.databasePath, (database) =>
    createKegService(database).createKeg({ kegNumber: 1, capacityMl: 19_500 }),
  );
  const second = backup(ws.databasePath, { now });
  assert.deepEqual(second, failed("a backup with this name already exists"));
  assert.deepEqual(readFileSync(copy ?? ""), original);
  assert.deepEqual(readdirSync(ws.backups), ["tapboard-v2-20261017T031500Z.sqlite3"]);
});

/** Point one b-tree page's first freeblock past the page: quick_check reports free-space corruption. */
function corruptFreeblock(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  const { page_size: pageSize } = database.prepare("PRAGMA page_size").get() as {
    page_size: number;
  };
  const { rootpage } = database
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'schema_migrations'")
    .get() as { rootpage: number };
  database.close();
  assert.ok(rootpage > 1);
  const file = openSync(path, "r+");
  try {
    writeSync(file, Buffer.from([0xff, 0xff]), 0, 2, (rootpage - 1) * pageSize + 1);
  } finally {
    closeSync(file);
  }
}

void test("a copy that fails quick_check exits nonzero and leaves no file behind", (context) => {
  const ws = workspace(context);
  openDatabase(ws.databasePath).close();
  const corrupted = join(ws.root, "corrupted.sqlite3");
  snapshotDatabase(ws.databasePath, corrupted);
  corruptFreeblock(corrupted);
  assert.throws(() => verifyDatabaseFile(corrupted), /^Error: SQLite integrity check failed$/u);

  const result = backup(ws.databasePath, {
    snapshotDatabase: (sourcePath, targetPath) => {
      snapshotDatabase(sourcePath, targetPath);
      corruptFreeblock(targetPath);
    },
  });
  assert.deepEqual(result, failed("the copy of the database failed its integrity check"));
  assert.deepEqual(readdirSync(ws.backups), []);
});

void test("copy failures print a fixed reason naming the copy, never the error's text", (context) => {
  const ws = workspace(context);
  openDatabase(ws.databasePath).close();
  const detail = `${ws.root} private-error-detail`;
  const reasons: readonly (readonly [string | undefined, string])[] = [
    ["SQLITE_BUSY", "the database stayed locked for 5 seconds"],
    ["SQLITE_FULL", "the target filesystem is full"],
    ["ENOSPC", "the target filesystem is full"],
    ["SQLITE_CORRUPT_INDEX", "the database is corrupt"],
    ["SQLITE_NOTADB", "the database is corrupt"],
    ["SQLITE_CANTOPEN", "the database could not be copied"],
    [undefined, "the database could not be copied"],
  ];
  for (const [code, reason] of reasons) {
    const result = backup(ws.databasePath, {
      snapshotDatabase: () => {
        throw Object.assign(new Error(detail), code === undefined ? {} : { code });
      },
    });
    assert.deepEqual(result, failed(reason));
  }
  assert.deepEqual(readdirSync(ws.backups), []);

  // The main copy stays listed when the Simulation copy then fails.
  const simulationPath = simulationDatabasePath(ws.databasePath);
  openDatabase(simulationPath).close();
  const partial = backup(ws.databasePath, {
    snapshotDatabase: (sourcePath, targetPath) => {
      if (sourcePath === simulationPath) {
        throw Object.assign(new Error(detail), { code: "SQLITE_BUSY" });
      }
      snapshotDatabase(sourcePath, targetPath);
    },
  });
  assert.equal(partial.code, 1);
  assert.equal(
    partial.stderr,
    "Operator command failed: the Simulation database stayed locked for 5 seconds.\n",
  );
  const [main, ...others] = copiesIn(partial.stdout);
  assert.deepEqual(others, []);
  assert.deepEqual(readdirSync(ws.backups), [basename(main ?? "")]);

  // An unexpected error keeps the generic line.
  assert.deepEqual(backup(ws.databasePath, { now: () => new Date(Number.NaN) }), {
    code: 1,
    stdout: "",
    stderr: "Operator command failed.\n",
  });
});

void test("an invalid configuration is reported without its values", (context) => {
  const saved = process.env.TAPBOARD_PORT;
  context.after(() => {
    if (saved === undefined) delete process.env.TAPBOARD_PORT;
    else process.env.TAPBOARD_PORT = saved;
  });
  process.env.TAPBOARD_PORT = "private-port-value";
  let stderr = "";
  const code = runBackup({
    argv: ["node", "backup.ts"],
    stdout: { write: () => undefined },
    stderr: { write: (value) => void (stderr += value) },
  });
  assert.equal(code, 1);
  assert.equal(stderr, "Operator command failed: the configuration is invalid.\n");
});

void test("backup prints only paths and sizes and keeps credentials encrypted", async (context) => {
  const ws = workspace(context);
  const rootKey = Buffer.alloc(32, 7).toString("base64url");
  const pin = "2468";
  const credential = "brewfather-credential-value";
  const database = openDatabase(ws.databasePath);
  try {
    await createAuthService(database).resetOperatorPin(pin);
    createSecretsService(database, { rootKey }).upsert(
      "brewfather",
      "brewery-1",
      "api_token",
      credential,
    );
  } finally {
    database.close();
  }

  const target = join(ws.root, "operator-copies");
  const result = backup(ws.databasePath, {
    argv: ["node", "backup.ts", target],
    config: config(ws.databasePath, { secretKey: rootKey, secretKeyState: "available" }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const [copy, ...others] = copiesIn(result.stdout);
  assert.deepEqual(others, []);
  assert.equal(dirname(copy ?? ""), target);
  assert.equal(result.stdout, `${copy} (${statSync(copy ?? "").size} bytes)\n`);
  for (const secret of [rootKey, pin, credential])
    assert.equal(result.stdout.includes(secret), false);
  if (checkModes) assert.equal(statSync(target).mode & 0o777, 0o700);

  withDatabase(copy ?? "", (restored) => {
    assert.throws(() =>
      createSecretsService(restored).revealPrivileged("brewfather", "brewery-1", "api_token"),
    );
    assert.equal(
      createSecretsService(restored, { rootKey }).revealPrivileged(
        "brewfather",
        "brewery-1",
        "api_token",
      ),
      credential,
    );
  });
});

void test("backup rejects invalid arguments, a missing database, and an unusable target without creating files", (context) => {
  const ws = workspace(context);
  assert.deepEqual(backup(ws.databasePath), failed("the database file does not exist"));
  assert.deepEqual(readdirSync(ws.root), []);

  openDatabase(ws.databasePath).close();
  for (const extra of [["one", "two"], ["--help"], [""]]) {
    assert.deepEqual(
      backup(ws.databasePath, { argv: ["node", "backup.ts", ...extra] }),
      failed("usage is npm run operator:backup [target-directory]"),
    );
  }
  assert.deepEqual(
    backup(ws.databasePath, { argv: ["node", "backup.ts", join(ws.root, "missing", "parent")] }),
    failed("the target directory's parent does not exist"),
  );
  assert.deepEqual(
    backup(ws.databasePath, { argv: ["node", "backup.ts", ws.databasePath] }),
    failed("the target is not a writable directory"),
  );
  assert.deepEqual(readdirSync(ws.root), ["tapboard-v2.sqlite3"]);

  mkdirSync(ws.backups, { mode: 0o755 });
  const existing = backup(ws.databasePath);
  assert.equal(existing.code, 0);
  if (checkModes) assert.equal(statSync(ws.backups).mode & 0o777, 0o755);
});
