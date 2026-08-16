import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import {
  DISPLAY_ACCENTS,
  DISPLAY_FONTS,
  DISPLAY_LAYOUT_MODES,
  DISPLAY_THEMES,
  DISPLAY_UNIT_SYSTEMS,
  type DisplayAccent,
  type DisplayFont,
  type DisplayLayoutMode,
  type DisplayTheme,
  type DisplayUnitSystem,
  type UpdateDisplaySettingsInput,
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
    accent: enumValue<DisplayAccent>(object.accent, "accent", DISPLAY_ACCENTS),
    unitSystem: enumValue<DisplayUnitSystem>(object.unitSystem, "unitSystem", DISPLAY_UNIT_SYSTEMS),
    showServingTemperature: object.showServingTemperature,
    layoutMode: enumValue<DisplayLayoutMode>(object.layoutMode, "layoutMode", DISPLAY_LAYOUT_MODES),
  };
}
