import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type {
  TapTelemetryAuthorityRow,
  TelemetryIngestReceiptRow,
  TelemetryMeasurementRow,
  TelemetrySettingsRow,
  TelemetrySourceRow,
  TelemetrySourceTapStatusRow,
} from "./types.ts";

/** Maximum rows removed per table by one bounded telemetry prune call. */
export const TELEMETRY_PRUNE_BATCH_SIZE = 500;

export function insertTelemetrySource(
  database: DatabaseExecutor,
  row: {
    readonly id: string;
    readonly name: string;
    readonly current_machine_key_id: string;
    readonly created_at: string;
    readonly updated_at: string;
  },
): void {
  database
    .prepare<[string, string, string, string, string]>(
      `INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.name, row.current_machine_key_id, row.created_at, row.updated_at);
}

export function updateTelemetrySourceName(
  database: DatabaseExecutor,
  id: string,
  name: string,
  updatedAt: string,
): boolean {
  const result = database
    .prepare<[string, string, string]>(
      `UPDATE telemetry_sources
       SET name = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(name, updatedAt, id);
  return result.changes > 0;
}

export function updateTelemetrySourceCurrentMachineKey(
  database: DatabaseExecutor,
  id: string,
  currentMachineKeyId: string,
  updatedAt: string,
): boolean {
  const result = database
    .prepare<[string, string, string]>(
      `UPDATE telemetry_sources
       SET current_machine_key_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(currentMachineKeyId, updatedAt, id);
  return result.changes > 0;
}

export function readTelemetrySourceById(
  database: DatabaseExecutor,
  id: string,
): TelemetrySourceRow | undefined {
  return database
    .prepare<[string], TelemetrySourceRow>(
      `SELECT id, name, current_machine_key_id, created_at, updated_at
       FROM telemetry_sources
       WHERE id = ?`,
    )
    .get(id);
}

export function readTelemetrySourceByName(
  database: DatabaseExecutor,
  name: string,
): TelemetrySourceRow | undefined {
  return database
    .prepare<[string], TelemetrySourceRow>(
      `SELECT id, name, current_machine_key_id, created_at, updated_at
       FROM telemetry_sources
       WHERE name = ?`,
    )
    .get(name);
}

export function readTelemetrySourceByCurrentMachineKeyId(
  database: DatabaseExecutor,
  keyId: string,
): TelemetrySourceRow | undefined {
  return database
    .prepare<[string], TelemetrySourceRow>(
      `SELECT id, name, current_machine_key_id, created_at, updated_at
       FROM telemetry_sources
       WHERE current_machine_key_id = ?`,
    )
    .get(keyId);
}

/** List only telemetry-owned source rows. Key descriptors are resolved by the service. */
export function listTelemetrySources(database: DatabaseExecutor): readonly TelemetrySourceRow[] {
  return database
    .prepare<[], TelemetrySourceRow>(
      `SELECT id, name, current_machine_key_id, created_at, updated_at
       FROM telemetry_sources
       ORDER BY created_at ASC, name ASC`,
    )
    .all();
}

/**
 * Compatibility alias for callers of the original repository API. Key
 * descriptors are intentionally resolved outside the telemetry repository.
 */
export const listTelemetrySourcesWithKeyDetails = listTelemetrySources;

// --- Tap Authority ---

export function readTapTelemetryAuthority(
  database: DatabaseExecutor,
  tapId: string,
): TapTelemetryAuthorityRow | undefined {
  return database
    .prepare<[string], TapTelemetryAuthorityRow>(
      `SELECT tap_id, source_id, changed_at
       FROM tap_telemetry_authority
       WHERE tap_id = ?`,
    )
    .get(tapId);
}

export function upsertTapTelemetryAuthority(
  database: DatabaseExecutor,
  tapId: string,
  sourceId: string,
  changedAt: string,
): void {
  database
    .prepare<[string, string, string]>(
      `INSERT INTO tap_telemetry_authority (tap_id, source_id, changed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(tap_id) DO UPDATE SET
         source_id = excluded.source_id,
         changed_at = excluded.changed_at`,
    )
    .run(tapId, sourceId, changedAt);
}

export function deleteTapTelemetryAuthority(database: DatabaseExecutor, tapId: string): boolean {
  const result = database
    .prepare<[string]>(`DELETE FROM tap_telemetry_authority WHERE tap_id = ?`)
    .run(tapId);
  return result.changes > 0;
}

export function listTapTelemetryAuthorities(
  database: DatabaseExecutor,
): readonly TapTelemetryAuthorityRow[] {
  return database
    .prepare<[], TapTelemetryAuthorityRow>(
      `SELECT tap_id, source_id, changed_at
       FROM tap_telemetry_authority
       ORDER BY changed_at ASC`,
    )
    .all();
}

// --- Telemetry Settings ---

export function readTelemetrySettings(database: DatabaseExecutor): TelemetrySettingsRow {
  const row = database
    .prepare<[], TelemetrySettingsRow>(
      `SELECT
         id,
         max_batch_size,
         max_future_skew_seconds,
         reconnect_horizon_seconds,
         raw_retention_seconds,
         receipt_retention_seconds,
         rate_limit_samples_per_minute,
         rate_limit_burst_samples,
         updated_at
       FROM telemetry_settings
       WHERE id = 1`,
    )
    .get();

  if (!row) {
    throw new Error("telemetry_settings row 1 is missing");
  }
  return row;
}

export function updateTelemetrySettings(
  database: DatabaseExecutor,
  settings: {
    readonly max_batch_size: number;
    readonly max_future_skew_seconds: number;
    readonly reconnect_horizon_seconds: number;
    readonly raw_retention_seconds: number;
    readonly receipt_retention_seconds: number;
    readonly rate_limit_samples_per_minute: number;
    readonly rate_limit_burst_samples: number;
    readonly updated_at: string;
  },
): void {
  database
    .prepare<[number, number, number, number, number, number, number, string]>(
      `UPDATE telemetry_settings
       SET
         max_batch_size = ?,
         max_future_skew_seconds = ?,
         reconnect_horizon_seconds = ?,
         raw_retention_seconds = ?,
         receipt_retention_seconds = ?,
         rate_limit_samples_per_minute = ?,
         rate_limit_burst_samples = ?,
         updated_at = ?
       WHERE id = 1`,
    )
    .run(
      settings.max_batch_size,
      settings.max_future_skew_seconds,
      settings.reconnect_horizon_seconds,
      settings.raw_retention_seconds,
      settings.receipt_retention_seconds,
      settings.rate_limit_samples_per_minute,
      settings.rate_limit_burst_samples,
      settings.updated_at,
    );
}

// --- Ingest Receipts ---

export function readReceiptByClientSampleId(
  database: DatabaseExecutor,
  sourceId: string,
  clientSampleId: string,
): TelemetryIngestReceiptRow | undefined {
  return database
    .prepare<[string, string], TelemetryIngestReceiptRow>(
      `SELECT
         id,
         source_id,
         tap_id,
         identity_kind,
         client_sample_id,
         measured_at_epoch_ms,
         payload_digest,
         normalization_version,
         outcome,
         outcome_code,
         accepted_measurement_id,
         measured_at,
         received_at,
         processed_at
       FROM telemetry_ingest_receipts
       WHERE source_id = ? AND client_sample_id = ?`,
    )
    .get(sourceId, clientSampleId);
}

export function readReceiptByFallbackIdentity(
  database: DatabaseExecutor,
  sourceId: string,
  tapId: string,
  measuredAtEpochMs: number,
): TelemetryIngestReceiptRow | undefined {
  return database
    .prepare<[string, string, number], TelemetryIngestReceiptRow>(
      `SELECT
         id,
         source_id,
         tap_id,
         identity_kind,
         client_sample_id,
         measured_at_epoch_ms,
         payload_digest,
         normalization_version,
         outcome,
         outcome_code,
         accepted_measurement_id,
         measured_at,
         received_at,
         processed_at
       FROM telemetry_ingest_receipts
       WHERE source_id = ? AND tap_id = ? AND measured_at_epoch_ms = ? AND client_sample_id IS NULL`,
    )
    .get(sourceId, tapId, measuredAtEpochMs);
}

export function insertTelemetryReceipt(
  database: DatabaseExecutor,
  receipt: TelemetryIngestReceiptRow,
): void {
  database
    .prepare<
      [
        string,
        string,
        string,
        string,
        string | null,
        number,
        string,
        number,
        string,
        string,
        string | null,
        string,
        string,
        string,
      ]
    >(
      `INSERT INTO telemetry_ingest_receipts (
         id,
         source_id,
         tap_id,
         identity_kind,
         client_sample_id,
         measured_at_epoch_ms,
         payload_digest,
         normalization_version,
         outcome,
         outcome_code,
         accepted_measurement_id,
         measured_at,
         received_at,
         processed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.id,
      receipt.source_id,
      receipt.tap_id,
      receipt.identity_kind,
      receipt.client_sample_id,
      receipt.measured_at_epoch_ms,
      receipt.payload_digest,
      receipt.normalization_version,
      receipt.outcome,
      receipt.outcome_code,
      receipt.accepted_measurement_id,
      receipt.measured_at,
      receipt.received_at,
      receipt.processed_at,
    );
}

export function pruneReceiptsOlderThan(database: DatabaseExecutor, processedAtIso: string): number {
  const result = database
    .prepare<[string]>(
      `DELETE FROM telemetry_ingest_receipts
       WHERE id IN (
         SELECT id
         FROM telemetry_ingest_receipts
         WHERE processed_at < ?
         ORDER BY processed_at ASC, id ASC
         LIMIT ${TELEMETRY_PRUNE_BATCH_SIZE}
       )`,
    )
    .run(processedAtIso);
  return result.changes;
}

// --- Measurements ---

export function insertTelemetryMeasurement(
  database: DatabaseExecutor,
  measurement: TelemetryMeasurementRow,
): void {
  database
    .prepare<
      [
        string,
        string,
        string,
        string,
        number,
        string,
        number,
        string,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO telemetry_measurements (
         id,
         source_id,
         tap_id,
         measured_at,
         measured_at_epoch_ms,
         received_at,
         normalization_version,
         primary_kind,
         total_mass_g,
         remaining_volume_ml,
         fill_percentage,
         temperature_c,
         captured_assignment_id,
         captured_fill_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      measurement.id,
      measurement.source_id,
      measurement.tap_id,
      measurement.measured_at,
      measurement.measured_at_epoch_ms,
      measurement.received_at,
      measurement.normalization_version,
      measurement.primary_kind,
      measurement.total_mass_g,
      measurement.remaining_volume_ml,
      measurement.fill_percentage,
      measurement.temperature_c,
      measurement.captured_assignment_id,
      measurement.captured_fill_id,
      measurement.created_at,
    );
}

export function readMeasurementById(
  database: DatabaseExecutor,
  id: string,
): TelemetryMeasurementRow | undefined {
  return database
    .prepare<[string], TelemetryMeasurementRow>(
      `SELECT
         id,
         source_id,
         tap_id,
         measured_at,
         measured_at_epoch_ms,
         received_at,
         normalization_version,
         primary_kind,
         total_mass_g,
         remaining_volume_ml,
         fill_percentage,
         temperature_c,
         captured_assignment_id,
         captured_fill_id,
         created_at
       FROM telemetry_measurements
       WHERE id = ?`,
    )
    .get(id);
}

export function pruneMeasurementsOlderThan(
  database: DatabaseExecutor,
  createdAtIso: string,
): number {
  const result = database
    .prepare<[string]>(
      `DELETE FROM telemetry_measurements
       WHERE id IN (
         SELECT id
         FROM telemetry_measurements
         WHERE created_at < ?
         ORDER BY created_at ASC, id ASC
         LIMIT ${TELEMETRY_PRUNE_BATCH_SIZE}
       )`,
    )
    .run(createdAtIso);
  return result.changes;
}

// --- Source Tap Status ---

export function readSourceTapStatus(
  database: DatabaseExecutor,
  sourceId: string,
  tapId: string,
): TelemetrySourceTapStatusRow | undefined {
  return database
    .prepare<[string, string], TelemetrySourceTapStatusRow>(
      `SELECT
         source_id,
         tap_id,
         latest_measurement_id,
         latest_measured_at,
         latest_measured_at_epoch_ms,
         latest_received_at,
         normalization_version,
         primary_kind,
         total_mass_g,
         remaining_volume_ml,
         fill_percentage,
         temperature_c,
         captured_assignment_id,
         captured_fill_id,
         updated_at
       FROM telemetry_source_tap_status
       WHERE source_id = ? AND tap_id = ?`,
    )
    .get(sourceId, tapId);
}

export function upsertSourceTapStatus(
  database: DatabaseExecutor,
  status: TelemetrySourceTapStatusRow,
): boolean {
  const result = database
    .prepare<
      [
        string,
        string,
        string | null,
        string,
        number,
        string,
        number,
        string,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO telemetry_source_tap_status (
         source_id,
         tap_id,
         latest_measurement_id,
         latest_measured_at,
         latest_measured_at_epoch_ms,
         latest_received_at,
         normalization_version,
         primary_kind,
         total_mass_g,
         remaining_volume_ml,
         fill_percentage,
         temperature_c,
         captured_assignment_id,
         captured_fill_id,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id, tap_id) DO UPDATE SET
         latest_measurement_id = excluded.latest_measurement_id,
         latest_measured_at = excluded.latest_measured_at,
         latest_measured_at_epoch_ms = excluded.latest_measured_at_epoch_ms,
         latest_received_at = excluded.latest_received_at,
         normalization_version = excluded.normalization_version,
         primary_kind = excluded.primary_kind,
         total_mass_g = excluded.total_mass_g,
         remaining_volume_ml = excluded.remaining_volume_ml,
         fill_percentage = excluded.fill_percentage,
         temperature_c = excluded.temperature_c,
         captured_assignment_id = excluded.captured_assignment_id,
         captured_fill_id = excluded.captured_fill_id,
         updated_at = excluded.updated_at
       WHERE excluded.latest_measured_at_epoch_ms > telemetry_source_tap_status.latest_measured_at_epoch_ms`,
    )
    .run(
      status.source_id,
      status.tap_id,
      status.latest_measurement_id,
      status.latest_measured_at,
      status.latest_measured_at_epoch_ms,
      status.latest_received_at,
      status.normalization_version,
      status.primary_kind,
      status.total_mass_g,
      status.remaining_volume_ml,
      status.fill_percentage,
      status.temperature_c,
      status.captured_assignment_id,
      status.captured_fill_id,
      status.updated_at,
    );
  return result.changes > 0;
}

export function listSourceTapStatusesForTap(
  database: DatabaseExecutor,
  tapId: string,
): readonly TelemetrySourceTapStatusRow[] {
  return database
    .prepare<[string], TelemetrySourceTapStatusRow>(
      `SELECT
         source_id,
         tap_id,
         latest_measurement_id,
         latest_measured_at,
         latest_measured_at_epoch_ms,
         latest_received_at,
         normalization_version,
         primary_kind,
         total_mass_g,
         remaining_volume_ml,
         fill_percentage,
         temperature_c,
         captured_assignment_id,
         captured_fill_id,
         updated_at
       FROM telemetry_source_tap_status
       WHERE tap_id = ?
       ORDER BY latest_measured_at_epoch_ms DESC`,
    )
    .all(tapId);
}

export function listAllSourceTapStatuses(
  database: DatabaseExecutor,
): readonly TelemetrySourceTapStatusRow[] {
  return database
    .prepare<[], TelemetrySourceTapStatusRow>(
      `SELECT
         source_id,
         tap_id,
         latest_measurement_id,
         latest_measured_at,
         latest_measured_at_epoch_ms,
         latest_received_at,
         normalization_version,
         primary_kind,
         total_mass_g,
         remaining_volume_ml,
         fill_percentage,
         temperature_c,
         captured_assignment_id,
         captured_fill_id,
         updated_at
       FROM telemetry_source_tap_status
       ORDER BY tap_id ASC, source_id ASC`,
    )
    .all();
}
