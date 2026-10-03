import {
  requireUuid,
  validationError as invalid,
  rejectUnknownKeys,
  requirePlainObject,
} from "../../shared/validation.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const DEFAULT_FORECAST_HISTORY_LIMIT = 50;
export const MAX_FORECAST_HISTORY_LIMIT = 200;

export function validateForecastFillId(value: unknown, field = "fillId"): string {
  return requireUuid(value, field);
}

export interface UpdateForecastSettingsInput {
  readonly servingSizeMl: number;
}

export function validateUpdateForecastSettingsInput(input: unknown): UpdateForecastSettingsInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["servingSizeMl"], "body");
  if (Object.keys(object).length !== 1 || !Object.hasOwn(object, "servingSizeMl")) {
    throw invalid("body", "servingSizeMl is required");
  }
  const servingSizeMl = object.servingSizeMl;
  if (typeof servingSizeMl !== "number" || !Number.isFinite(servingSizeMl) || servingSizeMl <= 0) {
    throw invalid("servingSizeMl", "must be a finite number greater than zero");
  }
  return { servingSizeMl };
}

export interface UpdateBeveragePourSettingInput {
  readonly pourSizeMl: number;
}

export function validateBeverageId(value: unknown, field = "beverageId"): string {
  return requireUuid(value, field);
}

export function validateUpdateBeveragePourSettingInput(
  input: unknown,
): UpdateBeveragePourSettingInput {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["pourSizeMl"], "body");
  if (Object.keys(object).length !== 1 || !Object.hasOwn(object, "pourSizeMl")) {
    throw invalid("body", "pourSizeMl is required");
  }
  const pourSizeMl = object.pourSizeMl;
  if (typeof pourSizeMl !== "number" || !Number.isFinite(pourSizeMl) || pourSizeMl <= 0) {
    throw invalid("pourSizeMl", "must be a finite number greater than zero");
  }
  return { pourSizeMl };
}

export function validateForecastHistoryLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_FORECAST_HISTORY_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_FORECAST_HISTORY_LIMIT
  ) {
    throw invalid("limit", `must be an integer between 1 and ${MAX_FORECAST_HISTORY_LIMIT}`);
  }
  return value;
}

export interface ForecastHistoryCursor {
  readonly completedAt: string;
  readonly id: string;
}

export function encodeForecastHistoryCursor(cursor: ForecastHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeForecastHistoryCursor(value: unknown): ForecastHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.length % 4 === 1 ||
    !BASE64URL.test(value)
  ) {
    throw invalid("cursor", "must be a valid history cursor");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical base64url");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("cursor", "must be a valid history cursor");
  }
  const object = requirePlainObject(decoded, "cursor");
  rejectUnknownKeys(object, ["completedAt", "id"], "cursor");
  if (
    typeof object.completedAt !== "string" ||
    !RFC3339_INSTANT.test(object.completedAt) ||
    !Number.isFinite(Date.parse(object.completedAt)) ||
    new Date(Date.parse(object.completedAt)).toISOString() !== object.completedAt
  ) {
    throw invalid("cursor", "must contain a valid completedAt instant");
  }
  return { completedAt: object.completedAt, id: validateForecastFillId(object.id, "cursor.id") };
}
