import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";

import { createApplication } from "../src/application.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import { createLogger } from "../src/shared/logging.ts";
import { SystemService } from "../src/features/system/index.ts";
import { LiveUpdateService } from "../src/features/live/index.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { HealthService } from "../src/features/health/index.ts";
import { BeverageService } from "../src/features/beverages/service.ts";
import { setEnabled } from "../src/features/simulation/repository.ts";
import { WorkspaceApplication } from "../src/features/simulation/workspace.ts";

const ADDRESS = { address: "127.0.0.1", family: "IPv4", port: 12345 };
const quietLogger = createLogger({ sink: () => undefined });

function config(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "tapboard-disposal-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "tapboard-v2.sqlite3"),
    shutdownGraceMs: 100,
  };
}

void test("all cleanup attempts preserve the first failure, detach owners, and redact diagnostics", async (context) => {
  const events: string[] = [];
  const logs: string[] = [];
  const firstFailure = new Error("PRIVATE_CLEANUP_SECRET");
  let armed = false;
  /* eslint-disable @typescript-eslint/unbound-method -- Originals are explicitly invoked with .call(this) below. */
  const systemStop = SystemService.prototype.stopMaintenance;
  const liveStop = LiveUpdateService.prototype.stop;
  const beverageDispose = BeverageService.prototype.dispose;
  const healthStop = HealthService.prototype.stopMaintenance;
  const detectorStop = DetectorService.prototype.stopMaintenance;
  /* eslint-enable @typescript-eslint/unbound-method */
  context.mock.method(SystemService.prototype, "stopMaintenance", function (this: SystemService) {
    systemStop.call(this);
    if (armed) {
      events.push("system");
      throw firstFailure;
    }
  });
  context.mock.method(LiveUpdateService.prototype, "stop", function (this: LiveUpdateService) {
    liveStop.call(this);
    if (armed) {
      events.push("live");
      throw new Error("PRIVATE_LIVE_SECRET");
    }
  });
  context.mock.method(BeverageService.prototype, "dispose", function (this: BeverageService) {
    beverageDispose.call(this);
    if (armed) {
      events.push("beverages");
      throw new Error("PRIVATE_BEVERAGE_SECRET");
    }
  });
  context.mock.method(HealthService.prototype, "stopMaintenance", function (this: HealthService) {
    healthStop.call(this);
    if (armed) {
      events.push("health");
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise defensive cleanup of a non-Error failure.
      throw "PRIVATE_HEALTH_SECRET";
    }
  });
  context.mock.method(
    DetectorService.prototype,
    "stopMaintenance",
    function (this: DetectorService) {
      detectorStop.call(this);
      if (armed) {
        events.push("detector");
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise defensive cleanup of a non-Error failure.
        throw { url: "https://private.invalid/token" };
      }
    },
  );
  let database: DatabaseConnection | undefined;
  const app = createApplication({
    config: { ...config(context), secretKey: Buffer.alloc(32, 7).toString("base64url") },
    logger: createLogger({ sink: (line) => logs.push(line) }),
    openDatabase(path) {
      database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push("database");
        close();
        throw new Error("PRIVATE_DATABASE_PATH");
      };
      return database;
    },
    createOutboundRuntime: () => ({
      worker: { start: () => undefined, stop: () => undefined },
      stop() {
        events.push("outbound");
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise defensive cleanup of a non-Error failure.
        throw "PRIVATE_OUTBOUND_TOKEN";
      },
    }),
    createHttpServer: () => ({
      start: () => Promise.resolve(ADDRESS),
      stop() {
        events.push("http");
        assert.equal(database?.isOpen, true);
        return Promise.reject(new Error("PRIVATE_HTTP_COOKIE"));
      },
    }),
  });
  await app.start();
  armed = true;
  const stopping = app.stop();
  assert.strictEqual(app.stop(), stopping);
  await assert.rejects(stopping, (error) => error === firstFailure);
  await assert.rejects(app.stop(), (error) => error === firstFailure);
  assert.deepEqual(events, [
    "system",
    "outbound",
    "live",
    "beverages",
    "health",
    "detector",
    "http",
    "database",
  ]);
  assert.equal(database?.isOpen, false);
  assert.equal(app.isReady(), false);
  assert.equal(app.address(), undefined);
  assert.equal(app.renderer(), undefined);
  assert.equal(logs.length, 8);
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_|private\.invalid|stack/u);
  for (const line of logs) {
    const entry: unknown = JSON.parse(line);
    assert.ok(typeof entry === "object" && entry !== null && "message" in entry);
    assert.equal(entry.message, "Application cleanup failed");
  }
});

void test("startup failure survives throwing HTTP and database cleanup without retrying owners", async (context) => {
  const startupFailure = new Error("startup failure");
  const events: string[] = [];
  let database: DatabaseConnection | undefined;
  const app = createApplication({
    config: config(context),
    logger: quietLogger,
    openDatabase(path) {
      database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push("database");
        close();
        throw new Error("cleanup database failure");
      };
      return database;
    },
    createHttpServer: () => ({
      start: () => Promise.reject(startupFailure),
      stop() {
        events.push("http");
        return Promise.reject(new Error("cleanup HTTP failure"));
      },
    }),
  });
  await assert.rejects(app.start(), (error) => error === startupFailure);
  await app.stop();
  await app.stop();
  assert.deepEqual(events, ["http", "database"]);
  assert.equal(database?.isOpen, false);
});

void test("partial startup still closes the database when renderer creation and close both fail", async (context) => {
  const failure = new Error("renderer failed");
  let closes = 0;
  const app = createApplication({
    config: config(context),
    logger: quietLogger,
    openDatabase(path) {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        closes += 1;
        close();
        throw new Error("close failed");
      };
      return database;
    },
    createRenderer: () => {
      throw failure;
    },
    createHttpServer: () => {
      throw new Error("HTTP must not be created");
    },
  });
  await assert.rejects(app.start(), (error) => error === failure);
  await app.stop();
  assert.equal(closes, 1);
});

void test("an outbound start failure disposes every later dependency before rejecting startup", async (context) => {
  const events: string[] = [];
  const failure = new Error("outbound failed to start");
  const app = createApplication({
    config: config(context),
    logger: quietLogger,
    openDatabase(path) {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push("database");
        close();
      };
      return database;
    },
    createOutboundRuntime: () => ({
      worker: { start: () => undefined, stop: () => undefined },
      start: () => {
        throw failure;
      },
      stop: () => {
        events.push("outbound");
        throw new Error("stop failed");
      },
    }),
    createHttpServer: () => ({
      start: () => Promise.resolve(ADDRESS),
      stop: () => {
        events.push("http");
        return Promise.resolve();
      },
    }),
  });
  await assert.rejects(app.start(), (error) => error === failure);
  await app.stop();
  assert.deepEqual(events, ["outbound", "http", "database"]);
  assert.equal(app.isReady(), false);
});

void test("shutdown during deferred startup drains late acquisition exactly once", async (context) => {
  let acquired!: () => void;
  const acquisition = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  let finish!: (value: typeof ADDRESS) => void;
  const binding = new Promise<typeof ADDRESS>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const app = createApplication({
    config: config(context),
    logger: quietLogger,
    openDatabase(path) {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push("database");
        close();
      };
      return database;
    },
    createHttpServer: () => {
      acquired();
      return {
        start: () => binding,
        stop: () => {
          events.push("http");
          return Promise.resolve();
        },
      };
    },
  });
  const starting = app.start();
  await acquisition;
  const rejected = assert.rejects(starting, /interrupted by shutdown/u);
  const stopping = app.stop();
  assert.strictEqual(stopping, app.stop());
  finish(ADDRESS);
  await Promise.all([rejected, stopping]);
  assert.deepEqual(events, ["http", "database"]);
  assert.equal(app.isReady(), false);
});

void test("stopping before startup acquires nothing and a custom logger cannot interrupt cleanup", async (context) => {
  let opens = 0;
  const stopped = createApplication({
    config: config(context),
    logger: quietLogger,
    openDatabase: () => {
      opens += 1;
      throw new Error("must not open");
    },
  });
  await stopped.stop();
  await assert.rejects(stopped.start(), /cannot start from state: stopped/u);
  assert.equal(opens, 0);
  const events: string[] = [];
  const first = new Error("outbound cleanup failed");
  const app = createApplication({
    config: config(context),
    logger: {
      ...quietLogger,
      error: () => {
        throw new Error("logger failure");
      },
    },
    openDatabase(path) {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push("database");
        close();
      };
      return database;
    },
    createOutboundRuntime: () => ({
      worker: {
        start: () => undefined,
        stop: () => {
          events.push("outbound");
          throw first;
        },
      },
    }),
    createHttpServer: () => ({
      start: () => Promise.resolve(ADDRESS),
      stop: () => {
        events.push("http");
        return Promise.resolve();
      },
    }),
  });
  await app.start();
  await assert.rejects(app.stop(), (error) => error === first);
  assert.deepEqual(events, ["outbound", "http", "database"]);
});

void test("normal and saved Simulation cleanup both complete without replacing the first failure", async (context) => {
  const settings = config(context);
  const seed = openDatabase(settings.databasePath);
  setEnabled(seed, true);
  seed.close();
  const events: string[] = [];
  const first = new Error("normal workspace cleanup failed");
  const second = new Error("simulation cleanup failed");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Original is explicitly invoked with .call(this) below.
  const dispose = BeverageService.prototype.dispose;
  let calls = 0;
  context.mock.method(BeverageService.prototype, "dispose", function (this: BeverageService) {
    dispose.call(this);
    calls += 1;
    events.push(calls === 1 ? "normal.dispose" : "simulation.dispose");
    throw calls === 1 ? first : second;
  });
  const app = createApplication({
    config: settings,
    logger: quietLogger,
    openDatabase(path) {
      const database = openDatabase(path);
      const close = database.close.bind(database);
      database.close = () => {
        events.push(
          path.endsWith(".simulation.sqlite3") ? "simulation.database" : "normal.database",
        );
        close();
      };
      return database;
    },
    createHttpServer: () => ({
      start: () => Promise.resolve(ADDRESS),
      stop: () => {
        events.push("http");
        return Promise.resolve();
      },
    }),
  });
  await app.start();
  assert.equal(app.isReady(), true);
  await assert.rejects(app.stop(), (error) => error === first);
  await assert.rejects(app.stop(), (error) => error === first);
  assert.equal(calls, 2);
  assert.deepEqual(events, [
    "normal.dispose",
    "http",
    "normal.database",
    "simulation.dispose",
    "simulation.database",
  ]);
  assert.equal(app.isReady(), false);
});

void test("Workspace startup preserves its original error even when cleanup and logging both fail", async (context) => {
  const original = new Error("original startup failure");
  const cleanup = new Error("cleanup failure");
  let stops = 0;
  const app = new WorkspaceApplication(
    {
      config: config(context),
      logger: {
        ...quietLogger,
        error: () => {
          throw new Error("logger failure");
        },
      },
    },
    () => ({
      start: () => Promise.reject(original),
      stop: () => {
        stops += 1;
        return Promise.reject(cleanup);
      },
      isReady: () => false,
      address: () => undefined,
      renderer: () => undefined,
    }),
  );
  await assert.rejects(app.start(), (error) => error === original);
  await assert.rejects(app.stop(), (error) => error === cleanup);
  assert.equal(stops, 1);
});
