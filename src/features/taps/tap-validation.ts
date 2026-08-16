import { ApplicationError } from "../../shared/errors.ts";
import {
  rejectUnknownKeys,
  requireIntegerInRange,
  requirePlainObject,
} from "../../shared/validation.ts";
import type {
  AssignTapInput,
  CreateTapInput,
  DeleteTapInput,
  MoveTapInput,
  RetireTapInput,
  UpdateTapInput,
  UpdateTapAssignmentMysteryInput,
} from "./types.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAP_NUMBER = 1_000_000;
const MAX_NAME_LENGTH = 120;
const MAX_GAS_TYPE_LENGTH = 64;
const MAX_NOTES_LENGTH = 2048;
const MAX_REASON_LENGTH = 255;

function validationError(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

export function validateTapId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim())) {
    throw validationError(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}

export function validateFillId(value: unknown, field = "fillId"): string {
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim())) {
    throw validationError(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw validationError(field, "must be a string or null");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw validationError(field, `must not exceed ${maxLength} characters`);
  }
  return trimmed;
}

function normalizeBoolean(value: unknown, field: string, defaultValue = true): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === "true" || value === "1") {
    return true;
  }
  if (value === 0 || value === "false" || value === "0") {
    return false;
  }
  throw validationError(field, "must be a boolean");
}

function normalizeOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  exclusiveMin = false,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw validationError(field, "must be a valid number or null");
  }
  if (exclusiveMin ? value <= min : value < min) {
    throw validationError(
      field,
      exclusiveMin ? `must be greater than ${min}` : `must be at least ${min}`,
    );
  }
  return value;
}

function normalizeOptionalInteger(value: unknown, field: string, min: number): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw validationError(field, "must be a valid integer or null");
  }
  if (value < min) {
    throw validationError(field, `must be at least ${min}`);
  }
  return value;
}

export function validateCreateTapInput(input: unknown): CreateTapInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(
    object,
    [
      "id",
      "tapNumber",
      "name",
      "enabled",
      "gasType",
      "servingPressureKpa",
      "lineLengthMm",
      "lineDiameterMm",
      "notes",
    ],
    "body",
  );

  const id = object.id !== undefined ? validateTapId(object.id, "id") : undefined;
  const tapNumber = requireIntegerInRange(object.tapNumber, "tapNumber", 1, MAX_TAP_NUMBER);
  const name = normalizeOptionalText(object.name, "name", MAX_NAME_LENGTH);
  const enabled = normalizeBoolean(object.enabled, "enabled", true);
  const gasType = normalizeOptionalText(object.gasType, "gasType", MAX_GAS_TYPE_LENGTH);
  const servingPressureKpa = normalizeOptionalNumber(
    object.servingPressureKpa,
    "servingPressureKpa",
    0,
  );
  const lineLengthMm = normalizeOptionalInteger(object.lineLengthMm, "lineLengthMm", 0);
  const lineDiameterMm = normalizeOptionalNumber(object.lineDiameterMm, "lineDiameterMm", 0, true);
  const notes = normalizeOptionalText(object.notes, "notes", MAX_NOTES_LENGTH);

  return {
    ...(id !== undefined ? { id } : {}),
    tapNumber,
    name,
    enabled,
    gasType,
    servingPressureKpa,
    lineLengthMm,
    lineDiameterMm,
    notes,
  };
}

export function validateUpdateTapInput(input: unknown): UpdateTapInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(
    object,
    [
      "tapNumber",
      "name",
      "enabled",
      "gasType",
      "servingPressureKpa",
      "lineLengthMm",
      "lineDiameterMm",
      "notes",
      "acknowledgeTelemetryEndpointImpact",
    ],
    "body",
  );

  const tapNumber =
    object.tapNumber !== undefined
      ? requireIntegerInRange(object.tapNumber, "tapNumber", 1, MAX_TAP_NUMBER)
      : undefined;
  const name =
    object.name !== undefined
      ? normalizeOptionalText(object.name, "name", MAX_NAME_LENGTH)
      : undefined;
  const enabled =
    object.enabled !== undefined ? normalizeBoolean(object.enabled, "enabled") : undefined;
  const gasType =
    object.gasType !== undefined
      ? normalizeOptionalText(object.gasType, "gasType", MAX_GAS_TYPE_LENGTH)
      : undefined;
  const servingPressureKpa =
    object.servingPressureKpa !== undefined
      ? normalizeOptionalNumber(object.servingPressureKpa, "servingPressureKpa", 0)
      : undefined;
  const lineLengthMm =
    object.lineLengthMm !== undefined
      ? normalizeOptionalInteger(object.lineLengthMm, "lineLengthMm", 0)
      : undefined;
  const lineDiameterMm =
    object.lineDiameterMm !== undefined
      ? normalizeOptionalNumber(object.lineDiameterMm, "lineDiameterMm", 0, true)
      : undefined;
  const notes =
    object.notes !== undefined
      ? normalizeOptionalText(object.notes, "notes", MAX_NOTES_LENGTH)
      : undefined;
  const acknowledgeTelemetryEndpointImpact =
    object.acknowledgeTelemetryEndpointImpact !== undefined
      ? normalizeBoolean(
          object.acknowledgeTelemetryEndpointImpact,
          "acknowledgeTelemetryEndpointImpact",
          false,
        )
      : undefined;

  return {
    ...(tapNumber !== undefined ? { tapNumber } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(gasType !== undefined ? { gasType } : {}),
    ...(servingPressureKpa !== undefined ? { servingPressureKpa } : {}),
    ...(lineLengthMm !== undefined ? { lineLengthMm } : {}),
    ...(lineDiameterMm !== undefined ? { lineDiameterMm } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(acknowledgeTelemetryEndpointImpact !== undefined
      ? { acknowledgeTelemetryEndpointImpact }
      : {}),
  };
}

export function validateAssignTapInput(input: unknown): AssignTapInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["fillId"], "body");
  const fillId = validateFillId(object.fillId, "fillId");
  return { fillId };
}

export function validateMoveTapInput(input: unknown): MoveTapInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["targetTapId"], "body");
  const targetTapId = validateTapId(object.targetTapId, "targetTapId");
  return { targetTapId };
}

export function validateRetireTapInput(input: unknown): RetireTapInput {
  if (input === undefined || input === null) {
    return { reason: null };
  }
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["reason"], "body");
  const reason = normalizeOptionalText(object.reason, "reason", MAX_REASON_LENGTH);
  return { reason };
}

export function validateDeleteTapInput(input: unknown): DeleteTapInput {
  if (input === undefined || input === null) {
    return { reason: null };
  }
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["reason"], "body");
  const reason = normalizeOptionalText(object.reason, "reason", MAX_REASON_LENGTH);
  return { reason };
}

export function validateUpdateTapAssignmentMysteryInput(
  input: unknown,
): UpdateTapAssignmentMysteryInput {
  const object = requirePlainObject(input, "body");
  const fields = [
    "enabled",
    "revealBeverageType",
    "revealStyle",
    "revealAbv",
    "revealIbu",
    "revealOg",
    "revealFg",
    "revealSrm",
    "revealDescription",
    "revealRecipe",
    "revealSensory",
    "revealHistory",
  ] as const;
  rejectUnknownKeys(object, [...fields], "body");
  const value = (field: (typeof fields)[number]): boolean => {
    if (typeof object[field] !== "boolean") throw validationError(field, "must be a boolean");
    return object[field];
  };
  return {
    enabled: value("enabled"),
    revealBeverageType: value("revealBeverageType"),
    revealStyle: value("revealStyle"),
    revealAbv: value("revealAbv"),
    revealIbu: value("revealIbu"),
    revealOg: value("revealOg"),
    revealFg: value("revealFg"),
    revealSrm: value("revealSrm"),
    revealDescription: value("revealDescription"),
    revealRecipe: value("revealRecipe"),
    revealSensory: value("revealSensory"),
    revealHistory: value("revealHistory"),
  };
}
