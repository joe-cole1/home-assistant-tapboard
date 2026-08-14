import { randomUUID } from "node:crypto";

import { canonicalizeJson } from "../../shared/canonical-json.ts";
import { insertDeletionAudit, listDeletionAudits as listDeletionAuditRows } from "./repository.ts";
import type {
  ActivityActorType,
  ActivityClockOptions,
  DeletionAuditInput,
  DeletionAuditRecord,
  DeletionImpact,
} from "./types.ts";

const ACTOR_TYPES = ["admin", "operator", "system", "machine"] as const;
const MACHINE_CODE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const MAX_OPAQUE_BYTES = 255;
const MAX_REASON_BYTES = 255;
const MAX_IMPACT_CODE_BYTES = 80;
const MAX_IMPACTS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(field: string, reason: string): TypeError {
  return new TypeError(`Invalid deletion audit ${field}: ${reason}`);
}

function bounded(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalid(field, "must be non-empty text");
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function optionalBounded(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return bounded(value, field, maxBytes);
}

function identifier(value: unknown, field: string): string {
  const normalized = bounded(value, field, MAX_OPAQUE_BYTES);
  if (!UUID.test(normalized)) throw invalid(field, "must be a canonical UUID");
  return normalized;
}

function timestamp(value: Date | string | undefined, now: () => Date): string {
  const date =
    value === undefined
      ? now()
      : value instanceof Date
        ? new Date(value.getTime())
        : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw invalid("deletedAt", "must be a valid timestamp");
  }
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) {
    throw invalid("deletedAt", "must be an exact canonical UTC timestamp");
  }
  return canonical;
}

function normalizeActor(value: unknown): ActivityActorType {
  if (typeof value !== "string" || !(ACTOR_TYPES as readonly string[]).includes(value)) {
    throw invalid("actorType", "is not supported");
  }
  return value as ActivityActorType;
}

function normalizeImpacts(value: unknown): {
  readonly impacts: readonly DeletionImpact[];
  readonly json: string;
} {
  if (!Array.isArray(value)) throw invalid("impacts", "must be an array");
  if (value.length > MAX_IMPACTS) throw invalid("impacts", "contains too many entries");
  const impacts: DeletionImpact[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalid(`impacts[${index}]`, "must be an object");
    }
    const prototype: unknown = Object.getPrototypeOf(item) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(`impacts[${index}]`, "must be a plain object");
    }
    const objectValue = item as Record<string, unknown>;
    const keys = Object.keys(objectValue);
    if (keys.length !== 2 || !keys.includes("code") || !keys.includes("count")) {
      throw invalid(`impacts[${index}]`, "must contain only code and count");
    }
    const values = objectValue;
    const code = bounded(values.code, `impacts[${index}].code`, MAX_IMPACT_CODE_BYTES);
    if (!MACHINE_CODE.test(code)) throw invalid(`impacts[${index}].code`, "must be a machine code");
    const count = values.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw invalid(`impacts[${index}].count`, "must be a non-negative safe integer");
    }
    impacts.push({ code, count });
  }
  const json = canonicalizeJson(impacts, {
    maxDepth: 2,
    maxArrayItems: MAX_IMPACTS,
    maxBytes: 2_048,
  });
  return { impacts, json };
}

export function normalizeDeletionAuditInput(
  input: DeletionAuditInput,
  options: ActivityClockOptions = {},
): DeletionAuditRecord & { readonly impactsJson: string } {
  if (typeof input !== "object" || input === null) throw invalid("input", "must be an object");
  const id = identifier(
    input.id === undefined ? (options.idFactory ?? randomUUID)() : input.id,
    "id",
  );
  const { impacts, json } = normalizeImpacts(input.impacts);
  const actorId = optionalBounded(input.actorId, "actorId", MAX_OPAQUE_BYTES);
  const reason = optionalBounded(input.reason, "reason", MAX_REASON_BYTES);
  if (reason !== undefined && reason.length === 0)
    throw invalid("reason", "must be non-empty text");
  const record: DeletionAuditRecord = {
    id,
    schemaVersion: 1,
    entityType: bounded(input.entityType, "entityType", MAX_OPAQUE_BYTES),
    entityId: bounded(input.entityId, "entityId", MAX_OPAQUE_BYTES),
    actorType: normalizeActor(input.actorType),
    impacts,
    deletedAt: timestamp(input.deletedAt, options.now ?? (() => new Date())),
  };
  if (actorId !== undefined) (record as { actorId?: string }).actorId = actorId;
  if (reason !== undefined) (record as { reason?: string }).reason = reason;
  return { ...record, impactsJson: json };
}

export function appendDeletionAudit(
  database: Parameters<typeof insertDeletionAudit>[0],
  input: DeletionAuditInput,
  options: ActivityClockOptions = {},
): DeletionAuditRecord {
  const record = normalizeDeletionAuditInput(input, options);
  insertDeletionAudit(database, record);
  const { impactsJson: _impactsJson, ...publicRecord } = record;
  return publicRecord;
}

export const recordDeletionAudit = appendDeletionAudit;

export function readDeletionAudits(
  database: Parameters<typeof listDeletionAuditRows>[0],
  limit?: number,
): DeletionAuditRecord[] {
  return listDeletionAuditRows(database, limit);
}

export const listDeletionAudits = readDeletionAudits;
