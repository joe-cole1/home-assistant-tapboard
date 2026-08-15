import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { findFillById } from "../fills/repository.ts";
import { findActiveAssignmentByFillId, findFirstAssignmentByFillId } from "../taps/repository.ts";
import {
  listCompletedPourHistoryPageForFill,
  listCompletedPoursForFill,
  readOpenTelemetryEpochStateForFill,
} from "../telemetry/repositories/detector.ts";
import { forecastFill } from "./forecast.ts";
import { toPublicForecastProjection } from "./projections.ts";
import {
  readForecastSettings,
  updateForecastServingSize,
  type ForecastSettings,
} from "./repository.ts";
import type {
  AdminForecastProjection,
  CurrentVolumeInput,
  ForecastPourInput,
  PublicForecastProjection,
} from "./types.ts";
import {
  encodeForecastHistoryCursor,
  validateForecastFillId,
  validateForecastHistoryLimit,
  validateUpdateForecastSettingsInput,
  type ForecastHistoryCursor,
} from "./forecast-validation.ts";

export interface ForecastHistoryItem {
  readonly pourId: string;
  readonly fillId: string;
  readonly tapId: string;
  readonly assignmentId: string;
  readonly epochId: string;
  readonly canonicalVolumeMl: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ForecastHistoryPage {
  readonly pours: readonly ForecastHistoryItem[];
  readonly nextCursor: string | null;
}
export interface ForecastActorOptions {
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
}
export interface ForecastService {
  getPourHistory(
    fillId: unknown,
    options?: { limit?: unknown; cursor?: ForecastHistoryCursor },
  ): ForecastHistoryPage;
  getForecast(fillId: unknown): AdminForecastProjection;
  getPublicForecastSummary(fillId: unknown): PublicForecastProjection;
  getSettings(): ForecastSettings;
  updateSettings(input: unknown, options?: ForecastActorOptions): ForecastSettings;
}

function notFound(fillId: string): never {
  throw new ApplicationError({
    category: "not_found",
    code: "forecast.fill_not_found",
    clientMessage: "The Fill was not found.",
    details: { fillId },
  });
}
function nowIso(now: (() => Date) | undefined): string {
  const value = now?.() ?? new Date();
  if (Number.isNaN(value.getTime())) throw new TypeError("Invalid clock in forecast service");
  return value.toISOString();
}
function mapPour(pour: {
  id: string;
  fillId: string;
  tapId: string;
  assignmentId: string;
  epochId: string;
  canonicalVolumeMl: number;
  startedAt: string;
  completedAt: string;
}): ForecastHistoryItem {
  return {
    pourId: pour.id,
    fillId: pour.fillId,
    tapId: pour.tapId,
    assignmentId: pour.assignmentId,
    epochId: pour.epochId,
    canonicalVolumeMl: pour.canonicalVolumeMl,
    startedAt: pour.startedAt,
    completedAt: pour.completedAt,
  };
}
function forecastPour(pour: {
  id: string;
  fillId: string;
  canonicalVolumeMl: number;
  startedAt: string;
  completedAt: string;
}): ForecastPourInput {
  return {
    id: pour.id,
    fillId: pour.fillId,
    attributed: true,
    volumeMl: pour.canonicalVolumeMl,
    startedAt: pour.startedAt,
    completedAt: pour.completedAt,
  };
}

export function createForecastService(
  database: DatabaseExecutor,
  options: { now?: () => Date } = {},
): ForecastService {
  const requireFill = (value: unknown) => {
    const fillId = validateForecastFillId(value);
    const fill = findFillById(database, fillId);
    if (!fill) notFound(fillId);
    return { fillId, fill };
  };
  const currentVolume = (
    fillId: string,
    asOf: string,
  ): { observationStart: string | null; current: CurrentVolumeInput } => {
    const first = findFirstAssignmentByFillId(database, fillId);
    if (!first)
      return {
        observationStart: null,
        current: { kind: "unavailable", reason: "no_assignment_history" },
      };
    const active = findActiveAssignmentByFillId(database, fillId);
    if (!active)
      return {
        observationStart: first.assignedAt,
        current: { kind: "unavailable", reason: "no_active_assignment" },
      };
    const record = readOpenTelemetryEpochStateForFill(database, fillId);
    if (
      !record ||
      record.epoch.assignmentId !== active.id ||
      record.epoch.tapId !== active.tapId ||
      record.epoch.fillId !== fillId
    )
      return {
        observationStart: first.assignedAt,
        current: { kind: "unavailable", reason: "current_volume_unavailable" },
      };
    const { epoch, state } = record;
    const measuredAt = state.lastMeasuredAtMs;
    const volume = state.lastStabilizedVolumeMl;
    const evidence = () => {
      if (
        measuredAt === null ||
        volume === null ||
        !Number.isFinite(measuredAt) ||
        !Number.isFinite(volume) ||
        !Number.isFinite(new Date(measuredAt).getTime())
      )
        return {};
      return {
        volumeMl: volume,
        capacityMl: epoch.capacityMl,
        diagnosticCode: state.lastDiagnosticCode,
        provenance: {
          identifier: "telemetry_epoch_stabilized" as const,
          epochId: epoch.id,
          tapId: epoch.tapId,
          assignmentId: epoch.assignmentId,
          measuredAt: new Date(measuredAt).toISOString(),
          asOf,
        },
      };
    };
    if (state.phase === "warning" || state.phase === "closed")
      return {
        observationStart: first.assignedAt,
        current: { kind: "anomaly", reason: "invalid_current_volume", ...evidence() },
      };
    if (state.phase === "waiting_for_measurement" || measuredAt === null || volume === null)
      return {
        observationStart: first.assignedAt,
        current: { kind: "unavailable", reason: "waiting_for_measurement" },
      };
    if (state.lastDiagnosticCode === "above_capacity")
      return {
        observationStart: first.assignedAt,
        current: { kind: "anomaly", reason: "capacity_inconsistency", ...evidence() },
      };
    if (
      state.lastDiagnosticCode !== "ok" ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      !Number.isFinite(measuredAt) ||
      !Number.isFinite(new Date(measuredAt).getTime())
    )
      return {
        observationStart: first.assignedAt,
        current: { kind: "anomaly", reason: "invalid_current_volume", ...evidence() },
      };
    if (!Number.isFinite(epoch.capacityMl) || epoch.capacityMl <= 0 || volume > epoch.capacityMl)
      return {
        observationStart: first.assignedAt,
        current: { kind: "anomaly", reason: "capacity_inconsistency", ...evidence() },
      };
    return {
      observationStart: first.assignedAt,
      current: {
        kind: "available",
        volumeMl: volume,
        capacityMl: epoch.capacityMl,
        diagnosticCode: "ok",
        provenance: {
          identifier: "telemetry_epoch_stabilized",
          epochId: epoch.id,
          tapId: epoch.tapId,
          assignmentId: epoch.assignmentId,
          measuredAt: new Date(measuredAt).toISOString(),
          asOf,
        },
      },
    };
  };
  const getForecast = (fillIdValue: unknown): AdminForecastProjection => {
    const { fillId, fill } = requireFill(fillIdValue);
    const asOf = nowIso(options.now);
    const context = currentVolume(fillId, asOf);
    return forecastFill({
      fill: { id: fillId, endedAt: fill.endedAt, observationStart: context.observationStart },
      pours: listCompletedPoursForFill(database, fillId).map(forecastPour),
      currentVolume: context.current,
      servingSizeMl: readForecastSettings(database).servingSizeMl,
      now: asOf,
    });
  };
  return {
    getPourHistory(fillIdValue, page = {}) {
      const { fillId } = requireFill(fillIdValue);
      const limit = validateForecastHistoryLimit(page.limit);
      const rows = listCompletedPourHistoryPageForFill(database, fillId, limit, page.cursor);
      const hasMore = rows.length > limit;
      const pours = rows.slice(0, limit).map(mapPour);
      const last = pours.at(-1);
      return {
        pours,
        nextCursor:
          hasMore && last
            ? encodeForecastHistoryCursor({ completedAt: last.completedAt, id: last.pourId })
            : null,
      };
    },
    getForecast,
    getPublicForecastSummary(fillIdValue) {
      return toPublicForecastProjection(getForecast(fillIdValue));
    },
    getSettings() {
      return readForecastSettings(database);
    },
    updateSettings(input, actor = {}) {
      const validated = validateUpdateForecastSettingsInput(input);
      const at = nowIso(actor.now ?? options.now);
      return database.withTransaction(() => {
        const result = updateForecastServingSize(database, validated.servingSizeMl, at);
        if (result.changed)
          appendActivity(database, {
            category: "admin",
            action: "configuration_changed",
            actorType: "admin",
            ...(actor.actorId !== undefined ? { actorId: actor.actorId } : {}),
            ...(actor.sessionId !== undefined ? { sessionId: actor.sessionId } : {}),
            entityType: "forecast_settings",
            entityId: "1",
            details: { serving_size_ml: result.current.servingSizeMl },
            occurredAt: at,
          });
        return result.current;
      });
    },
  };
}
