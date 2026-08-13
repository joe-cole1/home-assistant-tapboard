import assert from "node:assert/strict";
import { resolve } from "node:path";
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
  });

  assert.equal(loadConfig({ env: { TAPBOARD_PORT: "0" } }).port, 0);
  assert.throws(() => loadConfig({ env: { TAPBOARD_PORT: "65536" } }), /invalid value/i);
  assert.throws(() => loadConfig({ env: { TAPBOARD_SHUTDOWN_GRACE_MS: "0" } }), /invalid value/i);
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
