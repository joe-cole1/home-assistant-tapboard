import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { BeveragePourSetting } from "./types.ts";

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

interface BeveragePourRow {
  beverage_id: string;
  pour_size_ml: number;
  updated_at: string;
}

function mapBeveragePourSetting(row: BeveragePourRow): BeveragePourSetting {
  if (!Number.isFinite(row.pour_size_ml) || row.pour_size_ml <= 0) {
    throw new Error("Stored beverage pour size is invalid");
  }
  if (row.beverage_id.length === 0 || row.updated_at.length === 0) {
    throw new Error("Stored beverage pour setting identity is invalid");
  }
  return {
    beverageId: row.beverage_id,
    pourSizeMl: row.pour_size_ml,
    updatedAt: row.updated_at,
  };
}

export function readBeveragePourSetting(
  database: DatabaseExecutor,
  beverageId: string,
): BeveragePourSetting | undefined {
  const row = database
    .prepare<[string], BeveragePourRow>(
      `SELECT beverage_id, pour_size_ml, updated_at
       FROM beverage_pour_settings
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  return row === undefined ? undefined : mapBeveragePourSetting(row);
}

export interface BeveragePourSettingUpdateResult {
  readonly previous: BeveragePourSetting | undefined;
  readonly current: BeveragePourSetting | undefined;
  readonly changed: boolean;
}

/** Upsert a canonical Beverage override without churning timestamps on no-ops. */
export function updateBeveragePourSetting(
  database: DatabaseExecutor,
  beverageId: string,
  pourSizeMl: number,
  updatedAt: string,
): BeveragePourSettingUpdateResult {
  const previous = readBeveragePourSetting(database, beverageId);
  if (previous !== undefined && previous.pourSizeMl === pourSizeMl) {
    return { previous, current: previous, changed: false };
  }
  if (previous === undefined) {
    database
      .prepare<[string, number, string]>(
        `INSERT INTO beverage_pour_settings (beverage_id, pour_size_ml, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(beverageId, pourSizeMl, updatedAt);
  } else {
    database
      .prepare<[number, string, string]>(
        `UPDATE beverage_pour_settings
         SET pour_size_ml = ?, updated_at = ?
         WHERE beverage_id = ?`,
      )
      .run(pourSizeMl, updatedAt, beverageId);
  }
  return { previous, current: readBeveragePourSetting(database, beverageId), changed: true };
}

export function deleteBeveragePourSetting(database: DatabaseExecutor, beverageId: string): boolean {
  return (
    database
      .prepare<[string]>("DELETE FROM beverage_pour_settings WHERE beverage_id = ?")
      .run(beverageId).changes > 0
  );
}

export function readEffectiveServingSizeForBeverage(
  database: DatabaseExecutor,
  beverageId: string,
): { readonly servingSizeMl: number; readonly source: "beverage" | "global" } {
  const override = readBeveragePourSetting(database, beverageId);
  return override === undefined
    ? { servingSizeMl: readForecastSettings(database).servingSizeMl, source: "global" }
    : { servingSizeMl: override.pourSizeMl, source: "beverage" };
}
