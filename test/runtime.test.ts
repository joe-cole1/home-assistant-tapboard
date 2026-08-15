import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, connect, type Server as NetServer } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import { createApplication } from "../src/application.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { runApplication, type RuntimeProcess } from "../src/main.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { createLogger } from "../src/shared/logging.ts";

const quietLogger = createLogger({ sink: () => undefined });

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...extra };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function makeDatabasePath(context: TestContext): string {
  const root = mkdtempSync(
    join(process.platform === "win32" ? process.env.TEMP! : "/tmp", "tapboard-runtime-"),
  );
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "nested", "tapboard-v2.sqlite3");
}

function appConfig(
  databasePath: string,
  port = 0,
  shutdownGraceMs = 100,
): {
  host: string;
  port: number;
  databasePath: string;
  shutdownGraceMs: number;
} {
  return { host: "127.0.0.1", port, databasePath, shutdownGraceMs };
}

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

async function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

void test("application starts on an ephemeral port and exposes only local readiness", async (context) => {
  const databasePath = makeDatabasePath(context);
  const application = createApplication({
    config: appConfig(databasePath),
    logger: quietLogger,
  });
  context.after(() => application.stop());

  const address = await application.start();
  assert.equal(application.isReady(), true);
  assert.deepEqual(application.address(), address);
  assert.ok(application.renderer());

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  assert.deepEqual(await health.json(), { status: "ok", schemaVersion: 8 });

  const unknown = await fetch(`http://127.0.0.1:${address.port}/not-a-route`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), {
    error: { code: "http.not_found", message: "Resource not found." },
  });

  const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/healthz`, {
    method: "POST",
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  const firstStop = application.stop();
  const secondStop = application.stop();
  assert.strictEqual(firstStop, secondStop);
  await Promise.all([firstStop, secondStop]);
  assert.equal(application.isReady(), false);
  assert.equal(application.address(), undefined);

  const reopened = openDatabase(databasePath);
  reopened.close();
});

void test("database startup failure occurs before any HTTP server is created", async (context) => {
  let serverCreated = false;
  const application = createApplication({
    config: appConfig(makeDatabasePath(context)),
    logger: quietLogger,
    openDatabase: () => {
      throw new Error("schema rejected");
    },
    createHttpServer: () => {
      serverCreated = true;
      throw new Error("must not create server");
    },
  });

  await assert.rejects(application.start(), /schema rejected/);
  assert.equal(serverCreated, false);
  assert.equal(application.isReady(), false);
  await application.stop();
});

void test("renderer initialization failure closes the acquired database", async (context) => {
  let databaseClosed = false;
  let serverCreated = false;
  const application = createApplication({
    config: appConfig(makeDatabasePath(context)),
    logger: quietLogger,
    openDatabase: (path) => {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        databaseClosed = true;
        close();
      };
      return database;
    },
    createRenderer: () => {
      throw new Error("renderer unavailable");
    },
    createHttpServer: () => {
      serverCreated = true;
      throw new Error("must not create server");
    },
  });

  await assert.rejects(application.start(), /renderer unavailable/);
  assert.equal(databaseClosed, true);
  assert.equal(serverCreated, false);
});

void test("graceful shutdown closes HTTP before the database", async (context) => {
  const events: string[] = [];
  const databasePath = makeDatabasePath(context);
  const application = createApplication({
    config: appConfig(databasePath),
    logger: quietLogger,
    openDatabase: (path) => {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push("database");
        close();
      };
      return database;
    },
    createHttpServer: () => ({
      start() {
        return Promise.resolve({ address: "127.0.0.1", family: "IPv4", port: 12345 });
      },
      stop() {
        events.push("http");
        return Promise.resolve();
      },
    }),
  });

  await application.start();
  await application.stop();
  assert.deepEqual(events, ["http", "database"]);
});

void test("a bind failure rejects startup and closes the database", async (context) => {
  const occupiedServer = createNetServer();
  context.after(() => closeNetServer(occupiedServer));
  const occupiedPort = await listen(occupiedServer);
  let databaseClosed = false;
  const application = createApplication({
    config: appConfig(makeDatabasePath(context), occupiedPort),
    logger: quietLogger,
    openDatabase: (path) => {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        databaseClosed = true;
        close();
      };
      return database;
    },
  });

  await assert.rejects(application.start(), (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, "EADDRINUSE");
    return true;
  });
  assert.equal(databaseClosed, true);
  assert.equal(application.isReady(), false);
  await application.stop();
});

void test("central HTTP error mapping hides unexpected exception details", async (context) => {
  const logger = createLogger({ sink: () => undefined });
  const router = new Router(logger);
  router.get("/boom", async () => {
    await Promise.resolve();
    throw new Error("private implementation detail");
  });
  assert.throws(() => router.get("/boom", () => undefined), /Duplicate route registration/);
  const server = new HttpServer({ router, logger, shutdownGraceMs: 100 });
  context.after(() => server.stop());
  const address = await server.start("127.0.0.1", 0);

  const response = await fetch(`http://127.0.0.1:${address.port}/boom`);
  assert.equal(response.status, 500);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body, /private implementation detail|stack/i);
  assert.deepEqual(JSON.parse(body) as unknown, {
    error: { code: "internal.unexpected", message: "An unexpected error occurred." },
  });
});

void test("central HTTP error mapping redacts secret-like application-error details", async (context) => {
  const logger = createLogger({ sink: () => undefined });
  const router = new Router(logger);
  const sensitiveDetails = {
    password: "password-value",
    adminPin: "pin-value",
    client_secret: "secret-value",
    refreshToken: "token-value",
    "api-key": "api-key-value",
    authorizationHeader: "authorization-value",
    cookie: "cookie-value",
    sessionId: "session-value",
    credential: "credential-value",
    field: "displayName",
    reason: "required",
  } as const;
  router.get("/safe-error", () => {
    throw new ApplicationError({
      category: "validation",
      code: "validation.example",
      clientMessage: "Invalid value.",
      details: sensitiveDetails,
    });
  });
  const server = new HttpServer({ router, logger, shutdownGraceMs: 100 });
  context.after(() => server.stop());
  const address = await server.start("127.0.0.1", 0);

  const response = await fetch(`http://127.0.0.1:${address.port}/safe-error`);
  assert.equal(response.status, 400);
  const payload = await response.json();
  const serialized = JSON.stringify(payload);
  for (const value of Object.values(sensitiveDetails).slice(0, 9)) {
    assert.doesNotMatch(serialized, new RegExp(value));
  }
  assert.deepEqual(payload, {
    error: {
      code: "validation.example",
      message: "Invalid value.",
      details: {
        password: "[REDACTED]",
        adminPin: "[REDACTED]",
        client_secret: "[REDACTED]",
        refreshToken: "[REDACTED]",
        "api-key": "[REDACTED]",
        authorizationHeader: "[REDACTED]",
        cookie: "[REDACTED]",
        sessionId: "[REDACTED]",
        credential: "[REDACTED]",
        field: "displayName",
        reason: "required",
      },
    },
  });
});

void test("shutdown is bounded when a client leaves an incomplete request open", async (context) => {
  const application = createApplication({
    config: appConfig(makeDatabasePath(context), 0, 50),
    logger: quietLogger,
  });
  context.after(() => application.stop());
  const address = await application.start();
  const socket = connect(address.port, "127.0.0.1");
  socket.on("error", () => undefined);
  context.after(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n");

  const startedAt = Date.now();
  await application.stop();
  assert.ok(Date.now() - startedAt < 1000, "shutdown exceeded its bounded grace period");
  assert.equal(application.isReady(), false);
});

void test("a shutdown signal during startup stops cleanly before readiness", async () => {
  let resolveStart:
    ((address: { address: string; family: string; port: number }) => void) | undefined;
  let resourcesClosed = false;
  let stopCalls = 0;
  const start = new Promise<{ address: string; family: string; port: number }>((resolve) => {
    resolveStart = resolve;
  });
  const application = {
    start: () => start,
    async stop() {
      stopCalls += 1;
      await start;
      resourcesClosed = true;
    },
    address: () => undefined,
    isReady: () => false,
    renderer: () => undefined,
  };
  const listeners = new Map<string, (signal: "SIGINT" | "SIGTERM") => void>();
  const runtimeProcess: RuntimeProcess = {
    exitCode: undefined,
    once(event, listener) {
      listeners.set(event, listener);
    },
    off(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
  };
  const logLines: string[] = [];
  const logger = createLogger({ sink: (line) => logLines.push(line) });

  const running = runApplication({ application, logger, runtimeProcess });
  const signalHandler = listeners.get("SIGTERM");
  assert.ok(signalHandler, "SIGTERM handler must be installed before startup settles");
  signalHandler("SIGTERM");
  assert.equal(stopCalls, 1);
  assert.equal(listeners.size, 0);

  resolveStart?.({ address: "127.0.0.1", family: "IPv4", port: 12345 });
  await running;

  assert.equal(resourcesClosed, true);
  assert.equal(runtimeProcess.exitCode, undefined);
  assert.equal(stopCalls, 1);
  assert.equal(listeners.size, 0);
  assert.ok(logLines.some((line) => line.includes('"message":"Application shutdown requested"')));
  assert.ok(logLines.some((line) => line.includes('"message":"Application stopped"')));
  assert.ok(!logLines.some((line) => line.includes('"message":"Application started"')));
  assert.ok(!logLines.some((line) => line.includes('"message":"Application startup failed"')));
});

function waitForStarted(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`child did not start; output: ${output}`)),
      5000,
    );
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes('"message":"Application started"')) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited before startup with code ${String(code)}; output: ${output}`));
    });
  });
}

void test("the real bootstrap handles SIGTERM, exits, and releases its database", async (context) => {
  const databasePath = makeDatabasePath(context);
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: process.cwd(),
    env: childEnvironment({
      TAPBOARD_HOST: "127.0.0.1",
      TAPBOARD_PORT: "0",
      TAPBOARD_DATABASE_PATH: databasePath,
      TAPBOARD_SHUTDOWN_GRACE_MS: "100",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForStarted(child);
  assert.equal(child.kill("SIGTERM"), true);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  assert.equal(code, 0);
  assert.equal(signal, null);

  const reopened = openDatabase(databasePath);
  reopened.close();
});

void test("Node executes erasable TypeScript directly without a transpiler", () => {
  const result = spawnSync(process.execPath, ["test/fixtures/native-typescript.ts"], {
    cwd: process.cwd(),
    env: childEnvironment(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native-typescript-ok");
});
