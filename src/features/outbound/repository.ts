import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { EVENT_TYPES, type EventType } from "../events/types.ts";
import {
  applyDeliveryResult,
  claimDue,
  mutateAndAdmit,
  type DeliveryClaim,
  type DeliveryResultInput,
  type MutateAndAdmitOptions,
  type OutboxIntent,
  type QueueResult,
} from "../outbox/repository.ts";
import type {
  OutboundConfig,
  OutboundDestination,
  OutboundDestinationListItem,
  OutboundDestinationVersion,
  OutboundDeliveryHistoryItem,
  OutboundFailureClass,
  OutboundFailureSummary,
  OutboundHeader,
  OutboundSecretHeader,
  OutboundTransport,
} from "./types.ts";
import { type NormalizedDestinationConfig, validateDestinationId } from "./outbound-validation.ts";

const MAX_HISTORY = 100;
const FAILURE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u;

export interface OutboundRepositoryClock {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface DestinationBaseInput {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly transport: OutboundTransport;
  readonly now: string;
}

export interface VersionConfigInput {
  readonly id: string;
  readonly destinationId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
  readonly config: NormalizedDestinationConfig;
  readonly subscriptions: readonly EventType[];
  /** Required is consumed when creating the v19 profile row. */
  readonly required?: boolean;
}

export interface OutboundSecretDescriptorLike {
  readonly integrationType: string;
  readonly recordId: string;
  readonly fieldName: string;
  readonly configured: boolean;
  readonly available: boolean;
}

export interface DestinationReadOptions {
  readonly secrets?: readonly OutboundSecretDescriptorLike[];
  readonly now?: Date;
}

export interface DestinationProfileRow {
  readonly id: string;
  readonly label: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly transport_kind: "ha" | "webhook";
  readonly required: number;
  readonly current_version_id: string | null;
  readonly retired_at: string | null;
  readonly disabled_at: string | null;
  readonly disabled_reason: string | null;
  readonly connectivity_state:
    "unknown" | "healthy" | "failing" | "degraded" | "needs_attention" | "token_missing";
  readonly failure_started_at: string | null;
  readonly last_failure_at: string | null;
  readonly last_failure_code: string | null;
  readonly last_success_at: string | null;
  readonly profile_created_at: string;
  readonly profile_updated_at: string;
  readonly profile_revision: number;
}

export interface DestinationVersionRead {
  readonly id: string;
  readonly destinationId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
  readonly config: OutboundConfig;
  readonly configJson: string;
  readonly safeSummary: string;
  readonly subscriptions: readonly EventType[];
}

export interface DeliveryConfiguration {
  readonly destination: OutboundDestination;
  readonly version: OutboundDestinationVersion;
  readonly profileRevision: number;
}

function invalid(field: string, reason: string): never {
  throw new TypeError(`Invalid outbound ${field}: ${reason}`);
}

function id(value: string, field: string): string {
  return validateDestinationId(value, field);
}

function jsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    invalid(field, "must contain valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid(field, "must contain an object");
  }
  return parsed as Record<string, unknown>;
}

function parseSummary(value: string): OutboundConfig["urlSummary"] {
  const parsed = jsonObject(value, "safeSummary");
  if (
    (parsed.scheme !== "http" && parsed.scheme !== "https") ||
    typeof parsed.host !== "string" ||
    (parsed.port !== null && !Number.isSafeInteger(parsed.port))
  ) {
    invalid("safeSummary", "contains an invalid URL summary");
  }
  return {
    scheme: parsed.scheme,
    host: parsed.host,
    port: parsed.port as number | null,
  };
}

function parseHeaders(
  staticValue: unknown,
  secretValue?: unknown,
): {
  readonly staticHeaders: readonly OutboundHeader[];
  readonly secretHeaders: readonly OutboundSecretHeader[];
} {
  const staticHeaders: OutboundHeader[] = [];
  const secretHeaders: OutboundSecretHeader[] = [];
  const raw = Array.isArray(staticValue) ? (staticValue as readonly unknown[]) : [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string") continue;
    if (typeof record.value === "string")
      staticHeaders.push({ name: record.name, value: record.value });
  }
  const secretRaw = Array.isArray(secretValue) ? (secretValue as readonly unknown[]) : [];
  for (const item of secretRaw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.slot === "string") {
      secretHeaders.push({ name: record.name, slot: record.slot, configured: false });
    }
  }
  return { staticHeaders, secretHeaders };
}

function parseConfig(
  transportKind: "ha" | "webhook",
  configJson: string,
  safeSummary: string,
  secrets: readonly OutboundSecretDescriptorLike[] | undefined,
  destinationId: string,
  versionId: string,
): OutboundConfig {
  const parsed = jsonObject(configJson, "configJson");
  const summary = parseSummary(safeSummary);
  const headers = parseHeaders(parsed.staticHeaders ?? parsed.headers, parsed.secretHeaders);
  const payloadFormat = parsed.payloadFormat === "discord" ? "discord" : "standard";
  const authConfigured = (secrets ?? []).some(
    (item) =>
      item.integrationType === "outbound" &&
      item.recordId === destinationId &&
      item.fieldName === "token_current" &&
      item.configured,
  );
  const authAvailable = (secrets ?? []).some(
    (item) =>
      item.integrationType === "outbound" &&
      item.recordId === destinationId &&
      item.fieldName === "token_current" &&
      item.configured &&
      item.available,
  );
  const endpointConfigured = (secrets ?? []).some(
    (item) =>
      item.integrationType === "outbound" &&
      item.recordId === versionId &&
      item.fieldName === "endpoint" &&
      item.configured,
  );
  const endpointAvailable = (secrets ?? []).some(
    (item) =>
      item.integrationType === "outbound" &&
      item.recordId === versionId &&
      item.fieldName === "endpoint" &&
      item.configured &&
      item.available,
  );
  const secretHeaders = headers.secretHeaders.map((header) => {
    const descriptor = (secrets ?? []).find(
      (item) =>
        item.integrationType === "outbound" &&
        item.recordId === destinationId &&
        item.fieldName === header.slot,
    );
    return {
      ...header,
      configured: descriptor?.configured ?? false,
      available: descriptor?.available ?? false,
    };
  });
  if (transportKind === "ha") {
    const baseUrl =
      typeof parsed.baseUrl === "string" ? parsed.baseUrl : `${summary.scheme}://${summary.host}`;
    return {
      transport: "home_assistant",
      baseUrl,
      urlSummary: summary,
      authConfigured,
      authAvailable,
      staticHeaders: headers.staticHeaders,
      secretHeaders,
    };
  }
  return {
    transport: "webhook",
    payloadFormat,
    urlSummary: summary,
    endpointConfigured,
    endpointAvailable,
    staticHeaders: headers.staticHeaders,
    secretHeaders,
  };
}

function rowToVersion(
  row: {
    readonly id: string;
    readonly destination_id: string;
    readonly version_number: number;
    readonly created_at: string;
    readonly transport_kind: "ha" | "webhook";
    readonly safe_summary: string;
    readonly config_json: string;
  },
  subscriptions: readonly EventType[],
  secrets?: readonly OutboundSecretDescriptorLike[],
): DestinationVersionRead {
  return {
    id: row.id,
    destinationId: row.destination_id,
    versionNumber: row.version_number,
    createdAt: row.created_at,
    config: parseConfig(
      row.transport_kind,
      row.config_json,
      row.safe_summary,
      secrets,
      row.destination_id,
      row.id,
    ),
    configJson: row.config_json,
    safeSummary: row.safe_summary,
    subscriptions,
  };
}

function subscriptionsFor(database: DatabaseExecutor, versionId: string): EventType[] {
  const rows = database
    .prepare<[string], { readonly event_type: string }>(
      "SELECT event_type FROM outbound_destination_subscriptions WHERE version_id = ? ORDER BY event_type",
    )
    .all(versionId);
  const result = rows
    .map((row) => row.event_type)
    .filter((item): item is EventType => (EVENT_TYPES as readonly string[]).includes(item));
  // An empty persisted set is a valid explicit subscription subset. The
  // create normalizer expands only an omitted input to all six events.
  return result;
}

export function readDestinationProfile(
  database: DatabaseExecutor,
  destinationId: string,
): DestinationProfileRow | undefined {
  const normalized = id(destinationId, "destinationId");
  return database
    .prepare<[string], DestinationProfileRow>(
      `SELECT d.id, d.label, d.enabled, d.created_at, d.updated_at,
              p.transport_kind, p.required, p.current_version_id, p.retired_at,
              p.disabled_at, p.disabled_reason, p.connectivity_state, p.failure_started_at,
              p.last_failure_at, p.last_failure_code, p.last_success_at,
              p.created_at AS profile_created_at, p.updated_at AS profile_updated_at,
              p.revision AS profile_revision
       FROM outbound_destinations d
       JOIN outbound_destination_profiles p ON p.destination_id = d.id
       WHERE d.id = ?`,
    )
    .get(normalized);
}

export function readDestinationVersion(
  database: DatabaseExecutor,
  destinationId: string,
  versionId?: string,
  secrets?: readonly OutboundSecretDescriptorLike[],
): DestinationVersionRead | undefined {
  const destination = id(destinationId, "destinationId");
  const row = database
    .prepare<
      [string, string | null, string | null],
      {
        readonly id: string;
        readonly destination_id: string;
        readonly version_number: number;
        readonly created_at: string;
        readonly transport_kind: "ha" | "webhook";
        readonly safe_summary: string;
        readonly config_json: string;
      }
    >(
      `SELECT v.id, v.destination_id, v.version_number, v.created_at,
              c.transport_kind, c.safe_summary, c.config_json
       FROM outbound_destination_versions v
       JOIN outbound_destination_configs c
         ON c.version_id = v.id AND c.destination_id = v.destination_id
       WHERE v.destination_id = ? AND (? IS NULL OR v.id = ?)
       ORDER BY v.version_number DESC, v.id DESC LIMIT 1`,
    )
    .get(
      destination,
      versionId === undefined ? null : id(versionId, "versionId"),
      versionId === undefined ? null : id(versionId, "versionId"),
    );
  return row === undefined
    ? undefined
    : rowToVersion(row, subscriptionsFor(database, row.id), secrets);
}

export function readCurrentDestinationVersion(
  database: DatabaseExecutor,
  destinationId: string,
  secrets?: readonly OutboundSecretDescriptorLike[],
): DestinationVersionRead | undefined {
  const current = readDestinationProfile(database, destinationId);
  if (current?.current_version_id === null || current?.current_version_id === undefined)
    return undefined;
  return readDestinationVersion(database, destinationId, current.current_version_id, secrets);
}

function destinationFailure(
  profile: DestinationProfileRow,
  now: Date,
): OutboundFailureSummary | null {
  if (profile.last_failure_at === null || profile.last_failure_code === null) return null;
  const failureAt = Date.parse(profile.last_failure_at);
  if (!Number.isFinite(failureAt)) return null;
  return {
    code: safeErrorCode(profile.last_failure_code),
    failureClass:
      profile.connectivity_state === "needs_attention" ||
      profile.connectivity_state === "token_missing"
        ? "authentication"
        : profile.connectivity_state === "failing" || profile.connectivity_state === "degraded"
          ? "connectivity"
          : "unknown",
    occurredAt: profile.last_failure_at,
    ageMs: Math.max(0, now.getTime() - failureAt),
  };
}

function safeErrorCode(value: string | null | undefined): string {
  return value !== null && value !== undefined && FAILURE_CODE.test(value)
    ? value
    : "delivery_failed";
}

function failureAge(profile: DestinationProfileRow, now: Date): number | undefined {
  if (profile.failure_started_at === null) return undefined;
  const started = Date.parse(profile.failure_started_at);
  return Number.isFinite(started) ? Math.max(0, now.getTime() - started) : undefined;
}

function publicState(profile: DestinationProfileRow, now: Date): OutboundDestination["state"] {
  if (profile.enabled !== 1 || profile.retired_at !== null || profile.disabled_at !== null)
    return "disabled";
  const age = failureAge(profile, now);
  if (
    profile.connectivity_state === "token_missing" ||
    profile.connectivity_state === "needs_attention"
  ) {
    return profile.required === 1 && age !== undefined && age >= 5 * 60_000
      ? "degraded"
      : "needs_attention";
  }
  if (profile.connectivity_state === "degraded")
    return profile.required === 1 ? "degraded" : "healthy";
  if (profile.connectivity_state === "failing") {
    return profile.required === 1 && age !== undefined && age >= 5 * 60_000
      ? "degraded"
      : "failing";
  }
  if (profile.connectivity_state === "unknown") return "unknown";
  return "healthy";
}

function destinationFromRows(
  database: DatabaseExecutor,
  profile: DestinationProfileRow,
  options: DestinationReadOptions = {},
): OutboundDestination {
  const version = readCurrentDestinationVersion(database, profile.id, options.secrets);
  return {
    id: profile.id,
    label: profile.label,
    transport: profile.transport_kind === "ha" ? "home_assistant" : "webhook",
    enabled: profile.enabled === 1,
    required: profile.required === 1,
    retiredAt: profile.retired_at,
    disabledAt: profile.disabled_at,
    disabledReason: profile.disabled_reason,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
    currentVersion:
      version === undefined
        ? null
        : {
            id: version.id,
            destinationId: version.destinationId,
            versionNumber: version.versionNumber,
            createdAt: version.createdAt,
            config: version.config,
          },
    state: publicState(profile, options.now ?? new Date()),
    failure: destinationFailure(profile, options.now ?? new Date()),
    lastSuccessAt: profile.last_success_at,
    subscriptions: version?.subscriptions ?? [],
  };
}

export function insertDestinationBase(
  database: DatabaseExecutor,
  input: DestinationBaseInput,
): void {
  database
    .prepare<[string, string, number, string, string]>(
      `INSERT INTO outbound_destinations (id, label, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.label, input.enabled ? 1 : 0, input.now, input.now);
}

export function updateDestinationLabelRequired(
  database: DatabaseExecutor,
  destinationId: string,
  label: string,
  required: boolean,
  now: string,
): void {
  const normalized = id(destinationId, "destinationId");
  database
    .prepare<[string, string, string]>(
      "UPDATE outbound_destinations SET label = ?, updated_at = ? WHERE id = ?",
    )
    .run(label, now, normalized);
  database
    .prepare<[number, string, string]>(
      "UPDATE outbound_destination_profiles SET required = ?, updated_at = ?, revision = revision + 1 WHERE destination_id = ?",
    )
    .run(required ? 1 : 0, now, normalized);
}

export function insertVersionConfig(database: DatabaseExecutor, input: VersionConfigInput): void {
  database
    .prepare<[string, string, number, string]>(
      `INSERT INTO outbound_destination_versions (id, destination_id, version_number, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.id, input.destinationId, input.versionNumber, input.createdAt);
  database
    .prepare<[string, string, string, string, string, string]>(
      `INSERT INTO outbound_destination_configs
       (version_id, destination_id, transport_kind, safe_summary, config_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.destinationId,
      input.config.transportKind,
      input.config.safeSummary,
      input.config.configJson,
      input.createdAt,
    );
  for (const eventType of input.subscriptions) {
    database
      .prepare<[string, string, string, string]>(
        `INSERT INTO outbound_destination_subscriptions
         (version_id, destination_id, event_type, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.id, input.destinationId, eventType, input.createdAt);
  }
  const existing = database
    .prepare<[string], { readonly destination_id: string }>(
      "SELECT destination_id FROM outbound_destination_profiles WHERE destination_id = ?",
    )
    .get(input.destinationId);
  if (existing === undefined) {
    database
      .prepare<[string, string, number, string, string, string]>(
        `INSERT INTO outbound_destination_profiles
         (destination_id, transport_kind, required, current_version_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.destinationId,
        input.config.transportKind,
        input.required === true ? 1 : 0,
        input.id,
        input.createdAt,
        input.createdAt,
      );
  } else {
    database
      .prepare<[string, string, string, string]>(
        "UPDATE outbound_destination_profiles SET transport_kind = ?, current_version_id = ?, updated_at = ?, revision = revision + 1 WHERE destination_id = ?",
      )
      .run(input.config.transportKind, input.id, input.createdAt, input.destinationId);
  }
}

export function nextVersionNumber(database: DatabaseExecutor, destinationId: string): number {
  const row = database
    .prepare<[string], { readonly version_number: number | null }>(
      "SELECT max(version_number) AS version_number FROM outbound_destination_versions WHERE destination_id = ?",
    )
    .get(id(destinationId, "destinationId"));
  return (row?.version_number ?? 0) + 1;
}

export function listDestinationProfiles(
  database: DatabaseExecutor,
): readonly DestinationProfileRow[] {
  return database
    .prepare<[], DestinationProfileRow>(
      `SELECT d.id, d.label, d.enabled, d.created_at, d.updated_at,
              p.transport_kind, p.required, p.current_version_id, p.retired_at,
              p.disabled_at, p.disabled_reason, p.connectivity_state, p.failure_started_at,
              p.last_failure_at, p.last_failure_code, p.last_success_at,
              p.created_at AS profile_created_at, p.updated_at AS profile_updated_at,
              p.revision AS profile_revision
       FROM outbound_destinations d JOIN outbound_destination_profiles p ON p.destination_id = d.id
       ORDER BY d.created_at, d.id`,
    )
    .all();
}

export function listDestinationConfigJson(
  database: DatabaseExecutor,
  destinationId: string,
): readonly string[] {
  return database
    .prepare<[string], { readonly config_json: string }>(
      "SELECT config_json FROM outbound_destination_configs WHERE destination_id = ?",
    )
    .all(id(destinationId, "destinationId"))
    .map((row) => row.config_json);
}

export function listDestinationVersionIds(
  database: DatabaseExecutor,
  destinationId: string,
): readonly string[] {
  return database
    .prepare<[string], { readonly id: string }>(
      "SELECT id FROM outbound_destination_versions WHERE destination_id = ?",
    )
    .all(id(destinationId, "destinationId"))
    .map((row) => row.id);
}

export function listUnfinishedSecretSlots(
  database: DatabaseExecutor,
  destinationId: string,
): readonly string[] {
  const rows = database
    .prepare<[string], { readonly config_json: string }>(
      `SELECT DISTINCT c.config_json
       FROM outbound_deliveries d
       JOIN outbound_destination_configs c
         ON c.version_id = d.destination_version_id AND c.destination_id = d.destination_id
       WHERE d.destination_id = ? AND d.state IN ('pending', 'retry', 'leased')`,
    )
    .all(id(destinationId, "destinationId"));
  const slots = new Set<string>();
  for (const row of rows) {
    const parsed = jsonObject(row.config_json, "configJson");
    const headers = parsed.secretHeaders;
    if (!Array.isArray(headers)) continue;
    for (const header of headers) {
      if (typeof header !== "object" || header === null || Array.isArray(header)) continue;
      const slot = (header as Record<string, unknown>).slot;
      if (typeof slot === "string") slots.add(slot);
    }
  }
  return [...slots].sort();
}

export function readDestination(
  database: DatabaseExecutor,
  destinationId: string,
  options: DestinationReadOptions = {},
): OutboundDestination | undefined {
  const profile = readDestinationProfile(database, destinationId);
  return profile === undefined ? undefined : destinationFromRows(database, profile, options);
}

export function listDestinations(
  database: DatabaseExecutor,
  options: DestinationReadOptions = {},
): readonly OutboundDestination[] {
  return listDestinationProfiles(database).map((profile) =>
    destinationFromRows(database, profile, options),
  );
}

export function listDestinationPage(
  database: DatabaseExecutor,
  options: DestinationReadOptions = {},
): readonly OutboundDestinationListItem[] {
  return listDestinations(database, options).map((destination) => {
    const counts = database
      .prepare<
        [string],
        { readonly pending: number; readonly retry: number; readonly terminal: number }
      >(
        `SELECT
          sum(CASE WHEN state IN ('pending','leased') THEN 1 ELSE 0 END) AS pending,
          sum(CASE WHEN state = 'retry' THEN 1 ELSE 0 END) AS retry,
          sum(CASE WHEN state = 'terminal' THEN 1 ELSE 0 END) AS terminal
         FROM outbound_deliveries WHERE destination_id = ?`,
      )
      .get(destination.id) ?? { pending: 0, retry: 0, terminal: 0 };
    return {
      ...destination,
      pendingCount: counts.pending ?? 0,
      retryCount: counts.retry ?? 0,
      terminalCount: counts.terminal ?? 0,
    };
  });
}

export function resolveTargets(
  database: DatabaseExecutor,
  eventType: EventType,
): readonly { readonly destinationId: string; readonly destinationVersionId: string }[] {
  if (!(EVENT_TYPES as readonly string[]).includes(eventType))
    invalid("eventType", "is not registered");
  return database
    .prepare<[string], { readonly destination_id: string; readonly version_id: string | null }>(
      `SELECT d.id AS destination_id, p.current_version_id AS version_id
       FROM outbound_destinations d
       JOIN outbound_destination_profiles p ON p.destination_id = d.id
       JOIN outbound_destination_subscriptions s
         ON s.destination_id = d.id AND s.version_id = p.current_version_id
       WHERE d.enabled = 1 AND p.retired_at IS NULL AND p.disabled_at IS NULL
         AND s.event_type = ?
       ORDER BY d.created_at, d.id LIMIT 32`,
    )
    .all(eventType)
    .filter(
      (row): row is { readonly destination_id: string; readonly version_id: string } =>
        row.version_id !== null,
    )
    .map((row) => ({ destinationId: row.destination_id, destinationVersionId: row.version_id }));
}

export function setEnabledState(
  database: DatabaseExecutor,
  destinationId: string,
  enabled: boolean,
  now: string,
  reason: string | null = null,
): void {
  const idValue = id(destinationId, "destinationId");
  database
    .prepare<[number, string, string]>(
      "UPDATE outbound_destinations SET enabled = ?, updated_at = ? WHERE id = ?",
    )
    .run(enabled ? 1 : 0, now, idValue);
  if (!enabled) {
    database
      .prepare<[string, string, string, string]>(
        `UPDATE outbound_destination_profiles
       SET disabled_at = coalesce(disabled_at, ?), disabled_reason = ?, updated_at = ?, revision = revision + 1
       WHERE destination_id = ?`,
      )
      .run(now, reason === null ? "disabled" : safeErrorCode(reason), now, idValue);
    pauseDestinationDeliveries(database, idValue, now);
  } else {
    database
      .prepare<[string, string]>(
        "UPDATE outbound_destination_profiles SET disabled_at = NULL, disabled_reason = NULL, updated_at = ?, revision = revision + 1 WHERE destination_id = ?",
      )
      .run(now, idValue);
  }
}

export function touchDestinationProfile(
  database: DatabaseExecutor,
  destinationId: string,
  now: string,
): void {
  database
    .prepare<[string, string]>(
      "UPDATE outbound_destination_profiles SET updated_at = ?, revision = revision + 1 WHERE destination_id = ?",
    )
    .run(now, id(destinationId, "destinationId"));
}

export function shiftDestinationDeliveries(
  database: DatabaseExecutor,
  destinationId: string,
  disabledAt: string,
  enabledAt: string,
): number {
  const start = Date.parse(disabledAt);
  const end = Date.parse(enabledAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    invalid("disabled duration", "must be valid");
  const rows = database
    .prepare<
      [string],
      {
        readonly id: string;
        readonly next_attempt_at: string;
        readonly active_failure_started_at: string | null;
      }
    >(
      "SELECT id, next_attempt_at, active_failure_started_at FROM outbound_deliveries WHERE destination_id = ? AND state IN ('pending', 'retry')",
    )
    .all(id(destinationId, "destinationId"));
  for (const row of rows) {
    const next = new Date(
      Math.max(Date.parse(row.next_attempt_at), start) + (end - start),
    ).toISOString();
    const activeFailure =
      row.active_failure_started_at === null
        ? null
        : new Date(
            Math.max(Date.parse(row.active_failure_started_at), start) + (end - start),
          ).toISOString();
    database
      .prepare<[string, string | null, string, string]>(
        "UPDATE outbound_deliveries SET next_attempt_at = ?, active_failure_started_at = ?, updated_at = ? WHERE id = ? AND state IN ('pending','retry')",
      )
      .run(next, activeFailure, enabledAt, row.id);
  }
  const profile = database
    .prepare<[string], { readonly failure_started_at: string | null }>(
      "SELECT failure_started_at FROM outbound_destination_profiles WHERE destination_id = ?",
    )
    .get(id(destinationId, "destinationId"));
  if (profile?.failure_started_at !== null && profile?.failure_started_at !== undefined) {
    const failureStarted = Date.parse(profile.failure_started_at);
    if (Number.isFinite(failureStarted)) {
      const shifted = new Date(Math.max(failureStarted, start) + (end - start)).toISOString();
      database
        .prepare<[string, string, string]>(
          "UPDATE outbound_destination_profiles SET failure_started_at = ?, updated_at = ?, revision = revision + 1 WHERE destination_id = ?",
        )
        .run(shifted, enabledAt, id(destinationId, "destinationId"));
    }
  }
  return rows.length;
}

export function pauseDestinationDeliveries(
  database: DatabaseExecutor,
  destinationId: string,
  now: string,
): number {
  const result = database
    .prepare<[string, string, string]>(
      `UPDATE outbound_deliveries
       SET state = CASE WHEN state = 'leased' THEN 'retry' ELSE state END,
           lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?,
           revision = revision + 1, updated_at = ?
       WHERE destination_id = ? AND state IN ('pending', 'retry', 'leased')`,
    )
    .run(now, now, id(destinationId, "destinationId"));
  return result.changes;
}

export function dismissDestinationDeliveries(
  database: DatabaseExecutor,
  destinationId: string,
  now: string,
): number {
  const result = database
    .prepare<[string, string, string]>(
      `UPDATE outbound_deliveries
       SET state = 'dismissed', terminal_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           revision = revision + 1, updated_at = ?
       WHERE destination_id = ? AND state IN ('pending', 'retry', 'leased')`,
    )
    .run(now, now, id(destinationId, "destinationId"));
  return result.changes;
}

export function setRetired(database: DatabaseExecutor, destinationId: string, now: string): void {
  const idValue = id(destinationId, "destinationId");
  database
    .prepare<[string, string]>(
      "UPDATE outbound_destinations SET enabled = 0, updated_at = ? WHERE id = ?",
    )
    .run(now, idValue);
  database
    .prepare<[string, string, string, string]>(
      "UPDATE outbound_destination_profiles SET retired_at = coalesce(retired_at, ?), disabled_at = coalesce(disabled_at, ?), disabled_reason = 'retired', updated_at = ?, revision = revision + 1 WHERE destination_id = ?",
    )
    .run(now, now, now, idValue);
  dismissDestinationDeliveries(database, idValue, now);
}

export function recordFailure(
  database: DatabaseExecutor,
  destinationId: string,
  errorCode: string,
  failureClass: OutboundFailureClass,
  now: string,
  expectedRevision?: number,
): boolean {
  const normalizedCode = safeErrorCode(errorCode);
  const state =
    failureClass === "authentication"
      ? "needs_attention"
      : failureClass === "connectivity"
        ? "failing"
        : "unknown";
  const idValue = id(destinationId, "destinationId");
  const result = database
    .prepare<[string, string, string, string, string, string, number | null, number | null]>(
      `UPDATE outbound_destination_profiles
     SET connectivity_state = ?, failure_started_at = coalesce(failure_started_at, ?),
         last_failure_at = ?, last_failure_code = ?, updated_at = ?, revision = revision + 1
     WHERE destination_id = ? AND (? IS NULL OR revision = ?)`,
    )
    .run(
      state,
      now,
      now,
      normalizedCode,
      now,
      idValue,
      expectedRevision ?? null,
      expectedRevision ?? null,
    );
  return result.changes === 1;
}

export function recordSuccess(
  database: DatabaseExecutor,
  destinationId: string,
  now: string,
  expectedRevision?: number,
): boolean {
  const result = database
    .prepare<[string, string, string, number | null, number | null]>(
      `UPDATE outbound_destination_profiles
     SET connectivity_state = 'healthy', failure_started_at = NULL,
         last_failure_at = NULL, last_failure_code = NULL, last_success_at = ?,
         updated_at = ?, revision = revision + 1
     WHERE destination_id = ? AND (? IS NULL OR revision = ?)`,
    )
    .run(
      now,
      now,
      id(destinationId, "destinationId"),
      expectedRevision ?? null,
      expectedRevision ?? null,
    );
  return result.changes === 1;
}

export function markTokenMissing(
  database: DatabaseExecutor,
  destinationId: string,
  now: string,
): void {
  database
    .prepare<[string, string, string, string]>(
      `UPDATE outbound_destination_profiles SET connectivity_state = 'token_missing',
       failure_started_at = coalesce(failure_started_at, ?), last_failure_at = ?,
       last_failure_code = 'token_missing', updated_at = ?, revision = revision + 1
     WHERE destination_id = ?`,
    )
    .run(now, now, now, id(destinationId, "destinationId"));
}

export function projectConnectivity(
  database: DatabaseExecutor,
  now: Date = new Date(),
  missingTokenIds: readonly string[] = [],
): {
  readonly state: "healthy" | "degraded";
  readonly requiredDestinationIds: readonly string[];
  readonly degradedRequiredDestinationIds: readonly string[];
} {
  const missing = new Set(missingTokenIds);
  const rows = listDestinationProfiles(database);
  const required = rows
    .filter(
      (row) =>
        row.required === 1 &&
        row.enabled === 1 &&
        row.retired_at === null &&
        row.disabled_at === null,
    )
    .map((row) => row.id);
  const degraded = rows
    .filter((row) => {
      if (
        row.required !== 1 ||
        row.enabled !== 1 ||
        row.retired_at !== null ||
        row.disabled_at !== null
      )
        return false;
      if (
        missing.has(row.id) ||
        row.connectivity_state === "token_missing" ||
        row.connectivity_state === "needs_attention" ||
        row.connectivity_state === "failing"
      ) {
        const age = failureAge(row, now);
        return age !== undefined && age >= 5 * 60_000;
      }
      return false;
    })
    .map((row) => row.id);
  return {
    state: degraded.length === 0 ? "healthy" : "degraded",
    requiredDestinationIds: required,
    degradedRequiredDestinationIds: degraded,
  };
}

function safeHistoryCode(value: string | null): string | null {
  return value === null ? null : safeErrorCode(value);
}

export function listDeliveryHistory(
  database: DatabaseExecutor,
  destinationId: string,
  limit = MAX_HISTORY,
): readonly OutboundDeliveryHistoryItem[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY)
    invalid("history limit", "must be between 1 and 100");
  return database
    .prepare<
      [string, number],
      {
        readonly id: string;
        readonly event_id: string;
        readonly event_type: EventType;
        readonly destination_id: string;
        readonly destination_version_id: string;
        readonly state: OutboundDeliveryHistoryItem["state"];
        readonly attempt_count: number;
        readonly last_attempt_at: string | null;
        readonly next_attempt_at: string;
        readonly revision: number;
        readonly last_error_code: string | null;
        readonly envelope_bytes: number | null;
        readonly envelope_json: string;
        readonly created_at: string;
        readonly updated_at: string;
        readonly terminal_at: string | null;
      }
    >(
      `SELECT d.id, d.event_id, e.event_type, d.destination_id, d.destination_version_id, d.state,
            d.attempt_count, d.last_attempt_at, d.next_attempt_at, d.revision, d.last_error_code,
            length(CAST(e.envelope_json AS BLOB)) AS envelope_bytes,
            e.envelope_json, d.created_at, d.updated_at, d.terminal_at
     FROM outbound_deliveries d JOIN outbound_events e ON e.id = d.event_id
     WHERE d.destination_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
    )
    .all(id(destinationId, "destinationId"), limit)
    .map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      destinationId: row.destination_id,
      destinationVersionId: row.destination_version_id,
      state: row.state,
      attemptCount: row.attempt_count,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      revision: row.revision,
      lastErrorCode: safeHistoryCode(row.last_error_code),
      envelopeBytes: row.envelope_bytes ?? Buffer.byteLength(row.envelope_json, "utf8"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      terminalAt: row.terminal_at,
    }));
}

export function deliveryBelongsToDestination(
  database: DatabaseExecutor,
  destinationId: string,
  deliveryId: string,
): boolean {
  return (
    database
      .prepare<[string, string], { readonly id: string }>(
        "SELECT id FROM outbound_deliveries WHERE id = ? AND destination_id = ?",
      )
      .get(id(deliveryId, "deliveryId"), id(destinationId, "destinationId")) !== undefined
  );
}

export function readClaimConfiguration(
  database: DatabaseExecutor,
  claim: DeliveryClaim,
  secrets?: readonly OutboundSecretDescriptorLike[],
): DeliveryConfiguration | undefined {
  const profile = readDestinationProfile(database, claim.destinationId);
  if (profile === undefined) return undefined;
  const destination = readDestination(
    database,
    claim.destinationId,
    secrets === undefined ? {} : { secrets },
  );
  if (destination === undefined) return undefined;
  const versionRead = readDestinationVersion(
    database,
    claim.destinationId,
    claim.destinationVersionId,
    secrets,
  );
  if (versionRead === undefined) return undefined;
  return {
    destination,
    version: {
      id: versionRead.id,
      destinationId: versionRead.destinationId,
      versionNumber: versionRead.versionNumber,
      createdAt: versionRead.createdAt,
      config: versionRead.config,
    },
    profileRevision: profile.profile_revision,
  };
}

export function releaseClaim(
  database: DatabaseExecutor,
  claim: DeliveryClaim,
  now: string,
): boolean {
  return (
    database
      .prepare<[string, string, string, string, number]>(
        `UPDATE outbound_deliveries SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
       next_attempt_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND state = 'leased' AND lease_owner = ? AND revision = ?`,
      )
      .run(now, now, claim.deliveryId, claim.leaseOwner, claim.revision).changes === 1
  );
}

export function admitOutboxIntent(
  database: DatabaseExecutor,
  intent: OutboxIntent,
  options: MutateAndAdmitOptions = {},
): QueueResult {
  return mutateAndAdmit(database, () => undefined, intent, options);
}

export {
  applyDeliveryResult,
  claimDue,
  mutateAndAdmit,
  type DeliveryClaim,
  type DeliveryResultInput,
};
