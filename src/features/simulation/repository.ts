import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { SimulationSensor, SimulationSettings } from "./types.ts";

interface SettingsRow {
  readonly enabled: number;
  readonly revision: number;
  readonly seeded: number;
}

interface SensorRow {
  readonly tap_id: string;
  readonly source_id: string;
  readonly remaining_ml: number;
  readonly temperature_c: number;
  readonly online: number;
  readonly noise_enabled: number;
  readonly sequence: number;
}

const SENSOR_COLUMNS =
  "tap_id, source_id, remaining_ml, temperature_c, online, noise_enabled, sequence";

function sensor(row: SensorRow): SimulationSensor {
  return {
    tapId: row.tap_id,
    sourceId: row.source_id,
    remainingMl: row.remaining_ml,
    temperatureC: row.temperature_c,
    online: row.online === 1,
    noiseEnabled: row.noise_enabled === 1,
    sequence: row.sequence,
  };
}

export function readSettings(database: DatabaseExecutor): SimulationSettings {
  const row = database
    .prepare<[], SettingsRow>(
      "SELECT enabled, revision, seeded FROM simulation_settings WHERE singleton = 1",
    )
    .get();
  if (row === undefined) throw new Error("Simulation settings are missing");
  return { enabled: row.enabled === 1, revision: row.revision, seeded: row.seeded === 1 };
}

export function setEnabled(database: DatabaseExecutor, enabled: boolean): SimulationSettings {
  if (typeof enabled !== "boolean") throw new TypeError("Simulation enabled must be boolean");
  database
    .prepare<[number]>(
      "UPDATE simulation_settings SET enabled = ?, revision = revision + 1 WHERE singleton = 1",
    )
    .run(enabled ? 1 : 0);
  return readSettings(database);
}

export function setSeeded(database: DatabaseExecutor): SimulationSettings {
  database.prepare("UPDATE simulation_settings SET seeded = 1 WHERE singleton = 1").run();
  return readSettings(database);
}

export function bumpRevision(database: DatabaseExecutor): SimulationSettings {
  database
    .prepare("UPDATE simulation_settings SET revision = revision + 1 WHERE singleton = 1")
    .run();
  return readSettings(database);
}

export function listSensors(database: DatabaseExecutor): readonly SimulationSensor[] {
  return database
    .prepare<[], SensorRow>(`SELECT ${SENSOR_COLUMNS} FROM simulation_sensors ORDER BY tap_id`)
    .all()
    .map(sensor);
}

export function readSensor(
  database: DatabaseExecutor,
  tapId: string,
): SimulationSensor | undefined {
  const row = database
    .prepare<[string], SensorRow>(
      `SELECT ${SENSOR_COLUMNS} FROM simulation_sensors WHERE tap_id = ?`,
    )
    .get(tapId);
  return row === undefined ? undefined : sensor(row);
}

export function readFillVolume(database: DatabaseExecutor, fillId: string): number | undefined {
  return database
    .prepare<[string], { readonly remaining_ml: number }>(
      "SELECT remaining_ml FROM simulation_fill_volumes WHERE fill_id = ?",
    )
    .get(fillId)?.remaining_ml;
}

export function setFillVolume(
  database: DatabaseExecutor,
  fillId: string,
  remainingMl: number,
): void {
  if (!Number.isFinite(remainingMl) || remainingMl < 0)
    throw new RangeError("Simulation Fill volume must be non-negative");
  database
    .prepare<[string, number]>(
      `INSERT INTO simulation_fill_volumes (fill_id, remaining_ml) VALUES (?, ?)
       ON CONFLICT(fill_id) DO UPDATE SET remaining_ml = excluded.remaining_ml`,
    )
    .run(fillId, remainingMl);
}

export function insertSensor(database: DatabaseExecutor, value: SimulationSensor): void {
  validateSensor(value);
  database
    .prepare<[string, string, number, number, number, number, number]>(
      `INSERT INTO simulation_sensors (${SENSOR_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      value.tapId,
      value.sourceId,
      value.remainingMl,
      value.temperatureC,
      value.online ? 1 : 0,
      value.noiseEnabled ? 1 : 0,
      value.sequence,
    );
}

export function updateSensor(database: DatabaseExecutor, value: SimulationSensor): void {
  validateSensor(value);
  const result = database
    .prepare<[string, number, number, number, number, number, string]>(
      `UPDATE simulation_sensors SET source_id = ?, remaining_ml = ?, temperature_c = ?,
       online = ?, noise_enabled = ?, sequence = ? WHERE tap_id = ?`,
    )
    .run(
      value.sourceId,
      value.remainingMl,
      value.temperatureC,
      value.online ? 1 : 0,
      value.noiseEnabled ? 1 : 0,
      value.sequence,
      value.tapId,
    );
  if (result.changes !== 1) throw new Error("Simulation sensor is missing");
}

export function deleteSensor(database: DatabaseExecutor, tapId: string): boolean {
  return (
    database.prepare<[string]>("DELETE FROM simulation_sensors WHERE tap_id = ?").run(tapId)
      .changes === 1
  );
}

function validateSensor(value: SimulationSensor): void {
  if (!Number.isFinite(value.remainingMl) || value.remainingMl < 0)
    throw new RangeError("Simulation remaining volume must be non-negative");
  if (!Number.isFinite(value.temperatureC) || value.temperatureC < -20 || value.temperatureC > 80)
    throw new RangeError("Simulation temperature must be between -20 and 80 Celsius");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0)
    throw new RangeError("Simulation sample sequence must be non-negative");
  if (typeof value.online !== "boolean" || typeof value.noiseEnabled !== "boolean")
    throw new TypeError("Simulation sensor switches must be boolean");
}
