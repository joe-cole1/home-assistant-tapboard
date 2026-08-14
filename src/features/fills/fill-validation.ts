import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import type {
  CreateFillInput,
  DeleteFillInput,
  KickFillInput,
  ReorderOnDeckInput,
  UpdateFillSettingsInput,
} from "./types.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 255;

function validationError(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

export function validateUuid(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim())) {
    throw validationError(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}

export function validateFillDate(value: unknown, field = "fillDate"): string {
  if (typeof value !== "string") {
    throw validationError(field, "must be a string in YYYY-MM-DD format");
  }
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw validationError(field, "must be a valid date in YYYY-MM-DD format");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw validationError(field, "must be a valid calendar date");
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw validationError(field, "must be a valid calendar date");
  }

  return trimmed;
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
  if (Buffer.byteLength(trimmed, "utf8") > maxLength) {
    throw validationError(field, `must not exceed ${maxLength} bytes`);
  }
  return trimmed;
}

export function validateCreateFillInput(input: unknown): CreateFillInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["id", "beverageId", "kegId", "fillDate"], "body");

  const id = object.id !== undefined ? validateUuid(object.id, "id") : undefined;
  const beverageId = validateUuid(object.beverageId, "beverageId");
  const kegId = validateUuid(object.kegId, "kegId");
  const fillDate =
    object.fillDate !== undefined ? validateFillDate(object.fillDate, "fillDate") : undefined;

  return {
    ...(id !== undefined ? { id } : {}),
    beverageId,
    kegId,
    ...(fillDate !== undefined ? { fillDate } : {}),
  };
}

export function validateKickFillInput(input: unknown): KickFillInput {
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

export function validateReorderOnDeckInput(input: unknown): ReorderOnDeckInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["fillIds"], "body");

  const rawList: unknown = object.fillIds;
  if (!Array.isArray(rawList)) {
    throw validationError("fillIds", "must be an array of UUIDs");
  }

  const fillIds: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawList.length; i += 1) {
    const rawId: unknown = rawList[i];
    const validId = validateUuid(rawId, `fillIds[${i}]`);
    if (seen.has(validId)) {
      throw validationError("fillIds", `duplicate fill ID: ${validId}`);
    }
    seen.add(validId);
    fillIds.push(validId);
  }

  return { fillIds };
}

export function validateFillSettingsInput(input: unknown): UpdateFillSettingsInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["autoDeleteBeverageOnLastFill"], "body");

  if (typeof object.autoDeleteBeverageOnLastFill !== "boolean") {
    throw validationError("autoDeleteBeverageOnLastFill", "must be a strict boolean");
  }

  return {
    autoDeleteBeverageOnLastFill: object.autoDeleteBeverageOnLastFill,
  };
}

export function validateDeleteFillInput(input: unknown): DeleteFillInput {
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

export interface ListFillsQuery {
  readonly state?: string;
  readonly beverageId?: string;
  readonly kegId?: string;
}

export function validateListFillsQuery(query: unknown): ListFillsQuery {
  if (query === undefined || query === null || typeof query !== "object") {
    return {};
  }
  const q = query as Record<string, unknown>;
  const result: { state?: string; beverageId?: string; kegId?: string } = {};

  if (typeof q.state === "string" && q.state.trim().length > 0) {
    const s = q.state.trim().toLowerCase();
    if (!["available", "on_deck", "on_tap", "ended"].includes(s)) {
      throw validationError("state", "must be one of: available, on_deck, on_tap, ended");
    }
    result.state = s;
  }

  if (typeof q.beverageId === "string" && q.beverageId.trim().length > 0) {
    result.beverageId = validateUuid(q.beverageId, "beverageId");
  }

  if (typeof q.kegId === "string" && q.kegId.trim().length > 0) {
    result.kegId = validateUuid(q.kegId, "kegId");
  }

  return result;
}
