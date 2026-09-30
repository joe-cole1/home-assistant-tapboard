import { ApplicationError } from "../../shared/errors.ts";
import { requirePlainObject } from "../../shared/validation.ts";
import { isActivityCategory } from "../activity/types.ts";
import type { ActivityCategory } from "../activity/types.ts";
import { validateUpdateBeverageSettingsInput } from "../beverages/beverage-validation.ts";
import { validateUpdateForecastSettingsInput } from "../forecasting/forecast-validation.ts";
import { validateUpdateTelemetrySettingsInput } from "../telemetry/telemetry-validation.ts";
import type {
  SystemActivityCursor,
  SystemActorOptions,
  UpdateCalculationSettingsInput,
  UpdateSystemRetentionSettingsInput,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function invalid(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "system.invalid_settings",
    clientMessage: "The System request contains an invalid value.",
    details: { field, reason },
  });
}

/** Reject accessors, symbols, unknown keys and explicit undefined before calling feature validators. */
function inputObject(
  value: unknown,
  allowed: readonly string[],
  field: string,
): Record<string, unknown> {
  const result = requirePlainObject(value, field);
  if (Object.getOwnPropertySymbols(result).length > 0) throw invalid(field, "has unsupported keys");
  for (const key of Object.getOwnPropertyNames(result)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!allowed.includes(key) || descriptor === undefined || !("value" in descriptor)) {
      throw invalid(field, "has unsupported fields");
    }
    if (!descriptor.enumerable || descriptor.value === undefined)
      throw invalid(field, "has an invalid field");
  }
  return result;
}

function retentionDays(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 3_650) {
    throw invalid(field, "must be an integer between 1 and 3650");
  }
  return value;
}

export function validateCalculationSettings(input: unknown): UpdateCalculationSettingsInput {
  const object = inputObject(input, ["fallbackFg", "servingSizeMl"], "calculation");
  if (Object.keys(object).length === 0) throw invalid("calculation", "requires a setting");
  if (Object.hasOwn(object, "fallbackFg") && typeof object.fallbackFg !== "number")
    throw invalid("fallbackFg", "must be a number");
  const fallback = Object.hasOwn(object, "fallbackFg")
    ? validateUpdateBeverageSettingsInput({ fallbackFg: object.fallbackFg }).fallbackFg
    : undefined;
  const serving = Object.hasOwn(object, "servingSizeMl")
    ? validateUpdateForecastSettingsInput({ servingSizeMl: object.servingSizeMl }).servingSizeMl
    : undefined;
  return {
    ...(fallback === undefined ? {} : { fallbackFg: fallback }),
    ...(serving === undefined ? {} : { servingSizeMl: serving }),
  };
}

export function validateRetentionSettings(input: unknown): UpdateSystemRetentionSettingsInput {
  const object = inputObject(input, ["activity", "telemetry", "outbox"], "retention");
  if (Object.keys(object).length === 0) throw invalid("retention", "requires a setting");
  let activity: UpdateSystemRetentionSettingsInput["activity"];
  let telemetry: UpdateSystemRetentionSettingsInput["telemetry"];
  let outbox: UpdateSystemRetentionSettingsInput["outbox"];
  if (Object.hasOwn(object, "activity")) {
    const group = inputObject(object.activity, ["retentionDays"], "activity");
    activity = { retentionDays: retentionDays(group.retentionDays, "activity.retentionDays") };
  }
  if (Object.hasOwn(object, "telemetry")) {
    const group = inputObject(
      object.telemetry,
      ["rawRetentionSeconds", "receiptRetentionSeconds", "reconnectHorizonSeconds"],
      "telemetry",
    );
    if (Object.keys(group).length === 0) throw invalid("telemetry", "requires a setting");
    if (Object.values(group).some((value) => typeof value !== "number"))
      throw invalid("telemetry", "must contain numeric settings");
    const validated = validateUpdateTelemetrySettingsInput(group);
    telemetry = {
      ...(validated.rawRetentionSeconds === undefined
        ? {}
        : { rawRetentionSeconds: validated.rawRetentionSeconds }),
      ...(validated.receiptRetentionSeconds === undefined
        ? {}
        : { receiptRetentionSeconds: validated.receiptRetentionSeconds }),
      ...(validated.reconnectHorizonSeconds === undefined
        ? {}
        : { reconnectHorizonSeconds: validated.reconnectHorizonSeconds }),
    };
  }
  if (Object.hasOwn(object, "outbox")) {
    const group = inputObject(object.outbox, ["retentionDays"], "outbox");
    outbox = { retentionDays: retentionDays(group.retentionDays, "outbox.retentionDays") };
  }
  return {
    ...(activity === undefined ? {} : { activity }),
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(outbox === undefined ? {} : { outbox }),
  };
}

export function validateRetentionHorizons(settings: {
  readonly rawRetentionSeconds: number;
  readonly receiptRetentionSeconds: number;
  readonly reconnectHorizonSeconds: number;
}): void {
  if (
    settings.receiptRetentionSeconds < settings.rawRetentionSeconds ||
    settings.receiptRetentionSeconds < settings.reconnectHorizonSeconds
  ) {
    throw invalid("telemetry", "receipt retention must cover raw retention and reconnect horizon");
  }
}

export function validateSystemActor(input: unknown): SystemActorOptions {
  const object = inputObject(input, ["actorId", "sessionId"], "actor");
  for (const value of Object.values(object)) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 255 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw invalid("actor", "must contain bounded printable identifiers");
    }
  }
  return {
    ...(typeof object.actorId === "string" ? { actorId: object.actorId } : {}),
    ...(typeof object.sessionId === "string" ? { sessionId: object.sessionId } : {}),
  };
}

export function canonicalSystemTimestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new TypeError("Invalid System clock");
  return value.toISOString();
}

export function encodeActivityCursor(cursor: SystemActivityCursor): string {
  return Buffer.from(JSON.stringify([cursor.occurredAt, cursor.id]), "utf8").toString("base64url");
}

export function validateActivityPageQuery(input: unknown): {
  category?: ActivityCategory;
  cursor?: SystemActivityCursor;
} {
  const object = inputObject(input, ["category", "cursor"], "activityPage");
  let category: ActivityCategory | undefined;
  let cursor: SystemActivityCursor | undefined;
  if (Object.hasOwn(object, "category")) {
    if (typeof object.category !== "string" || !isActivityCategory(object.category))
      throw invalid("category", "is unsupported");
    category = object.category;
  }
  if (Object.hasOwn(object, "cursor")) {
    const value = object.cursor;
    if (typeof value !== "string" || value.length > 180 || !BASE64URL.test(value))
      throw invalid("cursor", "is invalid");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    } catch {
      throw invalid("cursor", "is invalid");
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string"
    )
      throw invalid("cursor", "is invalid");
    const occurredAt = decoded[0];
    const id = decoded[1];
    if (
      !UUID.test(id) ||
      !Number.isFinite(Date.parse(occurredAt)) ||
      new Date(occurredAt).toISOString() !== occurredAt
    )
      throw invalid("cursor", "is invalid");
    cursor = { occurredAt, id };
    if (encodeActivityCursor(cursor) !== value) throw invalid("cursor", "is invalid");
  }
  return {
    ...(category === undefined ? {} : { category }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
