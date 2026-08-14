import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { canonicalizeJson } from "../../shared/canonical-json.ts";
import type {
  ActivityAction,
  ActivityCategory,
  ActivityListOptions,
  ActivityRecord,
  ActivityRetention,
  DeletionAuditRecord,
} from "./types.ts";
import { isValidActivityPair } from "./types.ts";

interface ActivityRow {
  readonly id: string;
  readonly category: string;
  readonly action: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly session_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly details_json: string | null;
  readonly occurred_at: string;
}

interface RetentionRow {
  readonly retention_days: number;
  readonly updated_at: string;
}

interface DeletionAuditRow {
  readonly id: string;
  readonly schema_version: number;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly reason: string | null;
  readonly impacts_json: string;
  readonly deleted_at: string;
}

const DELETION_IMPACT_CODE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedOptional(value: string | null, maximum = 255): boolean {
  return value === null || (value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum);
}

function isActorType(value: string): value is ActivityRecord["actorType"] {
  return value === "admin" || value === "operator" || value === "system" || value === "machine";
}

function mapActivity(row: ActivityRow): ActivityRecord {
  if (
    !UUID.test(row.id) ||
    !boundedOptional(row.actor_id) ||
    !boundedOptional(row.session_id) ||
    !boundedOptional(row.entity_type) ||
    !boundedOptional(row.entity_id)
  ) {
    throw new Error("Stored activity record is invalid");
  }
  if (!isValidActivityPair(row.category, row.action)) {
    throw new Error("Stored activity category/action pair is invalid");
  }
  if (!isActorType(row.actor_type)) {
    throw new Error("Stored activity actor type is invalid");
  }
  if (!canonicalTimestamp(row.occurred_at)) {
    throw new Error("Stored activity timestamp is invalid");
  }
  let details: ActivityRecord["details"];
  if (row.details_json !== null) {
    const parsed: unknown = JSON.parse(row.details_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Stored activity details are invalid");
    }
    const canonical = canonicalizeJson(parsed, {
      maxDepth: 0,
      maxKeys: 8,
      maxBytes: 2_048,
    });
    if (canonical !== row.details_json)
      throw new Error("Stored activity details are not canonical");
    const values = parsed as Record<string, unknown>;
    for (const value of Object.values(values)) {
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error("Stored activity details are invalid");
      }
    }
    details = values as ActivityRecord["details"];
  }
  const result: ActivityRecord = {
    id: row.id,
    category: row.category as ActivityCategory,
    action: row.action,
    actorType: row.actor_type,
    occurredAt: row.occurred_at,
  };
  if (row.actor_id !== null) (result as { actorId?: string }).actorId = row.actor_id;
  if (row.session_id !== null) (result as { sessionId?: string }).sessionId = row.session_id;
  if (row.entity_type !== null) (result as { entityType?: string }).entityType = row.entity_type;
  if (row.entity_id !== null) (result as { entityId?: string }).entityId = row.entity_id;
  if (details !== undefined) (result as { details?: ActivityRecord["details"] }).details = details;
  return result;
}

function detailsJson(record: ActivityRecord): string | null {
  if (record.details === undefined) return null;
  return canonicalizeJson(record.details, { maxDepth: 0, maxKeys: 8, maxBytes: 2_048 });
}

/** Insert one explicitly shaped activity DTO; transaction ownership remains with the caller. */
export function insertActivity(database: DatabaseExecutor, record: ActivityRecord): void {
  database
    .prepare<
      [
        string,
        ActivityCategory,
        ActivityAction,
        ActivityRecord["actorType"],
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO activity_log
       (id, category, action, actor_type, actor_id, session_id, entity_type, entity_id, details_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.category,
      record.action,
      record.actorType,
      record.actorId ?? null,
      record.sessionId ?? null,
      record.entityType ?? null,
      record.entityId ?? null,
      detailsJson(record),
      record.occurredAt,
    );
}

export const appendActivityRecord = insertActivity;

export function listActivity(
  database: DatabaseExecutor,
  options: ActivityListOptions = {},
): ActivityRecord[] {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Activity list limit must be between 1 and 1000");
  }
  const category = options.category ?? null;
  const action = options.action ?? null;
  const before =
    options.before instanceof Date ? options.before.toISOString() : (options.before ?? null);
  const after =
    options.after instanceof Date ? options.after.toISOString() : (options.after ?? null);
  if (
    (before !== null && !canonicalTimestamp(before)) ||
    (after !== null && !canonicalTimestamp(after))
  ) {
    throw new TypeError("Activity list timestamps must be canonical UTC");
  }
  const rows = database
    .prepare<
      [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
      ],
      ActivityRow
    >(
      `SELECT id, category, action, actor_type, actor_id, session_id,
              entity_type, entity_id, details_json, occurred_at
       FROM activity_log
       WHERE (? IS NULL OR category = ?)
         AND (? IS NULL OR action = ?)
         AND (? IS NULL OR occurred_at < ?)
         AND (? IS NULL OR occurred_at > ?)
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(category, category, action, action, before, before, after, after, limit);
  return rows.map(mapActivity);
}

export function readActivityRetention(database: DatabaseExecutor): ActivityRetention {
  const row = database
    .prepare<[], RetentionRow>(
      `SELECT retention_days, updated_at
       FROM activity_retention
       WHERE id = 1`,
    )
    .get();
  if (row === undefined) throw new Error("Activity retention settings are missing");
  if (
    !Number.isSafeInteger(row.retention_days) ||
    row.retention_days < 1 ||
    row.retention_days > 3_650 ||
    !canonicalTimestamp(row.updated_at)
  ) {
    throw new Error("Activity retention settings are invalid");
  }
  return { retentionDays: row.retention_days, updatedAt: row.updated_at };
}

export function updateActivityRetention(
  database: DatabaseExecutor,
  retentionDays: number,
  updatedAt: string,
): ActivityRetention {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new RangeError("Activity retention must be between 1 and 3650 days");
  }
  database
    .prepare<[number, string]>(
      `UPDATE activity_retention
       SET retention_days = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(retentionDays, updatedAt);
  return readActivityRetention(database);
}

export function deleteActivityBefore(
  database: DatabaseExecutor,
  cutoff: string,
  batchSize: number,
): number {
  const result = database
    .prepare<[string, number]>(
      `DELETE FROM activity_log
       WHERE id IN (
         SELECT id FROM activity_log
         WHERE occurred_at < ?
         ORDER BY occurred_at ASC, id ASC
         LIMIT ?
       )`,
    )
    .run(cutoff, batchSize);
  return result.changes;
}

function mapDeletionAudit(row: DeletionAuditRow): DeletionAuditRecord {
  if (
    !UUID.test(row.id) ||
    !boundedOptional(row.entity_type) ||
    !boundedOptional(row.entity_id) ||
    !boundedOptional(row.actor_id) ||
    !boundedOptional(row.reason)
  ) {
    throw new Error("Stored deletion audit record is invalid");
  }
  if (row.schema_version !== 1) throw new Error("Stored deletion audit schema version is invalid");
  if (!isActorType(row.actor_type)) {
    throw new Error("Stored deletion audit actor type is invalid");
  }
  if (!canonicalTimestamp(row.deleted_at)) {
    throw new Error("Stored deletion audit timestamp is invalid");
  }
  const parsed: unknown = JSON.parse(row.impacts_json);
  if (!Array.isArray(parsed)) throw new Error("Stored deletion audit impacts are invalid");
  if (parsed.length > 16) throw new Error("Stored deletion audit impacts are invalid");
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Stored deletion audit impacts are invalid");
    }
    const object = item as Record<string, unknown>;
    if (
      Object.keys(object).length !== 2 ||
      !Object.hasOwn(object, "code") ||
      !Object.hasOwn(object, "count") ||
      typeof object.code !== "string" ||
      Buffer.byteLength(object.code, "utf8") > 80 ||
      !DELETION_IMPACT_CODE.test(object.code) ||
      typeof object.count !== "number" ||
      !Number.isSafeInteger(object.count) ||
      object.count < 0
    ) {
      throw new Error("Stored deletion audit impacts are invalid");
    }
  }
  const canonical = canonicalizeJson(parsed, {
    maxDepth: 2,
    maxArrayItems: 16,
    maxBytes: 2_048,
  });
  if (canonical !== row.impacts_json)
    throw new Error("Stored deletion audit impacts are not canonical");
  const impacts = parsed as DeletionAuditRecord["impacts"];
  const result: DeletionAuditRecord = {
    id: row.id,
    schemaVersion: row.schema_version,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorType: row.actor_type,
    impacts,
    deletedAt: row.deleted_at,
  };
  if (row.actor_id !== null) (result as { actorId?: string }).actorId = row.actor_id;
  if (row.reason !== null) (result as { reason?: string }).reason = row.reason;
  return result;
}

export function insertDeletionAudit(database: DatabaseExecutor, record: DeletionAuditRecord): void {
  const impactsJson = canonicalizeJson(record.impacts, {
    maxDepth: 2,
    maxArrayItems: 16,
    maxBytes: 2_048,
  });
  database
    .prepare<
      [string, number, string, string, string, string | null, string | null, string, string]
    >(
      `INSERT INTO deletion_audit
       (id, schema_version, entity_type, entity_id, actor_type, actor_id, reason, impacts_json, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.schemaVersion,
      record.entityType,
      record.entityId,
      record.actorType,
      record.actorId ?? null,
      record.reason ?? null,
      impactsJson,
      record.deletedAt,
    );
}

export function listDeletionAudits(database: DatabaseExecutor, limit = 100): DeletionAuditRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Deletion audit list limit must be between 1 and 1000");
  }
  return database
    .prepare<[number], DeletionAuditRow>(
      `SELECT id, schema_version, entity_type, entity_id, actor_type, actor_id,
              reason, impacts_json, deleted_at
       FROM deletion_audit
       ORDER BY deleted_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map(mapDeletionAudit);
}
