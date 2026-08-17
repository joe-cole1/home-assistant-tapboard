import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import {
  DISPLAY_FONTS,
  DISPLAY_LAYOUT_MODES,
  DISPLAY_THEMES,
  DISPLAY_UNIT_SYSTEMS,
  TAP_CARD_REMAINING_MODES,
  type TapCardDisplayOverridePatch,
  type TapCardRemainingMode,
  type UpdateTapCardDisplaySettingsInput,
  type DisplayAccent,
  type DisplayFont,
  type DisplayLayoutMode,
  type DisplayTheme,
  type DisplayUnitSystem,
  type UpdateDisplaySettingsInput,
  isDisplayAccent,
} from "./types.ts";

function invalid(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}
function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw invalid(field, "has an unsupported value");
  return value as T;
}

function accentValue(value: unknown): DisplayAccent {
  if (!isDisplayAccent(value))
    throw invalid("accent", "must be a named accent or lowercase #rrggbb");
  return value;
}

export function validateUpdateDisplaySettingsInput(input: unknown): UpdateDisplaySettingsInput {
  const object = requirePlainObject(input, "body");
  const keys = [
    "expectedRevision",
    "tapboardName",
    "theme",
    "font",
    "accent",
    "unitSystem",
    "showServingTemperature",
    "layoutMode",
  ] as const;
  rejectUnknownKeys(object, keys, "body");
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    throw invalid("body", "must contain every display setting");
  if (
    typeof object.expectedRevision !== "number" ||
    !Number.isSafeInteger(object.expectedRevision) ||
    object.expectedRevision < 1
  )
    throw invalid("expectedRevision", "must be a positive integer");
  if (
    typeof object.tapboardName !== "string" ||
    object.tapboardName.length < 1 ||
    object.tapboardName.length > 80 ||
    object.tapboardName.trim().length < 1 ||
    /[\u0000-\u001F\u007F-\u009F]/.test(object.tapboardName)
  )
    throw invalid("tapboardName", "must contain 1 to 80 non-control characters");
  if (typeof object.showServingTemperature !== "boolean")
    throw invalid("showServingTemperature", "must be a boolean");
  return {
    expectedRevision: object.expectedRevision,
    tapboardName: object.tapboardName,
    theme: enumValue<DisplayTheme>(object.theme, "theme", DISPLAY_THEMES),
    font: enumValue<DisplayFont>(object.font, "font", DISPLAY_FONTS),
    accent: accentValue(object.accent),
    unitSystem: enumValue<DisplayUnitSystem>(object.unitSystem, "unitSystem", DISPLAY_UNIT_SYSTEMS),
    showServingTemperature: object.showServingTemperature,
    layoutMode: enumValue<DisplayLayoutMode>(object.layoutMode, "layoutMode", DISPLAY_LAYOUT_MODES),
  };
}

export function validateTapCardDisplaySettingsInput(
  input: unknown,
): UpdateTapCardDisplaySettingsInput {
  const object = requirePlainObject(input, "body");
  const keys = [
    "expectedRevision",
    "showAbv",
    "showIbu",
    "showOg",
    "showFg",
    "showSrm",
    "remainingMode",
  ] as const;
  rejectUnknownKeys(object, keys, "body");
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    throw invalid("body", "must contain every Tap card display setting");
  if (
    typeof object.expectedRevision !== "number" ||
    !Number.isSafeInteger(object.expectedRevision) ||
    object.expectedRevision < 1
  )
    throw invalid("expectedRevision", "must be a positive integer");
  for (const field of ["showAbv", "showIbu", "showOg", "showFg", "showSrm"] as const) {
    if (typeof object[field] !== "boolean") throw invalid(field, "must be a boolean");
  }
  return {
    expectedRevision: object.expectedRevision,
    showAbv: object.showAbv as boolean,
    showIbu: object.showIbu as boolean,
    showOg: object.showOg as boolean,
    showFg: object.showFg as boolean,
    showSrm: object.showSrm as boolean,
    remainingMode: enumValue<TapCardRemainingMode>(
      object.remainingMode,
      "remainingMode",
      TAP_CARD_REMAINING_MODES,
    ),
  };
}

export const validateUpdateTapCardDisplaySettingsInput = validateTapCardDisplaySettingsInput;

const TAP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type MutableTapCardDisplayOverridePatch = {
  -readonly [Key in keyof TapCardDisplayOverridePatch]?: TapCardDisplayOverridePatch[Key];
};

export function validateTapCardDisplayOverridePatch(input: unknown): TapCardDisplayOverridePatch {
  const object = requirePlainObject(input, "body");
  const keys = ["showAbv", "showIbu", "showOg", "showFg", "showSrm"] as const;
  rejectUnknownKeys(object, keys, "body");
  const result: MutableTapCardDisplayOverridePatch = {};
  for (const field of keys) {
    if (!Object.hasOwn(object, field)) continue;
    const value = object[field];
    if (value !== null && typeof value !== "boolean")
      throw invalid(field, "must be a boolean or null");
    result[field] = value;
  }
  return result;
}

export const validateTapCardDisplayOverrideInput = validateTapCardDisplayOverridePatch;

export function validateTapCardId(value: unknown, field = "tapId"): string {
  if (typeof value !== "string" || !TAP_UUID.test(value.trim())) {
    throw invalid(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}
