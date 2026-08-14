import { ApplicationError } from "../../shared/errors.ts";
import {
  rejectUnknownKeys,
  requireBoundedNonemptyString,
  requireIntegerInRange,
  requirePlainObject,
} from "../../shared/validation.ts";
import type {
  CreateKegInput,
  DeleteKegInput,
  RecordMaintenanceInput,
  UpdateKegInput,
} from "./types.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEG_NUMBER = 1_000_000;
const MAX_CAPACITY_ML = 100_000_000; // 100,000 liters
const MAX_TARE_G = 100_000_000; // 100,000 kg
const MAX_LABEL_LENGTH = 120;
const MAX_MAINTENANCE_TYPE_LENGTH = 80;
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

export function validateKegId(value: unknown, field = "id"): string {
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

function normalizeTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw validationError(field, "must be a valid ISO timestamp");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError(field, "must be a valid ISO timestamp");
  }
  return date.toISOString();
}

export function validateCreateKegInput(input: unknown): CreateKegInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(
    object,
    ["id", "kegNumber", "label", "capacityMl", "currentTareG", "tareWeightG", "isActive"],
    "body",
  );

  const id = object.id !== undefined ? validateKegId(object.id, "id") : undefined;
  const kegNumber = requireIntegerInRange(object.kegNumber, "kegNumber", 1, MAX_KEG_NUMBER);
  const label = normalizeOptionalText(object.label, "label", MAX_LABEL_LENGTH);
  const capacityMl = requireIntegerInRange(object.capacityMl, "capacityMl", 1, MAX_CAPACITY_ML);

  const rawTare = object.currentTareG ?? object.tareWeightG ?? 0;
  const currentTareG = requireIntegerInRange(rawTare, "currentTareG", 0, MAX_TARE_G);
  const isActive = normalizeBoolean(object.isActive, "isActive", true);

  return {
    ...(id !== undefined ? { id } : {}),
    kegNumber,
    label,
    capacityMl,
    currentTareG,
    isActive,
  };
}

export function validateUpdateKegInput(input: unknown): UpdateKegInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(
    object,
    ["kegNumber", "label", "capacityMl", "currentTareG", "tareWeightG", "isActive", "reason"],
    "body",
  );

  const hasAnyKey =
    object.kegNumber !== undefined ||
    object.label !== undefined ||
    object.capacityMl !== undefined ||
    object.currentTareG !== undefined ||
    object.tareWeightG !== undefined ||
    object.isActive !== undefined ||
    object.reason !== undefined;

  if (!hasAnyKey) {
    throw validationError("body", "at least one field must be provided for update");
  }

  const result: UpdateKegInput = {
    ...(object.kegNumber !== undefined
      ? { kegNumber: requireIntegerInRange(object.kegNumber, "kegNumber", 1, MAX_KEG_NUMBER) }
      : {}),
    ...(object.label !== undefined
      ? { label: normalizeOptionalText(object.label, "label", MAX_LABEL_LENGTH) }
      : {}),
    ...(object.capacityMl !== undefined
      ? { capacityMl: requireIntegerInRange(object.capacityMl, "capacityMl", 1, MAX_CAPACITY_ML) }
      : {}),
    ...(object.currentTareG !== undefined || object.tareWeightG !== undefined
      ? {
          currentTareG: requireIntegerInRange(
            object.currentTareG ?? object.tareWeightG,
            "currentTareG",
            0,
            MAX_TARE_G,
          ),
        }
      : {}),
    ...(object.isActive !== undefined
      ? { isActive: normalizeBoolean(object.isActive, "isActive") }
      : {}),
    ...(object.reason !== undefined
      ? { reason: normalizeOptionalText(object.reason, "reason", MAX_REASON_LENGTH) }
      : {}),
  };

  return result;
}

export function validateRecordMaintenanceInput(input: unknown): RecordMaintenanceInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["maintenanceType", "notes", "recordedAt"], "body");

  const maintenanceType = requireBoundedNonemptyString(object.maintenanceType, "maintenanceType", {
    minLength: 1,
    maxLength: MAX_MAINTENANCE_TYPE_LENGTH,
  });
  const notes = normalizeOptionalText(object.notes, "notes", MAX_NOTES_LENGTH);
  const recordedAt = normalizeTimestamp(object.recordedAt, "recordedAt");

  return {
    maintenanceType,
    notes,
    ...(recordedAt !== undefined ? { recordedAt } : {}),
  };
}

export function validateDeleteKegInput(input: unknown): DeleteKegInput {
  if (
    input === undefined ||
    input === null ||
    (typeof input === "object" && Object.keys(input).length === 0)
  ) {
    return { reason: null };
  }
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["reason"], "body");
  const reason = normalizeOptionalText(object.reason, "reason", MAX_REASON_LENGTH);
  return { reason };
}
