import { randomUUID } from "node:crypto";

import { canonicalizeJson } from "../../shared/canonical-json.ts";
import type {
  ActivityDetails,
  ActivityInput,
  ActivityRecord,
  ActivityScalar,
  ActivityClockOptions,
  ActivityActorType,
  ActivityCategory,
} from "./types.ts";
import { isValidActivityPair } from "./types.ts";

export const ACTIVITY_MAX_OPAQUE_BYTES = 255;
export const ACTIVITY_MAX_DETAIL_KEYS = 8;
export const ACTIVITY_MAX_DETAIL_STRING_BYTES = 255;
export const ACTIVITY_MAX_DETAIL_JSON_BYTES = 2_048;

const ACTOR_TYPES = ["admin", "operator", "system", "machine"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(field: string, reason: string): TypeError {
  return new TypeError(`Invalid activity ${field}: ${reason}`);
}

function boundedOpaque(value: unknown, field: string, maximum = ACTIVITY_MAX_OPAQUE_BYTES): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalid(field, "must be non-empty text");
  if (Buffer.byteLength(value, "utf8") > maximum) throw invalid(field, "is too long");
  return value;
}

function optionalOpaque(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedOpaque(value, field);
}

function identifier(value: unknown, field: string): string {
  const normalized = boundedOpaque(value, field);
  if (!UUID.test(normalized)) throw invalid(field, "must be a canonical UUID");
  return normalized;
}

function timestamp(value: Date | string | undefined, fallback: () => Date, field: string): string {
  let date: Date;
  if (value === undefined) {
    date = fallback();
  } else if (value instanceof Date) {
    date = new Date(value.getTime());
  } else if (typeof value === "string") {
    date = new Date(value);
  } else {
    throw invalid(field, "must be a valid timestamp");
  }
  if (Number.isNaN(date.getTime())) throw invalid(field, "must be a valid timestamp");
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) {
    throw invalid(field, "must be an exact canonical UTC timestamp");
  }
  return canonical;
}

function actorType(value: unknown): ActivityActorType {
  if (typeof value !== "string" || !(ACTOR_TYPES as readonly string[]).includes(value)) {
    throw invalid("actorType", "is not supported");
  }
  return value as ActivityActorType;
}

function scalar(value: unknown, field: string): ActivityScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > ACTIVITY_MAX_DETAIL_STRING_BYTES) {
      throw invalid(field, "string is too long");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw invalid(field, "must be a string, finite number, boolean, or null");
}

function details(value: unknown): { readonly value?: ActivityDetails; readonly json?: string } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("details", "must be a plain object");
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("details", "must be a plain object");
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) throw invalid("details", "symbol keys are not supported");
  const keys = Object.keys(value).sort();
  if (keys.length > ACTIVITY_MAX_DETAIL_KEYS) throw invalid("details", "has too many keys");

  const normalized: Record<string, ActivityScalar> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalid("details", "accessor properties are not supported");
    }
    normalized[key] = scalar(descriptor.value, `details.${key}`);
  }
  const json = canonicalizeJson(normalized, {
    maxDepth: 0,
    maxKeys: ACTIVITY_MAX_DETAIL_KEYS,
    maxBytes: ACTIVITY_MAX_DETAIL_JSON_BYTES,
  });
  return { value: normalized, json };
}

export function normalizeActivityInput(
  input: ActivityInput,
  options: ActivityClockOptions = {},
): ActivityRecord & { readonly detailsJson?: string } {
  if (typeof input !== "object" || input === null) throw invalid("input", "must be an object");
  const category = input.category;
  const action = input.action;
  if (typeof category !== "string" || typeof action !== "string") {
    throw invalid("action", "category and action are required");
  }
  if (!isValidActivityPair(category, action))
    throw invalid("action", "category/action pair is invalid");

  const normalizedDetails = details(input.details);
  const id = identifier(
    input.id === undefined ? (options.idFactory ?? randomUUID)() : input.id,
    "id",
  );

  const record: ActivityRecord = {
    id,
    category: category as ActivityCategory,
    action,
    actorType: actorType(input.actorType),
    occurredAt: timestamp(input.occurredAt, options.now ?? (() => new Date()), "occurredAt"),
  };
  const actorId = optionalOpaque(input.actorId, "actorId");
  const sessionId = optionalOpaque(input.sessionId, "sessionId");
  const entityType = optionalOpaque(input.entityType, "entityType");
  const entityId = optionalOpaque(input.entityId, "entityId");
  if (actorId !== undefined) (record as { actorId?: string }).actorId = actorId;
  if (sessionId !== undefined) (record as { sessionId?: string }).sessionId = sessionId;
  if (entityType !== undefined) (record as { entityType?: string }).entityType = entityType;
  if (entityId !== undefined) (record as { entityId?: string }).entityId = entityId;
  if (normalizedDetails.value !== undefined) {
    (record as { details?: ActivityDetails }).details = normalizedDetails.value;
  }
  return normalizedDetails.json === undefined
    ? record
    : { ...record, detailsJson: normalizedDetails.json };
}
