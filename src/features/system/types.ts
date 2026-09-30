import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { ActivityService } from "../activity/operations.ts";
import type { ActivityAction, ActivityActorType, ActivityCategory } from "../activity/types.ts";
import type { AuthService } from "../auth/service.ts";
import type { BeverageService } from "../beverages/service.ts";
import type { ForecastService } from "../forecasting/service.ts";
import type { OutboxRetentionSettings } from "../outbox/repository.ts";
import type { TelemetryService } from "../telemetry/service.ts";

export type { OutboxRetentionSettings } from "../outbox/repository.ts";

export const SYSTEM_ACTIVITY_PAGE_SIZE = 50;

export const SYSTEM_ACTIVITY_ENTITY_TYPES = [
  "admin_session",
  "auth_session_settings",
  "beverage",
  "beverage_settings",
  "beverage_pour_settings",
  "brewfather_account",
  "display_settings",
  "fill",
  "fill_settings",
  "forecast_settings",
  "health_global_config",
  "health_incident",
  "health_tap_override",
  "keg",
  "machine_api_key",
  "outbound_destination",
  "secret",
  "system_retention_settings",
  "tap",
  "tap_card_display_settings",
  "tap_card_display_override",
  "tap_line_maintenance",
  "tap_war",
  "telemetry_settings",
  "telemetry_source",
] as const;

export const SYSTEM_ACTIVITY_IDENTIFIED_ENTITY_TYPES = [
  "admin_session",
  "beverage",
  "fill",
  "health_incident",
  "keg",
  "outbound_destination",
  "tap",
  "tap_war",
  "telemetry_source",
] as const;

export type SystemActivityEntityType = (typeof SYSTEM_ACTIVITY_ENTITY_TYPES)[number];

/** A display projection; arbitrary Activity details and actor identifiers are excluded. */
export interface SystemActivityItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly category: ActivityCategory;
  readonly action: ActivityAction;
  readonly actorType: ActivityActorType;
  readonly entityType: SystemActivityEntityType | null;
  readonly entityId: string | null;
}

export interface SystemActivityCursor {
  readonly occurredAt: string;
  readonly id: string;
}

export interface SystemActivityPageQuery {
  readonly category?: unknown;
  readonly cursor?: unknown;
}

export interface SystemActivityPage {
  readonly items: readonly SystemActivityItem[];
  readonly nextCursor: string | null;
  readonly pageSize: 50;
}

export interface CalculationSettings {
  readonly fallbackFg: number;
  readonly servingSizeMl: number;
}

export interface UpdateCalculationSettingsInput {
  readonly fallbackFg?: number;
  readonly servingSizeMl?: number;
}

export interface SystemRetentionSettings {
  readonly activity: { readonly retentionDays: number; readonly updatedAt: string };
  readonly telemetry: {
    readonly rawRetentionSeconds: number;
    readonly receiptRetentionSeconds: number;
    readonly reconnectHorizonSeconds: number;
    readonly updatedAt: string;
  };
  readonly outbox: OutboxRetentionSettings;
}

export interface UpdateSystemRetentionSettingsInput {
  readonly activity?: { readonly retentionDays: number };
  readonly telemetry?: {
    readonly rawRetentionSeconds?: number;
    readonly receiptRetentionSeconds?: number;
    readonly reconnectHorizonSeconds?: number;
  };
  readonly outbox?: { readonly retentionDays: number };
}

export interface SystemActorOptions {
  readonly actorId?: string;
  readonly sessionId?: string;
}

export interface RetentionCounts {
  readonly activity: number;
  readonly rawTelemetry: number;
  readonly ingestReceipts: number;
  readonly outboxDeliveries: number;
  readonly outboxEvents: number;
  readonly outboxVersions: number;
  readonly sessions: number;
}

export interface RetentionRunResult extends RetentionCounts {
  readonly completedAt: string;
}

export interface SystemDiagnosticCounts {
  readonly activity: number;
  readonly rawTelemetry: number;
  readonly ingestReceipts: number;
  readonly outboxPending: number;
  readonly outboxLeased: number;
  readonly outboxRetry: number;
  readonly outboxTerminal: number;
  readonly sessions: number;
}

export interface SystemStorageDiagnostics {
  readonly schemaVersion: number;
  readonly pageCount: number;
  readonly freePageCount: number;
  readonly pageSizeBytes: number;
}

export interface SystemDiagnostics {
  readonly counts: SystemDiagnosticCounts;
  readonly storage: SystemStorageDiagnostics;
  readonly retention: {
    readonly running: boolean;
    readonly lastRunAt: string | null;
    readonly lastOutcome: "never_run" | "completed" | "failed";
    readonly lastPruned: RetentionCounts | null;
  };
}

export interface SystemMaintenanceError {
  readonly code: "system.retention_failed";
  readonly message: string;
}

export interface SystemServiceDependencies {
  readonly database: DatabaseExecutor;
  readonly activityService: Pick<
    ActivityService,
    "append" | "getRetention" | "setRetention" | "prune"
  >;
  readonly telemetryService: Pick<
    TelemetryService,
    "getSettings" | "updateSettings" | "pruneTelemetry"
  >;
  readonly beverageService: Pick<BeverageService, "getSettings" | "updateSettings">;
  readonly forecastService: Pick<ForecastService, "getSettings" | "updateSettings">;
  readonly authService?: Pick<AuthService, "pruneExpiredSessions">;
  readonly now?: () => Date;
  readonly maintenanceIntervalMs?: number;
  readonly onError?: (error: SystemMaintenanceError) => void;
}
