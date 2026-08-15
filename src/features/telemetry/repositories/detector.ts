import type { DatabaseExecutor } from "../../../infrastructure/database/connection.ts";
import {
  DETECTOR_CONFIG_FIELDS,
  detectorConfigsEqual,
  mergeDetectorConfig,
  type DetectorConfig,
  type DetectorConfigOverride,
} from "../detector-config.ts";
import { waitingDetectorState } from "../detector.ts";
import type {
  CompletedPour,
  CreateCompletedPour,
  CreateTelemetryEpoch,
  DetectorArbitrationGroup,
  DetectorArbitrationMember,
  DetectorGlobalConfig,
  DetectorTapOverride,
  DueDetectorState,
  EffectiveDetectorConfig,
  TelemetryEpoch,
  TelemetryEpochCloseReason,
  TelemetryEpochSample,
  TelemetryEpochState,
} from "../epoch-types.ts";

const columns = DETECTOR_CONFIG_FIELDS.map((f) =>
  f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
);
const configSelect = columns.join(", ");
const configValues = (c: DetectorConfig | DetectorConfigOverride) =>
  DETECTOR_CONFIG_FIELDS.map((f) => c[f]);
const normalizeOverride = (override: DetectorConfigOverride): DetectorConfigOverride =>
  Object.fromEntries(DETECTOR_CONFIG_FIELDS.map((f) => [f, override[f] ?? null]));
const mapConfig = (row: Record<string, unknown>): DetectorConfig =>
  Object.fromEntries(
    DETECTOR_CONFIG_FIELDS.map((f, i) => [f, row[columns[i]!] as number]),
  ) as unknown as DetectorConfig;
const mapOverride = (row: Record<string, unknown>): DetectorConfigOverride =>
  Object.fromEntries(DETECTOR_CONFIG_FIELDS.map((f, i) => [f, row[columns[i]!] as number | null]));

export function readDetectorGlobalConfig(db: DatabaseExecutor): DetectorGlobalConfig {
  const r = db
    .prepare<[], Record<string, unknown>>(
      `SELECT revision, ${configSelect}, updated_at FROM detector_global_config WHERE id=1`,
    )
    .get();
  if (!r) throw new Error("detector_global_config row 1 is missing");
  return {
    revision: r.revision as number,
    config: mapConfig(r),
    updatedAt: r.updated_at as string,
  };
}
export function updateDetectorGlobalConfig(
  db: DatabaseExecutor,
  config: DetectorConfig,
  updatedAt: string,
): DetectorGlobalConfig {
  const current = readDetectorGlobalConfig(db);
  if (detectorConfigsEqual(current.config, config)) return current;
  db.prepare<unknown[]>(
    `UPDATE detector_global_config SET revision=revision+1, ${columns.map((c) => `${c}=?`).join(", ")}, updated_at=? WHERE id=1`,
  ).run(...configValues(config), updatedAt);
  return readDetectorGlobalConfig(db);
}
export function readDetectorTapOverride(
  db: DatabaseExecutor,
  tapId: string,
): DetectorTapOverride | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT tap_id,revision,${configSelect},updated_at FROM detector_tap_overrides WHERE tap_id=?`,
    )
    .get(tapId);
  return !r
    ? undefined
    : {
        tapId: r.tap_id as string,
        revision: r.revision as number,
        override: mapOverride(r),
        updatedAt: r.updated_at as string,
      };
}
export function upsertDetectorTapOverride(
  db: DatabaseExecutor,
  tapId: string,
  override: DetectorConfigOverride,
  updatedAt: string,
): DetectorTapOverride {
  const normalized = normalizeOverride(override),
    old = readDetectorTapOverride(db, tapId);
  if (old && DETECTOR_CONFIG_FIELDS.every((f) => old.override[f] === normalized[f])) return old;
  if (old)
    db.prepare<unknown[]>(
      `UPDATE detector_tap_overrides SET revision=revision+1,${columns.map((c) => `${c}=?`).join(",")},updated_at=? WHERE tap_id=?`,
    ).run(...configValues(normalized), updatedAt, tapId);
  else
    db.prepare<unknown[]>(
      `INSERT INTO detector_tap_overrides (tap_id,revision,${columns.join(",")},updated_at) VALUES (?,1,${columns.map(() => "?").join(",")},?)`,
    ).run(tapId, ...configValues(normalized), updatedAt);
  return readDetectorTapOverride(db, tapId)!;
}
export function removeDetectorTapOverride(db: DatabaseExecutor, tapId: string): boolean {
  return (
    db.prepare<[string]>("DELETE FROM detector_tap_overrides WHERE tap_id=?").run(tapId).changes > 0
  );
}
export function resolveEffectiveDetectorConfig(
  db: DatabaseExecutor,
  tapId: string,
): EffectiveDetectorConfig {
  const global = readDetectorGlobalConfig(db),
    override = readDetectorTapOverride(db, tapId);
  return {
    config: mergeDetectorConfig(global.config, override?.override),
    globalConfigRevision: global.revision,
    tapOverrideRevision: override?.revision ?? null,
  };
}
export function insertDetectorArbitrationGroup(
  db: DatabaseExecutor,
  g: DetectorArbitrationGroup,
): void {
  db.prepare<[string, string, string, string]>(
    "INSERT INTO detector_arbitration_groups (id,name,created_at,updated_at) VALUES (?,?,?,?)",
  ).run(g.id, g.name, g.createdAt, g.updatedAt);
}
export function readDetectorArbitrationGroup(
  db: DatabaseExecutor,
  id: string,
): DetectorArbitrationGroup | undefined {
  const r = db
    .prepare<[string], { id: string; name: string; created_at: string; updated_at: string }>(
      "SELECT id,name,created_at,updated_at FROM detector_arbitration_groups WHERE id=?",
    )
    .get(id);
  return r && { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
}
export function listDetectorArbitrationGroups(db: DatabaseExecutor): DetectorArbitrationGroup[] {
  return db
    .prepare<[], { id: string; name: string; created_at: string; updated_at: string }>(
      "SELECT id,name,created_at,updated_at FROM detector_arbitration_groups ORDER BY name COLLATE NOCASE,id",
    )
    .all()
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at }));
}
export function updateDetectorArbitrationGroupName(
  db: DatabaseExecutor,
  id: string,
  name: string,
  updatedAt: string,
): boolean {
  return (
    db
      .prepare<[string, string, string]>(
        "UPDATE detector_arbitration_groups SET name=?,updated_at=? WHERE id=?",
      )
      .run(name, updatedAt, id).changes > 0
  );
}
export function readDetectorArbitrationMembership(
  db: DatabaseExecutor,
  tapId: string,
): DetectorArbitrationMember | undefined {
  const r = db
    .prepare<[string], { tap_id: string; group_id: string; joined_at: string }>(
      "SELECT tap_id,group_id,joined_at FROM detector_arbitration_members WHERE tap_id=?",
    )
    .get(tapId);
  return r && { tapId: r.tap_id, groupId: r.group_id, joinedAt: r.joined_at };
}
export function listDetectorArbitrationMembers(
  db: DatabaseExecutor,
  groupId: string,
): DetectorArbitrationMember[] {
  return db
    .prepare<[string], { tap_id: string; group_id: string; joined_at: string }>(
      "SELECT tap_id,group_id,joined_at FROM detector_arbitration_members WHERE group_id=? ORDER BY tap_id",
    )
    .all(groupId)
    .map((r) => ({ tapId: r.tap_id, groupId: r.group_id, joinedAt: r.joined_at }));
}
/** The only repository-owned transaction: replacement must be atomic to preserve a tap's single explicit membership. */
export function replaceDetectorArbitrationMembership(
  db: DatabaseExecutor,
  groupId: string,
  tapIds: readonly string[],
  joinedAt: string,
): { previousTapIds: readonly string[]; currentTapIds: readonly string[] } {
  return db.withTransaction(() => {
    const previousTapIds = listDetectorArbitrationMembers(db, groupId).map((x) => x.tapId);
    db.prepare<[string]>("DELETE FROM detector_arbitration_members WHERE group_id=?").run(groupId);
    const s = db.prepare<[string, string, string]>(
      "INSERT INTO detector_arbitration_members (tap_id,group_id,joined_at) VALUES (?,?,?)",
    );
    for (const id of tapIds) s.run(id, groupId, joinedAt);
    return { previousTapIds, currentTapIds: [...tapIds] };
  });
}
function epoch(r: Record<string, unknown>): TelemetryEpoch {
  return {
    id: r.id as string,
    tapId: r.tap_id as string,
    sourceId: r.source_id as string | null,
    fillId: r.fill_id as string,
    assignmentId: r.assignment_id as string,
    kegId: r.keg_id as string,
    capacityMl: r.capacity_ml as number,
    tareG: r.tare_g as number,
    densityGPerMl: r.density_g_per_ml as number,
    densitySource: r.density_source as TelemetryEpoch["densitySource"],
    normalizationVersion: r.normalization_version as number,
    detectorConfigVersion: r.detector_config_version as string,
    globalConfigRevision: r.global_config_revision as number,
    tapOverrideRevision: r.tap_override_revision as number | null,
    arbitrationGroupId: r.arbitration_group_id as string | null,
    config: mapConfig(r),
    startedAt: r.started_at as string,
    startedAtEpochMs: r.started_at_epoch_ms as number,
    endedAt: r.ended_at as string | null,
    endedAtEpochMs: r.ended_at_epoch_ms as number | null,
    closeReason: r.close_reason as TelemetryEpochCloseReason | null,
  };
}
const epochCols =
  "id,tap_id,source_id,fill_id,assignment_id,keg_id,capacity_ml,tare_g,density_g_per_ml,density_source,normalization_version,detector_config_version,global_config_revision,tap_override_revision,arbitration_group_id," +
  configSelect +
  ",started_at,started_at_epoch_ms,ended_at,ended_at_epoch_ms,close_reason";
export function insertTelemetryEpoch(db: DatabaseExecutor, e: CreateTelemetryEpoch): void {
  db.prepare<unknown[]>(
    `INSERT INTO telemetry_epochs (${epochCols}) VALUES (${epochCols
      .split(",")
      .map(() => "?")
      .join(",")})`,
  ).run(
    e.id,
    e.tapId,
    e.sourceId,
    e.fillId,
    e.assignmentId,
    e.kegId,
    e.capacityMl,
    e.tareG,
    e.densityGPerMl,
    e.densitySource,
    e.normalizationVersion,
    e.detectorConfigVersion,
    e.globalConfigRevision,
    e.tapOverrideRevision,
    e.arbitrationGroupId,
    ...configValues(e.config),
    e.startedAt,
    e.startedAtEpochMs,
    null,
    null,
    null,
  );
}
export function readTelemetryEpoch(db: DatabaseExecutor, id: string): TelemetryEpoch | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${epochCols} FROM telemetry_epochs WHERE id=?`,
    )
    .get(id);
  return r && epoch(r);
}
export function readOpenTelemetryEpochForTap(
  db: DatabaseExecutor,
  tapId: string,
): TelemetryEpoch | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${epochCols} FROM telemetry_epochs WHERE tap_id=? AND ended_at IS NULL`,
    )
    .get(tapId);
  return r && epoch(r);
}
export function listOpenTelemetryEpochs(db: DatabaseExecutor): TelemetryEpoch[] {
  return db
    .prepare<[], Record<string, unknown>>(
      `SELECT ${epochCols} FROM telemetry_epochs WHERE ended_at IS NULL ORDER BY started_at_epoch_ms,id`,
    )
    .all()
    .map(epoch);
}
export function listOpenTelemetryEpochsForFill(
  db: DatabaseExecutor,
  fillId: string,
): TelemetryEpoch[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${epochCols} FROM telemetry_epochs WHERE fill_id=? AND ended_at IS NULL ORDER BY started_at_epoch_ms,id`,
    )
    .all(fillId)
    .map(epoch);
}
export function listTelemetryEpochsForFill(db: DatabaseExecutor, fillId: string): TelemetryEpoch[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${epochCols} FROM telemetry_epochs WHERE fill_id=? ORDER BY started_at_epoch_ms,id`,
    )
    .all(fillId)
    .map(epoch);
}
export function listOpenTelemetryEpochsForKeg(
  db: DatabaseExecutor,
  kegId: string,
): TelemetryEpoch[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${epochCols} FROM telemetry_epochs WHERE keg_id=? AND ended_at IS NULL ORDER BY started_at_epoch_ms,id`,
    )
    .all(kegId)
    .map(epoch);
}
export function listOpenTelemetryEpochsForBeverage(
  db: DatabaseExecutor,
  beverageId: string,
): TelemetryEpoch[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `SELECT e.${epochCols.split(",").join(",e.")} FROM telemetry_epochs e JOIN fills f ON f.id=e.fill_id WHERE f.beverage_id=? AND e.ended_at IS NULL ORDER BY e.started_at_epoch_ms,e.id`,
    )
    .all(beverageId)
    .map(epoch);
}
export function closeTelemetryEpoch(
  db: DatabaseExecutor,
  id: string,
  endedAt: string,
  endedAtEpochMs: number,
  reason: TelemetryEpochCloseReason,
): boolean {
  return (
    db
      .prepare<[string, number, TelemetryEpochCloseReason, string]>(
        "UPDATE telemetry_epochs SET ended_at=?,ended_at_epoch_ms=?,close_reason=? WHERE id=? AND ended_at IS NULL",
      )
      .run(endedAt, endedAtEpochMs, reason, id).changes > 0
  );
}
function state(r: Record<string, unknown>): TelemetryEpochState {
  return {
    ...waitingDetectorState(),
    epochId: r.epoch_id as string,
    phase: r.phase as TelemetryEpochState["phase"],
    baselineVolumeMl: r.baseline_volume_ml as number | null,
    baselineAtMs: r.baseline_at_epoch_ms as number | null,
    lastMeasuredAtMs: r.last_measured_at_epoch_ms as number | null,
    lastInterpretedVolumeMl: r.last_interpreted_volume_ml as number | null,
    lastStabilizedVolumeMl: r.last_stabilized_volume_ml as number | null,
    candidateSessionId: r.candidate_session_id as string | null,
    candidateStartedAtMs: r.candidate_started_at_epoch_ms as number | null,
    candidateBaselineVolumeMl: r.candidate_baseline_volume_ml as number | null,
    candidateLossMl: r.candidate_loss_ml as number | null,
    arbitrationDeadlineMs: r.arbitration_deadline_epoch_ms as number | null,
    lowestFlowVolumeMl: r.lowest_flow_volume_ml as number | null,
    lastMeaningfulFlowAtMs: r.last_meaningful_flow_at_epoch_ms as number | null,
    quietSinceMs: r.quiet_since_epoch_ms as number | null,
    timeoutAtMs: r.timeout_at_epoch_ms as number | null,
    cooldownUntilMs: r.cooldown_until_epoch_ms as number | null,
    warningCode: r.warning_code as "implausible_jump" | null,
    warningActivityFlag: r.warning_activity_flag === 1,
    warningStartedAtMs: r.warning_started_at_epoch_ms as number | null,
    warningReferenceVolumeMl: r.warning_reference_volume_ml as number | null,
    lastCancellationReason:
      r.last_cancellation_reason as TelemetryEpochState["lastCancellationReason"],
    lastMeasurementId: r.last_measurement_id as string | null,
    lastPrimaryKind: r.last_primary_kind as TelemetryEpochState["lastPrimaryKind"],
    lastPrimaryValue: r.last_primary_value as number | null,
    lastTemperatureC: r.last_temperature_c as number | null,
    lastPublicVolumeMl: r.last_public_volume_ml as number | null,
    lastDiagnosticCode: r.last_diagnostic_code as TelemetryEpochState["lastDiagnosticCode"],
    updatedAt: r.updated_at as string,
  };
}
const stateCols =
  "epoch_id,phase,baseline_volume_ml,baseline_at_epoch_ms,last_measurement_id,last_measured_at_epoch_ms,last_primary_kind,last_primary_value,last_temperature_c,last_interpreted_volume_ml,last_stabilized_volume_ml,last_public_volume_ml,last_diagnostic_code,candidate_session_id,candidate_started_at_epoch_ms,candidate_baseline_volume_ml,candidate_loss_ml,arbitration_deadline_epoch_ms,lowest_flow_volume_ml,last_meaningful_flow_at_epoch_ms,quiet_since_epoch_ms,timeout_at_epoch_ms,cooldown_until_epoch_ms,warning_code,warning_activity_flag,warning_started_at_epoch_ms,warning_reference_volume_ml,last_cancellation_reason,updated_at";
const stateValues = (s: TelemetryEpochState): unknown[] => [
  s.epochId,
  s.phase,
  s.baselineVolumeMl,
  s.baselineAtMs,
  s.lastMeasurementId,
  s.lastMeasuredAtMs,
  s.lastPrimaryKind,
  s.lastPrimaryValue,
  s.lastTemperatureC,
  s.lastInterpretedVolumeMl,
  s.lastStabilizedVolumeMl,
  s.lastPublicVolumeMl,
  s.lastDiagnosticCode,
  s.candidateSessionId,
  s.candidateStartedAtMs,
  s.candidateBaselineVolumeMl,
  s.candidateLossMl,
  s.arbitrationDeadlineMs,
  s.lowestFlowVolumeMl,
  s.lastMeaningfulFlowAtMs,
  s.quietSinceMs,
  s.timeoutAtMs,
  s.cooldownUntilMs,
  s.warningCode,
  s.warningActivityFlag ? 1 : 0,
  s.warningStartedAtMs,
  s.warningReferenceVolumeMl,
  s.lastCancellationReason,
  s.updatedAt,
];
export function createInitialTelemetryEpochState(
  db: DatabaseExecutor,
  epochId: string,
  updatedAt: string,
): void {
  const s = {
    ...waitingDetectorState(),
    epochId,
    lastMeasurementId: null,
    lastPrimaryKind: null,
    lastPrimaryValue: null,
    lastTemperatureC: null,
    lastPublicVolumeMl: null,
    lastDiagnosticCode: null,
    updatedAt,
  };
  db.prepare<unknown[]>(
    `INSERT INTO telemetry_epoch_state (${stateCols}) VALUES (${stateCols
      .split(",")
      .map(() => "?")
      .join(",")})`,
  ).run(...stateValues(s));
}
export function readTelemetryEpochState(
  db: DatabaseExecutor,
  epochId: string,
): TelemetryEpochState | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${stateCols} FROM telemetry_epoch_state WHERE epoch_id=?`,
    )
    .get(epochId);
  return r && state(r);
}
/**
 * Forecasting reads the detector's internal state rather than the public,
 * presentation-clamped volume. An open Fill can have at most one active
 * assignment/epoch, so the newest started epoch is the current one.
 */
export function readOpenTelemetryEpochStateForFill(
  db: DatabaseExecutor,
  fillId: string,
): { readonly epoch: TelemetryEpoch; readonly state: TelemetryEpochState } | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT e.${epochCols.split(",").join(",e.")},s.${stateCols.split(",").join(",s.")}
       FROM telemetry_epochs e
       JOIN telemetry_epoch_state s ON s.epoch_id=e.id
       WHERE e.fill_id=? AND e.ended_at IS NULL
       ORDER BY e.started_at_epoch_ms DESC,e.id DESC
       LIMIT 1`,
    )
    .get(fillId);
  return r === undefined ? undefined : { epoch: epoch(r), state: state(r) };
}
export function updateTelemetryEpochState(db: DatabaseExecutor, s: TelemetryEpochState): boolean {
  return (
    db
      .prepare<unknown[]>(
        `UPDATE telemetry_epoch_state SET ${stateCols
          .split(",")
          .slice(1)
          .map((c) => `${c}=?`)
          .join(",")} WHERE epoch_id=?`,
      )
      .run(...stateValues(s).slice(1), s.epochId).changes > 0
  );
}
export function insertTelemetryEpochSample(db: DatabaseExecutor, s: TelemetryEpochSample): void {
  db.prepare<[string, string, number, number]>(
    "INSERT INTO telemetry_epoch_samples (epoch_id,measurement_id,measured_at_epoch_ms,interpreted_volume_ml) VALUES (?,?,?,?)",
  ).run(s.epochId, s.measurementId, s.measuredAtEpochMs, s.interpretedVolumeMl);
}
export function listTelemetryEpochSamples(
  db: DatabaseExecutor,
  epochId: string,
): TelemetryEpochSample[] {
  return db
    .prepare<
      [string],
      {
        epoch_id: string;
        measurement_id: string;
        measured_at_epoch_ms: number;
        interpreted_volume_ml: number;
      }
    >(
      "SELECT epoch_id,measurement_id,measured_at_epoch_ms,interpreted_volume_ml FROM telemetry_epoch_samples WHERE epoch_id=? ORDER BY measured_at_epoch_ms",
    )
    .all(epochId)
    .map((r) => ({
      epochId: r.epoch_id,
      measurementId: r.measurement_id,
      measuredAtEpochMs: r.measured_at_epoch_ms,
      interpretedVolumeMl: r.interpreted_volume_ml,
    }));
}
export function pruneTelemetryEpochSamples(
  db: DatabaseExecutor,
  epochId: string,
  beforeMs: number,
  limit = 500,
): number {
  return db
    .prepare<[string, number, number]>(
      "DELETE FROM telemetry_epoch_samples WHERE rowid IN (SELECT rowid FROM telemetry_epoch_samples WHERE epoch_id=? AND measured_at_epoch_ms<? ORDER BY measured_at_epoch_ms LIMIT ?)",
    )
    .run(epochId, beforeMs, limit).changes;
}
const due = (r: Record<string, unknown>): DueDetectorState => {
  const e = epoch(r);
  return {
    epoch: e,
    state: { ...state(r), tapId: e.tapId },
    group:
      r.group_id_joined === null
        ? null
        : {
            id: r.group_id_joined as string,
            name: r.group_name as string,
            createdAt: r.group_created_at as string,
            updatedAt: r.group_updated_at as string,
          },
  };
};
const dueSelect = `SELECT e.${epochCols.split(",").join(",e.")},s.${stateCols.split(",").join(",s.")},g.id AS group_id_joined,g.name AS group_name,g.created_at AS group_created_at,g.updated_at AS group_updated_at FROM telemetry_epochs e JOIN telemetry_epoch_state s ON s.epoch_id=e.id LEFT JOIN detector_arbitration_groups g ON g.id=e.arbitration_group_id`;
export function listDueDetectorStates(db: DatabaseExecutor, nowMs: number): DueDetectorState[] {
  return db
    .prepare<[number, number, number], Record<string, unknown>>(
      `${dueSelect} WHERE e.ended_at IS NULL AND ((s.phase='candidate' AND s.arbitration_deadline_epoch_ms IS NOT NULL AND s.arbitration_deadline_epoch_ms<=?) OR (s.phase='pouring' AND ((s.timeout_at_epoch_ms IS NOT NULL AND s.timeout_at_epoch_ms<=?) OR (s.last_meaningful_flow_at_epoch_ms IS NOT NULL AND s.last_meaningful_flow_at_epoch_ms+e.quiet_period_ms<=?)))) ORDER BY CASE s.phase WHEN 'candidate' THEN s.arbitration_deadline_epoch_ms WHEN 'pouring' THEN CASE WHEN s.timeout_at_epoch_ms IS NULL THEN s.last_meaningful_flow_at_epoch_ms+e.quiet_period_ms WHEN s.last_meaningful_flow_at_epoch_ms IS NULL OR s.timeout_at_epoch_ms<=s.last_meaningful_flow_at_epoch_ms+e.quiet_period_ms THEN s.timeout_at_epoch_ms ELSE s.last_meaningful_flow_at_epoch_ms+e.quiet_period_ms END END,CASE WHEN s.phase='pouring' THEN 0 ELSE 1 END,e.id COLLATE BINARY LIMIT 500`,
    )
    .all(nowMs, nowMs, nowMs)
    .map(due);
}
export function listOpenCandidateDetectorStatesForGroup(
  db: DatabaseExecutor,
  groupId: string,
): DueDetectorState[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `${dueSelect} WHERE e.ended_at IS NULL AND e.arbitration_group_id=? AND s.phase='candidate' ORDER BY e.started_at_epoch_ms,e.id`,
    )
    .all(groupId)
    .map(due);
}
export function listOpenPouringDetectorStatesForGroup(
  db: DatabaseExecutor,
  groupId: string,
): DueDetectorState[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `${dueSelect} WHERE e.ended_at IS NULL AND e.arbitration_group_id=? AND s.phase='pouring' ORDER BY e.started_at_epoch_ms,e.id`,
    )
    .all(groupId)
    .map(due);
}
function pour(r: Record<string, unknown>): CompletedPour {
  return {
    id: r.id as string,
    effectKey: r.effect_key as string,
    fillId: r.fill_id as string,
    tapId: r.tap_id as string,
    assignmentId: r.assignment_id as string,
    epochId: r.epoch_id as string,
    detectorSessionId: r.detector_session_id as string,
    canonicalVolumeMl: r.canonical_volume_ml as number,
    startedAt: r.started_at as string,
    completedAt: r.completed_at as string,
    createdAt: r.created_at as string,
  };
}
const pourCols =
  "id,effect_key,fill_id,tap_id,assignment_id,epoch_id,detector_session_id,canonical_volume_ml,started_at,completed_at,created_at";
export function insertCompletedPourIdempotently(
  db: DatabaseExecutor,
  p: CreateCompletedPour,
): { pour: CompletedPour; created: boolean } {
  const old = readCompletedPourByEffectKey(db, p.effectKey);
  if (old) return { pour: old, created: false };
  try {
    db.prepare<unknown[]>(
      `INSERT INTO pours (${pourCols}) VALUES (${pourCols
        .split(",")
        .map(() => "?")
        .join(",")})`,
    ).run(
      p.id,
      p.effectKey,
      p.fillId,
      p.tapId,
      p.assignmentId,
      p.epochId,
      p.detectorSessionId,
      p.canonicalVolumeMl,
      p.startedAt,
      p.completedAt,
      p.createdAt,
    );
    return { pour: p, created: true };
  } catch (error) {
    const existing = readCompletedPourByEffectKey(db, p.effectKey);
    if (existing) return { pour: existing, created: false };
    throw error;
  }
}
export function readCompletedPourByEffectKey(
  db: DatabaseExecutor,
  key: string,
): CompletedPour | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(`SELECT ${pourCols} FROM pours WHERE effect_key=?`)
    .get(key);
  return r && pour(r);
}
export function readCompletedPourByEpochSession(
  db: DatabaseExecutor,
  epochId: string,
  detectorSessionId: string,
): CompletedPour | undefined {
  const r = db
    .prepare<[string, string], Record<string, unknown>>(
      `SELECT ${pourCols} FROM pours WHERE epoch_id=? AND detector_session_id=?`,
    )
    .get(epochId, detectorSessionId);
  return r && pour(r);
}

/**
 * Return the newest completed pour for one detector epoch.  Health consumes
 * this narrow projection so it never has to inspect raw pour history (or
 * identify a telemetry source) while deciding whether leak detection should
 * be suppressed.
 */
export function readLatestCompletedPourForEpoch(
  db: DatabaseExecutor,
  epochId: string,
): CompletedPour | undefined {
  const r = db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${pourCols}
       FROM pours
       WHERE epoch_id=?
       ORDER BY completed_at DESC,id DESC
       LIMIT 1`,
    )
    .get(epochId);
  return r && pour(r);
}
export function listCompletedPoursForFill(db: DatabaseExecutor, fillId: string): CompletedPour[] {
  return db
    .prepare<[string], Record<string, unknown>>(
      `SELECT ${pourCols} FROM pours WHERE fill_id=? ORDER BY completed_at,id`,
    )
    .all(fillId)
    .map(pour);
}

export interface CompletedPourHistoryCursor {
  readonly completedAt: string;
  readonly id: string;
}

/**
 * Return an opaque-page candidate set for one Fill only. The extra row lets
 * the application construct a next cursor without a second count query.
 * Forecast calculations must use listCompletedPoursForFill instead.
 */
export function listCompletedPourHistoryPageForFill(
  db: DatabaseExecutor,
  fillId: string,
  limit: number,
  cursor?: CompletedPourHistoryCursor,
): CompletedPour[] {
  if (cursor === undefined) {
    return db
      .prepare<[string, number], Record<string, unknown>>(
        `SELECT ${pourCols} FROM pours
         WHERE fill_id=?
         ORDER BY completed_at DESC,id DESC
         LIMIT ?`,
      )
      .all(fillId, limit + 1)
      .map(pour);
  }
  return db
    .prepare<[string, string, string, string, number], Record<string, unknown>>(
      `SELECT ${pourCols} FROM pours
       WHERE fill_id=?
         AND (completed_at<? OR (completed_at=? AND id<?))
       ORDER BY completed_at DESC,id DESC
       LIMIT ?`,
    )
    .all(fillId, cursor.completedAt, cursor.completedAt, cursor.id, limit + 1)
    .map(pour);
}
export function countCompletedPoursForFill(db: DatabaseExecutor, fillId: string): number {
  return (
    db
      .prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM pours WHERE fill_id=?")
      .get(fillId)?.count ?? 0
  );
}
