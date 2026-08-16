import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { DisplaySettings, UpdateDisplaySettingsInput } from "./types.ts";

interface Row {
  revision: number;
  tapboard_name: string;
  theme: DisplaySettings["theme"];
  font: DisplaySettings["font"];
  accent: DisplaySettings["accent"];
  unit_system: DisplaySettings["unitSystem"];
  show_serving_temperature: number;
  layout_mode: DisplaySettings["layoutMode"];
  updated_at: string;
}
function map(row: Row): DisplaySettings {
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    (row.show_serving_temperature !== 0 && row.show_serving_temperature !== 1)
  )
    throw new Error("display_settings row is invalid");
  return {
    revision: row.revision,
    tapboardName: row.tapboard_name,
    theme: row.theme,
    font: row.font,
    accent: row.accent,
    unitSystem: row.unit_system,
    showServingTemperature: row.show_serving_temperature === 1,
    layoutMode: row.layout_mode,
    updatedAt: row.updated_at,
  };
}
export function readDisplaySettings(database: DatabaseExecutor): DisplaySettings {
  const row = database
    .prepare<[], Row>(
      "SELECT revision, tapboard_name, theme, font, accent, unit_system, show_serving_temperature, layout_mode, updated_at FROM display_settings WHERE id = 1",
    )
    .get();
  if (!row) throw new Error("display_settings row 1 is missing");
  return map(row);
}
export function updateDisplaySettings(
  database: DatabaseExecutor,
  input: UpdateDisplaySettingsInput,
  updatedAt: string,
): boolean {
  return (
    database
      .prepare<[string, string, string, string, string, number, string, string, number]>(
        "UPDATE display_settings SET tapboard_name = ?, theme = ?, font = ?, accent = ?, unit_system = ?, show_serving_temperature = ?, layout_mode = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?",
      )
      .run(
        input.tapboardName,
        input.theme,
        input.font,
        input.accent,
        input.unitSystem,
        input.showServingTemperature ? 1 : 0,
        input.layoutMode,
        updatedAt,
        input.expectedRevision,
      ).changes === 1
  );
}
