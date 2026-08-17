import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";

export const TELEMETRY_NORMALIZATION_VERSION = 1;

export type TelemetryPrimaryKind = "total_weight" | "remaining_volume" | "fill_percentage";
export type MassUnit = "g" | "kg" | "oz" | "lb";
export type TotalWeightUnit = MassUnit;
export type VolumeUnit = "ml" | "l" | "us_fl_oz" | "us_gal";
export type RemainingVolumeUnit = VolumeUnit;
export type TemperatureUnit = "c" | "f";
export type PercentageUnit = "percent" | "pct" | "%";

/**
 * Machine-facing v1 request shapes.  These deliberately use the stable
 * snake_case wire contract; the camelCase shapes below are retained as the
 * service's internal ingestion port.
 */
export type ExternalTelemetryMeasurementInput =
  | {
      readonly kind: "total_weight";
      readonly value: number;
      readonly unit: MassUnit;
    }
  | {
      readonly kind: "remaining_volume";
      readonly value: number;
      readonly unit: VolumeUnit;
    }
  | {
      readonly kind: "fill_percentage";
      readonly value: number;
      readonly unit: "percent";
    };

export interface ExternalTelemetryTemperatureInput {
  readonly value: number;
  readonly unit: TemperatureUnit;
}

export interface ExternalTelemetryRequestInput {
  readonly client_sample_id?: string;
  readonly measured_at: string;
  readonly measurement: ExternalTelemetryMeasurementInput;
  readonly temperature?: ExternalTelemetryTemperatureInput;
}

export interface ExternalBatchTelemetryRequestSampleInput extends ExternalTelemetryRequestInput {
  readonly tap_number: number;
}

export interface ExternalBatchTelemetryRequestInput {
  readonly samples: readonly ExternalBatchTelemetryRequestSampleInput[];
}

// --- Database Rows ---

export interface TelemetrySourceRow {
  readonly id: string;
  readonly name: string;
  readonly current_machine_key_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
}

export interface TelemetrySourceWithKeyRow {
  readonly id: string;
  readonly name: string;
  readonly current_machine_key_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly disabled_at: string | null;
  readonly current_machine_key_public_id: string;
  readonly current_machine_key_label: string;
  readonly current_machine_key_created_at: string;
  readonly current_machine_key_revoked_at: string | null;
}

export interface TapTelemetryAuthorityRow {
  readonly tap_id: string;
  readonly source_id: string;
  readonly changed_at: string;
}

export interface TelemetrySettingsRow {
  readonly id: number;
  readonly max_batch_size: number;
  readonly max_future_skew_seconds: number;
  readonly reconnect_horizon_seconds: number;
  readonly raw_retention_seconds: number;
  readonly receipt_retention_seconds: number;
  readonly rate_limit_samples_per_minute: number;
  readonly rate_limit_burst_samples: number;
  readonly updated_at: string;
}

export interface TelemetryIngestReceiptRow {
  readonly id: string;
  readonly source_id: string;
  readonly tap_id: string;
  readonly identity_kind: "client_sample_id" | "fallback";
  readonly client_sample_id: string | null;
  readonly measured_at_epoch_ms: number;
  readonly payload_digest: string;
  readonly normalization_version: number;
  readonly outcome: "accepted" | "rejected";
  readonly outcome_code: string;
  readonly accepted_measurement_id: string | null;
  readonly measured_at: string;
  readonly received_at: string;
  readonly processed_at: string;
}

export interface TelemetryMeasurementRow {
  readonly id: string;
  readonly source_id: string;
  readonly tap_id: string;
  readonly measured_at: string;
  readonly measured_at_epoch_ms: number;
  readonly received_at: string;
  readonly normalization_version: number;
  readonly primary_kind: string;
  readonly total_mass_g: number | null;
  readonly remaining_volume_ml: number | null;
  readonly fill_percentage: number | null;
  readonly temperature_c: number | null;
  readonly captured_assignment_id: string | null;
  readonly captured_fill_id: string | null;
  readonly created_at: string;
}

export interface TelemetrySourceTapStatusRow {
  readonly source_id: string;
  readonly tap_id: string;
  readonly latest_measurement_id: string | null;
  readonly latest_measured_at: string;
  readonly latest_measured_at_epoch_ms: number;
  readonly latest_received_at: string;
  readonly normalization_version: number;
  readonly primary_kind: string;
  readonly total_mass_g: number | null;
  readonly remaining_volume_ml: number | null;
  readonly fill_percentage: number | null;
  readonly temperature_c: number | null;
  readonly captured_assignment_id: string | null;
  readonly captured_fill_id: string | null;
  readonly updated_at: string;
}

// --- Domain Models ---

export interface TelemetrySource {
  readonly id: string;
  readonly name: string;
  readonly currentMachineKeyId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
}

export interface TelemetrySourceWithKeyDetails {
  readonly id: string;
  readonly name: string;
  readonly currentMachineKeyId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disabledAt: string | null;
  readonly currentMachineKey: {
    readonly id: string;
    readonly publicId: string;
    readonly label: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
  };
}

export type TelemetryAdminSourceState = "active" | "disabled";

export interface TelemetryAdminSourcePageQuery {
  readonly q?: unknown;
  readonly state?: unknown;
  readonly page?: unknown;
}

export interface TelemetryAdminSourcePage {
  readonly items: readonly TelemetrySourceWithKeyDetails[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly query: string;
  readonly state: TelemetryAdminSourceState;
}

export interface TapTelemetryAuthority {
  readonly tapId: string;
  readonly sourceId: string;
  readonly changedAt: string;
}

export interface TelemetrySettings {
  readonly maxBatchSize: number;
  readonly maxFutureSkewSeconds: number;
  readonly reconnectHorizonSeconds: number;
  readonly rawRetentionSeconds: number;
  readonly receiptRetentionSeconds: number;
  readonly rateLimitSamplesPerMinute: number;
  readonly rateLimitBurstSamples: number;
  readonly updatedAt: string;
}

export interface TelemetryIngestReceipt {
  readonly id: string;
  readonly sourceId: string;
  readonly tapId: string;
  readonly identityKind: "client_sample_id" | "fallback";
  readonly clientSampleId: string | null;
  readonly measuredAtEpochMs: number;
  readonly payloadDigest: string;
  readonly normalizationVersion: number;
  readonly outcome: "accepted" | "rejected";
  readonly outcomeCode: string;
  readonly acceptedMeasurementId: string | null;
  readonly measuredAt: string;
  readonly receivedAt: string;
  readonly processedAt: string;
}

export interface TelemetryMeasurement {
  readonly id: string;
  readonly sourceId: string;
  readonly tapId: string;
  readonly measuredAt: string;
  readonly measuredAtEpochMs: number;
  readonly receivedAt: string;
  readonly normalizationVersion: number;
  readonly primaryKind: TelemetryPrimaryKind;
  readonly totalMassG: number | null;
  readonly remainingVolumeMl: number | null;
  readonly fillPercentage: number | null;
  readonly temperatureC: number | null;
  readonly capturedAssignmentId: string | null;
  readonly capturedFillId: string | null;
  readonly createdAt: string;
}

export interface TelemetrySourceTapStatus {
  readonly sourceId: string;
  readonly tapId: string;
  readonly latestMeasurementId: string | null;
  readonly latestMeasuredAt: string;
  readonly latestMeasuredAtEpochMs: number;
  readonly latestReceivedAt: string;
  readonly normalizationVersion: number;
  readonly primaryKind: TelemetryPrimaryKind;
  readonly totalMassG: number | null;
  readonly remainingVolumeMl: number | null;
  readonly fillPercentage: number | null;
  readonly temperatureC: number | null;
  readonly capturedAssignmentId: string | null;
  readonly capturedFillId: string | null;
  readonly updatedAt: string;
}

// --- Admin Inputs ---

export interface CreateTelemetrySourceInput {
  readonly name: string;
  readonly label?: string;
}

export interface RenameTelemetrySourceInput {
  readonly name: string;
}

export interface RotateTelemetrySourceInput {
  readonly label?: string;
}

export interface AssignAuthorityInput {
  readonly sourceId: string | null;
}

export interface UpdateTelemetrySettingsInput {
  readonly maxBatchSize?: number;
  readonly maxFutureSkewSeconds?: number;
  readonly reconnectHorizonSeconds?: number;
  readonly rawRetentionSeconds?: number;
  readonly receiptRetentionSeconds?: number;
  readonly rateLimitSamplesPerMinute?: number;
  readonly rateLimitBurstSamples?: number;
}

// --- External Ingestion Inputs ---

export interface ExternalTelemetrySampleInput {
  readonly clientSampleId?: string;
  readonly measuredAt: string;
  readonly totalWeight?: { readonly value: number; readonly unit: MassUnit };
  readonly remainingVolume?: { readonly value: number; readonly unit: VolumeUnit };
  readonly fillPercentage?: number | { readonly value: number; readonly unit?: PercentageUnit };
  readonly temperature?: { readonly value: number; readonly unit: TemperatureUnit };
}

export interface ExternalBatchTelemetrySampleInput extends ExternalTelemetrySampleInput {
  readonly tapNumber?: number;
  readonly tapId?: string;
}

export interface ExternalBatchTelemetryInput {
  readonly samples: readonly ExternalBatchTelemetrySampleInput[];
}

export interface NormalizedTelemetrySample {
  readonly clientSampleId?: string;
  readonly measuredAt: string;
  readonly measuredAtEpochMs: number;
  readonly normalizationVersion: 1;
  readonly primaryKind: TelemetryPrimaryKind;
  readonly totalMassG?: number;
  readonly remainingVolumeMl?: number;
  readonly fillPercentage?: number;
  readonly temperatureC?: number;
}

// --- Results & Extension Ports ---

export interface SingleIngestResult {
  readonly outcome: "accepted" | "rejected";
  readonly code: string;
  readonly duplicate: boolean;
  readonly acceptedMeasurementId?: string;
  readonly processedAt: string;
}

export interface BatchItemIngestResult {
  readonly index: number;
  readonly tapNumber: number;
  readonly clientSampleId?: string;
  readonly outcome: "accepted" | "rejected";
  readonly code: string;
  readonly duplicate: boolean;
  readonly acceptedMeasurementId?: string;
  readonly processedAt: string;
}

export interface BatchIngestResult {
  readonly processedCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly duplicateCount: number;
  readonly results: readonly BatchItemIngestResult[];
}

export interface AuthorityChangedEvent {
  readonly tapId: string;
  readonly previousSourceId: string | null;
  readonly newSourceId: string | null;
  readonly changedAt: string;
  readonly requiresFreshBaseline: true;
}

export interface TelemetryAuthorityExtensionPort {
  onAuthorityChanged(database: DatabaseExecutor, event: AuthorityChangedEvent): void;
}

export interface AcceptedSampleEvent {
  readonly measurementId: string;
  readonly sourceId: string;
  readonly tapId: string;
  readonly measuredAt: string;
  readonly receivedAt: string;
  readonly normalizationVersion: 1;
  readonly primaryMeasurement: {
    readonly kind: TelemetryPrimaryKind;
    readonly value: number;
  };
  readonly temperatureC: number | null;
  readonly capturedAssignmentId: string | null;
  readonly capturedFillId: string | null;
}

export interface AcceptedTelemetryExtensionPort {
  onAcceptedSample(database: DatabaseExecutor, event: AcceptedSampleEvent): void;
}

export interface TelemetryRateLimiter {
  consume(
    sourceId: string,
    count: number,
    nowMs: number,
    settings: {
      readonly rateLimitSamplesPerMinute: number;
      readonly rateLimitBurstSamples: number;
    },
  ): boolean;
  reset?(sourceId?: string): void;
}
