import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "../src/shared/errors.ts";
import { requireUuid, validationError } from "../src/shared/validation.ts";
import {
  validateUuid,
  validateDeleteFillInput,
  validateKickFillInput,
} from "../src/features/fills/fill-validation.ts";
import {
  validateKegId,
  validateCreateKegInput,
  validateDeleteKegInput,
} from "../src/features/kegs/keg-validation.ts";
import {
  validateTapId,
  validateFillId,
  validateUpdateTapInput,
  validateDeleteTapInput,
} from "../src/features/taps/tap-validation.ts";
import {
  validateTelemetrySourceId,
  validateTapId as validateTelemetryTapId,
  validateRenameTelemetrySourceInput,
} from "../src/features/telemetry/telemetry-validation.ts";
import {
  validateForecastFillId,
  validateBeverageId,
} from "../src/features/forecasting/forecast-validation.ts";

function assertValidationError(action: () => unknown, field: string, reason: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, "validation");
    assert.equal(error.code, "validation.invalid_value");
    assert.equal(error.message, "The request contains an invalid value.");
    assert.equal(error.clientMessage, error.message);
    assert.deepEqual(error.details, { field, reason });
    return true;
  });
}

void test("shared validation errors retain stable client-safe contracts", () => {
  assertValidationError(
    () => {
      throw validationError("example", "invalid example");
    },
    "example",
    "invalid example",
  );
});

const uuidValidators: readonly [string, (value: unknown, field?: string) => string, string][] = [
  ["shared", requireUuid, "id"],
  ["fill", validateUuid, "id"],
  ["keg", validateKegId, "id"],
  ["tap", validateTapId, "id"],
  ["tap fill", validateFillId, "fillId"],
  ["telemetry source", validateTelemetrySourceId, "id"],
  ["telemetry tap", validateTelemetryTapId, "tapId"],
  ["forecast fill", validateForecastFillId, "fillId"],
  ["forecast beverage", validateBeverageId, "beverageId"],
];
for (const [name, validate, defaultField] of uuidValidators) {
  void test(`${name} UUID syntax, normalization and errors remain compatible`, () => {
    for (const uuid of [
      "ABCDEF01-2345-6789-ABCD-EF0123456789",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ]) {
      assert.equal(validate(` \t${uuid}\n`), uuid.toLowerCase());
      assert.equal(validate(uuid, "custom.id"), uuid.toLowerCase());
    }
    for (const value of [
      undefined,
      null,
      123,
      {},
      [],
      "",
      "abcdef01-2345-6789-abcd-ef012345678",
      "abcdef01-2345-6789-abcd-ef012345678g",
      "abcdef0123456789abcdef0123456789",
      "abcdef01-2345-6789-abcd-ef0123456789extra",
    ]) {
      assertValidationError(() => validate(value), defaultField, "must be a valid UUID");
      assertValidationError(
        () => validate(value, "custom.id"),
        "custom.id",
        "must be a valid UUID",
      );
    }
  });
}

void test("destructive confirmation preserves exact whitespace and character limits", () => {
  for (const validate of [
    validateDeleteFillInput,
    validateDeleteKegInput,
    validateDeleteTapInput,
  ]) {
    assert.equal(validate({ confirmation: "  Visible label  " }).confirmation, "  Visible label  ");
    assert.equal(validate({ confirmation: "é".repeat(255) }).confirmation, "é".repeat(255));
    assertValidationError(
      () => validate({ confirmation: "a".repeat(256) }),
      "confirmation",
      "must not exceed 255 characters",
    );
  }
});

void test("fill reason and telemetry name retain byte limits", () => {
  assert.equal(validateKickFillInput({ reason: " é " }).reason, "é");
  assertValidationError(
    () => validateKickFillInput({ reason: "é".repeat(128) }),
    "reason",
    "must not exceed 255 bytes",
  );
  assert.equal(validateRenameTelemetrySourceInput({ name: "é".repeat(60) }).name, "é".repeat(60));
  assertValidationError(
    () => validateRenameTelemetrySourceInput({ name: "é".repeat(61) }),
    "name",
    "must not exceed 120 UTF-8 bytes",
  );
});

void test("nullable updates and legacy form coercions remain compatible", () => {
  const keg = validateCreateKegInput({
    kegNumber: " 2 ",
    capacityMl: "1000",
    label: " ",
    isActive: "false",
  });
  assert.equal(keg.kegNumber, 2);
  assert.equal(keg.label, null);
  assert.equal(keg.isActive, false);
  const tap = validateUpdateTapInput({ name: null, servingPressureKpa: null, enabled: "true" });
  assert.equal(tap.name, null);
  assert.equal(tap.servingPressureKpa, null);
  assert.equal(tap.enabled, true);
  assertValidationError(
    () => validateUpdateTapInput({ servingPressureKpa: "" }),
    "servingPressureKpa",
    "must be a valid number or null",
  );
  assert.deepEqual(validateKickFillInput(undefined), { reason: null });
  assert.deepEqual(validateKickFillInput(null), { reason: null });
});
