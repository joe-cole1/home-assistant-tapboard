import { createHash, randomUUID } from "node:crypto";

import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { appendActivity } from "../activity/operations.ts";
import { createEventEnvelope, serializeEventEnvelope } from "../events/envelope.ts";
import { getEventDefinition } from "../events/types.ts";
import type { EventEnvelope, EventEnvelopeInput, EventType } from "../events/types.ts";
import { canonicalizeJson } from "../../shared/canonical-json.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]*$/u;
const MAX_TARGETS = 32;
const MAX_PRUNE_BATCH = 100;
const DEFAULT_GLOBAL_ROWS = 10_000;
const DEFAULT_GLOBAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_DESTINATION_ROWS = 2_000;
const DEFAULT_DESTINATION_BYTES = 16 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 16_384;
const MAX_ERROR_BYTES = 120;

export interface OutboundDestinationDescriptor {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OutboundDestinationVersionDescriptor {
  readonly id: string;
  readonly destinationId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
}

export interface DestinationInput {
  readonly id?: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly createdAt?: Date | string;
}

export interface DestinationVersionInput {
  readonly id?: string;
  readonly destinationId: string;
  readonly versionNumber: number;
  readonly createdAt?: Date | string;
}

export interface OutboxTarget {
  readonly destinationId: string;
  readonly destinationVersionId: string;
  readonly versionId?: string;
}

export interface OutboxIntent {
  readonly event?: EventEnvelopeInput | EventEnvelope;
  readonly envelope?: EventEnvelopeInput | EventEnvelope;
  readonly eventType?: string;
  readonly event_type?: string;
  readonly data?: unknown;
  readonly identifiers?: EventEnvelopeInput["identifiers"];
  readonly occurredAt?: Date | string;
  readonly occurred_at?: Date | string;
  readonly eventId?: string;
  readonly event_id?: string;
  readonly coalescingKey?: string;
  readonly coalescing_key?: string;
  readonly targets?: readonly OutboxTarget[];
}

export interface OutboxQuotaOptions {
  readonly globalMaxRows?: number;
  readonly globalMaxBytes?: number;
  readonly destinationMaxRows?: number;
  readonly destinationMaxBytes?: number;
  readonly pruneBatch?: number;
}

export interface OutboxClockOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface MutateAndAdmitOptions extends OutboxQuotaOptions, OutboxClockOptions {}

export type QueueResult =
  | {
      readonly status: "queued";
      readonly eventId: string;
      readonly pruned: number;
      readonly coalesced: boolean;
    }
  | {
      readonly status: "not_queued_capacity";
      readonly pruned: number;
      readonly coalesced: boolean;
    };

export interface DeliveryClaim {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly destinationId: string;
  readonly destinationVersionId: string;
  readonly state: "leased";
  readonly attemptCount: number;
  readonly revision: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
  readonly envelope: EventEnvelope;
  readonly envelopeJson: string;
}

export interface DeliveryResultInput {
  readonly deliveryId: string;
  readonly owner: string;
  readonly revision: number;
  readonly outcome: "success" | "retry" | "failure";
  readonly errorCode?: string;
  readonly now?: Date | string;
}

export interface OverflowIncident {
  readonly slot: number;
  readonly isCatchall: boolean;
  readonly incidentKey: string | null;
  readonly destinationId: string | null;
  readonly eventType: string | null;
  readonly state: "empty" | "open" | "recovered";
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly omittedCount: number;
  readonly representative: Readonly<Record<string, unknown>> | null;
}

function invalid(field: string, reason: string): TypeError {
  return new TypeError(`Invalid outbox ${field}: ${reason}`);
}

function uuid(value: string | undefined, field: string, factory: () => string): string {
  const result = value ?? factory();
  if (!UUID.test(result)) throw invalid(field, "must be a canonical UUID");
  return result;
}

function boundedText(value: string, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalid(field, "must be non-empty text");
  if (!SAFE_TEXT.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw invalid(field, `must be printable UTF-8 text of at most ${maxBytes} bytes`);
  }
  return value;
}

function canonicalTime(value: Date | string | undefined, now: () => Date): string {
  const date =
    value === undefined
      ? now()
      : value instanceof Date
        ? new Date(value.getTime())
        : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid("time", "must be valid");
  const result = date.toISOString();
  if (typeof value === "string" && value !== result) throw invalid("time", "must be canonical UTC");
  return result;
}

function positiveInteger(value: number, field: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw invalid(field, "must be a bounded positive integer");
  }
  return value;
}

function normalizeQuota(options: OutboxQuotaOptions): Required<OutboxQuotaOptions> {
  const globalMaxRows = options.globalMaxRows ?? DEFAULT_GLOBAL_ROWS;
  const globalMaxBytes = options.globalMaxBytes ?? DEFAULT_GLOBAL_BYTES;
  const destinationMaxRows = options.destinationMaxRows ?? DEFAULT_DESTINATION_ROWS;
  const destinationMaxBytes = options.destinationMaxBytes ?? DEFAULT_DESTINATION_BYTES;
  const pruneBatch = options.pruneBatch ?? MAX_PRUNE_BATCH;
  positiveInteger(globalMaxRows, "globalMaxRows", DEFAULT_GLOBAL_ROWS);
  positiveInteger(globalMaxBytes, "globalMaxBytes", DEFAULT_GLOBAL_BYTES);
  positiveInteger(destinationMaxRows, "destinationMaxRows", DEFAULT_DESTINATION_ROWS);
  positiveInteger(destinationMaxBytes, "destinationMaxBytes", DEFAULT_DESTINATION_BYTES);
  positiveInteger(pruneBatch, "pruneBatch", MAX_PRUNE_BATCH);
  return { globalMaxRows, globalMaxBytes, destinationMaxRows, destinationMaxBytes, pruneBatch };
}

function targetKey(target: OutboxTarget): string {
  return `${target.destinationId}\u0000${target.destinationVersionId}`;
}

function normalizeTargets(intent: OutboxIntent): OutboxTarget[] {
  const source = intent.targets ?? [];
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_TARGETS) {
    throw invalid("targets", "must contain between 1 and 32 destinations");
  }
  const targets = (source as readonly unknown[]).map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw invalid(`targets[${index}]`, "must be an object");
    }
    const target = raw as Record<string, unknown>;
    const keys = Object.keys(target).sort();
    if (
      keys.some(
        (key) => key !== "destinationId" && key !== "destinationVersionId" && key !== "versionId",
      ) ||
      (target.destinationVersionId !== undefined && target.versionId !== undefined)
    ) {
      throw invalid(`targets[${index}]`, "contains unknown or duplicate fields");
    }
    if (typeof target.destinationId !== "string") {
      throw invalid(`targets[${index}].destinationId`, "must be a canonical UUID");
    }
    const destinationId = uuid(target.destinationId, `targets[${index}].destinationId`, () => "");
    const versionId = target.destinationVersionId ?? target.versionId;
    if (typeof versionId !== "string") {
      throw invalid(`targets[${index}].destinationVersionId`, "must be a canonical UUID");
    }
    const destinationVersionId = uuid(
      versionId,
      `targets[${index}].destinationVersionId`,
      () => "",
    );
    return { destinationId, destinationVersionId };
  });
  const keys = new Set(targets.map(targetKey));
  if (keys.size !== targets.length) throw invalid("targets", "must not contain duplicates");
  if (new Set(targets.map((target) => target.destinationId)).size !== targets.length) {
    throw invalid("targets", "must contain each destination only once");
  }
  return targets;
}

function envelopeInput(intent: OutboxIntent): EventEnvelopeInput {
  const allowed = new Set([
    "event",
    "envelope",
    "eventType",
    "event_type",
    "data",
    "identifiers",
    "occurredAt",
    "occurred_at",
    "eventId",
    "event_id",
    "coalescingKey",
    "coalescing_key",
    "targets",
  ]);
  if (Object.keys(intent).some((key) => !allowed.has(key))) {
    throw invalid("intent", "contains unknown fields");
  }
  const aliases = [
    ["event", "envelope"],
    ["eventType", "event_type"],
    ["occurredAt", "occurred_at"],
    ["eventId", "event_id"],
    ["coalescingKey", "coalescing_key"],
  ] as const;
  for (const [first, second] of aliases) {
    if (Object.hasOwn(intent, first) && Object.hasOwn(intent, second)) {
      throw invalid("intent", `duplicate aliases ${first}/${second} are not allowed`);
    }
  }
  const direct = intent.event ?? intent.envelope;
  if (direct !== undefined) {
    const key = intent.coalescingKey ?? intent.coalescing_key;
    return key === undefined ? direct : { ...direct, coalescing_key: key };
  }
  const eventType = intent.eventType ?? intent.event_type;
  if (eventType === undefined) throw invalid("event", "is required");
  const result = {
    event_type: eventType,
    data: intent.data,
    ...(intent.identifiers === undefined ? {} : { identifiers: intent.identifiers }),
    ...(intent.occurredAt === undefined && intent.occurred_at === undefined
      ? {}
      : { occurred_at: intent.occurredAt ?? intent.occurred_at }),
    ...(intent.eventId === undefined && intent.event_id === undefined
      ? {}
      : { event_id: intent.eventId ?? intent.event_id }),
    ...(intent.coalescingKey === undefined && intent.coalescing_key === undefined
      ? {}
      : { coalescing_key: intent.coalescingKey ?? intent.coalescing_key }),
  } satisfies EventEnvelopeInput;
  return result;
}

function buildEnvelope(
  intent: OutboxIntent,
  options: OutboxClockOptions,
): { envelope: EventEnvelope; json: string; bytes: number } {
  const input = envelopeInput(intent);
  const direct = intent.event ?? intent.envelope;
  if (
    direct !== undefined &&
    typeof direct === "object" &&
    direct !== null &&
    Object.hasOwn(direct, "schema_version")
  ) {
    const json = serializeEventEnvelope(direct as EventEnvelope);
    const envelope = JSON.parse(json) as EventEnvelope;
    const definition = getEventDefinition(envelope.event_type);
    const key = getCoalescingKey(intent);
    if (
      definition === undefined ||
      (definition.requiresCoalescingKey && key === undefined) ||
      (!definition.requiresCoalescingKey && key !== undefined)
    ) {
      throw invalid("coalescingKey", "does not match the registered event contract");
    }
    const bytes = Buffer.byteLength(json, "utf8");
    return { envelope, json, bytes };
  }
  const buildOptions: { now?: () => Date; idFactory?: () => string; eventId?: string } = {};
  if (options.now !== undefined) buildOptions.now = options.now;
  if (options.idFactory !== undefined) buildOptions.idFactory = options.idFactory;
  const eventId = intent.eventId ?? intent.event_id;
  if (eventId !== undefined) buildOptions.eventId = eventId;
  const envelope = createEventEnvelope(input, buildOptions);
  const json = serializeEventEnvelope(envelope);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes < 1 || bytes > MAX_ENVELOPE_BYTES) throw invalid("envelope", "exceeds byte limit");
  return { envelope, json, bytes };
}

function assertDestinationExists(database: DatabaseExecutor, target: OutboxTarget): void {
  const row = database
    .prepare<[string, string], { readonly destination_id: string }>(
      `SELECT d.id AS destination_id
       FROM outbound_destinations d
       JOIN outbound_destination_versions v ON v.destination_id = d.id
       WHERE d.id = ? AND v.id = ? AND d.enabled = 1`,
    )
    .get(target.destinationId, target.destinationVersionId);
  if (row === undefined) throw new Error("Outbox destination or immutable version is missing");
}

function pruneTerminal(database: DatabaseExecutor, batchSize: number): number {
  const result = database
    .prepare<[number]>(
      `DELETE FROM outbound_deliveries
       WHERE id IN (
         SELECT id FROM outbound_deliveries
         WHERE state IN ('succeeded', 'terminal', 'dismissed')
         ORDER BY terminal_at ASC, id ASC
         LIMIT ?
       )`,
    )
    .run(batchSize);
  const remaining = batchSize - result.changes;
  if (remaining <= 0) return result.changes;
  const events = database
    .prepare<[number]>(
      `DELETE FROM outbound_events
       WHERE id IN (
         SELECT e.id FROM outbound_events e
         WHERE NOT EXISTS (SELECT 1 FROM outbound_deliveries d WHERE d.event_id = e.id)
         ORDER BY e.created_at ASC, e.id ASC LIMIT ?
       )`,
    )
    .run(remaining);
  return result.changes + events.changes;
}

function findCoalescibleEvent(
  database: DatabaseExecutor,
  eventType: EventType,
  coalescingKey: string,
  targets: readonly OutboxTarget[],
): string | undefined {
  const rows = database
    .prepare<[string, string], { readonly event_id: string; readonly envelope_json: string }>(
      `SELECT e.id AS event_id, e.envelope_json
       FROM outbound_events e
       WHERE e.event_type = ?
         AND e.coalescing_key = ?
       ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(eventType, coalescingKey);
  const wanted = new Set(targets.map(targetKey));
  for (const row of rows) {
    const deliveries = database
      .prepare<
        [string],
        {
          readonly destination_id: string;
          readonly destination_version_id: string;
          readonly state: string;
          readonly attempt_count: number;
          readonly lease_owner: string | null;
          readonly lease_expires_at: string | null;
        }
      >(
        `SELECT destination_id, destination_version_id, state, attempt_count, lease_owner, lease_expires_at
         FROM outbound_deliveries WHERE event_id = ?`,
      )
      .all(row.event_id);
    if (deliveries.length !== wanted.size) continue;
    if (
      deliveries.some(
        (item) =>
          item.state !== "pending" ||
          item.attempt_count !== 0 ||
          item.lease_owner !== null ||
          item.lease_expires_at !== null,
      )
    )
      continue;
    const actual = new Set(
      deliveries.map((item) => `${item.destination_id}\u0000${item.destination_version_id}`),
    );
    if (actual.size === wanted.size && [...actual].every((key) => wanted.has(key)))
      return row.event_id;
  }
  return undefined;
}

function deleteEvent(database: DatabaseExecutor, eventId: string): void {
  database.prepare<[string]>("DELETE FROM outbound_events WHERE id = ?").run(eventId);
}

function usage(database: DatabaseExecutor): {
  rows: number;
  bytes: number;
  destination: Map<string, { rows: number; bytes: number }>;
} {
  const global = database
    .prepare<[], { readonly rows: number; readonly bytes: number }>(
      `SELECT
         (SELECT count(*) FROM outbound_events) + (SELECT count(*) FROM outbound_deliveries) AS rows,
         (SELECT coalesce(sum(envelope_bytes), 0) FROM outbound_events) +
         (SELECT coalesce(sum(envelope_bytes), 0) FROM outbound_deliveries) AS bytes`,
    )
    .get();
  if (global === undefined) throw new Error("Unable to read outbox usage");
  const destination = new Map<string, { rows: number; bytes: number }>();
  for (const row of database
    .prepare<
      [],
      { readonly destination_id: string; readonly rows: number; readonly bytes: number }
    >(
      `SELECT destination_id, count(*) AS rows, coalesce(sum(envelope_bytes), 0) AS bytes
     FROM outbound_deliveries GROUP BY destination_id`,
    )
    .all()) {
    destination.set(row.destination_id, { rows: row.rows, bytes: row.bytes });
  }
  return { rows: global.rows, bytes: global.bytes, destination };
}

function incidentKey(eventType: string, targets: readonly OutboxTarget[]): string {
  const ids = [...new Set(targets.map((target) => target.destinationId))].sort();
  return createHash("sha256")
    .update(`${eventType}\n${ids.join("\n")}`, "utf8")
    .digest("hex");
}

function representative(event: EventEnvelope, targets: readonly OutboxTarget[]): string {
  return canonicalizeJson(
    {
      event_type: event.event_type,
      destination_ids: [...new Set(targets.map((target) => target.destinationId))].sort(),
      representative_event_id: event.event_id,
    },
    { maxBytes: 1_024, maxKeys: 4, maxDepth: 2 },
  );
}

function recordCapacityIncident(
  database: DatabaseExecutor,
  event: EventEnvelope,
  targets: readonly OutboxTarget[],
  now: string,
): void {
  const key = incidentKey(event.event_type, targets);
  const normal = database
    .prepare<[string], { readonly slot: number }>(
      "SELECT slot FROM outbox_overflow_incidents WHERE incident_key = ? AND slot < 15",
    )
    .get(key);
  let slot = normal?.slot;
  if (slot === undefined) {
    slot = database
      .prepare<[], { readonly slot: number }>(
        "SELECT slot FROM outbox_overflow_incidents WHERE state IN ('empty', 'recovered') AND slot < 15 ORDER BY slot LIMIT 1",
      )
      .get()?.slot;
  }
  const isCatchall = slot === undefined;
  const selectedSlot = slot ?? 15;
  const rep = representative(event, targets);
  const existing = database
    .prepare<
      [number],
      { readonly omitted_count: number; readonly state: string; readonly first_at: string | null }
    >("SELECT omitted_count, state, first_at FROM outbox_overflow_incidents WHERE slot = ?")
    .get(selectedSlot);
  if (existing === undefined) throw new Error("Outbox overflow incident slots are missing");
  const continuing = existing.state === "open";
  database
    .prepare<[string, string | null, string | null, string, string, number, string, number]>(
      `UPDATE outbox_overflow_incidents
       SET incident_key = ?, destination_id = ?, event_type = ?, state = 'open',
           first_at = ?, last_at = ?, omitted_count = ?, representative_json = ?
       WHERE slot = ?`,
    )
    .run(
      isCatchall ? "catchall" : key,
      isCatchall ? null : (targets[0]?.destinationId ?? null),
      isCatchall ? null : event.event_type,
      continuing ? (existing.first_at ?? now) : now,
      now,
      continuing ? existing.omitted_count + 1 : 1,
      rep,
      selectedSlot,
    );
  const degradation = database
    .prepare<[], { readonly state: string }>("SELECT state FROM outbox_degradation WHERE id = 1")
    .get();
  if (degradation?.state === "healthy") {
    database
      .prepare<[string]>(
        "UPDATE outbox_degradation SET state = 'degraded', opened_at = ?, recovered_at = NULL, revision = revision + 1 WHERE id = 1",
      )
      .run(now);
    appendActivity(database, {
      category: "outbox",
      action: "capacity_degraded",
      actorType: "system",
      occurredAt: now,
      details: { incident_slot: selectedSlot, catchall: isCatchall },
    });
  }
}

function validateCapacity(
  current: ReturnType<typeof usage>,
  quota: Required<OutboxQuotaOptions>,
  eventBytes: number,
  targets: readonly OutboxTarget[],
): boolean {
  const projectedRows = current.rows + 1 + targets.length;
  const projectedBytes = current.bytes + eventBytes * (targets.length + 1);
  if (projectedRows > quota.globalMaxRows || projectedBytes > quota.globalMaxBytes) return false;
  const additions = new Map<string, number>();
  for (const target of targets) {
    additions.set(target.destinationId, (additions.get(target.destinationId) ?? 0) + 1);
  }
  for (const [destinationId, count] of additions) {
    const item = current.destination.get(destinationId) ?? { rows: 0, bytes: 0 };
    if (
      item.rows + count > quota.destinationMaxRows ||
      item.bytes + eventBytes * count > quota.destinationMaxBytes
    )
      return false;
  }
  return true;
}

export function createDestination(
  database: DatabaseExecutor,
  input: DestinationInput,
  options: OutboxClockOptions = {},
): OutboundDestinationDescriptor {
  const id = uuid(input.id, "destination.id", options.idFactory ?? randomUUID);
  const label = boundedText(input.label, "destination.label", 120);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw invalid("destination.enabled", "must be boolean");
  }
  const now = canonicalTime(input.createdAt, options.now ?? (() => new Date()));
  database
    .prepare<[string, string, number, string, string]>(
      `INSERT INTO outbound_destinations (id, label, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, label, input.enabled === false ? 0 : 1, now, now);
  return { id, label, enabled: input.enabled !== false, createdAt: now, updatedAt: now };
}

export const createOutboundDestination = createDestination;

export function setDestinationEnabled(
  database: DatabaseExecutor,
  destinationId: string,
  enabled: boolean,
  now: Date | string = new Date(),
): OutboundDestinationDescriptor {
  const id = uuid(destinationId, "destinationId", randomUUID);
  if (typeof enabled !== "boolean") throw invalid("enabled", "must be boolean");
  const timestamp = canonicalTime(now, () => new Date());
  database
    .prepare<[number, string, string]>(
      "UPDATE outbound_destinations SET enabled = ?, updated_at = ? WHERE id = ?",
    )
    .run(enabled ? 1 : 0, timestamp, id);
  const result = readDestination(database, id);
  if (result === undefined) throw new Error("Outbound destination is missing");
  return result;
}

export const enableDestination = setDestinationEnabled;

export function createDestinationVersion(
  database: DatabaseExecutor,
  input: DestinationVersionInput,
  options: OutboxClockOptions = {},
): OutboundDestinationVersionDescriptor {
  const id = uuid(input.id, "destinationVersion.id", options.idFactory ?? randomUUID);
  const destinationId = uuid(input.destinationId, "destinationId", randomUUID);
  positiveInteger(input.versionNumber, "versionNumber");
  const createdAt = canonicalTime(input.createdAt, options.now ?? (() => new Date()));
  database
    .prepare<[string, string, number, string]>(
      `INSERT INTO outbound_destination_versions (id, destination_id, version_number, created_at)
     VALUES (?, ?, ?, ?)`,
    )
    .run(id, destinationId, input.versionNumber, createdAt);
  return { id, destinationId, versionNumber: input.versionNumber, createdAt };
}

export const createOutboundDestinationVersion = createDestinationVersion;

export function readDestination(
  database: DatabaseExecutor,
  id: string,
): OutboundDestinationDescriptor | undefined {
  const row = database
    .prepare<
      [string],
      {
        readonly id: string;
        readonly label: string;
        readonly enabled: number;
        readonly created_at: string;
        readonly updated_at: string;
      }
    >("SELECT id, label, enabled, created_at, updated_at FROM outbound_destinations WHERE id = ?")
    .get(id);
  return row === undefined
    ? undefined
    : {
        id: row.id,
        label: row.label,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
}

export function deleteDestinationVersion(database: DatabaseExecutor, versionId: string): boolean {
  const id = uuid(versionId, "destinationVersionId", randomUUID);
  return (
    database.prepare<[string]>("DELETE FROM outbound_destination_versions WHERE id = ?").run(id)
      .changes === 1
  );
}

export function getCapacityStatus(database: DatabaseExecutor): {
  readonly state: "healthy" | "degraded";
  readonly openedAt: string | null;
  readonly recoveredAt: string | null;
  readonly revision: number;
} {
  const row = database
    .prepare<
      [],
      {
        readonly state: "healthy" | "degraded";
        readonly opened_at: string | null;
        readonly recovered_at: string | null;
        readonly revision: number;
      }
    >("SELECT state, opened_at, recovered_at, revision FROM outbox_degradation WHERE id = 1")
    .get();
  if (row === undefined) throw new Error("Outbox degradation state is missing");
  return {
    state: row.state,
    openedAt: row.opened_at,
    recoveredAt: row.recovered_at,
    revision: row.revision,
  };
}

export function listOverflowIncidents(database: DatabaseExecutor): OverflowIncident[] {
  const rows = database
    .prepare<
      [],
      {
        readonly slot: number;
        readonly is_catchall: number;
        readonly incident_key: string | null;
        readonly destination_id: string | null;
        readonly event_type: string | null;
        readonly state: "empty" | "open" | "recovered";
        readonly first_at: string | null;
        readonly last_at: string | null;
        readonly omitted_count: number;
        readonly representative_json: string | null;
      }
    >(
      "SELECT slot, is_catchall, incident_key, destination_id, event_type, state, first_at, last_at, omitted_count, representative_json FROM outbox_overflow_incidents ORDER BY slot",
    )
    .all();
  return rows.map((row) => {
    let representativeValue: Readonly<Record<string, unknown>> | null = null;
    if (row.representative_json !== null) {
      const parsed: unknown = JSON.parse(row.representative_json);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        canonicalizeJson(parsed, { maxBytes: 1_024, maxKeys: 4, maxDepth: 2 }) !==
          row.representative_json
      ) {
        throw new Error("Stored outbox overflow incident is invalid");
      }
      representativeValue = parsed as Readonly<Record<string, unknown>>;
    }
    if (
      (row.first_at !== null && canonicalTime(row.first_at, () => new Date()) !== row.first_at) ||
      (row.last_at !== null && canonicalTime(row.last_at, () => new Date()) !== row.last_at)
    ) {
      throw new Error("Stored outbox overflow incident is invalid");
    }
    return {
      slot: row.slot,
      isCatchall: row.is_catchall === 1,
      incidentKey: row.incident_key,
      destinationId: row.destination_id,
      eventType: row.event_type,
      state: row.state,
      firstAt: row.first_at,
      lastAt: row.last_at,
      omittedCount: row.omitted_count,
      representative: representativeValue,
    };
  });
}

export function mutateAndAdmit(
  database: DatabaseExecutor,
  mutation: (database: DatabaseExecutor) => void,
  intent: OutboxIntent,
  options: MutateAndAdmitOptions = {},
): QueueResult {
  if (typeof mutation !== "function") throw new TypeError("Outbox mutation must be synchronous");
  const quota = normalizeQuota(options);
  const targets = normalizeTargets(intent);
  const admissionNow = canonicalTime(undefined, options.now ?? (() => new Date()));
  const built = buildEnvelope(intent, { ...options, now: () => new Date(admissionNow) });
  for (const target of targets) assertCanonicalTarget(target);
  return database.withTransaction(() => {
    const mutationResult: unknown = mutation(database);
    if (
      ((typeof mutationResult === "object" && mutationResult !== null) ||
        typeof mutationResult === "function") &&
      "then" in mutationResult &&
      typeof mutationResult.then === "function"
    ) {
      throw new TypeError("Outbox mutation must complete synchronously");
    }
    for (const target of targets) assertDestinationExists(database, target);
    const pruned = pruneTerminal(database, quota.pruneBatch);
    let coalesced = false;
    const definition = getEventDefinition(built.envelope.event_type);
    const coalescingKey = getCoalescingKey(intent);
    if (definition?.supersedable === true && coalescingKey !== undefined) {
      const oldId = findCoalescibleEvent(
        database,
        built.envelope.event_type,
        coalescingKey,
        targets,
      );
      if (oldId !== undefined && oldId !== built.envelope.event_id) {
        class ReplacementWouldExceedCapacity extends Error {}
        try {
          database.withTransaction(() => {
            deleteEvent(database, oldId);
            if (!validateCapacity(usage(database), quota, built.bytes, targets)) {
              throw new ReplacementWouldExceedCapacity();
            }
          });
          coalesced = true;
        } catch (error) {
          if (!(error instanceof ReplacementWouldExceedCapacity)) throw error;
        }
      }
    }
    if (!validateCapacity(usage(database), quota, built.bytes, targets)) {
      recordCapacityIncident(database, built.envelope, targets, admissionNow);
      return { status: "not_queued_capacity", pruned, coalesced } as const;
    }
    database
      .prepare<[string, string, string, string, number, string | null, string]>(
        `INSERT INTO outbound_events
       (id, event_type, schema_version, occurred_at, envelope_json, envelope_bytes, coalescing_key, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        built.envelope.event_id,
        built.envelope.event_type,
        built.envelope.occurred_at,
        built.json,
        built.bytes,
        coalescingKey ?? null,
        admissionNow,
      );
    const insert = database.prepare<
      [string, string, string, string, string, number, string, string]
    >(
      `INSERT INTO outbound_deliveries
       (id, event_id, destination_id, destination_version_id, state, attempt_count, next_attempt_at, revision, envelope_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?, ?)`,
    );
    for (const target of targets) {
      insert.run(
        randomUUID(),
        built.envelope.event_id,
        target.destinationId,
        target.destinationVersionId,
        admissionNow,
        built.bytes,
        admissionNow,
        admissionNow,
      );
    }
    return { status: "queued", eventId: built.envelope.event_id, pruned, coalesced } as const;
  });
}

function getCoalescingKey(intent: OutboxIntent): string | undefined {
  if (intent.coalescingKey !== undefined) return intent.coalescingKey;
  if (intent.coalescing_key !== undefined) return intent.coalescing_key;
  const event = intent.event ?? intent.envelope;
  if (event === undefined || typeof event !== "object" || event === null) return undefined;
  const candidate = event as unknown as Record<string, unknown>;
  const value = candidate.coalescingKey ?? candidate.coalescing_key;
  return typeof value === "string" ? value : undefined;
}

function assertCanonicalTarget(target: OutboxTarget): void {
  if (!UUID.test(target.destinationId) || !UUID.test(target.destinationVersionId))
    throw invalid("target", "must use canonical UUIDs");
}

export function recoverCapacity(
  database: DatabaseExecutor,
  now: Date | string = new Date(),
  options: OutboxQuotaOptions = {},
): boolean {
  const quota = normalizeQuota(options);
  const timestamp = canonicalTime(now, () => new Date());
  return database.withTransaction(() => {
    const current = usage(database);
    if (current.rows > quota.globalMaxRows * 0.8 || current.bytes > quota.globalMaxBytes * 0.8)
      return false;
    for (const item of current.destination.values()) {
      if (
        item.rows > quota.destinationMaxRows * 0.8 ||
        item.bytes > quota.destinationMaxBytes * 0.8
      )
        return false;
    }
    const open =
      database
        .prepare<[], { readonly count: number }>(
          "SELECT count(*) AS count FROM outbox_overflow_incidents WHERE state = 'open'",
        )
        .get()?.count ?? 0;
    const degradation = database
      .prepare<[], { readonly state: string }>("SELECT state FROM outbox_degradation WHERE id = 1")
      .get();
    if (open === 0 || degradation?.state !== "degraded") return false;
    database
      .prepare<[string]>(
        "UPDATE outbox_overflow_incidents SET state = 'recovered', last_at = ? WHERE state = 'open'",
      )
      .run(timestamp);
    database
      .prepare<[string]>(
        "UPDATE outbox_degradation SET state = 'healthy', recovered_at = ?, revision = revision + 1 WHERE id = 1",
      )
      .run(timestamp);
    appendActivity(database, {
      category: "outbox",
      action: "capacity_recovered",
      actorType: "system",
      occurredAt: timestamp,
    });
    return true;
  });
}

export const recoverOutboxCapacity = recoverCapacity;

function validateLease(owner: string, ttlMs: number, limit: number): void {
  boundedText(owner, "lease owner", 120);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000)
    throw invalid("ttlMs", "must be between 1 second and 1 hour");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw invalid("limit", "must be between 1 and 100");
}

export function claimDue(
  database: DatabaseExecutor,
  owner: string,
  now: Date | string = new Date(),
  ttlMs = 30_000,
  limit = 10,
): DeliveryClaim[] {
  validateLease(owner, ttlMs, limit);
  const timestamp = canonicalTime(now, () => new Date());
  const expires = new Date(Date.parse(timestamp) + ttlMs).toISOString();
  return database.withTransaction(() => {
    const exhausted = database
      .prepare<[string, number], { readonly id: string; readonly revision: number }>(
        `SELECT id, revision FROM outbound_deliveries
         WHERE state = 'leased' AND attempt_count >= 8 AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC, id ASC LIMIT ?`,
      )
      .all(timestamp, limit);
    for (const row of exhausted) {
      database
        .prepare<[string, string, string, number, string]>(
          `UPDATE outbound_deliveries
           SET state = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
               terminal_at = ?, last_error_code = 'lease_expired_max_attempts',
               updated_at = ?, revision = revision + 1
           WHERE id = ? AND revision = ? AND state = 'leased'
             AND attempt_count >= 8 AND lease_expires_at <= ?`,
        )
        .run(timestamp, timestamp, row.id, row.revision, timestamp);
    }
    const rows = database
      .prepare<
        [string, string, number],
        {
          readonly id: string;
          readonly event_id: string;
          readonly destination_id: string;
          readonly destination_version_id: string;
          readonly attempt_count: number;
          readonly revision: number;
          readonly envelope_json: string;
        }
      >(
        `SELECT d.id, d.event_id, d.destination_id, d.destination_version_id, d.attempt_count, d.revision, e.envelope_json
       FROM outbound_deliveries d JOIN outbound_events e ON e.id = d.event_id
       WHERE d.attempt_count < 8 AND ((d.state IN ('pending', 'retry') AND d.next_attempt_at <= ?) OR (d.state = 'leased' AND d.lease_expires_at <= ?))
       ORDER BY d.next_attempt_at ASC, d.id ASC LIMIT ?`,
      )
      .all(timestamp, timestamp, limit);
    const result: DeliveryClaim[] = [];
    for (const row of rows) {
      const changed = database
        .prepare<[string, string, string, string, number, string]>(
          `UPDATE outbound_deliveries SET state = 'leased', attempt_count = attempt_count + 1, revision = revision + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND revision = ? AND (state IN ('pending', 'retry') OR (state = 'leased' AND lease_expires_at <= ?))`,
        )
        .run(owner, expires, timestamp, row.id, row.revision, timestamp);
      if (changed.changes !== 1) continue;
      const parsed: unknown = JSON.parse(row.envelope_json);
      const envelope = parsed as EventEnvelope;
      if (serializeEventEnvelope(envelope) !== row.envelope_json) {
        throw new Error("Stored outbound event envelope is invalid");
      }
      result.push({
        deliveryId: row.id,
        eventId: row.event_id,
        destinationId: row.destination_id,
        destinationVersionId: row.destination_version_id,
        state: "leased",
        attemptCount: row.attempt_count + 1,
        revision: row.revision + 1,
        leaseOwner: owner,
        leaseExpiresAt: expires,
        envelope,
        envelopeJson: row.envelope_json,
      });
    }
    return result;
  });
}

export function applyDeliveryResult(
  database: DatabaseExecutor,
  input: DeliveryResultInput,
): boolean {
  if (!UUID.test(input.deliveryId)) throw invalid("deliveryId", "must be a canonical UUID");
  boundedText(input.owner, "owner", 120);
  positiveInteger(input.revision, "revision");
  if (input.outcome !== "success" && input.outcome !== "retry" && input.outcome !== "failure") {
    throw invalid("outcome", "is unsupported");
  }
  const timestamp = canonicalTime(input.now, () => new Date());
  return database.withTransaction(() => {
    const row = database
      .prepare<
        [string],
        { readonly attempt_count: number; readonly lease_expires_at: string | null }
      >("SELECT attempt_count, lease_expires_at FROM outbound_deliveries WHERE id = ?")
      .get(input.deliveryId);
    if (row === undefined || row.lease_expires_at === null || row.lease_expires_at <= timestamp)
      return false;
    if (input.outcome === "success") {
      return (
        database
          .prepare<[string, string, string, string, number, string]>(
            `UPDATE outbound_deliveries SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, terminal_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND state = 'leased' AND lease_owner = ? AND revision = ? AND lease_expires_at > ?`,
          )
          .run(timestamp, timestamp, input.deliveryId, input.owner, input.revision, timestamp)
          .changes === 1
      );
    }
    const errorCode = boundedText(
      input.errorCode ?? "delivery_failed",
      "errorCode",
      MAX_ERROR_BYTES,
    );
    if (row.attempt_count >= 8) {
      return (
        database
          .prepare<[string, string, string, string, string, number, string]>(
            `UPDATE outbound_deliveries SET state = 'terminal', lease_owner = NULL, lease_expires_at = NULL, terminal_at = ?, last_error_code = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND state = 'leased' AND lease_owner = ? AND revision = ? AND lease_expires_at > ?`,
          )
          .run(
            timestamp,
            errorCode,
            timestamp,
            input.deliveryId,
            input.owner,
            input.revision,
            timestamp,
          ).changes === 1
      );
    }
    const backoff = Math.min(3_600_000, 5_000 * 2 ** Math.max(0, row.attempt_count - 1));
    const next = new Date(Date.parse(timestamp) + backoff).toISOString();
    return (
      database
        .prepare<[string, string, string, string, string, number, string]>(
          `UPDATE outbound_deliveries SET state = 'retry', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND state = 'leased' AND lease_owner = ? AND revision = ? AND lease_expires_at > ?`,
        )
        .run(next, errorCode, timestamp, input.deliveryId, input.owner, input.revision, timestamp)
        .changes === 1
    );
  });
}

export const completeDelivery = applyDeliveryResult;

export function retryDelivery(
  database: DatabaseExecutor,
  deliveryId: string,
  now: Date | string = new Date(),
): boolean {
  if (!UUID.test(deliveryId)) throw invalid("deliveryId", "must be a canonical UUID");
  const timestamp = canonicalTime(now, () => new Date());
  return (
    database
      .prepare<[string, string, string]>(
        `UPDATE outbound_deliveries SET state = 'retry', attempt_count = 0, lease_owner = NULL, lease_expires_at = NULL, terminal_at = NULL, next_attempt_at = ?, revision = revision + 1, updated_at = ?
     WHERE id = ? AND state IN ('terminal', 'dismissed')`,
      )
      .run(timestamp, timestamp, deliveryId).changes === 1
  );
}

export const manualRetry = retryDelivery;

export function dismissDelivery(
  database: DatabaseExecutor,
  deliveryId: string,
  now: Date | string = new Date(),
): boolean {
  if (!UUID.test(deliveryId)) throw invalid("deliveryId", "must be a canonical UUID");
  const timestamp = canonicalTime(now, () => new Date());
  return (
    database
      .prepare<[string, string, string]>(
        `UPDATE outbound_deliveries SET state = 'dismissed', lease_owner = NULL, lease_expires_at = NULL, terminal_at = coalesce(terminal_at, ?), revision = revision + 1, updated_at = ?
     WHERE id = ? AND state = 'terminal'`,
      )
      .run(timestamp, timestamp, deliveryId).changes === 1
  );
}

export function listDeliveries(database: DatabaseExecutor): readonly Record<string, unknown>[] {
  return database
    .prepare(
      "SELECT id, event_id, destination_id, destination_version_id, state, attempt_count, next_attempt_at, lease_owner, lease_expires_at, revision, last_error_code, envelope_bytes, created_at, updated_at, terminal_at FROM outbound_deliveries ORDER BY created_at, id",
    )
    .all() as Record<string, unknown>[];
}
