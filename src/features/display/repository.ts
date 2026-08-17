import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type {
  DisplaySettings,
  EffectiveTapCardDisplaySettings,
  TapCardDisplayOverride,
  TapCardDisplayOverridePatch,
  TapCardDisplaySettings,
  UpdateDisplaySettingsInput,
  UpdateTapCardDisplaySettingsInput,
} from "./types.ts";
import { isDisplayAccent } from "./types.ts";

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
    (row.show_serving_temperature !== 0 && row.show_serving_temperature !== 1) ||
    !isDisplayAccent(row.accent)
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

interface TapCardSettingsRow {
  revision: number;
  show_abv: number;
  show_ibu: number;
  show_og: number;
  show_fg: number;
  show_srm: number;
  remaining_mode: TapCardDisplaySettings["remainingMode"];
  updated_at: string;
}

interface TapCardOverrideRow {
  tap_id: string;
  show_abv: number | null;
  show_ibu: number | null;
  show_og: number | null;
  show_fg: number | null;
  show_srm: number | null;
  updated_at: string;
}

function rowBoolean(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) throw new Error(`tap card setting ${field} is invalid`);
  return value === 1;
}

function rowNullableBoolean(value: number | null, field: string): boolean | null {
  if (value === null) return null;
  return rowBoolean(value, field);
}

function mapTapCardSettings(row: TapCardSettingsRow): TapCardDisplaySettings {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error("tap_card_display_settings revision is invalid");
  }
  return {
    revision: row.revision,
    showAbv: rowBoolean(row.show_abv, "show_abv"),
    showIbu: rowBoolean(row.show_ibu, "show_ibu"),
    showOg: rowBoolean(row.show_og, "show_og"),
    showFg: rowBoolean(row.show_fg, "show_fg"),
    showSrm: rowBoolean(row.show_srm, "show_srm"),
    remainingMode: row.remaining_mode,
    updatedAt: row.updated_at,
  };
}

function mapTapCardOverride(row: TapCardOverrideRow): TapCardDisplayOverride {
  return {
    tapId: row.tap_id,
    showAbv: rowNullableBoolean(row.show_abv, "show_abv"),
    showIbu: rowNullableBoolean(row.show_ibu, "show_ibu"),
    showOg: rowNullableBoolean(row.show_og, "show_og"),
    showFg: rowNullableBoolean(row.show_fg, "show_fg"),
    showSrm: rowNullableBoolean(row.show_srm, "show_srm"),
    updatedAt: row.updated_at,
  };
}

const TAP_CARD_SETTINGS_SELECT =
  "revision, show_abv, show_ibu, show_og, show_fg, show_srm, remaining_mode, updated_at";
const TAP_CARD_OVERRIDE_SELECT =
  "tap_id, show_abv, show_ibu, show_og, show_fg, show_srm, updated_at";

export function readTapCardDisplaySettings(database: DatabaseExecutor): TapCardDisplaySettings {
  const row = database
    .prepare<[], TapCardSettingsRow>(
      `SELECT ${TAP_CARD_SETTINGS_SELECT}
       FROM tap_card_display_settings
       WHERE id = 1`,
    )
    .get();
  if (row === undefined) throw new Error("tap_card_display_settings row 1 is missing");
  return mapTapCardSettings(row);
}

export function updateTapCardDisplaySettings(
  database: DatabaseExecutor,
  input: UpdateTapCardDisplaySettingsInput,
  updatedAt: string,
): boolean {
  return (
    database
      .prepare<unknown[]>(
        `UPDATE tap_card_display_settings
         SET show_abv = ?, show_ibu = ?, show_og = ?, show_fg = ?, show_srm = ?,
             remaining_mode = ?, revision = revision + 1, updated_at = ?
         WHERE id = 1 AND revision = ?`,
      )
      .run(
        input.showAbv ? 1 : 0,
        input.showIbu ? 1 : 0,
        input.showOg ? 1 : 0,
        input.showFg ? 1 : 0,
        input.showSrm ? 1 : 0,
        input.remainingMode,
        updatedAt,
        input.expectedRevision,
      ).changes === 1
  );
}

export function readTapCardDisplayOverride(
  database: DatabaseExecutor,
  tapId: string,
): TapCardDisplayOverride | undefined {
  const row = database
    .prepare<[string], TapCardOverrideRow>(
      `SELECT ${TAP_CARD_OVERRIDE_SELECT}
       FROM tap_card_display_overrides
       WHERE tap_id = ?`,
    )
    .get(tapId);
  return row === undefined ? undefined : mapTapCardOverride(row);
}

export interface TapCardDisplayOverrideUpdateResult {
  readonly previous: TapCardDisplayOverride | undefined;
  readonly current: TapCardDisplayOverride | undefined;
  readonly changed: boolean;
}

const overrideValues = (override: TapCardDisplayOverridePatch): readonly (number | null)[] => [
  override.showAbv === undefined || override.showAbv === null ? null : override.showAbv ? 1 : 0,
  override.showIbu === undefined || override.showIbu === null ? null : override.showIbu ? 1 : 0,
  override.showOg === undefined || override.showOg === null ? null : override.showOg ? 1 : 0,
  override.showFg === undefined || override.showFg === null ? null : override.showFg ? 1 : 0,
  override.showSrm === undefined || override.showSrm === null ? null : override.showSrm ? 1 : 0,
];

export function upsertTapCardDisplayOverride(
  database: DatabaseExecutor,
  tapId: string,
  override: TapCardDisplayOverridePatch,
  updatedAt: string,
): TapCardDisplayOverrideUpdateResult {
  const previous = readTapCardDisplayOverride(database, tapId);
  const values = overrideValues(override);
  if (values.every((value) => value === null)) {
    if (previous === undefined) return { previous, current: previous, changed: false };
    database
      .prepare<[string]>("DELETE FROM tap_card_display_overrides WHERE tap_id = ?")
      .run(tapId);
    return { previous, current: undefined, changed: true };
  }
  const oldValues = previous === undefined ? [] : overrideValues(previous);
  const changed =
    previous === undefined || values.some((value, index) => value !== oldValues[index]);
  if (!changed) return { previous, current: previous, changed: false };
  if (previous === undefined) {
    database
      .prepare<unknown[]>(
        `INSERT INTO tap_card_display_overrides
         (tap_id, show_abv, show_ibu, show_og, show_fg, show_srm, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tapId, ...values, updatedAt);
  } else {
    database
      .prepare<unknown[]>(
        `UPDATE tap_card_display_overrides
         SET show_abv = ?, show_ibu = ?, show_og = ?, show_fg = ?, show_srm = ?, updated_at = ?
         WHERE tap_id = ?`,
      )
      .run(...values, updatedAt, tapId);
  }
  return { previous, current: readTapCardDisplayOverride(database, tapId), changed: true };
}

export function deleteTapCardDisplayOverride(database: DatabaseExecutor, tapId: string): boolean {
  return (
    database.prepare<[string]>("DELETE FROM tap_card_display_overrides WHERE tap_id = ?").run(tapId)
      .changes > 0
  );
}

export function resolveTapCardDisplaySettings(
  database: DatabaseExecutor,
  tapId: string,
): EffectiveTapCardDisplaySettings {
  const base = readTapCardDisplaySettings(database);
  const override = readTapCardDisplayOverride(database, tapId);
  return {
    tapId,
    settings: {
      showAbv: override?.showAbv ?? base.showAbv,
      showIbu: override?.showIbu ?? base.showIbu,
      showOg: override?.showOg ?? base.showOg,
      showFg: override?.showFg ?? base.showFg,
      showSrm: override?.showSrm ?? base.showSrm,
      remainingMode: base.remainingMode,
    },
    override: override ?? null,
  };
}
