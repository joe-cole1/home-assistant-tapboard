import { ApplicationError } from "../../shared/errors.ts";
import {
  pruneTerminalOutbox,
  readOutboxRetentionSettings,
  updateOutboxRetentionSettings,
} from "../outbox/repository.ts";
import { readSystemActivityPageRows, readSystemDiagnostics } from "./repository.ts";
import {
  SYSTEM_ACTIVITY_PAGE_SIZE,
  type CalculationSettings,
  type RetentionCounts,
  type RetentionRunResult,
  type SystemActivityPage,
  type SystemActivityPageQuery,
  type SystemActorOptions,
  type SystemDiagnostics,
  type SystemRetentionSettings,
  type SystemServiceDependencies,
} from "./types.ts";
import {
  canonicalSystemTimestamp,
  encodeActivityCursor,
  validateActivityPageQuery,
  validateCalculationSettings,
  validateRetentionHorizons,
  validateRetentionSettings,
  validateSystemActor,
} from "./system-validation.ts";

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const RETENTION_FAILURE_MESSAGE = "Retention maintenance could not be completed.";

export class SystemService {
  readonly #dependencies: SystemServiceDependencies;
  readonly #now: () => Date;
  readonly #maintenanceIntervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #maintenanceStarted = false;
  #retentionRunning = false;
  #lastRunAt: string | null = null;
  #lastOutcome: "never_run" | "completed" | "failed" = "never_run";
  #lastPruned: RetentionCounts | null = null;

  constructor(dependencies: SystemServiceDependencies) {
    const interval = dependencies.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 86_400_000) {
      throw new RangeError("System maintenance interval must be between 1 second and 1 day");
    }
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date());
    this.#maintenanceIntervalMs = interval;
  }

  getCalculationSettings(): CalculationSettings {
    return {
      fallbackFg: this.#dependencies.beverageService.getSettings().fallbackFg,
      servingSizeMl: this.#dependencies.forecastService.getSettings().servingSizeMl,
    };
  }

  updateCalculationSettings(input: unknown, actor: SystemActorOptions = {}): CalculationSettings {
    const validated = validateCalculationSettings(input);
    const validatedActor = validateSystemActor(actor);
    const at = canonicalSystemTimestamp(this.#now());
    return this.#dependencies.database.withTransaction(() => {
      const current = this.getCalculationSettings();
      if (validated.fallbackFg !== undefined && validated.fallbackFg !== current.fallbackFg) {
        // The Beverage service also closes affected density epochs; its
        // Brewfather completion policy is preserved by this partial update.
        this.#dependencies.beverageService.updateSettings(
          { fallbackFg: validated.fallbackFg },
          { ...validatedActor, now: () => new Date(at) },
        );
      }
      if (
        validated.servingSizeMl !== undefined &&
        validated.servingSizeMl !== current.servingSizeMl
      ) {
        this.#dependencies.forecastService.updateSettings(
          { servingSizeMl: validated.servingSizeMl },
          { ...validatedActor, now: () => new Date(at) },
        );
      }
      return this.getCalculationSettings();
    });
  }

  getRetentionSettings(): SystemRetentionSettings {
    const activity = this.#dependencies.activityService.getRetention();
    const telemetry = this.#dependencies.telemetryService.getSettings();
    return {
      activity: { retentionDays: activity.retentionDays, updatedAt: activity.updatedAt },
      telemetry: {
        rawRetentionSeconds: telemetry.rawRetentionSeconds,
        receiptRetentionSeconds: telemetry.receiptRetentionSeconds,
        reconnectHorizonSeconds: telemetry.reconnectHorizonSeconds,
        updatedAt: telemetry.updatedAt,
      },
      outbox: readOutboxRetentionSettings(this.#dependencies.database),
    };
  }

  updateRetentionSettings(input: unknown, actor: SystemActorOptions = {}): SystemRetentionSettings {
    const validated = validateRetentionSettings(input);
    const validatedActor = validateSystemActor(actor);
    const at = canonicalSystemTimestamp(this.#now());
    validateRetentionHorizons({ ...this.getRetentionSettings().telemetry, ...validated.telemetry });
    return this.#dependencies.database.withTransaction(() => {
      const current = this.getRetentionSettings();
      const telemetry = { ...current.telemetry, ...validated.telemetry };
      // Repeat the merged invariant under the write transaction before any
      // feature mutation so a concurrent settings change cannot evade it.
      validateRetentionHorizons(telemetry);
      let changed = false;
      if (
        validated.activity !== undefined &&
        validated.activity.retentionDays !== current.activity.retentionDays
      ) {
        this.#dependencies.activityService.setRetention(validated.activity.retentionDays, {
          now: () => new Date(at),
        });
        changed = true;
      }
      if (
        validated.telemetry !== undefined &&
        (telemetry.rawRetentionSeconds !== current.telemetry.rawRetentionSeconds ||
          telemetry.receiptRetentionSeconds !== current.telemetry.receiptRetentionSeconds ||
          telemetry.reconnectHorizonSeconds !== current.telemetry.reconnectHorizonSeconds)
      ) {
        this.#dependencies.telemetryService.updateSettings(validated.telemetry, {
          ...validatedActor,
          actorType: "admin",
        });
        changed = true;
      }
      if (
        validated.outbox !== undefined &&
        validated.outbox.retentionDays !== current.outbox.retentionDays
      ) {
        updateOutboxRetentionSettings(
          this.#dependencies.database,
          validated.outbox.retentionDays,
          at,
        );
        changed = true;
      }
      const result = this.getRetentionSettings();
      if (changed)
        this.#dependencies.activityService.append({
          category: "admin",
          action: "configuration_changed",
          actorType: "admin",
          ...validatedActor,
          entityType: "system_retention_settings",
          entityId: "1",
          occurredAt: at,
          details: {
            activity_retention_days: result.activity.retentionDays,
            raw_retention_seconds: result.telemetry.rawRetentionSeconds,
            receipt_retention_seconds: result.telemetry.receiptRetentionSeconds,
            reconnect_horizon_seconds: result.telemetry.reconnectHorizonSeconds,
            outbox_retention_days: result.outbox.retentionDays,
          },
        });
      return result;
    });
  }

  getActivityPage(query: SystemActivityPageQuery = {}): SystemActivityPage {
    const validated = validateActivityPageQuery(query);
    const rows = readSystemActivityPageRows(this.#dependencies.database, validated);
    const items = rows.slice(0, SYSTEM_ACTIVITY_PAGE_SIZE);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > SYSTEM_ACTIVITY_PAGE_SIZE && last !== undefined
          ? encodeActivityCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
      pageSize: SYSTEM_ACTIVITY_PAGE_SIZE,
    };
  }

  getDiagnostics(): SystemDiagnostics {
    return {
      ...readSystemDiagnostics(this.#dependencies.database),
      retention: {
        running: this.#retentionRunning,
        lastRunAt: this.#lastRunAt,
        lastOutcome: this.#lastOutcome,
        lastPruned: this.#lastPruned === null ? null : { ...this.#lastPruned },
      },
    };
  }

  /** Exactly one batch per feature; no backlog-draining loop or domain-history pruning. */
  runRetention(): RetentionRunResult {
    if (this.#retentionRunning)
      throw new ApplicationError({
        category: "conflict",
        code: "system.retention_running",
        clientMessage: "Retention maintenance is already running.",
      });
    this.#retentionRunning = true;
    try {
      const at = canonicalSystemTimestamp(this.#now());
      this.#lastRunAt = at;
      const counts = this.#dependencies.database.withTransaction(() => {
        const activity = this.#dependencies.activityService.prune({
          batchSize: 1_000,
          now: () => new Date(at),
        });
        const telemetry = this.#dependencies.telemetryService.pruneTelemetry(new Date(at));
        const outboxSettings = readOutboxRetentionSettings(this.#dependencies.database);
        const cutoff = new Date(
          Date.parse(at) - outboxSettings.retentionDays * 86_400_000,
        ).toISOString();
        const outbox = pruneTerminalOutbox(this.#dependencies.database, cutoff);
        const sessions =
          this.#dependencies.authService?.pruneExpiredSessions({ now: () => new Date(at) }) ?? 0;
        return {
          activity,
          rawTelemetry: telemetry.prunedMeasurementsCount,
          ingestReceipts: telemetry.prunedReceiptsCount,
          outboxDeliveries: outbox.deliveries,
          outboxEvents: outbox.events,
          outboxVersions: outbox.versions,
          sessions,
        };
      });
      this.#lastOutcome = "completed";
      this.#lastPruned = { ...counts };
      return { ...counts, completedAt: at };
    } catch {
      this.#lastOutcome = "failed";
      this.#lastPruned = null;
      throw new ApplicationError({
        category: "unavailable",
        code: "system.retention_failed",
        clientMessage: RETENTION_FAILURE_MESSAGE,
      });
    } finally {
      this.#retentionRunning = false;
    }
  }

  startMaintenance(): void {
    if (this.#maintenanceStarted) return;
    this.#maintenanceStarted = true;
    this.#scheduleMaintenance(0);
  }

  stopMaintenance(): void {
    this.#maintenanceStarted = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #scheduleMaintenance(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#maintenanceStarted) return;
      try {
        if (!this.#retentionRunning) this.runRetention();
      } catch {
        try {
          this.#dependencies.onError?.({
            code: "system.retention_failed",
            message: RETENTION_FAILURE_MESSAGE,
          });
        } catch {
          // A diagnostic callback cannot disrupt local operation or cleanup.
        }
      } finally {
        if (this.#maintenanceStarted) this.#scheduleMaintenance(this.#maintenanceIntervalMs);
      }
    }, delay);
    this.#timer.unref();
  }
}

export function createSystemService(dependencies: SystemServiceDependencies): SystemService {
  return new SystemService(dependencies);
}
