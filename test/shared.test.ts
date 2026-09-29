import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import {
  ApplicationError,
  isObviousSecretKey,
  redactSafeErrorDetails,
} from "../src/shared/errors.ts";
import { createLogger } from "../src/shared/logging.ts";
import {
  rejectUnknownKeys,
  requireBoundedNonemptyString,
  requireIntegerInRange,
  requirePlainObject,
} from "../src/shared/validation.ts";

void test("application errors carry only stable client-safe fields", () => {
  const error = new ApplicationError({
    category: "validation",
    code: "validation.example",
    clientMessage: "Invalid value.",
    details: { field: "name" },
    cause: new Error("private cause"),
  });

  assert.equal(error.category, "validation");
  assert.equal(error.code, "validation.example");
  assert.equal(error.clientMessage, "Invalid value.");
  assert.deepEqual(error.details, { field: "name" });
});

void test("application-error detail redaction recognizes obvious secret-like keys", () => {
  const secretKeys = [
    "password",
    "adminPin",
    "client_secret",
    "refreshToken",
    "api-key",
    "api_key",
    "authorizationHeader",
    "cookie",
    "sessionId",
    "credential",
  ];
  for (const key of secretKeys) {
    assert.equal(isObviousSecretKey(key), true, `expected ${key} to be treated as sensitive`);
  }
  assert.equal(isObviousSecretKey("field"), false);
  assert.equal(isObviousSecretKey("reason"), false);

  assert.deepEqual(
    redactSafeErrorDetails({ field: "name", reason: "required", apiKey: "private-value" }),
    { field: "name", reason: "required", apiKey: "[REDACTED]" },
  );
});

void test("explicit validation primitives accept valid input and reject ambiguous input", () => {
  const input = requirePlainObject({ name: " Tapboard ", count: "4" }, "input");
  rejectUnknownKeys(input, ["name", "count"], "input");
  assert.equal(requireBoundedNonemptyString(input.name, "name", { maxLength: 20 }), "Tapboard");
  assert.equal(requireIntegerInRange(input.count, "count", 0, 10), 4);

  assert.throws(() => requirePlainObject([], "input"), /invalid value/i);
  assert.throws(() => rejectUnknownKeys({ extra: true }, [], "input"), /invalid value/i);
  assert.throws(
    () => requireBoundedNonemptyString("   ", "name", { maxLength: 20 }),
    /invalid value/i,
  );
  assert.throws(() => requireIntegerInRange("1.5", "count", 0, 10), /invalid value/i);
});

void test("configuration has collision-free defaults and validates injected values", () => {
  const config = loadConfig({ env: {}, baseDirectory: "/tmp/tapboard-config-root" });
  assert.deepEqual(config, {
    host: "127.0.0.1",
    port: 3000,
    databasePath: resolve("/tmp/tapboard-config-root/data/tapboard-v2.sqlite3"),
    shutdownGraceMs: 5000,
    sessionInactivityMs: 2_592_000_000,
    sessionAbsoluteMs: 31_536_000_000,
    trustedProxies: [],
    secretKeyState: "missing",
  });

  assert.equal(loadConfig({ env: { TAPBOARD_PORT: "0" } }).port, 0);
  assert.throws(() => loadConfig({ env: { TAPBOARD_PORT: "65536" } }), /invalid value/i);
  assert.throws(() => loadConfig({ env: { TAPBOARD_SHUTDOWN_GRACE_MS: "0" } }), /invalid value/i);
  assert.deepEqual(
    loadConfig({
      env: {
        TAPBOARD_EXTERNAL_ORIGIN: "https://admin.example",
        TAPBOARD_TRUSTED_PROXIES: "127.0.0.1,::1",
        TAPBOARD_SESSION_INACTIVITY_MS: "60000",
        TAPBOARD_SESSION_ABSOLUTE_MS: "120000",
      },
    }),
    {
      host: "127.0.0.1",
      port: 3000,
      databasePath: resolve(process.cwd(), "data/tapboard-v2.sqlite3"),
      shutdownGraceMs: 5000,
      sessionInactivityMs: 60000,
      sessionAbsoluteMs: 120000,
      canonicalExternalOrigin: "https://admin.example",
      trustedProxies: ["127.0.0.1", "::1"],
      secretKeyState: "missing",
    },
  );
  assert.throws(
    () => loadConfig({ env: { TAPBOARD_EXTERNAL_ORIGIN: "https://admin.example/" } }),
    /invalid/i,
  );
  assert.throws(
    () => loadConfig({ env: { TAPBOARD_TRUSTED_PROXIES: "127.0.0.1,127.0.0.1" } }),
    /invalid/i,
  );
  assert.equal(loadConfig({ env: { TAPBOARD_SECRET_KEY: "" } }).secretKeyState, "invalid");
  const validKey = Buffer.alloc(32, 3).toString("base64url");
  assert.deepEqual(loadConfig({ env: { TAPBOARD_SECRET_KEY: validKey } }), {
    host: "127.0.0.1",
    port: 3000,
    databasePath: resolve(process.cwd(), "data/tapboard-v2.sqlite3"),
    shutdownGraceMs: 5000,
    sessionInactivityMs: 2_592_000_000,
    sessionAbsoluteMs: 31_536_000_000,
    trustedProxies: [],
    secretKey: validKey,
    secretKeyState: "available",
  });
});

void test("configuration accepts legacy deployment aliases with canonical precedence", () => {
  const baseDirectory = "/tmp/tapboard-config-alias-root";
  assert.equal(loadConfig({ env: { PORT: "3005" }, baseDirectory }).port, 3005);
  assert.equal(
    loadConfig({ env: { DATA_DIR: "/srv/tapboard/data" }, baseDirectory }).databasePath,
    resolve("/srv/tapboard/data/tapboard-v2.sqlite3"),
  );
  assert.equal(
    loadConfig({ env: { TAPBOARD_PUBLIC_ORIGIN: "https://legacy.example" }, baseDirectory })
      .canonicalExternalOrigin,
    "https://legacy.example",
  );
  assert.equal(
    loadConfig({ env: { TAPBOARD_PUBLIC_ORIGIN: "" }, baseDirectory }).canonicalExternalOrigin,
    undefined,
  );

  assert.equal(loadConfig({ env: { TAPBOARD_PORT: "3006", PORT: "3007" } }).port, 3006);
  assert.equal(
    loadConfig({
      env: {
        TAPBOARD_DATABASE_PATH: "/srv/tapboard/canonical.sqlite3",
        DATA_DIR: "/srv/tapboard/legacy",
      },
    }).databasePath,
    resolve("/srv/tapboard/canonical.sqlite3"),
  );
  assert.equal(
    loadConfig({
      env: {
        TAPBOARD_EXTERNAL_ORIGIN: "https://canonical.example",
        TAPBOARD_PUBLIC_ORIGIN: "https://legacy.example",
      },
    }).canonicalExternalOrigin,
    "https://canonical.example",
  );

  assert.throws(() => loadConfig({ env: { TAPBOARD_PORT: "", PORT: "3005" } }), /invalid/i);
  assert.throws(
    () => loadConfig({ env: { TAPBOARD_DATABASE_PATH: "", DATA_DIR: "/srv/tapboard" } }),
    /invalid/i,
  );
  assert.throws(
    () =>
      loadConfig({
        env: {
          TAPBOARD_EXTERNAL_ORIGIN: "",
          TAPBOARD_PUBLIC_ORIGIN: "https://legacy.example",
        },
      }),
    /invalid/i,
  );
  assert.throws(() => loadConfig({ env: { PORT: "not-a-port" } }), /invalid/i);
  assert.throws(() => loadConfig({ env: { DATA_DIR: "   " } }), /invalid/i);
  assert.throws(() => loadConfig({ env: { TAPBOARD_PUBLIC_ORIGIN: "not-an-origin" } }), /invalid/i);
});

void test("legacy database files remain untouched when resolving the v2 path", () => {
  const root = mkdtempSync(join(tmpdir(), "tapboard-config-alias-"));
  try {
    const legacyPath = join(root, "tapboard.db");
    const v2Path = join(root, "tapboard-v2.sqlite3");
    writeFileSync(legacyPath, "legacy database marker", "utf8");

    const config = loadConfig({ env: { DATA_DIR: root }, baseDirectory: root });

    assert.equal(config.databasePath, v2Path);
    assert.equal(readFileSync(legacyPath, "utf8"), "legacy database marker");
    assert.equal(existsSync(v2Path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("structured logging recursively redacts secrets and safely serializes difficult values", () => {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  const cyclic: Record<string, unknown> = { visible: "yes" };
  cyclic.self = cyclic;

  logger.error("safe event", {
    password: "never log me",
    nested: {
      api_key: "also hidden",
      authorizationHeader: "hidden",
      okay: 42n,
      missing: undefined,
    },
    cyclic,
    error: new Error("private message"),
  });

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /never log me|also hidden|private message/);
  assert.deepEqual(JSON.parse(lines[0]!) as unknown, {
    timestamp: "2026-08-13T12:00:00.000Z",
    level: "error",
    message: "safe event",
    context: {
      password: "[REDACTED]",
      nested: {
        api_key: "[REDACTED]",
        authorizationHeader: "[REDACTED]",
        okay: "42",
        missing: "[Undefined]",
      },
      cyclic: { visible: "yes", self: "[Circular]" },
      error: { name: "Error" },
    },
  });
});

void test("logging never throws when time, context, or sink serialization fails", () => {
  const throwing = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwing, "value", {
    enumerable: true,
    get() {
      throw new Error("getter failure");
    },
  });
  const logger = createLogger({
    sink: () => {
      throw new Error("sink failure");
    },
  });

  assert.doesNotThrow(() => logger.info("event", throwing));
});
