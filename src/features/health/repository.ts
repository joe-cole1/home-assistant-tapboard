import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import {
  HEALTH_CHECK_IDS,
  type HealthCheckId,
  type HealthConfig,
  type HealthConfigOverride,
  type HealthEvidence,
  type HealthIncidentTransition,
  type HealthLeakSample,
  type HealthMaintenanceRecord,
  type HealthMaintenanceType,
  type HealthReason,
  type HealthSeverity,
  type HealthState,
  type LineCleaningDueHealthConfig,
  type LowKegHealthConfig,
  type ScaleAvailabilityHealthConfig,
  type ServingTemperatureHealthConfig,
  type SuspectedLeakHealthConfig,
} from "./types.ts";
import { HEALTH_CONFIG_FIELDS } from "./config.ts";

/**
 * Repository code intentionally owns SQL only.  Callers provide the
 * transaction boundary, allowing health evaluations to participate in the
 * telemetry, tap, and maintenance transactions without nested transactions.
 */

const CONFIG_SECTIONS = [
  ["low_keg", "low_keg", HEALTH_CONFIG_FIELDS.low_keg],
  ["scale_availability", "scale", HEALTH_CONFIG_FIELDS.scale_availability],
  ["suspected_leak", "suspected_leak", HEALTH_CONFIG_FIELDS.suspected_leak],
  ["serving_temperature", "serving_temperature", HEALTH_CONFIG_FIELDS.serving_temperature],
  ["line_cleaning_due", "line_cleaning_due", HEALTH_CONFIG_FIELDS.line_cleaning_due],
] as const satisfies readonly (readonly [HealthCheckId, string, readonly string[]])[];

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function configColumn(section: HealthCheckId, prefix: string, field: string): string {
  if (section === "scale_availability" && field === "enabled") {
    return "scale_availability_enabled";
  }
  return `${prefix}_${snakeCase(field)}`;
}

const CONFIG_COLUMNS = CONFIG_SECTIONS.flatMap(([section, prefix, fields]) =>
  fields.map((field) => configColumn(section, prefix, field)),
);
const CONFIG_SELECT = CONFIG_COLUMNS.join(", ");

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Stored health value ${key} is invalid`);
  }
  return value;
}

function rowBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = rowNumber(row, key);
  if (value !== 0 && value !== 1) throw new Error(`Stored health boolean ${key} is invalid`);
  return value === 1;
}

function rowNullableNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Stored health nullable value ${key} is invalid`);
  }
  return value;
}

function configSectionFromRow<T>(
  row: Record<string, unknown>,
  section: HealthCheckId,
  nullable: boolean,
): T {
  const result: Record<string, boolean | number | null> = {};
  const prefix = CONFIG_SECTIONS.find(([id]) => id === section)?.[1];
  if (prefix === undefined) throw new Error(`Unknown health config section ${section}`);
  for (const field of HEALTH_CONFIG_FIELDS[section]) {
    const key = configColumn(section, prefix, field);
    result[field] = nullable
      ? rowNullableNumberOrBoolean(row, key, field)
      : valueFromRow(row, key, field);
  }
  return result as T;
}

function valueFromRow(row: Record<string, unknown>, key: string, field: string): boolean | number {
  return field === "enabled" ? rowBoolean(row, key) : rowNumber(row, key);
}

function rowNullableNumberOrBoolean(
  row: Record<string, unknown>,
  key: string,
  field: string,
): boolean | number | null {
  const value = row[key];
  if (value === null) return null;
  return field === "enabled" ? rowBoolean(row, key) : rowNullableNumber(row, key);
}

function mapGlobalConfig(row: Record<string, unknown>): HealthGlobalConfig {
  return {
    revision: rowNumber(row, "revision"),
    config: {
      low_keg: configSectionFromRow<LowKegHealthConfig>(row, "low_keg", false),
      scale_availability: configSectionFromRow<ScaleAvailabilityHealthConfig>(
        row,
        "scale_availability",
        false,
      ),
      suspected_leak: configSectionFromRow<SuspectedLeakHealthConfig>(row, "suspected_leak", false),
      serving_temperature: configSectionFromRow<ServingTemperatureHealthConfig>(
        row,
        "serving_temperature",
        false,
      ),
      line_cleaning_due: configSectionFromRow<LineCleaningDueHealthConfig>(
        row,
        "line_cleaning_due",
        false,
      ),
    },
    updatedAt: requireText(row, "updated_at"),
  };
}

function mapOverride(row: Record<string, unknown>): HealthConfigOverride {
  return {
    low_keg: configSectionFromRow<NonNullable<HealthConfigOverride["low_keg"]>>(
      row,
      "low_keg",
      true,
    ),
    scale_availability: configSectionFromRow<
      NonNullable<HealthConfigOverride["scale_availability"]>
    >(row, "scale_availability", true),
    suspected_leak: configSectionFromRow<NonNullable<HealthConfigOverride["suspected_leak"]>>(
      row,
      "suspected_leak",
      true,
    ),
    serving_temperature: configSectionFromRow<
      NonNullable<HealthConfigOverride["serving_temperature"]>
    >(row, "serving_temperature", true),
    line_cleaning_due: configSectionFromRow<NonNullable<HealthConfigOverride["line_cleaning_due"]>>(
      row,
      "line_cleaning_due",
      true,
    ),
  };
}

function requireText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored health text ${key} is invalid`);
  }
  return value;
}

export interface HealthGlobalConfig {
  readonly revision: number;
  readonly config: HealthConfig;
  readonly updatedAt: string;
}

export interface HealthTapOverride {
  readonly tapId: string;
  readonly revision: number;
  readonly override: HealthConfigOverride;
  readonly updatedAt: string;
}

export interface UpdateHealthConfigResult<T> {
  readonly previous: T;
  readonly current: T;
  readonly changed: boolean;
}

export function readHealthGlobalConfig(database: DatabaseExecutor): HealthGlobalConfig {
  const row = database
    .prepare<[], Record<string, unknown>>(
      `SELECT revision, ${CONFIG_SELECT}, updated_at
       FROM health_global_config
       WHERE id = 1`,
    )
    .get();
  if (row === undefined) throw new Error("health_global_config row 1 is missing");
  return mapGlobalConfig(row);
}

const configValues = (config: HealthConfig): unknown[] =>
  CONFIG_SECTIONS.flatMap(([section, , fields]) =>
    fields.map((field) => {
      const value = (config[section] as unknown as Record<string, unknown>)[field];
      return field === "enabled" ? (value === true ? 1 : 0) : value;
    }),
  );

export function updateHealthGlobalConfig(
  database: DatabaseExecutor,
  config: HealthConfig,
  updatedAt: string,
): UpdateHealthConfigResult<HealthGlobalConfig> {
  const previous = readHealthGlobalConfig(database);
  const values = configValues(config);
  const oldValues = configValues(previous.config);
  const changed = values.some((value, index) => value !== oldValues[index]);
  if (!changed) return { previous, current: previous, changed: false };
  database
    .prepare<unknown[]>(
      `UPDATE health_global_config
       SET revision = revision + 1,
           ${CONFIG_COLUMNS.map((column) => `${column} = ?`).join(", ")},
           updated_at = ?
       WHERE id = 1`,
    )
    .run(...values, updatedAt);
  return { previous, current: readHealthGlobalConfig(database), changed: true };
}

export function readHealthTapOverride(
  database: DatabaseExecutor,
  tapId: string,
): HealthTapOverride | undefined {
  const row = database
    .prepare<[string], Record<string, unknown>>(
      `SELECT tap_id, revision, ${CONFIG_SELECT}, updated_at
       FROM health_tap_overrides
       WHERE tap_id = ?`,
    )
    .get(tapId);
  if (row === undefined) return undefined;
  return {
    tapId: requireText(row, "tap_id"),
    revision: rowNumber(row, "revision"),
    override: mapOverride(row),
    updatedAt: requireText(row, "updated_at"),
  };
}

function overrideValues(override: HealthConfigOverride): unknown[] {
  return CONFIG_SECTIONS.flatMap(([section, , fields]) =>
    fields.map((field) => {
      const value = (override[section] as unknown as Record<string, unknown> | null | undefined)?.[
        field
      ];
      return value === undefined || value === null
        ? null
        : field === "enabled"
          ? value === true
            ? 1
            : 0
          : value;
    }),
  );
}

export function upsertHealthTapOverride(
  database: DatabaseExecutor,
  tapId: string,
  override: HealthConfigOverride,
  updatedAt: string,
): UpdateHealthConfigResult<HealthTapOverride | undefined> {
  const previous = readHealthTapOverride(database, tapId);
  const values = overrideValues(override);
  if (!values.some((value) => value !== null)) {
    if (previous === undefined) return { previous, current: previous, changed: false };
    deleteHealthTapOverride(database, tapId);
    return { previous, current: undefined, changed: true };
  }
  const oldValues = previous === undefined ? [] : overrideValues(previous.override);
  const changed =
    previous === undefined || values.some((value, index) => value !== oldValues[index]);
  if (!changed) return { previous, current: previous, changed: false };

  if (previous === undefined) {
    database
      .prepare<unknown[]>(
        `INSERT INTO health_tap_overrides
         (tap_id, revision, ${CONFIG_COLUMNS.join(", ")}, updated_at)
         VALUES (?, 1, ${CONFIG_COLUMNS.map(() => "?").join(", ")}, ?)`,
      )
      .run(tapId, ...values, updatedAt);
  } else {
    database
      .prepare<unknown[]>(
        `UPDATE health_tap_overrides
         SET revision = revision + 1,
             ${CONFIG_COLUMNS.map((column) => `${column} = ?`).join(", ")},
             updated_at = ?
         WHERE tap_id = ?`,
      )
      .run(...values, updatedAt, tapId);
  }
  return { previous, current: readHealthTapOverride(database, tapId), changed: true };
}

export function deleteHealthTapOverride(database: DatabaseExecutor, tapId: string): boolean {
  return (
    database.prepare<[string]>("DELETE FROM health_tap_overrides WHERE tap_id = ?").run(tapId)
      .changes > 0
  );
}

export interface HealthCheckStateRecord {
  readonly tapId: string;
  readonly checkId: HealthCheckId;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason | null;
  readonly evidence: HealthEvidence;
  readonly conditionStartedAtMs: number | null;
  readonly lastObservationAtMs: number | null;
  readonly suppressionUntilMs: number | null;
  readonly cooldownUntilMs: number | null;
  readonly revision: number;
  readonly evaluatedAtMs: number;
  readonly updatedAt: string;
}

interface HealthCheckStateRow extends Record<string, unknown> {
  tap_id: string;
  check_id: HealthCheckId;
  state: HealthState;
  severity: HealthSeverity;
  reason_code: string | null;
  evidence_json: string;
  condition_started_at: string | null;
  last_observation_at: string | null;
  suppression_until: string | null;
  cooldown_until: string | null;
  revision: number;
  evaluated_at: string;
  updated_at: string;
}

function timestampMs(value: string | null, key: string): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Stored health timestamp ${key} is invalid`);
  return parsed;
}

function mapCheckState(row: HealthCheckStateRow): HealthCheckStateRecord {
  const evidence = JSON.parse(row.evidence_json) as HealthEvidence;
  const evaluatedAtMs = timestampMs(row.evaluated_at, "evaluated_at");
  if (evaluatedAtMs === null) throw new Error("Stored health evaluated_at is invalid");
  return {
    tapId: row.tap_id,
    checkId: row.check_id,
    state: row.state,
    severity: row.severity,
    reason: row.reason_code as HealthReason | null,
    evidence,
    conditionStartedAtMs: timestampMs(row.condition_started_at, "condition_started_at"),
    lastObservationAtMs: timestampMs(row.last_observation_at, "last_observation_at"),
    suppressionUntilMs: timestampMs(row.suppression_until, "suppression_until"),
    cooldownUntilMs: timestampMs(row.cooldown_until, "cooldown_until"),
    revision: row.revision,
    evaluatedAtMs,
    updatedAt: row.updated_at,
  };
}

const STATE_COLUMNS =
  "tap_id,check_id,state,severity,reason_code,evidence_json,condition_started_at,last_observation_at,suppression_until,cooldown_until,revision,evaluated_at,updated_at";

export function readHealthCheckState(
  database: DatabaseExecutor,
  tapId: string,
  checkId: HealthCheckId,
): HealthCheckStateRecord | undefined {
  const row = database
    .prepare<[string, HealthCheckId], HealthCheckStateRow>(
      `SELECT ${STATE_COLUMNS} FROM health_check_state WHERE tap_id = ? AND check_id = ?`,
    )
    .get(tapId, checkId);
  return row === undefined ? undefined : mapCheckState(row);
}

export function listHealthCheckStates(
  database: DatabaseExecutor,
  tapId: string,
): HealthCheckStateRecord[] {
  return database
    .prepare<[string], HealthCheckStateRow>(
      `SELECT ${STATE_COLUMNS}
       FROM health_check_state
       WHERE tap_id = ?
       ORDER BY CASE check_id
         WHEN 'low_keg' THEN 1
         WHEN 'scale_availability' THEN 2
         WHEN 'suspected_leak' THEN 3
         WHEN 'serving_temperature' THEN 4
         WHEN 'line_cleaning_due' THEN 5
       END`,
    )
    .all(tapId)
    .map(mapCheckState);
}

export function seedHealthCheckStates(
  database: DatabaseExecutor,
  tapId: string,
  atIso: string,
): void {
  const statement = database.prepare<unknown[]>(
    `INSERT OR IGNORE INTO health_check_state
     (tap_id,check_id,state,severity,evidence_json,revision,evaluated_at,updated_at)
     VALUES (?,?,?,?,'{}',1,?,?)`,
  );
  for (const checkId of HEALTH_CHECK_IDS) {
    statement.run(tapId, checkId, "not_configured", "none", atIso, atIso);
  }
}

/** Idempotent lifecycle hook used when a Tap is created after v11 migration. */
export const ensureHealthCheckStates = seedHealthCheckStates;

export interface WriteHealthCheckState {
  readonly tapId: string;
  readonly checkId: HealthCheckId;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason | null;
  readonly evidence: HealthEvidence;
  readonly conditionStartedAtMs: number | null;
  readonly lastObservationAtMs: number | null;
  readonly suppressionUntilMs: number | null;
  readonly cooldownUntilMs: number | null;
  readonly evaluatedAtMs: number;
  readonly updatedAt: string;
}

function isoOrNull(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function upsertHealthCheckState(
  database: DatabaseExecutor,
  state: WriteHealthCheckState,
): HealthCheckStateRecord {
  const previous = readHealthCheckState(database, state.tapId, state.checkId);
  const evidenceJson = JSON.stringify(state.evidence);
  const semanticChanged =
    previous === undefined ||
    previous.state !== state.state ||
    previous.severity !== state.severity ||
    previous.reason !== state.reason ||
    JSON.stringify(previous.evidence) !== evidenceJson ||
    previous.conditionStartedAtMs !== state.conditionStartedAtMs ||
    previous.lastObservationAtMs !== state.lastObservationAtMs ||
    previous.suppressionUntilMs !== state.suppressionUntilMs;

  if (previous === undefined) {
    database
      .prepare<unknown[]>(
        `INSERT INTO health_check_state
         (${STATE_COLUMNS})
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      )
      .run(
        state.tapId,
        state.checkId,
        state.state,
        state.severity,
        state.reason,
        evidenceJson,
        isoOrNull(state.conditionStartedAtMs),
        isoOrNull(state.lastObservationAtMs),
        isoOrNull(state.suppressionUntilMs),
        isoOrNull(state.cooldownUntilMs),
        new Date(state.evaluatedAtMs).toISOString(),
        state.updatedAt,
      );
  } else if (semanticChanged || previous.cooldownUntilMs !== state.cooldownUntilMs) {
    database
      .prepare<unknown[]>(
        `UPDATE health_check_state
         SET state=?,severity=?,reason_code=?,evidence_json=?,condition_started_at=?,
             last_observation_at=?,suppression_until=?,cooldown_until=?,
             revision=revision+1,evaluated_at=?,updated_at=?
         WHERE tap_id=? AND check_id=?`,
      )
      .run(
        state.state,
        state.severity,
        state.reason,
        evidenceJson,
        isoOrNull(state.conditionStartedAtMs),
        isoOrNull(state.lastObservationAtMs),
        isoOrNull(state.suppressionUntilMs),
        isoOrNull(state.cooldownUntilMs),
        new Date(state.evaluatedAtMs).toISOString(),
        state.updatedAt,
        state.tapId,
        state.checkId,
      );
  } else if (previous.evaluatedAtMs !== state.evaluatedAtMs) {
    database
      .prepare<[string, string, string]>(
        `UPDATE health_check_state
         SET evaluated_at=?
         WHERE tap_id=? AND check_id=?`,
      )
      .run(new Date(state.evaluatedAtMs).toISOString(), state.tapId, state.checkId);
  }
  const current = readHealthCheckState(database, state.tapId, state.checkId);
  if (current === undefined) throw new Error("Health state write did not persist");
  return current;
}

export interface HealthIncidentRecord {
  readonly id: string;
  readonly tapId: string;
  readonly checkId: HealthCheckId;
  readonly openedAtMs: number;
  readonly currentSeverity: "warning" | "critical";
  readonly maxSeverity: "warning" | "critical";
  readonly resolvedAtMs: number | null;
  readonly acknowledgedAtMs: number | null;
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly openReason: HealthReason;
  readonly openEvidence: HealthEvidence;
  readonly resolutionReason: HealthReason | null;
  readonly revision: number;
  readonly updatedAt: string;
}

interface IncidentRow extends Record<string, unknown> {
  id: string;
  tap_id: string;
  check_id: HealthCheckId;
  opened_at: string;
  current_severity: "warning" | "critical";
  max_severity: "warning" | "critical";
  resolved_at: string | null;
  acknowledged_at: string | null;
  by_actor_id: string | null;
  by_session_id: string | null;
  open_reason_code: HealthReason;
  open_evidence_json: string;
  resolution_reason_code: HealthReason | null;
  revision: number;
  updated_at: string;
}

function mapIncident(row: IncidentRow): HealthIncidentRecord {
  const openEvidence = JSON.parse(row.open_evidence_json) as HealthEvidence;
  const openedAtMs = timestampMs(row.opened_at, "opened_at");
  if (openedAtMs === null) throw new Error("Stored health incident opened_at is invalid");
  return {
    id: row.id,
    tapId: row.tap_id,
    checkId: row.check_id,
    openedAtMs,
    currentSeverity: row.current_severity,
    maxSeverity: row.max_severity,
    resolvedAtMs: timestampMs(row.resolved_at, "resolved_at"),
    acknowledgedAtMs: timestampMs(row.acknowledged_at, "acknowledged_at"),
    actorId: row.by_actor_id,
    sessionId: row.by_session_id,
    openReason: row.open_reason_code,
    openEvidence,
    resolutionReason: row.resolution_reason_code,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

const INCIDENT_COLUMNS =
  "id,tap_id,check_id,opened_at,current_severity,max_severity,resolved_at,acknowledged_at,by_actor_id,by_session_id,open_reason_code,open_evidence_json,resolution_reason_code,revision,updated_at";

export function readHealthIncident(
  database: DatabaseExecutor,
  incidentId: string,
): HealthIncidentRecord | undefined {
  const row = database
    .prepare<[string], IncidentRow>(`SELECT ${INCIDENT_COLUMNS} FROM health_incidents WHERE id=?`)
    .get(incidentId);
  return row === undefined ? undefined : mapIncident(row);
}

export function readOpenHealthIncident(
  database: DatabaseExecutor,
  tapId: string,
  checkId: HealthCheckId,
): HealthIncidentRecord | undefined {
  const row = database
    .prepare<[string, HealthCheckId], IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}
       FROM health_incidents
       WHERE tap_id=? AND check_id=? AND resolved_at IS NULL`,
    )
    .get(tapId, checkId);
  return row === undefined ? undefined : mapIncident(row);
}

export const readOpenIncident = readOpenHealthIncident;

export function deleteHealthIncident(database: DatabaseExecutor, incidentId: string): boolean {
  return (
    database.prepare<[string]>("DELETE FROM health_incidents WHERE id=?").run(incidentId).changes >
    0
  );
}

export function listHealthIncidents(
  database: DatabaseExecutor,
  tapId: string,
  limit = 100,
): HealthIncidentRecord[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  return database
    .prepare<[string, number], IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}
       FROM health_incidents
       WHERE tap_id=?
       ORDER BY opened_at DESC,id DESC
       LIMIT ?`,
    )
    .all(tapId, safeLimit)
    .map(mapIncident);
}

export interface HealthIncidentCursor {
  readonly openedAt: string;
  readonly id: string;
}

/** Stable newest-first incident pagination; the extra row is a has-more sentinel. */
export function listHealthIncidentPage(
  database: DatabaseExecutor,
  tapId: string,
  limit = 50,
  cursor?: HealthIncidentCursor,
): HealthIncidentRecord[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  if (cursor === undefined) {
    return database
      .prepare<[string, number], IncidentRow>(
        `SELECT ${INCIDENT_COLUMNS}
         FROM health_incidents
         WHERE tap_id=?
         ORDER BY opened_at DESC,id DESC
         LIMIT ?`,
      )
      .all(tapId, safeLimit + 1)
      .map(mapIncident);
  }
  return database
    .prepare<[string, string, string, string, number], IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}
       FROM health_incidents
       WHERE tap_id=? AND (opened_at < ? OR (opened_at = ? AND id < ?))
       ORDER BY opened_at DESC,id DESC
       LIMIT ?`,
    )
    .all(tapId, cursor.openedAt, cursor.openedAt, cursor.id, safeLimit + 1)
    .map(mapIncident);
}

export function listOpenHealthIncidents(
  database: DatabaseExecutor,
  tapId?: string,
): HealthIncidentRecord[] {
  const rows =
    tapId === undefined
      ? database
          .prepare<[], IncidentRow>(
            `SELECT ${INCIDENT_COLUMNS}
           FROM health_incidents
           WHERE resolved_at IS NULL
           ORDER BY opened_at ASC,id ASC`,
          )
          .all()
      : database
          .prepare<[string], IncidentRow>(
            `SELECT ${INCIDENT_COLUMNS}
           FROM health_incidents
           WHERE tap_id=? AND resolved_at IS NULL
           ORDER BY opened_at ASC,id ASC`,
          )
          .all(tapId);
  return rows.map(mapIncident);
}

export function countOpenHealthIncidents(database: DatabaseExecutor, tapId?: string): number {
  const row =
    tapId === undefined
      ? database
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM health_incidents WHERE resolved_at IS NULL",
          )
          .get()
      : database
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) AS count FROM health_incidents WHERE tap_id=? AND resolved_at IS NULL",
          )
          .get(tapId);
  return row?.count ?? 0;
}

export function insertHealthIncident(
  database: DatabaseExecutor,
  input: {
    readonly id: string;
    readonly tapId: string;
    readonly checkId: HealthCheckId;
    readonly openedAtMs: number;
    readonly severity: "warning" | "critical";
    readonly reason: HealthReason;
    readonly evidence: HealthEvidence;
    readonly updatedAt: string;
  },
): HealthIncidentRecord {
  database
    .prepare<unknown[]>(
      `INSERT INTO health_incidents
       (id,tap_id,check_id,opened_at,current_severity,max_severity,
        open_reason_code,open_evidence_json,revision,updated_at)
       VALUES (?,?,?,?,?,?,?, ?,1,?)`,
    )
    .run(
      input.id,
      input.tapId,
      input.checkId,
      new Date(input.openedAtMs).toISOString(),
      input.severity,
      input.severity,
      input.reason,
      JSON.stringify(input.evidence),
      input.updatedAt,
    );
  const record = readHealthIncident(database, input.id);
  if (record === undefined) throw new Error("Health incident write did not persist");
  return record;
}

export function updateHealthIncidentSeverity(
  database: DatabaseExecutor,
  incidentId: string,
  severity: "warning" | "critical",
  maxSeverity: "warning" | "critical",
  updatedAt: string,
): HealthIncidentRecord | undefined {
  database
    .prepare<[string, string, string, string]>(
      `UPDATE health_incidents
       SET current_severity=?,max_severity=?,revision=revision+1,updated_at=?
       WHERE id=? AND resolved_at IS NULL`,
    )
    .run(severity, maxSeverity, updatedAt, incidentId);
  return readHealthIncident(database, incidentId);
}

export function resolveHealthIncident(
  database: DatabaseExecutor,
  incidentId: string,
  resolvedAtMs: number,
  reason: HealthReason,
  updatedAt: string,
): HealthIncidentRecord | undefined {
  database
    .prepare<unknown[]>(
      `UPDATE health_incidents
       SET resolved_at=?,resolution_reason_code=?,revision=revision+1,updated_at=?
       WHERE id=? AND resolved_at IS NULL`,
    )
    .run(new Date(resolvedAtMs).toISOString(), reason, updatedAt, incidentId);
  return readHealthIncident(database, incidentId);
}

export function acknowledgeHealthIncident(
  database: DatabaseExecutor,
  incidentId: string,
  acknowledgedAtMs: number,
  actorId: string | null,
  sessionId: string,
  updatedAt: string,
): HealthIncidentRecord | undefined {
  database
    .prepare<unknown[]>(
      `UPDATE health_incidents
       SET acknowledged_at=?,by_actor_id=?,by_session_id=?,revision=revision+1,updated_at=?
       WHERE id=? AND resolved_at IS NULL AND acknowledged_at IS NULL`,
    )
    .run(new Date(acknowledgedAtMs).toISOString(), actorId, sessionId, updatedAt, incidentId);
  return readHealthIncident(database, incidentId);
}

export interface HealthIncidentTransitionRecord extends HealthIncidentTransition {
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly createdAtMs: number;
}

interface TransitionRow extends Record<string, unknown> {
  id: string;
  incident_id: string;
  transition_kind: HealthIncidentTransition["transitionKind"];
  state: HealthState | null;
  severity: HealthSeverity | null;
  reason_code: HealthReason | null;
  evidence_json: string;
  actor_id: string | null;
  session_id: string | null;
  occurred_at: string;
  created_at: string;
}

function mapTransition(row: TransitionRow): HealthIncidentTransitionRecord {
  const occurredAtMs = timestampMs(row.occurred_at, "occurred_at");
  const createdAtMs = timestampMs(row.created_at, "created_at");
  if (occurredAtMs === null || createdAtMs === null) {
    throw new Error("Stored health transition timestamp is invalid");
  }
  return {
    id: row.id,
    incidentId: row.incident_id,
    transitionKind: row.transition_kind,
    state: row.state,
    severity: row.severity,
    reason: row.reason_code,
    evidence: JSON.parse(row.evidence_json) as HealthEvidence,
    occurredAtMs,
    actorId: row.actor_id,
    sessionId: row.session_id,
    createdAtMs,
  };
}

export function insertHealthIncidentTransition(
  database: DatabaseExecutor,
  input: {
    readonly id: string;
    readonly incidentId: string;
    readonly transitionKind: HealthIncidentTransition["transitionKind"];
    readonly state: HealthState | null;
    readonly severity: HealthSeverity | null;
    readonly reason: HealthReason | null;
    readonly evidence?: HealthEvidence;
    readonly actorId?: string | null;
    readonly sessionId?: string | null;
    readonly occurredAtMs: number;
    readonly createdAtMs?: number;
  },
): void {
  database
    .prepare<unknown[]>(
      `INSERT INTO health_incident_transitions
       (id,incident_id,transition_kind,state,severity,reason_code,evidence_json,
        actor_id,session_id,occurred_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.id,
      input.incidentId,
      input.transitionKind,
      input.state,
      input.severity,
      input.reason,
      JSON.stringify(input.evidence ?? {}),
      input.actorId ?? null,
      input.sessionId ?? null,
      new Date(input.occurredAtMs).toISOString(),
      new Date(input.createdAtMs ?? input.occurredAtMs).toISOString(),
    );
}

export function listHealthIncidentTransitions(
  database: DatabaseExecutor,
  incidentId: string,
  limit = 200,
): HealthIncidentTransitionRecord[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  return database
    .prepare<[string, number], TransitionRow>(
      `SELECT id,incident_id,transition_kind,state,severity,reason_code,evidence_json,
              actor_id,session_id,occurred_at,created_at
       FROM health_incident_transitions
       WHERE incident_id=?
       ORDER BY occurred_at ASC,id ASC
       LIMIT ?`,
    )
    .all(incidentId, safeLimit)
    .map(mapTransition);
}

export interface HealthLeakSampleRecord {
  readonly tapId: string;
  readonly measurementId: string;
  readonly epochId: string;
  readonly atMs: number;
  readonly volumeMl: number;
  readonly createdAt: string;
}

interface LeakSampleRow {
  tap_id: string;
  measurement_id: string;
  epoch_id: string;
  measured_at_epoch_ms: number;
  stabilized_volume_ml: number;
  created_at: string;
}

function mapLeakSample(row: LeakSampleRow): HealthLeakSampleRecord {
  return {
    tapId: row.tap_id,
    measurementId: row.measurement_id,
    epochId: row.epoch_id,
    atMs: row.measured_at_epoch_ms,
    volumeMl: row.stabilized_volume_ml,
    createdAt: row.created_at,
  };
}

export function listHealthLeakSampleRecords(
  database: DatabaseExecutor,
  tapId: string,
  limit = 64,
): HealthLeakSampleRecord[] {
  const safeLimit = Math.max(1, Math.min(64, Math.trunc(limit)));
  return database
    .prepare<[string, string, number], LeakSampleRow>(
      `SELECT tap_id,measurement_id,epoch_id,measured_at_epoch_ms,stabilized_volume_ml,created_at
       FROM health_leak_samples
       WHERE tap_id=? AND measurement_id IN (
         SELECT measurement_id FROM health_leak_samples
         WHERE tap_id=?
         ORDER BY measured_at_epoch_ms DESC,measurement_id DESC
         LIMIT ?
       )
       ORDER BY measured_at_epoch_ms ASC,measurement_id ASC`,
    )
    .all(tapId, tapId, safeLimit)
    .map(mapLeakSample);
}

export function listHealthLeakSamples(
  database: DatabaseExecutor,
  tapId: string,
  limit = 64,
): HealthLeakSample[] {
  return listHealthLeakSampleRecords(database, tapId, limit).map(({ epochId, atMs, volumeMl }) => ({
    epochId,
    atMs,
    volumeMl,
  }));
}

export function replaceHealthLeakSamples(
  database: DatabaseExecutor,
  tapId: string,
  samples: readonly HealthLeakSampleRecord[],
): void {
  database.prepare<[string]>("DELETE FROM health_leak_samples WHERE tap_id=?").run(tapId);
  const insert = database.prepare<[string, string, string, number, number, string]>(
    `INSERT INTO health_leak_samples
     (tap_id,measurement_id,epoch_id,measured_at_epoch_ms,stabilized_volume_ml,created_at)
     VALUES (?,?,?,?,?,?)`,
  );
  for (const sample of samples.slice(-64)) {
    insert.run(
      tapId,
      sample.measurementId,
      sample.epochId,
      sample.atMs,
      sample.volumeMl,
      sample.createdAt,
    );
  }
}

export function insertHealthLeakSample(
  database: DatabaseExecutor,
  sample: HealthLeakSampleRecord,
): void {
  database
    .prepare<[string, string, string, number, number, string]>(
      `INSERT INTO health_leak_samples
       (tap_id,measurement_id,epoch_id,measured_at_epoch_ms,stabilized_volume_ml,created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      sample.tapId,
      sample.measurementId,
      sample.epochId,
      sample.atMs,
      sample.volumeMl,
      sample.createdAt,
    );
}

export function deleteHealthLeakSample(
  database: DatabaseExecutor,
  tapId: string,
  measurementId: string,
): boolean {
  return (
    database
      .prepare<[string, string]>(
        "DELETE FROM health_leak_samples WHERE tap_id=? AND measurement_id=?",
      )
      .run(tapId, measurementId).changes > 0
  );
}

export function deleteHealthLeakSamplesForEpoch(
  database: DatabaseExecutor,
  tapId: string,
  epochId: string,
): number {
  return database
    .prepare<[string, string]>("DELETE FROM health_leak_samples WHERE tap_id=? AND epoch_id=?")
    .run(tapId, epochId).changes;
}

export function clearHealthLeakSamples(database: DatabaseExecutor, tapId: string): number {
  return database.prepare<[string]>("DELETE FROM health_leak_samples WHERE tap_id=?").run(tapId)
    .changes;
}

export interface HealthMaintenanceRecordWithSession extends HealthMaintenanceRecord {
  readonly sessionId: string | null;
}

interface MaintenanceRow {
  id: string;
  tap_id: string;
  maintenance_type: HealthMaintenanceType;
  performed_at: string;
  notes: string | null;
  actor_type: "admin" | "operator" | "system";
  actor_id: string | null;
  session_id: string | null;
  recorded_at: string;
  resulting_due_at: string | null;
}

function mapMaintenance(row: MaintenanceRow): HealthMaintenanceRecordWithSession {
  const performedAtMs = timestampMs(row.performed_at, "performed_at");
  const recordedAtMs = timestampMs(row.recorded_at, "recorded_at");
  if (performedAtMs === null || recordedAtMs === null) {
    throw new Error("Stored health maintenance timestamp is invalid");
  }
  const dueAtMs = timestampMs(row.resulting_due_at, "resulting_due_at");
  return {
    id: row.id,
    tapId: row.tap_id,
    maintenanceType: row.maintenance_type,
    performedAtMs,
    ...(row.maintenance_type === "line_cleaned" ? { cleanedAtMs: performedAtMs } : {}),
    ...(dueAtMs === null ? {} : { dueAtMs, resultingDueAtMs: dueAtMs }),
    notes: row.notes,
    recordedAtMs,
    actorType: row.actor_type,
    actorId: row.actor_id,
    sessionId: row.session_id,
  };
}

export interface InsertHealthMaintenanceInput {
  readonly id: string;
  readonly tapId: string;
  readonly maintenanceType: HealthMaintenanceType;
  readonly performedAtMs: number;
  readonly notes: string | null;
  readonly actorType: "admin" | "operator" | "system";
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly recordedAtMs: number;
  readonly resultingDueAtMs: number | null;
}

export function insertHealthMaintenance(
  database: DatabaseExecutor,
  input: InsertHealthMaintenanceInput,
): HealthMaintenanceRecordWithSession {
  database
    .prepare<unknown[]>(
      `INSERT INTO tap_line_maintenance_records
       (id,tap_id,maintenance_type,performed_at,notes,actor_type,actor_id,session_id,recorded_at,resulting_due_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.id,
      input.tapId,
      input.maintenanceType,
      new Date(input.performedAtMs).toISOString(),
      input.notes,
      input.actorType,
      input.actorId,
      input.sessionId,
      new Date(input.recordedAtMs).toISOString(),
      input.resultingDueAtMs === null ? null : new Date(input.resultingDueAtMs).toISOString(),
    );
  const record = readHealthMaintenance(database, input.id);
  if (record === undefined) throw new Error("Health maintenance write did not persist");
  return record;
}

export function readHealthMaintenance(
  database: DatabaseExecutor,
  id: string,
): HealthMaintenanceRecordWithSession | undefined {
  const row = database
    .prepare<[string], MaintenanceRow>(
      `SELECT id,tap_id,maintenance_type,performed_at,notes,actor_type,actor_id,session_id,recorded_at,resulting_due_at
       FROM tap_line_maintenance_records
       WHERE id=?`,
    )
    .get(id);
  return row === undefined ? undefined : mapMaintenance(row);
}

export interface HealthMaintenanceCursor {
  readonly performedAt: string;
  readonly id: string;
}

export function listHealthMaintenancePage(
  database: DatabaseExecutor,
  tapId: string,
  limit = 50,
  cursor?: HealthMaintenanceCursor,
): HealthMaintenanceRecordWithSession[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  if (cursor === undefined) {
    return database
      .prepare<[string, number], MaintenanceRow>(
        `SELECT id,tap_id,maintenance_type,performed_at,notes,actor_type,actor_id,session_id,recorded_at,resulting_due_at
         FROM tap_line_maintenance_records
         WHERE tap_id=?
         ORDER BY performed_at DESC,id DESC
         LIMIT ?`,
      )
      .all(tapId, safeLimit + 1)
      .map(mapMaintenance);
  }
  return database
    .prepare<[string, string, string, string, number], MaintenanceRow>(
      `SELECT id,tap_id,maintenance_type,performed_at,notes,actor_type,actor_id,session_id,recorded_at,resulting_due_at
       FROM tap_line_maintenance_records
       WHERE tap_id=? AND (performed_at < ? OR (performed_at = ? AND id < ?))
       ORDER BY performed_at DESC,id DESC
       LIMIT ?`,
    )
    .all(tapId, cursor.performedAt, cursor.performedAt, cursor.id, safeLimit + 1)
    .map(mapMaintenance);
}

export function latestHealthLineCleaning(
  database: DatabaseExecutor,
  tapId: string,
): HealthMaintenanceRecordWithSession | undefined {
  const row = database
    .prepare<[string], MaintenanceRow>(
      `SELECT id,tap_id,maintenance_type,performed_at,notes,actor_type,actor_id,session_id,recorded_at,resulting_due_at
       FROM tap_line_maintenance_records
       WHERE tap_id=? AND maintenance_type='line_cleaned'
       ORDER BY performed_at DESC,id DESC
       LIMIT 1`,
    )
    .get(tapId);
  return row === undefined ? undefined : mapMaintenance(row);
}

export function pruneResolvedHealthIncidents(
  database: DatabaseExecutor,
  resolvedBeforeIso: string,
): number {
  return database
    .prepare<[string]>(
      `DELETE FROM health_incidents
       WHERE id IN (
         SELECT id FROM health_incidents
         WHERE resolved_at IS NOT NULL AND resolved_at < ?
         ORDER BY resolved_at ASC,id ASC
         LIMIT 100
       )`,
    )
    .run(resolvedBeforeIso).changes;
}

export interface HealthTapIdPage {
  readonly ids: readonly string[];
  readonly hasMore: boolean;
}

export function listHealthTapIdPage(
  database: DatabaseExecutor,
  limit = 100,
  cursor?: string,
): HealthTapIdPage {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows =
    cursor === undefined
      ? database
          .prepare<[number], { id: string }>(
            `SELECT id FROM taps ORDER BY tap_number ASC,id ASC LIMIT ?`,
          )
          .all(safeLimit + 1)
      : database
          .prepare<[string, string, string, number], { id: string }>(
            `SELECT t.id
             FROM taps t
             WHERE (t.tap_number > (SELECT tap_number FROM taps WHERE id=?))
                OR (t.tap_number = (SELECT tap_number FROM taps WHERE id=?) AND t.id > ?)
             ORDER BY t.tap_number ASC,t.id ASC
             LIMIT ?`,
          )
          .all(cursor, cursor, cursor, safeLimit + 1);
  return { ids: rows.slice(0, safeLimit).map((row) => row.id), hasMore: rows.length > safeLimit };
}

/** Compatibility aliases for callers that name this operation as a sweep. */
export const listHealthTapIds = listHealthTapIdPage;
export const listHealthEvaluationTapIds = listHealthTapIdPage;
export const deleteResolvedHealthIncidentsOlderThan = pruneResolvedHealthIncidents;
