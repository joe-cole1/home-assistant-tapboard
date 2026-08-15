import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";

export interface ForecastSettings {
  readonly servingSizeMl: number;
  readonly updatedAt: string;
}

interface ForecastSettingsRow {
  readonly serving_size_ml: number;
  readonly updated_at: string;
}

function mapSettings(row: ForecastSettingsRow): ForecastSettings {
  return { servingSizeMl: row.serving_size_ml, updatedAt: row.updated_at };
}

export function readForecastSettings(database: DatabaseExecutor): ForecastSettings {
  const row = database
    .prepare<[], ForecastSettingsRow>(
      "SELECT serving_size_ml, updated_at FROM forecast_settings WHERE id = 1",
    )
    .get();
  if (row === undefined) throw new Error("forecast_settings row 1 is missing");
  return mapSettings(row);
}

export interface UpdateForecastSettingsResult {
  readonly previous: ForecastSettings;
  readonly current: ForecastSettings;
  readonly changed: boolean;
}

/** Does not churn updated_at for a semantically identical setting. */
export function updateForecastServingSize(
  database: DatabaseExecutor,
  servingSizeMl: number,
  updatedAt: string,
): UpdateForecastSettingsResult {
  const previous = readForecastSettings(database);
  if (previous.servingSizeMl === servingSizeMl) {
    return { previous, current: previous, changed: false };
  }
  database
    .prepare<[number, string]>(
      "UPDATE forecast_settings SET serving_size_ml = ?, updated_at = ? WHERE id = 1",
    )
    .run(servingSizeMl, updatedAt);
  return { previous, current: readForecastSettings(database), changed: true };
}
