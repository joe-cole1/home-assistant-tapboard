import assert from "node:assert/strict";
import test from "node:test";

import { adminFailureMessage, errorStatus, reportFailure } from "../src/shared/diagnostics.ts";
import { ApplicationError, type ApplicationErrorCategory } from "../src/shared/errors.ts";
import { createLogger, type Logger } from "../src/shared/logging.ts";

void test("failure categories have authoritative HTTP statuses and curated expected messages", () => {
  const statuses: Record<ApplicationErrorCategory, number> = {
    validation: 400,
    too_large: 413,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    unavailable: 503,
    internal: 500,
  };
  for (const [category, status] of Object.entries(statuses)) {
    assert.equal(errorStatus(category as ApplicationErrorCategory), status);
    const lines: string[] = [];
    const report = reportFailure(
      new ApplicationError({
        category: category as ApplicationErrorCategory,
        code: "safe.code",
        clientMessage: "Curated guidance.",
      }),
      { operation: "admin.test", logger: createLogger({ sink: (line) => lines.push(line) }) },
    );
    assert.equal(report.expected, true);
    assert.equal(report.message, "Curated guidance.");
    assert.equal(report.status, status);
    const operational = category === "unavailable" || category === "internal";
    assert.equal(lines.length, operational ? 1 : 0);
    assert.equal(report.reference !== undefined, operational);
    assert.equal(
      adminFailureMessage(report, "Fallback."),
      operational ? `Curated guidance. Reference: ${report.reference}.` : "Curated guidance.",
    );
  }
});

void test("unexpected failures expose no raw error data and correlate one sanitized event", () => {
  const sentinel = "sentinel-private-api-credential";
  for (const error of [new Error(sentinel), { message: sentinel, details: sentinel }, sentinel]) {
    const lines: string[] = [];
    const report = reportFailure(error, {
      operation: "admin.test",
      logger: createLogger({ sink: (line) => lines.push(line) }),
    });
    assert.equal(report.expected, false);
    assert.equal(report.code, "internal.unexpected");
    assert.equal(report.status, 500);
    assert.equal(report.message, "An unexpected error occurred.");
    assert.match(report.reference!, /^[0-9a-f-]{36}$/);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!) as {
      level: string;
      message: string;
      context: Record<string, unknown>;
    };
    assert.equal(event.level, "error");
    assert.equal(event.message, "Operation failed");
    assert.deepEqual(event.context, {
      operation: "admin.test",
      code: report.code,
      category: "internal",
      reference: report.reference,
      httpStatus: 500,
    });
    assert.equal(
      JSON.stringify([report, lines, adminFailureMessage(report, "Save failed.")]).includes(
        sentinel,
      ),
      false,
    );
    assert.equal(
      adminFailureMessage(report, "Save failed."),
      `Save failed. Reference: ${report.reference}.`,
    );
  }
});

void test("operational known failures log code and reference without cause, details or message", () => {
  const sentinel = "sentinel-private-api-credential";
  const lines: string[] = [];
  const report = reportFailure(
    new ApplicationError({
      category: "unavailable",
      code: "secrets.key_missing",
      clientMessage: "Safe server configuration guidance.",
      cause: new Error(sentinel),
      details: { token: sentinel },
    }),
    {
      operation: "admin.credentials.save",
      logger: createLogger({ sink: (line) => lines.push(line) }),
    },
  );
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]!) as { level: string; context: { reference: string } };
  assert.equal(event.level, "warn");
  assert.equal(lines[0]!.includes(sentinel), false);
  assert.equal(lines[0]!.includes("Safe server configuration guidance."), false);
  assert.equal(event.context.reference, report.reference);
});

void test("a throwing custom logger does not change failure reporting", () => {
  const fail = (): never => {
    throw new Error("logger failed");
  };
  const logger: Logger = { debug: fail, info: fail, warn: fail, error: fail };
  for (const error of [
    new Error("private"),
    new ApplicationError({
      category: "unavailable",
      code: "safe.code",
      clientMessage: "Safe guidance.",
    }),
  ]) {
    assert.ok(reportFailure(error, { operation: "admin.test", logger }).reference);
  }
});

void test("provider diagnostics allow only bounded numeric status and retry metadata", () => {
  for (const valid of [true, false]) {
    const lines: string[] = [];
    reportFailure(
      new ApplicationError({
        category: "unavailable",
        code: "brewfather.rate_limited",
        clientMessage: "Try again later.",
        details: {
          providerStatus: valid ? 429 : 999,
          retryAfterMs: valid ? 60_000 : -1,
          untrusted: "private-provider-body",
        },
      }),
      {
        operation: "admin.brewfather.sync",
        logger: createLogger({ sink: (line) => lines.push(line) }),
      },
    );
    const context = (JSON.parse(lines[0]!) as { context: Record<string, unknown> }).context;
    assert.equal(context.providerStatus, valid ? 429 : undefined);
    assert.equal(context.retryAfterMs, valid ? 60_000 : undefined);
    assert.equal(lines[0]!.includes("private-provider-body"), false);
  }
});

void test("long Admin error messages retain their matching reference in form redirects", () => {
  const report = reportFailure(
    new ApplicationError({
      category: "unavailable",
      code: "safe.unavailable",
      clientMessage: "x".repeat(300),
    }),
    { operation: "admin.test" },
  );
  const message = adminFailureMessage(report, "Fallback.");
  assert.equal(message.length, 240);
  assert.ok(message.endsWith(` Reference: ${report.reference}.`));
});
