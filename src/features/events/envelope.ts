import { randomUUID } from "node:crypto";

import { canonicalizeJson } from "../../shared/canonical-json.ts";
import {
  EVENT_REGISTRY,
  getEventDefinition,
  isEventType,
  type EventData,
  type EventDefinition,
  type EventEnvelope,
  type EventEnvelopeBuildOptions,
  type EventEnvelopeInput,
  type EventIdentifiers,
  type EventType,
  type FillAssignedData,
  type FillEndedData,
  type HealthTransitionedData,
  type IntegrationStatusChangedData,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MACHINE_TOKEN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const IDENTIFIER_KEYS = ["tap_id", "fill_id", "keg_id", "beverage_id"] as const;
const FILL_END_REASONS = ["kicked", "manual", "deleted", "other"] as const;
const HEALTH_CHECKS = [
  "low_keg",
  "scale_availability",
  "suspected_leak",
  "serving_temperature",
  "line_cleaning_due",
] as const;
const HEALTH_STATES = ["healthy", "degraded", "active"] as const;
const HEALTH_SEVERITIES = ["none", "info", "warning", "critical"] as const;
const INTEGRATION_STATES = ["healthy", "degraded", "disabled"] as const;

function invalid(field: string, reason: string): TypeError {
  return new TypeError(`Invalid event ${field}: ${reason}`);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(field, "must be a plain object");
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(field, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw invalid(field, "symbol keys are not supported");
  return value as Record<string, unknown>;
}

function ownValue(object: Record<string, unknown>, key: string, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw invalid(field, "accessor properties are not supported");
  }
  return descriptor.value;
}

function exactKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid(field, "contains unknown or missing fields");
  }
}

function boundedToken(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalid(field, "must be non-empty text");
  if (Buffer.byteLength(value, "utf8") > maximum || !MACHINE_TOKEN.test(value)) {
    throw invalid(field, "must be a bounded machine token");
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw invalid(field, "must be a canonical UUID");
  return value;
}

function timestamp(value: Date | string | undefined, now: () => Date): string {
  const date =
    value === undefined
      ? now()
      : value instanceof Date
        ? new Date(value.getTime())
        : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw invalid("occurred_at", "must be a valid timestamp");
  }
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) {
    throw invalid("occurred_at", "must be an exact canonical UTC timestamp");
  }
  return canonical;
}

function normalizeInputObject(input: EventEnvelopeInput): Record<string, unknown> {
  const object = plainObject(input, "input");
  const allowed = [
    "eventType",
    "event_type",
    "identifiers",
    "data",
    "eventId",
    "event_id",
    "occurredAt",
    "occurred_at",
    "coalescingKey",
    "coalescing_key",
  ];
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw invalid("input", "contains unknown fields");
  }
  return object;
}

function optionalAlias(
  object: Record<string, unknown>,
  first: string,
  second: string,
  field: string,
): unknown {
  const hasFirst = Object.hasOwn(object, first);
  const hasSecond = Object.hasOwn(object, second);
  if (hasFirst && hasSecond) throw invalid(field, "duplicate aliases are not allowed");
  if (hasFirst) return ownValue(object, first, field);
  if (hasSecond) return ownValue(object, second, field);
  return undefined;
}

function normalizeIdentifiers(value: unknown, definition: EventDefinition): EventIdentifiers {
  const object = value === undefined ? {} : plainObject(value, "identifiers");
  const keys = Object.keys(object);
  if (keys.some((key) => !(IDENTIFIER_KEYS as readonly string[]).includes(key))) {
    throw invalid("identifiers", "contains unknown fields");
  }
  const result: Partial<Record<(typeof IDENTIFIER_KEYS)[number], string | null>> = {};
  for (const key of IDENTIFIER_KEYS) {
    if (!Object.hasOwn(object, key)) continue;
    const item = ownValue(object, key, `identifiers.${key}`);
    if (item === null) {
      result[key] = null;
    } else {
      result[key] = uuid(item, `identifiers.${key}`);
    }
  }
  if (
    definition.requiresIdentifier &&
    !IDENTIFIER_KEYS.some((key) => result[key] !== undefined && result[key] !== null)
  ) {
    throw invalid("identifiers", "at least one identifier is required");
  }
  return result;
}

function normalizeData(eventType: EventType, value: unknown): EventData {
  const object = plainObject(value, "data");
  switch (eventType) {
    case "fill.assigned": {
      exactKeys(object, ["assignment_id"], "data");
      const result: FillAssignedData = {
        assignment_id: uuid(
          ownValue(object, "assignment_id", "data.assignment_id"),
          "data.assignment_id",
        ),
      };
      return result;
    }
    case "fill.ended": {
      exactKeys(object, ["reason"], "data");
      const reason = ownValue(object, "reason", "data.reason");
      if (typeof reason !== "string" || !(FILL_END_REASONS as readonly string[]).includes(reason)) {
        throw invalid("data.reason", "is not supported");
      }
      return { reason } as FillEndedData;
    }
    case "pour.completed": {
      exactKeys(object, ["volume_ml"], "data");
      const volume = ownValue(object, "volume_ml", "data.volume_ml");
      if (
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 100_000
      ) {
        throw invalid("data.volume_ml", "must be finite and between 0 and 100000");
      }
      return { volume_ml: volume };
    }
    case "keg.low": {
      exactKeys(object, ["remaining_percent", "threshold_percent"], "data");
      const remaining = ownValue(object, "remaining_percent", "data.remaining_percent");
      const threshold = ownValue(object, "threshold_percent", "data.threshold_percent");
      if (
        typeof remaining !== "number" ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 100
      ) {
        throw invalid("data.remaining_percent", "must be finite and between 0 and 100");
      }
      if (
        typeof threshold !== "number" ||
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        threshold > 100
      ) {
        throw invalid("data.threshold_percent", "must be finite and between 0 and 100");
      }
      return { remaining_percent: remaining, threshold_percent: threshold };
    }
    case "health.transitioned": {
      exactKeys(object, ["check_id", "state", "severity"], "data");
      const checkId = ownValue(object, "check_id", "data.check_id");
      const state = ownValue(object, "state", "data.state");
      const severity = ownValue(object, "severity", "data.severity");
      if (typeof checkId !== "string" || !(HEALTH_CHECKS as readonly string[]).includes(checkId)) {
        throw invalid("data.check_id", "is not supported");
      }
      if (typeof state !== "string" || !(HEALTH_STATES as readonly string[]).includes(state)) {
        throw invalid("data.state", "is not supported");
      }
      if (
        typeof severity !== "string" ||
        !(HEALTH_SEVERITIES as readonly string[]).includes(severity)
      ) {
        throw invalid("data.severity", "is not supported");
      }
      return { check_id: checkId, state, severity } as HealthTransitionedData;
    }
    case "integration.status_changed": {
      exactKeys(object, ["integration_type", "state", "reason_code"], "data");
      const integrationType = boundedToken(
        ownValue(object, "integration_type", "data.integration_type"),
        "data.integration_type",
        64,
      );
      const state = ownValue(object, "state", "data.state");
      if (typeof state !== "string" || !(INTEGRATION_STATES as readonly string[]).includes(state)) {
        throw invalid("data.state", "is not supported");
      }
      const reasonCodeValue = ownValue(object, "reason_code", "data.reason_code");
      const reasonCode =
        reasonCodeValue === null ? null : boundedToken(reasonCodeValue, "data.reason_code", 80);
      return {
        integration_type: integrationType,
        state,
        reason_code: reasonCode,
      } as IntegrationStatusChangedData;
    }
  }
}

function coalescingKey(
  input: Record<string, unknown>,
  definition: EventDefinition,
): string | undefined {
  const value = optionalAlias(input, "coalescingKey", "coalescing_key", "coalescing_key");
  if (value === undefined) {
    if (definition.requiresCoalescingKey) throw invalid("coalescing_key", "is required");
    return undefined;
  }
  if (!definition.requiresCoalescingKey)
    throw invalid("coalescing_key", "is not allowed for this event");
  return boundedToken(value, "coalescing_key", definition.coalescingKeyMaxBytes);
}

export function createEventEnvelope(
  input: EventEnvelopeInput,
  options: EventEnvelopeBuildOptions = {},
): EventEnvelope {
  const inputObject = normalizeInputObject(input);
  const eventTypeValue = optionalAlias(inputObject, "eventType", "event_type", "event_type");
  if (typeof eventTypeValue !== "string" || !isEventType(eventTypeValue)) {
    throw invalid("event_type", "is not registered");
  }
  const definition = getEventDefinition(eventTypeValue);
  if (definition === undefined) throw invalid("event_type", "is not registered");
  // Validate the admission key even though it is intentionally not part of the wire envelope.
  coalescingKey(inputObject, definition);
  const suppliedEventId = optionalAlias(inputObject, "eventId", "event_id", "event_id");
  const eventIdValue = suppliedEventId ?? options.eventId ?? (options.idFactory ?? randomUUID)();
  const eventId = uuid(eventIdValue, "event_id");
  const occurredAtValue = optionalAlias(inputObject, "occurredAt", "occurred_at", "occurred_at");
  const occurredAt = timestamp(
    occurredAtValue as Date | string | undefined,
    options.now ?? (() => new Date()),
  );
  const identifiers = normalizeIdentifiers(
    Object.hasOwn(inputObject, "identifiers")
      ? ownValue(inputObject, "identifiers", "identifiers")
      : undefined,
    definition,
  );
  const data = normalizeData(eventTypeValue, ownValue(inputObject, "data", "data"));
  const envelope: EventEnvelope = {
    schema_version: 1,
    event_id: eventId,
    event_type: eventTypeValue,
    occurred_at: occurredAt,
    identifiers,
    data,
  };
  canonicalizeJson(envelope, { maxBytes: 16_384 });
  return envelope;
}

export function serializeEventEnvelope(envelope: EventEnvelope): string {
  const object = plainObject(envelope, "envelope");
  exactKeys(
    object,
    ["schema_version", "event_id", "event_type", "occurred_at", "identifiers", "data"],
    "envelope",
  );
  if (ownValue(object, "schema_version", "envelope.schema_version") !== 1) {
    throw invalid("schema_version", "must be 1");
  }
  const validated = createEventEnvelope({
    event_type: ownValue(object, "event_type", "envelope.event_type") as string,
    event_id: ownValue(object, "event_id", "envelope.event_id") as string,
    occurred_at: ownValue(object, "occurred_at", "envelope.occurred_at") as string,
    identifiers: ownValue(object, "identifiers", "envelope.identifiers") as EventIdentifiers,
    data: ownValue(object, "data", "envelope.data"),
    ...(ownValue(object, "event_type", "envelope.event_type") === "integration.status_changed"
      ? { coalescing_key: "serialized" }
      : {}),
  });
  return canonicalizeJson(validated, { maxBytes: 16_384 });
}

export const encodeEventEnvelope = serializeEventEnvelope;
export const buildEventEnvelope = createEventEnvelope;
export const createEvent = createEventEnvelope;
export const serializeEvent = serializeEventEnvelope;

export function getEventCoalescingKeyRequirement(eventType: string): boolean {
  return EVENT_REGISTRY[eventType as EventType]?.requiresCoalescingKey === true;
}
