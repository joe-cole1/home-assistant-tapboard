import { invalidForm } from "./forms.ts";
import { vesselFromForm } from "./beverage-presentation.ts";

export const TAP_CARD_DISPLAY_FIELDS = [
  ["showAbv", "ABV"],
  ["showIbu", "IBU"],
  ["showOg", "OG"],
  ["showFg", "FG"],
  ["showSrm", "SRM"],
] as const;

export function tapCardOverrideFromForm(
  form: Readonly<Record<string, string>>,
): Record<(typeof TAP_CARD_DISPLAY_FIELDS)[number][0], boolean | null> {
  const result = {} as Record<(typeof TAP_CARD_DISPLAY_FIELDS)[number][0], boolean | null>;
  for (const [field, label] of TAP_CARD_DISPLAY_FIELDS) {
    const value = form[field];
    if (value === "inherit") result[field] = null;
    else if (value === "show") result[field] = true;
    else if (value === "hide") result[field] = false;
    else invalidForm(`${label} must be set to Inherit, Show, or Hide.`, field);
  }
  return result;
}

export type PresentationField =
  | "name"
  | "beverageType"
  | "style"
  | "abv"
  | "ibu"
  | "og"
  | "fg"
  | "srm"
  | "displayColor"
  | "description"
  | "fillGlass"
  | "manualDensityOverride";

export type PresentationOverride =
  { readonly inherit: true } | { readonly clear: true } | { readonly value: string | number };

export function presentationOverridesFromForm(
  form: Readonly<Record<string, string>>,
): Partial<Record<PresentationField, PresentationOverride>> {
  const result: Partial<Record<PresentationField, PresentationOverride>> = {};
  const fields: readonly PresentationField[] = [
    "name",
    "beverageType",
    "style",
    "abv",
    "ibu",
    "og",
    "fg",
    "srm",
    "displayColor",
    "description",
    "fillGlass",
    "manualDensityOverride",
  ];
  for (const field of fields) {
    const mode = form[`${field}Mode`];
    if (mode === undefined) {
      // Older forms did not expose a mode for the vessel picker. Preserve
      // that normal form action while keeping newly-supported fields absent
      // unless the detail form explicitly submits them.
      if (field === "fillGlass") {
        result[field] = { value: vesselFromForm(form[field] ?? "") ?? "" };
      }
      continue;
    }
    if (mode === "inherit") {
      result[field] = { inherit: true };
    } else if (mode === "clear" && field !== "name" && field !== "beverageType") {
      result[field] = { clear: true };
    } else if (mode !== "value") {
      invalidForm(`${field} mode must be inherit, clear, or value.`, `${field}Mode`);
    } else {
      const value = form[field] ?? "";
      if (field === "fillGlass") {
        result[field] = { value: vesselFromForm(value) ?? "" };
      } else {
        result[field] = ["abv", "ibu", "og", "fg", "srm", "manualDensityOverride"].includes(field)
          ? { value: Number(value) }
          : { value };
      }
    }
  }
  return result;
}
