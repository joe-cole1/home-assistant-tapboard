import { createHash, randomUUID } from "node:crypto";

import {
  assertSynchronousCompletion,
  type DatabaseExecutor,
} from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import { appendActivity } from "../activity/operations.ts";
import { findTapById, listTaps, registerTapFirstUse } from "../taps/repository.ts";
import { validateTapId } from "../taps/tap-validation.ts";
import type {
  AssignmentClosedContext,
  AssignmentOpenedContext,
  Tap,
  TapAssignmentExtensionPort,
} from "../taps/types.ts";
import { readSourceTapStatus, readTapTelemetryAuthority } from "../telemetry/repository.ts";
import type {
  AcceptedSampleEvent,
  AcceptedTelemetryExtensionPort,
  AuthorityChangedEvent,
  TelemetryAuthorityExtensionPort,
} from "../telemetry/types.ts";
import {
  listOpenTelemetryEpochsForBeverage,
  listOpenTelemetryEpochsForKeg,
  readLatestCompletedPourForEpoch,
  readOpenTelemetryEpochForTap,
  readTelemetryEpochState,
} from "../telemetry/repositories/detector.ts";
import type { KegCorrectionEvent } from "../kegs/types.ts";
import type { EffectiveDensityChangedEvent } from "../beverages/types.ts";
import {
  DEFAULT_HEALTH_CONFIG,
  HEALTH_CONFIG_FIELDS,
  calculateLineCleaningDue,
  resolveHealthConfig,
} from "./config.ts";
import { evaluateHealthCheck } from "./engine.ts";
import { validateHealthConfig } from "./health-validation.ts";
import {
  acknowledgeHealthIncident,
  deleteHealthTapOverride,
  insertHealthIncident,
  insertHealthIncidentTransition,
  insertHealthMaintenance,
  latestHealthLineCleaning,
  listHealthCheckStates,
  listHealthIncidentPage,
  listHealthIncidentTransitions,
  listHealthIncidents,
  listHealthLeakSampleRecords,
  listHealthMaintenancePage,
  listHealthTapOverrides,
  listHealthTapIdPage,
  pruneResolvedHealthIncidents,
  readHealthCheckState,
  readHealthGlobalConfig,
  readHealthIncident,
  readHealthMaintenance,
  readOpenHealthIncident,
  readHealthTapOverride,
  replaceHealthLeakSamples,
  resolveHealthIncident,
  seedHealthCheckStates,
  updateHealthIncidentSeverity,
  updateHealthGlobalConfig,
  upsertHealthCheckState,
  upsertHealthTapOverride,
  type HealthCheckStateRecord,
  type HealthGlobalConfig,
  type HealthIncidentRecord,
  type HealthIncidentTransitionRecord,
  type HealthLeakSampleRecord,
  type HealthMaintenanceCursor,
  type HealthMaintenanceRecordWithSession,
} from "./repository.ts";
import {
  toAdminHealthDetail,
  toAdminHealthIncidentPage,
  toAdminHealthMaintenancePage,
  toAdminHealthOverview,
  toHealthTargetedUpdate,
  type AdminHealthDetailProjection,
  type AdminHealthIncidentPageProjection,
  type AdminHealthMaintenancePageProjection,
  type AdminHealthOverviewProjection,
  type HealthProjectionContext,
  type HealthTargetedUpdateProjection,
} from "./projections.ts";
import {
  HEALTH_CHECK_IDS,
  type HealthAuthoritativeMeasurement,
  type HealthCheckId,
  type HealthConfig,
  type HealthConfigOverride,
  type HealthCurrentEpochEvidence,
  type HealthEvaluation,
  type HealthEvaluationInput,
  type HealthEvaluationTimers,
  type HealthMaintenanceType,
} from "./types.ts";

const MAX_SWEEP_TAPS = 100;
const MAX_COOLDOWN_MS = 30 * 86_400_000;
const INCIDENT_RETENTION_MS = 365 * 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HealthActorOptions {
  readonly actorType?: "admin" | "operator" | "system";
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
}

export interface HealthServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly sweepIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly onIncidentOpened?: (db: DatabaseExecutor, incident: HealthIncidentRecord) => void;
  readonly onMaintenanceRecorded?: (
    db: DatabaseExecutor,
    record: HealthMaintenanceRecordWithSession,
  ) => void;
  readonly onTargetedUpdate?: (update: HealthTargetedUpdateProjection) => void;
  /** Transaction-local notification for semantic health state/severity changes. */
  readonly onHealthTransition?: (
    database: DatabaseExecutor,
    context: {
      readonly tapId: string;
      readonly checkId: HealthCheckId;
      readonly previousState: string | null;
      readonly previousSeverity: string | null;
      readonly current: {
        readonly state: string;
        readonly severity: string;
        readonly evidence: unknown;
        readonly reason: string | null;
      };
      readonly occurredAt: string;
    },
  ) => void;
}

export interface HealthEvaluationResult {
  readonly tapId: string;
  readonly checks: readonly HealthEvaluation[];
  readonly changedCheckIds: readonly HealthCheckId[];
}

export interface HealthMaintenanceHistoryPage {
  readonly records: readonly HealthMaintenanceRecordWithSession[];
  readonly nextCursor: HealthMaintenanceCursor | null;
}

export interface HealthIncidentHistoryPage {
  readonly incidents: readonly HealthIncidentRecord[];
  readonly nextCursor: { readonly openedAt: string; readonly id: string } | null;
}

function invalid(field: string, reason: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

function notFound(code: string, field: string, value: string): never {
  throw new ApplicationError({
    category: "not_found",
    code,
    clientMessage: "The requested health resource was not found.",
    details: { [field]: value },
  });
}

function conflict(code: string, details: Record<string, string | number | boolean | null>): never {
  throw new ApplicationError({
    category: "conflict",
    code,
    clientMessage: "The requested health operation conflicts with the current state.",
    details,
  });
}

function clock(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Invalid health clock");
  }
  return new Date(value.getTime());
}

function asMs(value: Date | string | number, field: string, exactString = false): number {
  const parsed =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(field, "must be a valid timestamp");
  if (exactString && typeof value === "string" && new Date(parsed).toISOString() !== value) {
    invalid(field, "must be an exact canonical UTC timestamp");
  }
  return parsed;
}

function iso(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Invalid health timestamp");
  return new Date(value).toISOString();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function cloneConfig(config: HealthConfig): HealthConfig {
  return {
    low_keg: { ...config.low_keg },
    scale_availability: { ...config.scale_availability },
    suspected_leak: { ...config.suspected_leak },
    serving_temperature: { ...config.serving_temperature },
    line_cleaning_due: { ...config.line_cleaning_due },
  };
}

function parseGlobalPatch(input: unknown, current: HealthConfig): HealthConfig {
  const body = requirePlainObject(input, "healthConfig");
  rejectUnknownKeys(body, HEALTH_CHECK_IDS, "healthConfig");
  const candidate = cloneConfig(current) as unknown as Record<string, Record<string, unknown>>;
  for (const checkId of HEALTH_CHECK_IDS) {
    if (!Object.hasOwn(body, checkId)) continue;
    const section = body[checkId];
    if (!isPlainRecord(section)) invalid(checkId, "must be a plain object");
    rejectUnknownKeys(section, HEALTH_CONFIG_FIELDS[checkId], checkId);
    for (const field of HEALTH_CONFIG_FIELDS[checkId]) {
      if (!Object.hasOwn(section, field)) continue;
      if (section[field] === null || section[field] === undefined) {
        invalid(`${checkId}.${field}`, "must not be null");
      }
      candidate[checkId]![field] = section[field];
    }
  }
  return validateHealthConfig(candidate);
}

function parseOverridePatch(input: unknown): HealthConfigOverride | null {
  if (input === null) return null;
  const body = requirePlainObject(input, "healthConfigOverride");
  rejectUnknownKeys(body, HEALTH_CHECK_IDS, "healthConfigOverride");
  const parsed: Record<string, Record<string, unknown> | null> = {};
  for (const checkId of HEALTH_CHECK_IDS) {
    if (!Object.hasOwn(body, checkId)) continue;
    const section = body[checkId];
    if (section === null) {
      parsed[checkId] = null;
      continue;
    }
    if (!isPlainRecord(section)) invalid(checkId, "must be a plain object or null");
    rejectUnknownKeys(section, HEALTH_CONFIG_FIELDS[checkId], checkId);
    const values: Record<string, unknown> = {};
    for (const field of HEALTH_CONFIG_FIELDS[checkId]) {
      if (Object.hasOwn(section, field)) values[field] = section[field];
    }
    parsed[checkId] = values;
  }
  return parsed;
}

function mergeOverride(
  existing: HealthConfigOverride | undefined,
  patch: HealthConfigOverride | null,
): HealthConfigOverride | null {
  if (patch === null) return null;
  const old = existing as Record<string, Record<string, unknown> | null | undefined> | undefined;
  const next = patch as Record<string, Record<string, unknown> | null | undefined>;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const checkId of HEALTH_CHECK_IDS) {
    const oldSection = old?.[checkId] ?? {};
    const patchSection = next[checkId];
    const section: Record<string, unknown> = {};
    for (const field of HEALTH_CONFIG_FIELDS[checkId]) {
      if (patchSection === null) section[field] = null;
      else if (patchSection !== undefined && Object.hasOwn(patchSection, field)) {
        // Preserve an explicit null: null is the persisted "inherit" marker,
        // whereas an absent field means "leave the prior override intact".
        section[field] = patchSection[field];
      } else section[field] = oldSection?.[field] ?? null;
    }
    merged[checkId] = section;
  }
  const hasOverride = Object.values(merged).some((section) =>
    Object.values(section).some((value) => value !== null && value !== undefined),
  );
  return hasOverride ? merged : null;
}

function overridesEqual(
  left: HealthConfigOverride | undefined,
  right: HealthConfigOverride | null,
): boolean {
  const a = left as Record<string, Record<string, unknown> | null | undefined> | undefined;
  const b = right as Record<string, Record<string, unknown> | null | undefined> | null;
  for (const checkId of HEALTH_CHECK_IDS) {
    for (const field of HEALTH_CONFIG_FIELDS[checkId]) {
      if ((a?.[checkId]?.[field] ?? null) !== (b?.[checkId]?.[field] ?? null)) return false;
    }
  }
  return true;
}

function deterministicUuid(value: string): string {
  if (UUID.test(value)) return value;
  const digest = createHash("sha256").update(value).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function maxSeverity(left: "warning" | "critical", right: "warning" | "critical") {
  return left === "critical" || right === "critical" ? "critical" : "warning";
}

function activityActor(actor: HealthActorOptions, fallback: "admin" | "operator" | "system") {
  return actor.actorType ?? fallback;
}

function active(evaluation: HealthEvaluation): boolean {
  return evaluation.state === "active";
}

export class HealthService
  implements
    AcceptedTelemetryExtensionPort,
    TelemetryAuthorityExtensionPort,
    TapAssignmentExtensionPort
{
  readonly #database: DatabaseExecutor;
  readonly #now: () => Date;
  readonly #ids: () => string;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #onIncidentOpened?: HealthServiceOptions["onIncidentOpened"];
  readonly #onMaintenanceRecorded?: HealthServiceOptions["onMaintenanceRecorded"];
  readonly #onTargetedUpdate?: HealthServiceOptions["onTargetedUpdate"];
  readonly #onHealthTransition?: HealthServiceOptions["onHealthTransition"];
  #timer: NodeJS.Timeout | undefined;
  #sweepRunning = false;
  #sweepCursor: string | undefined;
  #sweepPending = false;
  #lastEvaluationChangedCheckIds: readonly HealthCheckId[] = [];

  constructor(database: DatabaseExecutor, options: HealthServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#ids = options.idFactory ?? randomUUID;
    this.#intervalMs = options.sweepIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new RangeError("Health sweep interval must be a positive integer");
    }
    this.#onError = options.onError ?? (() => {});
    this.#onIncidentOpened = options.onIncidentOpened;
    this.#onMaintenanceRecorded = options.onMaintenanceRecorded;
    this.#onTargetedUpdate = options.onTargetedUpdate;
    this.#onHealthTransition = options.onHealthTransition;
  }

  getGlobalConfig(): HealthGlobalConfig {
    return readHealthGlobalConfig(this.#database);
  }

  getConfig(): HealthGlobalConfig {
    return this.getGlobalConfig();
  }

  getTapOverride(tapId: string) {
    return readHealthTapOverride(this.#database, tapId);
  }

  getEffectiveConfig(tapId: string) {
    const tap = this.#requireTap(tapId);
    const global = readHealthGlobalConfig(this.#database);
    const override = readHealthTapOverride(this.#database, tap.id);
    return resolveHealthConfig(global.config, override?.override);
  }

  updateGlobalConfig(input: unknown, actor: HealthActorOptions = {}): HealthConfig {
    const at = clock(actor.now ?? this.#now).getTime();
    const result = this.#database.withTransaction(() => {
      const current = readHealthGlobalConfig(this.#database);
      const parsed = parseGlobalPatch(input, current.config);
      for (const override of listHealthTapOverrides(this.#database)) {
        validateHealthConfig(resolveHealthConfig(parsed, override.override).effective);
      }
      const updated = updateHealthGlobalConfig(this.#database, parsed, iso(at));
      if (updated.changed) this.#appendConfigActivity(updated.current, actor, at);
      return updated;
    });
    if (result.changed) this.runSweepOnce(at);
    return result.current.config;
  }

  setGlobalConfig(input: unknown, actor: HealthActorOptions = {}): HealthConfig {
    return this.updateGlobalConfig(input, actor);
  }

  updateTapOverride(
    tapIdValue: unknown,
    input: unknown,
    actor: HealthActorOptions = {},
  ): HealthConfigOverride | null {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    const patch = parseOverridePatch(input);
    const at = clock(actor.now ?? this.#now).getTime();
    let changedCheckIds: readonly HealthCheckId[] = [];
    const result = this.#database.withTransaction(() => {
      const global = readHealthGlobalConfig(this.#database);
      const previous = readHealthTapOverride(this.#database, tapId);
      const merged = mergeOverride(previous?.override, patch);
      validateHealthConfig(resolveHealthConfig(global.config, merged).effective);
      if (overridesEqual(previous?.override, merged)) return merged;
      if (merged === null) deleteHealthTapOverride(this.#database, tapId);
      else upsertHealthTapOverride(this.#database, tapId, merged, iso(at));
      changedCheckIds = this.evaluateTapInTransaction(
        this.#database,
        tapId,
        at,
        actor,
      ).changedCheckIds;
      appendActivity(this.#database, {
        category: "admin",
        action: "configuration_changed",
        actorType: activityActor(actor, "admin"),
        ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
        ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
        entityType: "health_tap_override",
        entityId: tapId,
        details: { tap_id: tapId },
        occurredAt: iso(at),
      });
      return merged;
    });
    if (changedCheckIds.length > 0) this.#emitTargeted(tapId, changedCheckIds);
    return result;
  }

  setTapOverride(tapId: unknown, input: unknown, actor: HealthActorOptions = {}) {
    return this.updateTapOverride(tapId, input, actor);
  }

  clearTapOverride(tapIdValue: unknown, actor: HealthActorOptions = {}): boolean {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    const at = clock(actor.now ?? this.#now).getTime();
    let changedCheckIds: readonly HealthCheckId[] = [];
    const changed = this.#database.withTransaction(() => {
      const previous = readHealthTapOverride(this.#database, tapId);
      if (previous === undefined) return false;
      deleteHealthTapOverride(this.#database, tapId);
      changedCheckIds = this.evaluateTapInTransaction(
        this.#database,
        tapId,
        at,
        actor,
      ).changedCheckIds;
      appendActivity(this.#database, {
        category: "admin",
        action: "configuration_changed",
        actorType: activityActor(actor, "admin"),
        ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
        ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
        entityType: "health_tap_override",
        entityId: tapId,
        details: { tap_id: tapId, cleared: true },
        occurredAt: iso(at),
      });
      return true;
    });
    if (changed && changedCheckIds.length > 0) this.#emitTargeted(tapId, changedCheckIds);
    return changed;
  }

  evaluateTap(tapIdValue: unknown, at?: Date | string | number): HealthEvaluationResult {
    const tapId = this.#requireTapId(tapIdValue);
    const evaluatedAt = at === undefined ? clock(this.#now).getTime() : asMs(at, "at");
    const result = this.#database.withTransaction(() =>
      this.evaluateTapInTransaction(this.#database, tapId, evaluatedAt),
    );
    this.#emitTargeted(tapId, result.changedCheckIds);
    return result;
  }

  /** Transaction-local evaluation hook. Never begins a nested transaction. */
  evaluateTapInTransaction(
    database: DatabaseExecutor,
    tapId: string,
    at: Date | string | number,
    actor: HealthActorOptions = {},
  ): HealthEvaluationResult {
    const evaluatedAtMs = asMs(at, "at");
    const tap = findTapById(database, tapId);
    if (tap === undefined) notFound("health.tap_not_found", "tapId", tapId);
    seedHealthCheckStates(database, tap.id, iso(evaluatedAtMs));
    if (tap.retiredAt !== null)
      return this.#retireInTransaction(database, tap, evaluatedAtMs, actor);

    const global = readHealthGlobalConfig(database);
    const override = readHealthTapOverride(database, tap.id);
    const effective = resolveHealthConfig(global.config, override?.override).effective;
    const authority = readTapTelemetryAuthority(database, tap.id);
    const authorityChangedAtMs =
      authority === undefined ? null : asMs(authority.changed_at, "changed_at");
    const epoch = readOpenTelemetryEpochForTap(database, tap.id);
    const epochState =
      epoch === undefined ? undefined : readTelemetryEpochState(database, epoch.id);
    const status =
      authority === undefined
        ? undefined
        : readSourceTapStatus(database, authority.source_id, tap.id);
    const sourceStatusMeasurement = this.#measurement(status, true);
    const latestScaleMeasurement =
      sourceStatusMeasurement !== null &&
      (authorityChangedAtMs === null ||
        sourceStatusMeasurement.measuredAtMs >= authorityChangedAtMs)
        ? sourceStatusMeasurement
        : null;
    // The detector state is authoritative for the generic measurement used to
    // derive a settled volume/phase. Scale freshness uses the dedicated source
    // status projection above even when the current epoch has no detector state.
    const statusMeasurement = this.#measurement(status, epoch === undefined, epochState);
    const measurement =
      statusMeasurement !== null &&
      (authorityChangedAtMs === null || statusMeasurement.measuredAtMs >= authorityChangedAtMs)
        ? statusMeasurement
        : null;
    const currentEpoch: HealthCurrentEpochEvidence | null =
      epoch === undefined || epochState === undefined
        ? null
        : {
            epochId: epoch.id,
            capacityMl: epoch.capacityMl,
            stabilizedVolumeMl: epochState.lastStabilizedVolumeMl,
            diagnosticCode: epochState.lastDiagnosticCode,
            lastDiagnosticCode: epochState.lastDiagnosticCode,
            phase: epochState.phase,
            lastMeasuredAtMs: epochState.lastMeasuredAtMs,
            lastStabilizedVolumeMl: epochState.lastStabilizedVolumeMl,
          };
    const latestPourAtMs =
      !effective.suspected_leak.enabled || epoch === undefined
        ? null
        : (() => {
            const pour = readLatestCompletedPourForEpoch(database, epoch.id);
            return pour === undefined ? null : asMs(pour.completedAt, "completedAt");
          })();
    const latestCleaning = latestHealthLineCleaning(database, tap.id);
    // A maintenance row stores the due date calculated at creation time for
    // historical integrity.  The current check uses today's effective
    // policy, so changing the interval is reflected on the next evaluation.
    const currentLineDueAtMs =
      latestCleaning === undefined
        ? null
        : calculateLineCleaningDue(latestCleaning.performedAtMs, effective.line_cleaning_due)
            .dueAtMs;
    const storedSamples = listHealthLeakSampleRecords(database, tap.id);
    const checks: HealthEvaluation[] = [];
    const changedCheckIds: HealthCheckId[] = [];
    for (const checkId of HEALTH_CHECK_IDS) {
      const previous = readHealthCheckState(database, tap.id, checkId);
      const authorityReset =
        previous !== undefined &&
        authorityChangedAtMs !== null &&
        authorityChangedAtMs > previous.evaluatedAtMs;
      const epochReset =
        previous !== undefined &&
        epoch !== undefined &&
        epoch.startedAtEpochMs > previous.evaluatedAtMs;
      const input: HealthEvaluationInput = {
        nowMs: evaluatedAtMs,
        enabled: tap.enabled,
        retired: false,
        tapId: tap.id,
        authorityChangedAtMs,
        latestMeasurement: measurement,
        latestScaleMeasurement,
        latestAuthoritativeMeasurement: measurement,
        currentEpoch,
        currentEpochEvidence: currentEpoch,
        latestCompletedPourAtMs: latestPourAtMs,
        recentPourAtMs: latestPourAtMs,
        lineCleanedAtMs: latestCleaning?.performedAtMs ?? null,
        lineCleaningBaselineAtMs: latestCleaning?.performedAtMs ?? null,
        lineCleaningDueAtMs: currentLineDueAtMs,
        latestLineCleaning:
          latestCleaning === undefined
            ? null
            : {
                cleanedAtMs: latestCleaning.performedAtMs,
                dueAtMs: currentLineDueAtMs,
              },
        previous:
          previous === undefined
            ? null
            : this.#previous(previous, storedSamples, authorityReset || epochReset),
        leakSamples: storedSamples.map(({ epochId, atMs, volumeMl }) => ({
          epochId,
          atMs,
          volumeMl,
        })),
      };
      const evaluation = evaluateHealthCheck(checkId, input, effective);
      checks.push(evaluation);
      const timers = evaluation.nextTimers;
      const persistedCooldownUntilMs =
        previous?.cooldownUntilMs !== null &&
        previous?.cooldownUntilMs !== undefined &&
        previous.cooldownUntilMs <= evaluatedAtMs
          ? null
          : (previous?.cooldownUntilMs ?? null);
      const persisted = upsertHealthCheckState(database, {
        tapId: tap.id,
        checkId,
        state: evaluation.state,
        severity: evaluation.severity,
        reason: evaluation.reason,
        evidence: evaluation.evidence,
        conditionStartedAtMs:
          checkId === "low_keg"
            ? timers.lowKegBelowSinceMs
            : checkId === "scale_availability"
              ? timers.scaleUnavailableSinceMs
              : checkId === "serving_temperature"
                ? timers.temperatureOutsideSinceMs
                : null,
        lastObservationAtMs:
          checkId === "serving_temperature" ? timers.temperatureLastMeasuredAtMs : null,
        suppressionUntilMs: checkId === "suspected_leak" ? timers.leakSuppressedUntilMs : null,
        cooldownUntilMs: persistedCooldownUntilMs,
        evaluatedAtMs,
        updatedAt: iso(evaluatedAtMs),
      });
      const semanticTransition =
        previous !== undefined &&
        (previous.state !== persisted.state || previous.severity !== persisted.severity);
      if (
        semanticTransition &&
        persisted.state !== "not_configured" &&
        this.#onHealthTransition !== undefined
      ) {
        const callback = this.#onHealthTransition(database, {
          tapId: tap.id,
          checkId,
          previousState: previous.state,
          previousSeverity: previous.severity,
          current: {
            state: persisted.state,
            severity: persisted.severity,
            evidence: persisted.evidence,
            reason: persisted.reason,
          },
          occurredAt: iso(evaluatedAtMs),
        });
        assertSynchronousCompletion(callback, "Health transition callback");
      }
      if (this.#stateChanged(previous, persisted)) changedCheckIds.push(checkId);
      if (checkId === "suspected_leak") {
        const bounded = evaluation.nextLeakSamples.slice(
          0,
          Math.min(64, effective.suspected_leak.maxSamples),
        );
        replaceHealthLeakSamples(
          database,
          tap.id,
          this.#sampleRecords(tap.id, bounded, storedSamples, measurement, evaluatedAtMs),
        );
      }
      this.#syncIncident(database, tap, persisted, evaluation, evaluatedAtMs, actor);
    }
    return { tapId: tap.id, checks, changedCheckIds };
  }

  onAcceptedSample(database: DatabaseExecutor, event: AcceptedSampleEvent): void {
    this.evaluateTapInTransaction(database, event.tapId, event.receivedAt);
  }

  onAuthorityChanged(database: DatabaseExecutor, event: AuthorityChangedEvent): void {
    this.evaluateTapInTransaction(database, event.tapId, event.changedAt);
  }

  onAssignmentOpened(database: DatabaseExecutor, context: AssignmentOpenedContext): void {
    this.evaluateTapInTransaction(database, context.tapId, context.occurredAt);
  }

  onAssignmentClosed(database: DatabaseExecutor, context: AssignmentClosedContext): void {
    this.evaluateTapInTransaction(database, context.tapId, context.occurredAt);
  }

  onTapCreated(database: DatabaseExecutor, tapId: string, at: Date | string | number): void {
    seedHealthCheckStates(database, tapId, iso(asMs(at, "at")));
  }

  /** Explicit name for composition code that initializes a newly inserted Tap. */
  initializeTapInTransaction(
    database: DatabaseExecutor,
    tapId: string,
    at: Date | string | number,
  ): void {
    this.onTapCreated(database, tapId, at);
  }

  onTapRetired(database: DatabaseExecutor, tapId: string, at: Date | string | number): void {
    const tap = findTapById(database, tapId);
    if (tap === undefined) notFound("health.tap_not_found", "tapId", tapId);
    this.#retireInTransaction(database, tap, asMs(at, "at"));
  }

  /** Explicit transaction-local retirement hook for TapService composition. */
  retireTapInTransaction(
    database: DatabaseExecutor,
    tapId: string,
    at: Date | string | number,
    actor: HealthActorOptions = {},
  ): void {
    const tap = findTapById(database, tapId);
    if (tap === undefined) notFound("health.tap_not_found", "tapId", tapId);
    this.#retireInTransaction(database, tap, asMs(at, "at"), actor);
  }

  onKegCorrection(database: DatabaseExecutor, event: KegCorrectionEvent): void {
    if (event.previousCapacityMl === event.newCapacityMl && event.previousTareG === event.newTareG)
      return;
    const tapIds = new Set(
      listOpenTelemetryEpochsForKeg(database, event.kegId).map((epoch) => epoch.tapId),
    );
    for (const tapId of tapIds) this.evaluateTapInTransaction(database, tapId, event.changedAt);
  }

  onEffectiveDensityChanged(database: DatabaseExecutor, event: EffectiveDensityChangedEvent): void {
    if (event.previousDensity.densityGPerMl === event.newDensity.densityGPerMl) return;
    const tapIds = new Set(
      listOpenTelemetryEpochsForBeverage(database, event.beverageId).map((epoch) => epoch.tapId),
    );
    for (const tapId of tapIds) this.evaluateTapInTransaction(database, tapId, event.changedAt);
  }

  recordMaintenance(
    tapIdValue: unknown,
    input: unknown,
    actor: HealthActorOptions = {},
  ): HealthMaintenanceRecordWithSession {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    const at = clock(actor.now ?? this.#now).getTime();
    let changedCheckIds: readonly HealthCheckId[] = [];
    const result = this.#database.withTransaction(() => {
      const record = this.recordMaintenanceInTransaction(this.#database, tapId, input, at, actor);
      changedCheckIds = this.#lastEvaluationChangedCheckIds;
      return record;
    });
    if (changedCheckIds.length > 0) this.#emitTargeted(tapId, changedCheckIds);
    return result;
  }

  recordMaintenanceInTransaction(
    database: DatabaseExecutor,
    tapId: string,
    input: unknown,
    at: Date | string | number,
    actor: HealthActorOptions = {},
  ): HealthMaintenanceRecordWithSession {
    const tap = findTapById(database, tapId);
    if (tap === undefined) notFound("health.tap_not_found", "tapId", tapId);
    const nowMs = asMs(at, "at");
    const body = requirePlainObject(input ?? {}, "maintenance");
    rejectUnknownKeys(body, ["maintenanceType", "performedAt", "notes"], "maintenance");
    const maintenanceType = body.maintenanceType;
    const allowed: readonly HealthMaintenanceType[] = [
      "line_cleaned",
      "sanitized",
      "inspection",
      "repair",
      "other",
    ];
    if (
      typeof maintenanceType !== "string" ||
      !allowed.includes(maintenanceType as HealthMaintenanceType)
    ) {
      invalid("maintenanceType", "is not supported");
    }
    if (
      body.performedAt !== undefined &&
      !(body.performedAt instanceof Date || typeof body.performedAt === "string")
    ) {
      invalid("performedAt", "must be a Date or canonical RFC3339 timestamp");
    }
    const performedAtMs =
      body.performedAt === undefined
        ? nowMs
        : asMs(body.performedAt, "performedAt", typeof body.performedAt === "string");
    if (performedAtMs > nowMs) invalid("performedAt", "must not be in the future");
    let notes: string | null = null;
    if (body.notes !== undefined && body.notes !== null) {
      if (typeof body.notes !== "string") invalid("notes", "must be text or null");
      if (body.notes.length === 0 || Buffer.byteLength(body.notes, "utf8") > 2_048) {
        invalid("notes", "must contain between 1 and 2048 UTF-8 bytes");
      }
      notes = body.notes;
    }
    const global = readHealthGlobalConfig(database);
    const override = readHealthTapOverride(database, tap.id);
    const effective = resolveHealthConfig(global.config, override?.override).effective;
    const resultingDueAtMs =
      maintenanceType === "line_cleaned"
        ? calculateLineCleaningDue(performedAtMs, effective.line_cleaning_due).dueAtMs
        : null;
    const record = insertHealthMaintenance(database, {
      id: this.#ids(),
      tapId: tap.id,
      maintenanceType: maintenanceType as HealthMaintenanceType,
      performedAtMs,
      notes,
      actorType: activityActor(actor, "admin"),
      actorId: actor.actorId ?? null,
      sessionId: actor.sessionId ?? null,
      recordedAtMs: nowMs,
      resultingDueAtMs,
    });
    registerTapFirstUse(database, tap.id, iso(nowMs));
    appendActivity(database, {
      category: "domain",
      action: "entity_changed",
      actorType: activityActor(actor, "admin"),
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
      entityType: "tap_line_maintenance",
      entityId: record.id,
      details: { maintenance_type: record.maintenanceType, tap_id: tap.id },
      occurredAt: iso(nowMs),
    });
    const maintenanceCallback = this.#onMaintenanceRecorded?.(database, record);
    assertSynchronousCompletion(maintenanceCallback, "Health maintenance callback");
    const evaluation = this.evaluateTapInTransaction(database, tap.id, nowMs, actor);
    this.#lastEvaluationChangedCheckIds = evaluation.changedCheckIds;
    return record;
  }

  createMaintenance(tapId: unknown, input: unknown, actor: HealthActorOptions = {}) {
    return this.recordMaintenance(tapId, input, actor);
  }

  getMaintenanceHistory(
    tapIdValue: unknown,
    options: { readonly limit?: number; readonly cursor?: HealthMaintenanceCursor } = {},
  ): HealthMaintenanceHistoryPage {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      invalid("limit", "must be 1..200");
    const rows = listHealthMaintenancePage(this.#database, tapId, limit, options.cursor);
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit);
    const last = records.at(-1);
    return {
      records,
      nextCursor: hasMore && last ? { performedAt: iso(last.performedAtMs), id: last.id } : null,
    };
  }

  getMaintenanceRecord(tapIdValue: unknown, id: string): HealthMaintenanceRecordWithSession {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    const full = readHealthMaintenance(this.#database, id);
    if (full === undefined || full.tapId !== tapId)
      notFound("health.maintenance_not_found", "id", id);
    return full;
  }

  getIncident(incidentId: string): HealthIncidentRecord {
    const record = readHealthIncident(this.#database, incidentId);
    if (record === undefined) notFound("health.incident_not_found", "incidentId", incidentId);
    return record;
  }

  listIncidents(tapIdValue: unknown, limit = 100): readonly HealthIncidentRecord[] {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    return listHealthIncidents(this.#database, tapId, limit);
  }

  getIncidentPage(
    tapIdValue: unknown,
    options: {
      readonly limit?: number;
      readonly cursor?: { readonly openedAt: string; readonly id: string };
    } = {},
  ): HealthIncidentHistoryPage {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      invalid("limit", "must be 1..200");
    const rows = listHealthIncidentPage(this.#database, tapId, limit, options.cursor);
    const hasMore = rows.length > limit;
    const incidents = rows.slice(0, limit);
    const last = incidents.at(-1);
    return {
      incidents,
      nextCursor: hasMore && last ? { openedAt: iso(last.openedAtMs), id: last.id } : null,
    };
  }

  listIncidentTransitions(
    incidentId: string,
    limit = 200,
  ): readonly HealthIncidentTransitionRecord[] {
    this.getIncident(incidentId);
    return listHealthIncidentTransitions(this.#database, incidentId, limit);
  }

  acknowledgeIncident(incidentId: string, actor: HealthActorOptions = {}): HealthIncidentRecord {
    const at = clock(actor.now ?? this.#now).getTime();
    return this.#database.withTransaction(() =>
      this.acknowledgeIncidentInTransaction(this.#database, incidentId, at, actor),
    );
  }

  acknowledgeIncidentInTransaction(
    database: DatabaseExecutor,
    incidentId: string,
    at: Date | string | number,
    actor: HealthActorOptions = {},
  ): HealthIncidentRecord {
    const acknowledgedAtMs = asMs(at, "at");
    const sessionId = actor.sessionId ?? "health-service";
    const incident = readHealthIncident(database, incidentId);
    if (incident === undefined) notFound("health.incident_not_found", "incidentId", incidentId);
    if (incident.resolvedAtMs !== null) conflict("health.incident_resolved", { incidentId });
    if (incident.acknowledgedAtMs !== null) return incident;
    const updated = acknowledgeHealthIncident(
      database,
      incidentId,
      acknowledgedAtMs,
      actor.actorId ?? null,
      sessionId,
      iso(acknowledgedAtMs),
    );
    if (updated === undefined) throw new Error("Health acknowledgement did not persist");
    insertHealthIncidentTransition(database, {
      id: this.#ids(),
      incidentId,
      transitionKind: "acknowledged",
      state: "active",
      severity: updated.currentSeverity,
      reason: updated.openReason,
      evidence: {},
      actorId: actor.actorId ?? null,
      sessionId,
      occurredAtMs: acknowledgedAtMs,
    });
    appendActivity(database, {
      category: "domain",
      action: "transition",
      actorType: activityActor(actor, "admin"),
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
      entityType: "health_incident",
      entityId: incidentId,
      details: { transition: "acknowledged", check_id: updated.checkId },
      occurredAt: iso(acknowledgedAtMs),
    });
    return updated;
  }

  acknowledge(incidentId: string, actor: HealthActorOptions = {}) {
    return this.acknowledgeIncident(incidentId, actor);
  }

  setIncidentCooldown(
    incidentId: string,
    until: Date | string | number | null,
    actor: HealthActorOptions = {},
  ): HealthIncidentRecord {
    const at = clock(actor.now ?? this.#now).getTime();
    const untilMs = until === null ? null : asMs(until, "cooldownUntil", typeof until === "string");
    if (untilMs !== null && untilMs > at + MAX_COOLDOWN_MS)
      invalid("cooldownUntil", "must be within 30 days");
    const result = this.#database.withTransaction(() =>
      this.setIncidentCooldownInTransaction(this.#database, incidentId, untilMs, at, actor),
    );
    this.#emitTargeted(result.tapId, [result.checkId]);
    return result;
  }

  setIncidentCooldownInTransaction(
    database: DatabaseExecutor,
    incidentId: string,
    untilMs: number | null,
    at: Date | string | number,
    actor: HealthActorOptions = {},
  ): HealthIncidentRecord {
    const nowMs = asMs(at, "at");
    if (untilMs !== null && (!Number.isFinite(untilMs) || untilMs > nowMs + MAX_COOLDOWN_MS)) {
      invalid("cooldownUntil", "must be within 30 days");
    }
    const incident = readHealthIncident(database, incidentId);
    if (incident === undefined) notFound("health.incident_not_found", "incidentId", incidentId);
    if (incident.resolvedAtMs !== null) conflict("health.incident_resolved", { incidentId });
    seedHealthCheckStates(database, incident.tapId, iso(nowMs));
    const state = readHealthCheckState(database, incident.tapId, incident.checkId);
    if (state === undefined) throw new Error("Health check state is missing");
    if (state.cooldownUntilMs === untilMs) return incident;
    upsertHealthCheckState(database, {
      tapId: state.tapId,
      checkId: state.checkId,
      state: state.state,
      severity: state.severity,
      reason: state.reason,
      evidence: state.evidence,
      conditionStartedAtMs: state.conditionStartedAtMs,
      lastObservationAtMs: state.lastObservationAtMs,
      suppressionUntilMs: state.suppressionUntilMs,
      cooldownUntilMs: untilMs,
      evaluatedAtMs: state.evaluatedAtMs,
      updatedAt: iso(nowMs),
    });
    insertHealthIncidentTransition(database, {
      id: this.#ids(),
      incidentId,
      transitionKind: "cooldown_changed",
      state: state.state,
      severity: state.severity,
      reason: state.reason,
      evidence: {},
      actorId: actor.actorId ?? null,
      sessionId: actor.sessionId ?? null,
      occurredAtMs: nowMs,
    });
    appendActivity(database, {
      category: "domain",
      action: "transition",
      actorType: activityActor(actor, "admin"),
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
      entityType: "health_incident",
      entityId: incidentId,
      details: { transition: "cooldown_changed", check_id: incident.checkId },
      occurredAt: iso(nowMs),
    });
    return incident;
  }

  setCooldown(
    incidentId: string,
    until: Date | string | number | null,
    actor: HealthActorOptions = {},
  ) {
    return this.setIncidentCooldown(incidentId, until, actor);
  }

  pruneResolvedIncidents(at?: Date | string | number): number {
    const nowMs = at === undefined ? clock(this.#now).getTime() : asMs(at, "at");
    return this.#database.withTransaction(() =>
      pruneResolvedHealthIncidents(this.#database, iso(nowMs - INCIDENT_RETENTION_MS)),
    );
  }

  listEvaluationTapIds(limit = MAX_SWEEP_TAPS, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SWEEP_TAPS)
      invalid("limit", "must be 1..100");
    const page = listHealthTapIdPage(this.#database, limit, cursor);
    return {
      ids: page.ids,
      nextCursor: page.ids.at(-1) ?? null,
      hasMore: page.hasMore,
    };
  }

  startMaintenance(options: { readonly onError?: (error: unknown) => void } = {}): void {
    if (this.#timer !== undefined) return;
    const onError = options.onError ?? this.#onError;
    try {
      this.runSweepOnce(clock(this.#now).getTime());
    } catch (error) {
      onError(error);
    }
    this.#timer = setInterval(() => {
      try {
        this.runSweepOnce(clock(this.#now).getTime());
      } catch (error) {
        onError(error);
      }
    }, this.#intervalMs);
  }

  startSweep(options: { readonly onError?: (error: unknown) => void } = {}): void {
    this.startMaintenance(options);
  }

  stopMaintenance(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#sweepPending = false;
  }

  stopSweep(): void {
    this.stopMaintenance();
  }

  runSweepOnce(at?: Date | string | number) {
    if (this.#sweepRunning) {
      this.#sweepPending = true;
      return { tapIds: [] as readonly string[], pruned: 0 };
    }
    const nowMs = at === undefined ? clock(this.#now).getTime() : asMs(at, "at");
    this.#sweepRunning = true;
    let rerun = false;
    const result = (() => {
      try {
        return this.#database.withTransaction(() => {
          let page = listHealthTapIdPage(this.#database, MAX_SWEEP_TAPS, this.#sweepCursor);
          if (page.ids.length === 0 && this.#sweepCursor !== undefined) {
            page = listHealthTapIdPage(this.#database, MAX_SWEEP_TAPS);
          }
          const tapIds = [...page.ids];
          const changedByTap = new Map<string, readonly HealthCheckId[]>();
          for (const tapId of tapIds) {
            const evaluation = this.evaluateTapInTransaction(this.#database, tapId, nowMs);
            if (evaluation.changedCheckIds.length > 0) {
              changedByTap.set(tapId, evaluation.changedCheckIds);
            }
          }
          this.#sweepCursor = tapIds.at(-1) ?? undefined;
          const pruned = pruneResolvedHealthIncidents(
            this.#database,
            iso(nowMs - INCIDENT_RETENTION_MS),
          );
          return { tapIds, changedByTap, pruned };
        });
      } finally {
        this.#sweepRunning = false;
        rerun = this.#sweepPending;
        this.#sweepPending = false;
      }
    })();
    for (const [tapId, changedCheckIds] of result.changedByTap) {
      this.#emitTargeted(tapId, changedCheckIds);
    }
    if (rerun) this.runSweepOnce(clock(this.#now).getTime());
    return { tapIds: result.tapIds, pruned: result.pruned };
  }

  getAdminOverview(tapIdValue: unknown): AdminHealthOverviewProjection {
    return toAdminHealthOverview(this.#projectionContext(this.#requireTapId(tapIdValue)));
  }

  listAdminOverview(): readonly AdminHealthOverviewProjection[] {
    return listTaps(this.#database).map((tap) =>
      toAdminHealthOverview(this.#projectionContext(tap.id)),
    );
  }

  getAdminDetail(tapIdValue: unknown): AdminHealthDetailProjection {
    return toAdminHealthDetail(this.#projectionContext(this.#requireTapId(tapIdValue)));
  }

  getAdminIncidentPage(
    tapIdValue: unknown,
    options: {
      readonly limit?: number;
      readonly cursor?: { readonly openedAt: string; readonly id: string };
    } = {},
  ): AdminHealthIncidentPageProjection {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    return toAdminHealthIncidentPage(this.getIncidentPage(tapId, options));
  }

  getAdminMaintenancePage(
    tapIdValue: unknown,
    options: { readonly limit?: number; readonly cursor?: HealthMaintenanceCursor } = {},
  ): AdminHealthMaintenancePageProjection {
    const tapId = this.#requireTapId(tapIdValue);
    this.#requireTap(tapId);
    return toAdminHealthMaintenancePage(this.getMaintenanceHistory(tapId, options));
  }

  getHealthOverview(tapId: unknown) {
    return this.getAdminOverview(tapId);
  }

  getHealthDetail(tapId: unknown) {
    return this.getAdminDetail(tapId);
  }

  #requireTapId(value: unknown): string {
    return validateTapId(value, "tapId");
  }

  #requireTap(tapId: string): Tap {
    const tap = findTapById(this.#database, tapId);
    if (tap === undefined) notFound("health.tap_not_found", "tapId", tapId);
    return tap;
  }

  #appendConfigActivity(config: HealthGlobalConfig, actor: HealthActorOptions, at: number): void {
    appendActivity(this.#database, {
      category: "admin",
      action: "configuration_changed",
      actorType: activityActor(actor, "admin"),
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
      entityType: "health_global_config",
      entityId: "1",
      details: { revision: config.revision },
      occurredAt: iso(at),
    });
  }

  #measurement(
    status: ReturnType<typeof readSourceTapStatus>,
    allowSourceStatusFallback: boolean,
    epochState?: ReturnType<typeof readTelemetryEpochState>,
  ): HealthAuthoritativeMeasurement | null {
    if (status === undefined) return null;
    const receivedAtMs = Date.parse(status.latest_received_at);
    if (!Number.isFinite(receivedAtMs)) return null;
    if (epochState !== undefined) {
      // Once an epoch exists, source status may still describe the prior
      // assignment.  Only the detector's current-epoch sample is usable.
      const measuredAtMs = epochState.lastMeasuredAtMs;
      if (
        epochState.lastMeasurementId === null ||
        measuredAtMs === null ||
        !Number.isFinite(measuredAtMs)
      ) {
        return null;
      }
      return {
        measurementId: epochState.lastMeasurementId,
        measuredAtMs,
        receivedAtMs,
        tempC: epochState.lastTemperatureC,
      };
    }
    if (!allowSourceStatusFallback) return null;
    if (
      status.latest_measurement_id === null ||
      !Number.isFinite(status.latest_measured_at_epoch_ms)
    ) {
      return null;
    }
    return {
      measurementId: status.latest_measurement_id,
      measuredAtMs: status.latest_measured_at_epoch_ms,
      receivedAtMs,
      tempC: status.temperature_c,
    };
  }

  #previous(
    state: HealthCheckStateRecord,
    samples: readonly HealthLeakSampleRecord[],
    resetTimers = false,
  ): NonNullable<HealthEvaluationInput["previous"]> {
    const timers: { -readonly [K in keyof HealthEvaluationTimers]?: HealthEvaluationTimers[K] } =
      {};
    if (state.checkId === "low_keg") {
      timers.lowKegBelowSinceMs = resetTimers ? null : state.conditionStartedAtMs;
    }
    if (state.checkId === "scale_availability") {
      timers.scaleUnavailableSinceMs = resetTimers ? null : state.conditionStartedAtMs;
    }
    if (state.checkId === "serving_temperature") {
      timers.temperatureOutsideSinceMs = resetTimers ? null : state.conditionStartedAtMs;
      timers.temperatureLastMeasuredAtMs = resetTimers ? null : state.lastObservationAtMs;
    }
    if (state.checkId === "suspected_leak") timers.leakSuppressedUntilMs = state.suppressionUntilMs;
    return {
      state: state.state,
      severity: state.severity,
      evaluatedAtMs: state.evaluatedAtMs,
      timers,
      leakSamples: samples.map(({ epochId, atMs, volumeMl }) => ({ epochId, atMs, volumeMl })),
    };
  }

  #stateChanged(
    previous: HealthCheckStateRecord | undefined,
    current: HealthCheckStateRecord,
  ): boolean {
    return previous === undefined || previous.revision !== current.revision;
  }

  #sampleRecords(
    tapId: string,
    samples: readonly {
      readonly epochId: string;
      readonly atMs: number;
      readonly volumeMl: number;
    }[],
    existing: readonly HealthLeakSampleRecord[],
    measurement: HealthAuthoritativeMeasurement | null,
    createdAtMs: number,
  ): HealthLeakSampleRecord[] {
    const byValue = new Map(
      existing.map((sample) => [`${sample.epochId}|${sample.atMs}|${sample.volumeMl}`, sample]),
    );
    const ids = new Set<string>();
    return samples.slice(0, 64).map((sample) => {
      const key = `${sample.epochId}|${sample.atMs}|${sample.volumeMl}`;
      const old = byValue.get(key);
      let measurementId =
        old?.measurementId ??
        (measurement?.measuredAtMs === sample.atMs
          ? deterministicUuid(measurement.measurementId)
          : deterministicUuid(`${tapId}|${key}`));
      let suffix = 0;
      while (ids.has(measurementId))
        measurementId = deterministicUuid(`${measurementId}|${++suffix}`);
      ids.add(measurementId);
      return {
        tapId,
        measurementId,
        epochId: sample.epochId,
        atMs: sample.atMs,
        volumeMl: sample.volumeMl,
        createdAt: iso(createdAtMs),
      };
    });
  }

  #syncIncident(
    database: DatabaseExecutor,
    tap: Tap,
    state: HealthCheckStateRecord,
    evaluation: HealthEvaluation,
    atMs: number,
    actor: HealthActorOptions,
  ): void {
    const openRecord = readOpenHealthIncident(database, tap.id, evaluation.checkId);
    const systemActor = activityActor(actor, "system");
    if (active(evaluation)) {
      if (openRecord !== undefined) {
        if (openRecord.currentSeverity !== evaluation.severity) {
          const severity = evaluation.severity as "warning" | "critical";
          const updated = updateHealthIncidentSeverity(
            database,
            openRecord.id,
            severity,
            maxSeverity(openRecord.maxSeverity, severity),
            iso(atMs),
          );
          if (updated === undefined)
            throw new Error("Health incident severity change did not persist");
          insertHealthIncidentTransition(database, {
            id: this.#ids(),
            incidentId: openRecord.id,
            transitionKind: "severity_changed",
            state: evaluation.state,
            severity: evaluation.severity,
            reason: evaluation.reason,
            evidence: evaluation.evidence,
            actorId: actor.actorId ?? null,
            sessionId: actor.sessionId ?? null,
            occurredAtMs: atMs,
          });
          appendActivity(database, {
            category: "domain",
            action: "transition",
            actorType: systemActor,
            ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
            ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
            entityType: "health_incident",
            entityId: openRecord.id,
            details: { transition: "severity_changed", check_id: evaluation.checkId, severity },
            occurredAt: iso(atMs),
          });
        }
        return;
      }
      if (state.cooldownUntilMs !== null && state.cooldownUntilMs > atMs) return;
      const severity = evaluation.severity as "warning" | "critical";
      const incident = insertHealthIncident(database, {
        id: this.#ids(),
        tapId: tap.id,
        checkId: evaluation.checkId,
        openedAtMs: atMs,
        severity,
        reason: evaluation.reason,
        evidence: evaluation.evidence,
        updatedAt: iso(atMs),
      });
      insertHealthIncidentTransition(database, {
        id: this.#ids(),
        incidentId: incident.id,
        transitionKind: "opened",
        state: evaluation.state,
        severity: evaluation.severity,
        reason: evaluation.reason,
        evidence: evaluation.evidence,
        actorId: actor.actorId ?? null,
        sessionId: actor.sessionId ?? null,
        occurredAtMs: atMs,
      });
      registerTapFirstUse(database, tap.id, iso(atMs));
      appendActivity(database, {
        category: "domain",
        action: "transition",
        actorType: systemActor,
        ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
        ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
        entityType: "health_incident",
        entityId: incident.id,
        details: { transition: "opened", check_id: evaluation.checkId, severity },
        occurredAt: iso(atMs),
      });
      const incidentCallback = this.#onIncidentOpened?.(database, incident);
      assertSynchronousCompletion(incidentCallback, "Health incident callback");
      return;
    }
    if (openRecord === undefined) return;
    const resolved = resolveHealthIncident(
      database,
      openRecord.id,
      atMs,
      evaluation.reason,
      iso(atMs),
    );
    if (resolved === undefined) throw new Error("Health incident resolution did not persist");
    insertHealthIncidentTransition(database, {
      id: this.#ids(),
      incidentId: openRecord.id,
      transitionKind: "resolved",
      state: evaluation.state,
      severity: evaluation.severity,
      reason: evaluation.reason,
      evidence: evaluation.evidence,
      actorId: actor.actorId ?? null,
      sessionId: actor.sessionId ?? null,
      occurredAtMs: atMs,
    });
    appendActivity(database, {
      category: "domain",
      action: "transition",
      actorType: systemActor,
      ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
      ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
      entityType: "health_incident",
      entityId: openRecord.id,
      details: { transition: "resolved", check_id: evaluation.checkId },
      occurredAt: iso(atMs),
    });
  }

  #retireInTransaction(
    database: DatabaseExecutor,
    tap: Tap,
    atMs: number,
    actor: HealthActorOptions = {},
  ): HealthEvaluationResult {
    const checks: HealthEvaluation[] = [];
    const changedCheckIds: HealthCheckId[] = [];
    for (const checkId of HEALTH_CHECK_IDS) {
      const previous = readHealthCheckState(database, tap.id, checkId);
      const evaluation = evaluateHealthCheck(
        checkId,
        {
          nowMs: atMs,
          retired: true,
          enabled: tap.enabled,
          authorityChangedAtMs: null,
        },
        DEFAULT_HEALTH_CONFIG,
      );
      checks.push(evaluation);
      const persisted = upsertHealthCheckState(database, {
        tapId: tap.id,
        checkId,
        state: "not_configured",
        severity: "none",
        reason: "tap_retired",
        evidence: { reason: "tap_retired" },
        conditionStartedAtMs: null,
        lastObservationAtMs: null,
        suppressionUntilMs: null,
        cooldownUntilMs: null,
        evaluatedAtMs: atMs,
        updatedAt: iso(atMs),
      });
      if (this.#stateChanged(previous, persisted)) changedCheckIds.push(checkId);
      const open = readOpenHealthIncident(database, tap.id, checkId);
      if (open !== undefined) {
        resolveHealthIncident(database, open.id, atMs, "tap_retired", iso(atMs));
        insertHealthIncidentTransition(database, {
          id: this.#ids(),
          incidentId: open.id,
          transitionKind: "resolved",
          state: "not_configured",
          severity: "none",
          reason: "tap_retired",
          evidence: { reason: "tap_retired" },
          actorId: actor.actorId ?? null,
          sessionId: actor.sessionId ?? null,
          occurredAtMs: atMs,
        });
        appendActivity(database, {
          category: "domain",
          action: "transition",
          actorType: activityActor(actor, "system"),
          ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          entityType: "health_incident",
          entityId: open.id,
          details: { transition: "resolved", check_id: checkId, reason: "tap_retired" },
          occurredAt: iso(atMs),
        });
      }
    }
    replaceHealthLeakSamples(database, tap.id, []);
    return { tapId: tap.id, checks, changedCheckIds };
  }

  #projectionContext(tapId: string): HealthProjectionContext {
    const tap = this.#requireTap(tapId);
    const global = readHealthGlobalConfig(this.#database);
    const override = readHealthTapOverride(this.#database, tapId);
    const resolved = resolveHealthConfig(global.config, override?.override);
    return {
      tap,
      global,
      override,
      effectiveConfig: resolved.effective,
      inheritance: resolved.inheritance,
      states: listHealthCheckStates(this.#database, tapId),
      incidents: listHealthIncidents(this.#database, tapId, 200),
      maintenance: listHealthMaintenancePage(this.#database, tapId, 200).slice(0, 200),
    };
  }

  #emitTargeted(tapId: string, changedCheckIds: readonly HealthCheckId[]): void {
    if (this.#onTargetedUpdate === undefined) return;
    try {
      this.#onTargetedUpdate(
        toHealthTargetedUpdate(this.#projectionContext(tapId), changedCheckIds),
      );
    } catch (error) {
      this.#onError(error);
    }
  }
}

export function createHealthService(
  database: DatabaseExecutor,
  options: HealthServiceOptions = {},
): HealthService {
  return new HealthService(database, options);
}

export type HealthServicePort = HealthService;
