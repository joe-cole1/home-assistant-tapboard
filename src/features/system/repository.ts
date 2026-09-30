import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { isValidActivityPair } from "../activity/types.ts";
import type { ActivityCategory } from "../activity/types.ts";
import {
  SYSTEM_ACTIVITY_ENTITY_TYPES,
  SYSTEM_ACTIVITY_IDENTIFIED_ENTITY_TYPES,
  SYSTEM_ACTIVITY_PAGE_SIZE,
  type SystemActivityCursor,
  type SystemActivityEntityType,
  type SystemActivityItem,
  type SystemDiagnosticCounts,
  type SystemStorageDiagnostics,
} from "./types.ts";

interface SafeActivityRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly category: string;
  readonly action: string;
  readonly actor_type: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("System diagnostic count is invalid");
  return value;
}

function projectActivity(row: SafeActivityRow): SystemActivityItem {
  if (
    !UUID.test(row.id) ||
    !canonicalTimestamp(row.occurred_at) ||
    !isValidActivityPair(row.category, row.action)
  )
    throw new Error("Stored System Activity projection is invalid");
  const actorType = row.actor_type;
  if (
    actorType !== "admin" &&
    actorType !== "operator" &&
    actorType !== "system" &&
    actorType !== "machine"
  )
    throw new Error("Stored System Activity actor is invalid");
  const entityType =
    row.entity_type !== null &&
    (SYSTEM_ACTIVITY_ENTITY_TYPES as readonly string[]).includes(row.entity_type)
      ? (row.entity_type as SystemActivityEntityType)
      : null;
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    category: row.category as ActivityCategory,
    action: row.action,
    actorType,
    entityType,
    entityId:
      entityType !== null &&
      (SYSTEM_ACTIVITY_IDENTIFIED_ENTITY_TYPES as readonly string[]).includes(entityType) &&
      row.entity_id !== null &&
      UUID.test(row.entity_id)
        ? row.entity_id
        : null,
  };
}

/** Select only presentation-safe columns; never load Activity details or session identifiers. */
export function readSystemActivityPageRows(
  database: DatabaseExecutor,
  query: { readonly category?: ActivityCategory; readonly cursor?: SystemActivityCursor },
): SystemActivityItem[] {
  const category = query.category ?? null;
  const occurredAt = query.cursor?.occurredAt ?? null;
  const id = query.cursor?.id ?? null;
  return database
    .prepare<
      [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
      ],
      SafeActivityRow
    >(
      `SELECT id, occurred_at, category, action, actor_type, entity_type, entity_id
     FROM activity_log
     WHERE (? IS NULL OR category = ?)
       AND (? IS NULL OR occurred_at < ? OR (occurred_at = ? AND id < ?))
     ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(category, category, occurredAt, occurredAt, occurredAt, id, SYSTEM_ACTIVITY_PAGE_SIZE + 1)
    .map(projectActivity);
}

/** Fixed aggregate queries and storage metadata, with no config, filenames or raw records. */
export function readSystemDiagnostics(database: DatabaseExecutor): {
  readonly counts: SystemDiagnosticCounts;
  readonly storage: SystemStorageDiagnostics;
} {
  const row = database
    .prepare<[], SystemDiagnosticCounts>(
      `SELECT
       (SELECT count(*) FROM activity_log) AS activity,
       (SELECT count(*) FROM telemetry_measurements) AS rawTelemetry,
       (SELECT count(*) FROM telemetry_ingest_receipts) AS ingestReceipts,
       (SELECT count(*) FROM outbound_deliveries WHERE state = 'pending') AS outboxPending,
       (SELECT count(*) FROM outbound_deliveries WHERE state = 'leased') AS outboxLeased,
       (SELECT count(*) FROM outbound_deliveries WHERE state = 'retry') AS outboxRetry,
       (SELECT count(*) FROM outbound_deliveries WHERE state IN ('succeeded', 'terminal', 'dismissed')) AS outboxTerminal,
       (SELECT count(*) FROM admin_sessions) AS sessions`,
    )
    .get();
  if (row === undefined) throw new Error("System diagnostic counts are unavailable");
  return {
    counts: {
      activity: safeInteger(row.activity),
      rawTelemetry: safeInteger(row.rawTelemetry),
      ingestReceipts: safeInteger(row.ingestReceipts),
      outboxPending: safeInteger(row.outboxPending),
      outboxLeased: safeInteger(row.outboxLeased),
      outboxRetry: safeInteger(row.outboxRetry),
      outboxTerminal: safeInteger(row.outboxTerminal),
      sessions: safeInteger(row.sessions),
    },
    storage: {
      schemaVersion: safeInteger(database.pragma<number>("user_version", { simple: true })),
      pageCount: safeInteger(database.pragma<number>("page_count", { simple: true })),
      freePageCount: safeInteger(database.pragma<number>("freelist_count", { simple: true })),
      pageSizeBytes: safeInteger(database.pragma<number>("page_size", { simple: true })),
    },
  };
}
