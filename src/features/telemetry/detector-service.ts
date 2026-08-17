import { createHash, randomUUID } from "node:crypto";

import {
  assertSynchronousCompletion,
  type DatabaseExecutor,
} from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { resolveBeverageDensity } from "../beverages/density.ts";
import { resolveEffectivePresentationFromDb } from "../beverages/presentation.ts";
import { readBeverageSettings } from "../beverages/repository.ts";
import type { DensityResolution, EffectiveDensityChangedEvent } from "../beverages/types.ts";
import { findFillById } from "../fills/repository.ts";
import { findKegById } from "../kegs/repository.ts";
import type { KegCorrectionEvent } from "../kegs/types.ts";
import {
  findActiveAssignmentByTapId,
  findTapById,
  listActiveAssignments,
} from "../taps/repository.ts";
import type {
  AssignmentClosedContext,
  AssignmentOpenedContext,
  TapAssignmentExtensionPort,
} from "../taps/types.ts";
import type { CompletedPourEventContext } from "../outbound/types.ts";
import {
  DETECTOR_CONFIG_FIELDS,
  detectorConfigsEqual,
  type DetectorConfig,
  type DetectorConfigOverride,
} from "./detector-config.ts";
import {
  activateCandidate,
  advanceDetector,
  arbitrateCandidates,
  nextDetectorDueAt,
  reduceDetector,
  suppressCandidate,
  type DetectorEffect,
} from "./detector.ts";
import type {
  DetectorArbitrationGroup,
  DetectorGlobalConfig,
  DetectorTapOverride,
  TelemetryEpoch,
  TelemetryEpochCloseReason,
  TelemetryEpochState,
} from "./epoch-types.ts";
import { interpretTelemetry } from "./interpretation.ts";
import { readTapTelemetryAuthority } from "./repository.ts";
import {
  closeTelemetryEpoch,
  createInitialTelemetryEpochState,
  insertCompletedPourIdempotently,
  insertDetectorArbitrationGroup,
  insertTelemetryEpoch,
  insertTelemetryEpochSample,
  listDetectorArbitrationGroups,
  listDetectorArbitrationMembers,
  listDueDetectorStates,
  listOpenCandidateDetectorStatesForGroup,
  listOpenPouringDetectorStatesForGroup,
  listOpenTelemetryEpochs,
  listOpenTelemetryEpochsForBeverage,
  listOpenTelemetryEpochsForKeg,
  listTelemetryEpochSamples,
  pruneTelemetryEpochSamples,
  readDetectorArbitrationGroup,
  readDetectorArbitrationMembership,
  readDetectorGlobalConfig,
  readDetectorTapOverride,
  readOpenTelemetryEpochForTap,
  readTelemetryEpochState,
  removeDetectorTapOverride,
  replaceDetectorArbitrationMembership,
  resolveEffectiveDetectorConfig,
  updateDetectorArbitrationGroupName,
  updateDetectorGlobalConfig,
  updateTelemetryEpochState,
  upsertDetectorTapOverride,
} from "./repositories/detector.ts";
import {
  TELEMETRY_NORMALIZATION_VERSION,
  type AcceptedSampleEvent,
  type AcceptedTelemetryExtensionPort,
  type AuthorityChangedEvent,
  type TelemetryAuthorityExtensionPort,
} from "./types.ts";

export interface DetectorServiceOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  /** Transaction-local notification for each newly persisted completed pour. */
  readonly onPourCompleted?: (database: DatabaseExecutor, pour: CompletedPourEventContext) => void;
}

export interface DetectorMaintenanceOptions {
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface DetectorActorOptions {
  readonly actorType?: "admin" | "operator" | "system";
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
}

export interface DetectorDiagnostics {
  readonly tapId: string;
  readonly epoch: null | {
    readonly id: string;
    readonly sourceId: string | null;
    readonly fillId: string;
    readonly assignmentId: string;
    readonly kegId: string;
    readonly startedAt: string;
    readonly configVersion: string;
    readonly arbitrationGroupId: string | null;
    readonly snapshots: {
      readonly capacityMl: number;
      readonly tareG: number;
      readonly densityGPerMl: number;
      readonly densitySource: TelemetryEpoch["densitySource"];
      readonly normalizationVersion: number;
      readonly detectorConfig: DetectorConfig;
    };
  };
  readonly detector: null | {
    readonly phase: TelemetryEpochState["phase"];
    readonly waitingForMeasurement: boolean;
    readonly baselineVolumeMl: number | null;
    readonly warningCode: string | null;
    readonly candidate: null | {
      readonly sessionId: string;
      readonly startedAt: string | null;
      readonly lossMl: number | null;
    };
  };
  readonly measurement: null | {
    readonly id: string;
    readonly measuredAt: string | null;
    readonly canonical: {
      readonly kind: TelemetryEpochState["lastPrimaryKind"];
      readonly value: number | null;
      readonly temperatureC: number | null;
    };
    readonly interpretedVolumeMl: number | null;
    readonly stabilizedVolumeMl: number | null;
    readonly publicVolumeMl: number | null;
    readonly diagnosticCode: TelemetryEpochState["lastDiagnosticCode"];
  };
}

const INTEGER_CONFIG_FIELDS = new Set<keyof DetectorConfig>([
  "candidateSamples",
  "candidateSampleWindowMs",
  "candidateLookbackMs",
  "arbitrationMs",
  "quietPeriodMs",
  "hardTimeoutMs",
  "jumpStableSamples",
  "jumpStableSpanMs",
  "baselineSamples",
  "baselineSpanMs",
  "settledSamples",
  "settledSpanMs",
  "cooldownMs",
  "historyMs",
]);

const NONNEGATIVE_CONFIG_FIELDS = new Set<keyof DetectorConfig>([
  "candidateSampleWindowMs",
  "candidateLookbackMs",
  "arbitrationMs",
  "quietPeriodMs",
  "jumpStableSpanMs",
  "jumpBandMl",
  "baselineSpanMs",
  "baselineBandMl",
  "settledSpanMs",
  "settledBandMl",
  "cooldownMs",
]);

function asEpochMs(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError("Invalid detector timestamp");
  return result;
}

function iso(value: number): string {
  const result = new Date(value);
  if (!Number.isFinite(value) || Number.isNaN(result.getTime())) {
    throw new TypeError("Invalid detector timestamp");
  }
  return result.toISOString();
}

function assertDetectorConfig(config: DetectorConfig): void {
  for (const field of DETECTOR_CONFIG_FIELDS) {
    const value = config[field];
    if (!Number.isFinite(value)) throw new TypeError(`Invalid detector config field: ${field}`);
    if (INTEGER_CONFIG_FIELDS.has(field) && !Number.isSafeInteger(value)) {
      throw new TypeError(`Invalid detector config field: ${field}`);
    }
    if (NONNEGATIVE_CONFIG_FIELDS.has(field) ? value < 0 : value <= 0) {
      throw new RangeError(`Invalid detector config field: ${field}`);
    }
  }
  if (config.arbitrationDominanceRatio < 1) {
    throw new RangeError("Detector arbitration dominance ratio must be at least 1");
  }
  if (config.candidateSampleWindowMs > config.candidateLookbackMs) {
    throw new RangeError("Detector candidate window cannot exceed lookback");
  }
  if (config.quietPeriodMs > config.hardTimeoutMs) {
    throw new RangeError("Detector quiet period cannot exceed hard timeout");
  }
  if (
    config.historyMs <
    Math.max(
      config.candidateLookbackMs,
      config.baselineSpanMs,
      config.settledSpanMs,
      config.jumpStableSpanMs,
    )
  ) {
    throw new RangeError("Detector history cannot be shorter than a retained detector span");
  }
}

function densityEqual(left: DensityResolution, right: DensityResolution): boolean {
  return left.densityGPerMl === right.densityGPerMl;
}

function detectorConfigVersion(config: DetectorConfig): string {
  const canonicalValues = DETECTOR_CONFIG_FIELDS.map((field) => [field, config[field]]);
  const digest = createHash("sha256").update(JSON.stringify(canonicalValues)).digest("hex");
  return `detector-v1:sha256:${digest}`;
}

export class DetectorService
  implements
    TapAssignmentExtensionPort,
    TelemetryAuthorityExtensionPort,
    AcceptedTelemetryExtensionPort
{
  readonly #database: DatabaseExecutor;
  readonly #ids: () => string;
  readonly #now: () => Date;
  readonly #onPourCompleted?: DetectorServiceOptions["onPourCompleted"];
  #maintenanceTimer: NodeJS.Timeout | undefined;

  constructor(database: DatabaseExecutor, options: DetectorServiceOptions = {}) {
    this.#database = database;
    this.#ids = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#onPourCompleted = options.onPourCompleted;
  }

  onAssignmentOpened(database: DatabaseExecutor, context: AssignmentOpenedContext): void {
    this.#open(
      database,
      context.tapId,
      context.fillId,
      context.assignmentId,
      asEpochMs(context.occurredAt),
    );
  }

  onAssignmentClosed(database: DatabaseExecutor, context: AssignmentClosedContext): void {
    const reason =
      context.reason === "unassigned"
        ? "assignment_unassigned"
        : context.reason === "moved"
          ? "assignment_moved"
          : "fill_ended";
    this.#close(database, context.tapId, reason, asEpochMs(context.occurredAt));
  }

  onAuthorityChanged(database: DatabaseExecutor, event: AuthorityChangedEvent): void {
    if (event.previousSourceId === event.newSourceId) return;
    const at = asEpochMs(event.changedAt);
    this.#close(database, event.tapId, "source_changed", at);
    const assignment = findActiveAssignmentByTapId(database, event.tapId);
    if (assignment !== undefined)
      this.#open(database, event.tapId, assignment.fillId, assignment.id, at);
  }

  onKegCorrection(database: DatabaseExecutor, event: KegCorrectionEvent): void {
    const capacityChanged = event.previousCapacityMl !== event.newCapacityMl;
    const tareChanged = event.previousTareG !== event.newTareG;
    if (!capacityChanged && !tareChanged) return;
    const at = asEpochMs(event.changedAt);
    const reason: TelemetryEpochCloseReason = capacityChanged ? "capacity_changed" : "tare_changed";
    for (const epoch of listOpenTelemetryEpochsForKeg(database, event.kegId))
      this.#transition(database, epoch, reason, at);
  }

  onEffectiveDensityChanged(database: DatabaseExecutor, event: EffectiveDensityChangedEvent): void {
    if (densityEqual(event.previousDensity, event.newDensity)) return;
    const at = asEpochMs(event.changedAt);
    for (const epoch of listOpenTelemetryEpochsForBeverage(database, event.beverageId)) {
      if (
        epoch.densityGPerMl !== event.newDensity.densityGPerMl ||
        epoch.densitySource !== event.newDensity.source
      ) {
        this.#transition(database, epoch, "density_changed", at);
      }
    }
  }

  onAcceptedSample(database: DatabaseExecutor, event: AcceptedSampleEvent): void {
    if (event.capturedAssignmentId === null || event.capturedFillId === null) return;
    const epoch = readOpenTelemetryEpochForTap(database, event.tapId);
    const measuredAt = asEpochMs(event.measuredAt);
    if (
      epoch === undefined ||
      epoch.sourceId === null ||
      epoch.sourceId !== event.sourceId ||
      epoch.assignmentId !== event.capturedAssignmentId ||
      epoch.fillId !== event.capturedFillId ||
      epoch.normalizationVersion !== event.normalizationVersion ||
      measuredAt < epoch.startedAtEpochMs
    )
      return;

    this.#advanceEpoch(database, epoch, measuredAt);
    const state = readTelemetryEpochState(database, epoch.id);
    if (state === undefined) throw new Error("Telemetry epoch runtime state is missing");
    const interpreted = interpretTelemetry(epoch, event.primaryMeasurement);
    const baseState: TelemetryEpochState = {
      ...state,
      lastMeasurementId: event.measurementId,
      lastMeasuredAtMs: measuredAt,
      lastPrimaryKind: event.primaryMeasurement.kind,
      lastPrimaryValue: event.primaryMeasurement.value,
      lastTemperatureC: event.temperatureC,
      lastInterpretedVolumeMl: interpreted.interpretedVolumeMl,
      lastPublicVolumeMl: interpreted.publicVolumeMl,
      lastDiagnosticCode: interpreted.diagnosticCode,
      updatedAt: event.receivedAt,
    };
    if (interpreted.diagnosticCode !== "ok") {
      const invalidTransition = reduceDetector(
        { ...state, tapId: epoch.tapId },
        { atMs: measuredAt, volumeMl: interpreted.interpretedVolumeMl },
        this.#history(database, epoch.id),
        epoch.config,
        this.#ids(),
      );
      if (invalidTransition.state.phase === "warning") {
        this.#persist(
          database,
          epoch,
          {
            ...invalidTransition.state,
            epochId: epoch.id,
            lastMeasurementId: event.measurementId,
            lastPrimaryKind: event.primaryMeasurement.kind,
            lastPrimaryValue: event.primaryMeasurement.value,
            lastTemperatureC: event.temperatureC,
            lastPublicVolumeMl: interpreted.publicVolumeMl,
            lastDiagnosticCode: interpreted.diagnosticCode,
            updatedAt: event.receivedAt,
          },
          invalidTransition.effects,
        );
      } else {
        updateTelemetryEpochState(database, baseState);
      }
      return;
    }

    insertTelemetryEpochSample(database, {
      epochId: epoch.id,
      measurementId: event.measurementId,
      measuredAtEpochMs: measuredAt,
      interpretedVolumeMl: interpreted.interpretedVolumeMl,
    });
    pruneTelemetryEpochSamples(database, epoch.id, measuredAt - epoch.config.historyMs);
    const transition = reduceDetector(
      { ...state, tapId: epoch.tapId },
      { atMs: measuredAt, volumeMl: interpreted.interpretedVolumeMl },
      this.#history(database, epoch.id),
      epoch.config,
      this.#ids(),
    );
    this.#persist(
      database,
      epoch,
      {
        ...transition.state,
        epochId: epoch.id,
        lastMeasurementId: event.measurementId,
        lastPrimaryKind: event.primaryMeasurement.kind,
        lastPrimaryValue: event.primaryMeasurement.value,
        lastTemperatureC: event.temperatureC,
        lastPublicVolumeMl: interpreted.publicVolumeMl,
        lastDiagnosticCode:
          transition.state.phase === "warning" ? "implausible_jump" : interpreted.diagnosticCode,
        updatedAt: event.receivedAt,
      },
      transition.effects,
    );
    if (
      transition.state.phase === "candidate" &&
      transition.state.arbitrationDeadlineMs !== null &&
      transition.state.arbitrationDeadlineMs <= measuredAt
    )
      this.#advanceEpoch(database, epoch, measuredAt);
  }

  processDue(now: Date = this.#currentTime()): number {
    const nowMs = now.getTime();
    if (Number.isNaN(nowMs)) throw new TypeError("Invalid detector clock");
    return this.#database.withTransaction(() => {
      const handledEpochs = new Set<string>();
      for (let transitions = 0; transitions < 500; transitions += 1) {
        const next = listDueDetectorStates(this.#database, nowMs)
          .map((item) => ({
            item,
            dueAt: nextDetectorDueAt(
              item.state,
              this.#history(this.#database, item.epoch.id),
              item.epoch.config,
              nowMs,
            ),
          }))
          .filter((item): item is typeof item & { readonly dueAt: number } => item.dueAt !== null)
          .sort(
            (a, b) =>
              a.dueAt - b.dueAt ||
              (a.item.state.phase === "pouring" ? 0 : 1) -
                (b.item.state.phase === "pouring" ? 0 : 1) ||
              (a.item.epoch.tapId < b.item.epoch.tapId
                ? -1
                : a.item.epoch.tapId > b.item.epoch.tapId
                  ? 1
                  : 0),
          )[0];
        if (next === undefined) break;
        const { item, dueAt } = next;
        if (item.state.phase === "candidate" && item.epoch.arbitrationGroupId !== null) {
          for (const epochId of this.#arbitrateGroup(
            this.#database,
            item.epoch.arbitrationGroupId,
            dueAt,
          ))
            handledEpochs.add(epochId);
        } else {
          this.#advanceEpoch(this.#database, item.epoch, dueAt);
          handledEpochs.add(item.epoch.id);
        }
      }
      return handledEpochs.size;
    });
  }

  reconcileActiveAssignments(now: Date = this.#currentTime()): number {
    const startedAt = now.getTime();
    if (Number.isNaN(startedAt)) throw new TypeError("Invalid detector clock");
    return this.#database.withTransaction(() => {
      let opened = 0;
      for (const assignment of listActiveAssignments(this.#database)) {
        if (readOpenTelemetryEpochForTap(this.#database, assignment.tapId) !== undefined) continue;
        this.#open(this.#database, assignment.tapId, assignment.fillId, assignment.id, startedAt);
        opened += 1;
      }
      return opened;
    });
  }

  startMaintenance(options: DetectorMaintenanceOptions = {}): void {
    this.stopMaintenance();
    const intervalMs = options.intervalMs ?? 200;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > 60_000) {
      throw new RangeError("Detector maintenance interval must be between 50 and 60000 ms");
    }
    this.reconcileActiveAssignments();
    this.processDue();
    this.#maintenanceTimer = setInterval(() => {
      try {
        this.processDue();
      } catch (error) {
        options.onError?.(error);
      }
    }, intervalMs);
  }

  stopMaintenance(): void {
    if (this.#maintenanceTimer !== undefined) {
      clearInterval(this.#maintenanceTimer);
      this.#maintenanceTimer = undefined;
    }
  }

  getGlobalConfig(): DetectorGlobalConfig {
    return readDetectorGlobalConfig(this.#database);
  }

  updateGlobalConfig(
    config: DetectorConfig,
    actorOptions: DetectorActorOptions = {},
  ): DetectorGlobalConfig {
    assertDetectorConfig(config);
    const at = this.#actorTime(actorOptions).getTime();
    return this.#database.withTransaction(() => {
      const previous = readDetectorGlobalConfig(this.#database);
      const updated = updateDetectorGlobalConfig(this.#database, config, iso(at));
      if (updated.revision === previous.revision) return updated;
      for (const epoch of listOpenTelemetryEpochs(this.#database)) {
        const next = resolveEffectiveDetectorConfig(this.#database, epoch.tapId);
        if (!detectorConfigsEqual(epoch.config, next.config))
          this.#transition(this.#database, epoch, "detector_config_changed", at);
      }
      this.#configurationActivity("detector_global_config", "1", at, actorOptions);
      return updated;
    });
  }

  getTapOverride(tapId: string): DetectorTapOverride | undefined {
    this.#requireTap(tapId);
    return readDetectorTapOverride(this.#database, tapId);
  }

  setTapOverride(
    tapId: string,
    override: DetectorConfigOverride,
    actorOptions: DetectorActorOptions = {},
  ): DetectorTapOverride {
    this.#requireTap(tapId);
    const at = this.#actorTime(actorOptions).getTime();
    return this.#database.withTransaction(() => {
      const oldEffective = resolveEffectiveDetectorConfig(this.#database, tapId);
      const previous = readDetectorTapOverride(this.#database, tapId);
      const updated = upsertDetectorTapOverride(this.#database, tapId, override, iso(at));
      if (previous !== undefined && updated.revision === previous.revision) return updated;
      const nextEffective = resolveEffectiveDetectorConfig(this.#database, tapId);
      assertDetectorConfig(nextEffective.config);
      const epoch = readOpenTelemetryEpochForTap(this.#database, tapId);
      if (epoch !== undefined && !detectorConfigsEqual(oldEffective.config, nextEffective.config))
        this.#transition(this.#database, epoch, "detector_config_changed", at);
      this.#configurationActivity("tap_detector_override", tapId, at, actorOptions);
      return updated;
    });
  }

  clearTapOverride(tapId: string, actorOptions: DetectorActorOptions = {}): boolean {
    this.#requireTap(tapId);
    const at = this.#actorTime(actorOptions).getTime();
    return this.#database.withTransaction(() => {
      const oldEffective = resolveEffectiveDetectorConfig(this.#database, tapId);
      const removed = removeDetectorTapOverride(this.#database, tapId);
      if (!removed) return false;
      const nextEffective = resolveEffectiveDetectorConfig(this.#database, tapId);
      const epoch = readOpenTelemetryEpochForTap(this.#database, tapId);
      if (epoch !== undefined && !detectorConfigsEqual(oldEffective.config, nextEffective.config))
        this.#transition(this.#database, epoch, "detector_config_changed", at);
      this.#configurationActivity("tap_detector_override", tapId, at, actorOptions);
      return true;
    });
  }

  listArbitrationGroups(): readonly (DetectorArbitrationGroup & {
    readonly tapIds: readonly string[];
  })[] {
    return listDetectorArbitrationGroups(this.#database).map((group) => ({
      ...group,
      tapIds: listDetectorArbitrationMembers(this.#database, group.id).map(
        (member) => member.tapId,
      ),
    }));
  }

  createArbitrationGroup(
    name: string,
    tapIds: readonly string[],
    actorOptions: DetectorActorOptions = {},
  ): DetectorArbitrationGroup {
    const at = this.#actorTime(actorOptions).getTime();
    return this.#database.withTransaction(() => {
      const group = {
        id: this.#ids(),
        name: this.#groupName(name),
        createdAt: iso(at),
        updatedAt: iso(at),
      };
      insertDetectorArbitrationGroup(this.#database, group);
      this.#replaceGroupMembers(group.id, tapIds, at);
      this.#configurationActivity("detector_arbitration_group", group.id, at, actorOptions);
      return group;
    });
  }

  updateArbitrationGroup(
    groupId: string,
    input: { readonly name?: string; readonly tapIds?: readonly string[] },
    actorOptions: DetectorActorOptions = {},
  ): DetectorArbitrationGroup {
    const at = this.#actorTime(actorOptions).getTime();
    return this.#database.withTransaction(() => {
      const existing = readDetectorArbitrationGroup(this.#database, groupId);
      if (existing === undefined) throw this.#notFound("Detector arbitration group was not found.");
      if (input.name !== undefined)
        updateDetectorArbitrationGroupName(
          this.#database,
          groupId,
          this.#groupName(input.name),
          iso(at),
        );
      if (input.tapIds !== undefined) this.#replaceGroupMembers(groupId, input.tapIds, at);
      this.#configurationActivity("detector_arbitration_group", groupId, at, actorOptions);
      return readDetectorArbitrationGroup(this.#database, groupId)!;
    });
  }

  manualRebaseline(tapId: string, actorOptions: DetectorActorOptions = {}): DetectorDiagnostics {
    const at = this.#actorTime(actorOptions).getTime();
    return this.#database.withTransaction(() => {
      const epoch = readOpenTelemetryEpochForTap(this.#database, tapId);
      const assignment = findActiveAssignmentByTapId(this.#database, tapId);
      if (epoch === undefined || assignment === undefined || assignment.id !== epoch.assignmentId)
        throw this.#notFound("Tap does not have an active telemetry interpretation epoch.");
      this.#close(this.#database, tapId, "manual_rebaseline", at);
      const next = this.#open(this.#database, tapId, epoch.fillId, epoch.assignmentId, at);
      appendActivity(
        this.#database,
        {
          category: "domain",
          action: "transition",
          actorType: actorOptions.actorType ?? "admin",
          ...(actorOptions.actorId === undefined ? {} : { actorId: actorOptions.actorId }),
          ...(actorOptions.sessionId === undefined ? {} : { sessionId: actorOptions.sessionId }),
          entityType: "telemetry_epoch",
          entityId: next.id,
          details: { transition: "manual_rebaseline", tap_id: tapId, previous_epoch_id: epoch.id },
          occurredAt: iso(at),
        },
        { idFactory: this.#ids },
      );
      return this.diagnostics(tapId);
    });
  }

  diagnostics(tapId: string): DetectorDiagnostics {
    this.#requireTap(tapId);
    const epoch = readOpenTelemetryEpochForTap(this.#database, tapId);
    if (epoch === undefined) return { tapId, epoch: null, detector: null, measurement: null };
    const state = readTelemetryEpochState(this.#database, epoch.id);
    if (state === undefined) throw new Error("Telemetry epoch runtime state is missing");
    return {
      tapId,
      epoch: {
        id: epoch.id,
        sourceId: epoch.sourceId,
        fillId: epoch.fillId,
        assignmentId: epoch.assignmentId,
        kegId: epoch.kegId,
        startedAt: epoch.startedAt,
        configVersion: epoch.detectorConfigVersion,
        arbitrationGroupId: epoch.arbitrationGroupId,
        snapshots: {
          capacityMl: epoch.capacityMl,
          tareG: epoch.tareG,
          densityGPerMl: epoch.densityGPerMl,
          densitySource: epoch.densitySource,
          normalizationVersion: epoch.normalizationVersion,
          detectorConfig: epoch.config,
        },
      },
      detector: {
        phase: state.phase,
        waitingForMeasurement: state.phase === "waiting_for_measurement",
        baselineVolumeMl: state.baselineVolumeMl,
        warningCode: state.warningCode,
        candidate:
          state.candidateSessionId === null
            ? null
            : {
                sessionId: state.candidateSessionId,
                startedAt:
                  state.candidateStartedAtMs === null ? null : iso(state.candidateStartedAtMs),
                lossMl: state.candidateLossMl,
              },
      },
      measurement:
        state.lastMeasurementId === null
          ? null
          : {
              id: state.lastMeasurementId,
              measuredAt: state.lastMeasuredAtMs === null ? null : iso(state.lastMeasuredAtMs),
              canonical: {
                kind: state.lastPrimaryKind,
                value: state.lastPrimaryValue,
                temperatureC: state.lastTemperatureC,
              },
              interpretedVolumeMl: state.lastInterpretedVolumeMl,
              stabilizedVolumeMl: state.lastStabilizedVolumeMl,
              publicVolumeMl: state.lastPublicVolumeMl,
              diagnosticCode: state.lastDiagnosticCode,
            },
    };
  }

  #currentTime(): Date {
    const current = this.#now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime()))
      throw new TypeError("Invalid detector clock");
    return current;
  }
  #actorTime(options: DetectorActorOptions): Date {
    const current = (options.now ?? this.#now)();
    if (!(current instanceof Date) || Number.isNaN(current.getTime()))
      throw new TypeError("Invalid detector clock");
    return current;
  }

  #open(
    database: DatabaseExecutor,
    tapId: string,
    fillId: string,
    assignmentId: string,
    at: number,
  ): TelemetryEpoch {
    if (readOpenTelemetryEpochForTap(database, tapId) !== undefined)
      throw new Error("Tap already has an open telemetry epoch");
    const fill = findFillById(database, fillId);
    const keg = fill === undefined ? undefined : findKegById(database, fill.kegId);
    const presentation =
      fill === undefined
        ? undefined
        : resolveEffectivePresentationFromDb(database, fill.beverageId);
    if (fill === undefined || keg === undefined || presentation === undefined)
      throw new Error("Cannot snapshot telemetry epoch dependencies");
    const density = resolveBeverageDensity(presentation, readBeverageSettings(database).fallbackFg);
    const effective = resolveEffectiveDetectorConfig(database, tapId);
    assertDetectorConfig(effective.config);
    const membership = readDetectorArbitrationMembership(database, tapId);
    const id = this.#ids();
    const epoch: TelemetryEpoch = {
      id,
      tapId,
      sourceId: readTapTelemetryAuthority(database, tapId)?.source_id ?? null,
      fillId,
      assignmentId,
      kegId: keg.id,
      capacityMl: keg.capacityMl,
      tareG: keg.currentTareG,
      densityGPerMl: density.densityGPerMl,
      densitySource: density.source,
      normalizationVersion: TELEMETRY_NORMALIZATION_VERSION,
      detectorConfigVersion: detectorConfigVersion(effective.config),
      globalConfigRevision: effective.globalConfigRevision,
      tapOverrideRevision: effective.tapOverrideRevision,
      arbitrationGroupId: membership?.groupId ?? null,
      config: effective.config,
      startedAt: iso(at),
      startedAtEpochMs: at,
      endedAt: null,
      endedAtEpochMs: null,
      closeReason: null,
    };
    insertTelemetryEpoch(database, epoch);
    createInitialTelemetryEpochState(database, id, epoch.startedAt);
    return epoch;
  }

  #close(
    database: DatabaseExecutor,
    tapId: string,
    reason: TelemetryEpochCloseReason,
    at: number,
  ): TelemetryEpoch | undefined {
    const epoch = readOpenTelemetryEpochForTap(database, tapId);
    if (epoch === undefined) return undefined;
    const state = readTelemetryEpochState(database, epoch.id);
    if (state === undefined) throw new Error("Telemetry epoch runtime state is missing");
    updateTelemetryEpochState(database, {
      ...state,
      phase: "closed",
      candidateSessionId: null,
      candidateStartedAtMs: null,
      candidateBaselineVolumeMl: null,
      candidateLossMl: null,
      arbitrationDeadlineMs: null,
      lowestFlowVolumeMl: null,
      lastMeaningfulFlowAtMs: null,
      quietSinceMs: null,
      timeoutAtMs: null,
      cooldownUntilMs: null,
      warningCode: null,
      warningActivityFlag: false,
      warningStartedAtMs: null,
      warningReferenceVolumeMl: null,
      updatedAt: iso(at),
    });
    if (!closeTelemetryEpoch(database, epoch.id, iso(at), at, reason))
      throw new Error("Telemetry epoch close transition failed");
    return epoch;
  }

  #transition(
    database: DatabaseExecutor,
    epoch: TelemetryEpoch,
    reason: TelemetryEpochCloseReason,
    at: number,
  ): TelemetryEpoch {
    this.#close(database, epoch.tapId, reason, at);
    return this.#open(database, epoch.tapId, epoch.fillId, epoch.assignmentId, at);
  }
  #history(database: DatabaseExecutor, epochId: string) {
    return listTelemetryEpochSamples(database, epochId).map((sample) => ({
      atMs: sample.measuredAtEpochMs,
      volumeMl: sample.interpretedVolumeMl,
    }));
  }

  #advanceEpoch(database: DatabaseExecutor, epoch: TelemetryEpoch, now: number): void {
    if (readOpenTelemetryEpochForTap(database, epoch.tapId)?.id !== epoch.id) return;
    let state = readTelemetryEpochState(database, epoch.id);
    if (state === undefined) throw new Error("Telemetry epoch runtime state is missing");
    if (
      state.phase === "candidate" &&
      epoch.arbitrationGroupId !== null &&
      state.arbitrationDeadlineMs !== null &&
      state.arbitrationDeadlineMs <= now
    ) {
      const affected = this.#arbitrateGroup(database, epoch.arbitrationGroupId, now);
      if (!affected.includes(epoch.id)) return;
      state = readTelemetryEpochState(database, epoch.id)!;
    }
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const transition = advanceDetector(
        state,
        this.#history(database, epoch.id),
        epoch.config,
        now,
      );
      if (transition.effects.length === 0 && transition.state.phase === state.phase) return;
      this.#persist(
        database,
        epoch,
        { ...transition.state, epochId: epoch.id, updatedAt: iso(now) } as TelemetryEpochState,
        transition.effects,
      );
      state = readTelemetryEpochState(database, epoch.id)!;
      if (readOpenTelemetryEpochForTap(database, epoch.tapId)?.id !== epoch.id) return;
    }
  }

  #arbitrateGroup(database: DatabaseExecutor, groupId: string, now: number): readonly string[] {
    const due = listOpenCandidateDetectorStatesForGroup(database, groupId)
      .filter(
        (item) =>
          item.state.arbitrationDeadlineMs !== null && item.state.arbitrationDeadlineMs <= now,
      )
      .sort(
        (a, b) =>
          a.state.arbitrationDeadlineMs! - b.state.arbitrationDeadlineMs! ||
          (a.epoch.tapId < b.epoch.tapId ? -1 : a.epoch.tapId > b.epoch.tapId ? 1 : 0),
      );
    if (due.length === 0) return [];
    const coordinator = due[0]!;
    const decisionAt = coordinator.state.arbitrationDeadlineMs!;
    for (const item of listOpenPouringDetectorStatesForGroup(database, groupId)) {
      const terminalAt = nextDetectorDueAt(
        item.state,
        this.#history(database, item.epoch.id),
        item.epoch.config,
        decisionAt,
      );
      if (terminalAt !== null) this.#advanceEpoch(database, item.epoch, terminalAt);
    }
    const eligible = listOpenCandidateDetectorStatesForGroup(database, groupId).filter(
      (item) =>
        item.state.candidateStartedAtMs !== null && item.state.candidateStartedAtMs <= decisionAt,
    );
    const groupAlreadyPouring = listOpenPouringDetectorStatesForGroup(database, groupId).length > 0;
    const decision = groupAlreadyPouring
      ? {
          winnerTapId: null,
          suppressedTapIds: eligible.map((item) => item.epoch.tapId),
        }
      : arbitrateCandidates(
          eligible.map((item) => ({ ...item.state, tapId: item.epoch.tapId })),
          coordinator.epoch.config,
        );
    const affected: string[] = [];
    for (const item of eligible) {
      const transition =
        decision.winnerTapId === item.epoch.tapId
          ? activateCandidate(item.state, decisionAt, item.epoch.config)
          : suppressCandidate(item.state, item.epoch.config, decisionAt, "arbitration");
      this.#persist(
        database,
        item.epoch,
        {
          ...transition.state,
          epochId: item.epoch.id,
          updatedAt: iso(decisionAt),
        } as TelemetryEpochState,
        transition.effects,
      );
      affected.push(item.epoch.id);
    }
    const winner = eligible.find((item) => item.epoch.tapId === decision.winnerTapId);
    if (winner !== undefined) this.#advanceEpoch(database, winner.epoch, now);
    return affected;
  }

  #persist(
    database: DatabaseExecutor,
    epoch: TelemetryEpoch,
    state: TelemetryEpochState,
    effects: readonly DetectorEffect[],
  ): void {
    updateTelemetryEpochState(database, state);
    for (const effect of effects) {
      if (effect.type === "warning_opened") {
        const at = state.warningStartedAtMs ?? state.lastMeasuredAtMs ?? epoch.startedAtEpochMs;
        appendActivity(
          database,
          {
            category: "domain",
            action: "transition",
            actorType: "system",
            entityType: "telemetry_epoch",
            entityId: epoch.id,
            details: { transition: "implausible_jump_warning", tap_id: epoch.tapId },
            occurredAt: iso(at),
          },
          { idFactory: this.#ids },
        );
      }
      if (effect.type === "pour_completed") {
        const result = insertCompletedPourIdempotently(database, {
          id: this.#ids(),
          effectKey: `telemetry-pour:${epoch.id}:${effect.sessionId}:complete`,
          fillId: epoch.fillId,
          tapId: epoch.tapId,
          assignmentId: epoch.assignmentId,
          epochId: epoch.id,
          detectorSessionId: effect.sessionId,
          canonicalVolumeMl: effect.volumeMl,
          startedAt: iso(effect.startedAtMs),
          completedAt: iso(effect.completedAtMs),
          createdAt: iso(effect.completedAtMs),
        });
        if (result.created)
          appendActivity(
            database,
            {
              category: "domain",
              action: "transition",
              actorType: "system",
              entityType: "pour",
              entityId: result.pour.id,
              details: {
                transition: "completed",
                tap_id: epoch.tapId,
                fill_id: epoch.fillId,
                volume_ml: effect.volumeMl,
                effect_key: result.pour.effectKey,
              },
              occurredAt: iso(effect.completedAtMs),
            },
            { idFactory: this.#ids },
          );
        if (result.created) {
          const callback = this.#onPourCompleted?.(database, {
            id: result.pour.id,
            effectKey: result.pour.effectKey,
            fillId: result.pour.fillId,
            tapId: result.pour.tapId,
            assignmentId: result.pour.assignmentId,
            epochId: result.pour.epochId,
            canonicalVolumeMl: result.pour.canonicalVolumeMl,
            completedAt: result.pour.completedAt,
          });
          assertSynchronousCompletion(callback, "Pour completion callback");
        }
      }
    }
  }

  #replaceGroupMembers(groupId: string, tapIds: readonly string[], at: number): void {
    const unique = [...new Set(tapIds)];
    if (unique.length !== tapIds.length) throw new TypeError("Duplicate arbitration Tap");
    for (const tapId of unique) {
      this.#requireTap(tapId);
      const member = readDetectorArbitrationMembership(this.#database, tapId);
      if (member !== undefined && member.groupId !== groupId)
        throw new ApplicationError({
          category: "conflict",
          code: "telemetry.arbitration_membership_conflict",
          clientMessage: "A Tap can belong to only one detector arbitration group.",
        });
    }
    const previous = listDetectorArbitrationMembers(this.#database, groupId).map(
      (member) => member.tapId,
    );
    replaceDetectorArbitrationMembership(this.#database, groupId, unique, iso(at));
    for (const tapId of new Set([...previous, ...unique])) {
      const epoch = readOpenTelemetryEpochForTap(this.#database, tapId);
      const member = readDetectorArbitrationMembership(this.#database, tapId);
      if (epoch !== undefined && epoch.arbitrationGroupId !== (member?.groupId ?? null))
        this.#transition(this.#database, epoch, "arbitration_changed", at);
    }
  }

  #configurationActivity(
    entityType: string,
    entityId: string,
    at: number,
    actorOptions: DetectorActorOptions,
  ): void {
    appendActivity(
      this.#database,
      {
        category: "admin",
        action: "configuration_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId === undefined ? {} : { actorId: actorOptions.actorId }),
        ...(actorOptions.sessionId === undefined ? {} : { sessionId: actorOptions.sessionId }),
        entityType,
        entityId,
        details: { change: "updated" },
        occurredAt: iso(at),
      },
      { idFactory: this.#ids },
    );
  }
  #groupName(name: string): string {
    const normalized = name.trim();
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes < 1 || bytes > 128) throw new RangeError("Invalid detector arbitration group name");
    return normalized;
  }
  #notFound(message: string): ApplicationError {
    return new ApplicationError({
      category: "not_found",
      code: "telemetry.detector_not_found",
      clientMessage: message,
    });
  }
  #requireTap(tapId: string): void {
    if (findTapById(this.#database, tapId) === undefined)
      throw this.#notFound("Tap was not found.");
  }
}
