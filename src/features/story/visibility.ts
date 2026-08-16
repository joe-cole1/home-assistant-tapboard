import {
  MYSTERY_ALWAYS_VISIBLE_KEYS,
  MYSTERY_REVEAL_KEYS,
  type MysteryRevealConfig,
  type MysteryRevealKey,
  type MysteryVisibilityInput,
  type MysteryVisibilityPolicy,
} from "./types.ts";

type AnyRecord = Record<string, unknown>;

export const MYSTERY_TITLE = "Mystery Tap" as const;

const REVEAL_CONFIG_KEYS: Readonly<Record<MysteryRevealKey, keyof MysteryRevealConfig>> = {
  beverage_type: "revealBeverageType",
  style: "revealStyle",
  abv: "revealAbv",
  ibu: "revealIbu",
  og: "revealOg",
  fg: "revealFg",
  srm: "revealSrm",
  description: "revealDescription",
  recipe: "revealRecipe",
  sensory: "revealSensory",
  history: "revealHistory",
};

const CAMEL_FIELDS: Readonly<Record<string, MysteryRevealKey>> = {
  beverageType: "beverage_type",
  beverage_type: "beverage_type",
  style: "style",
  abv: "abv",
  ibu: "ibu",
  og: "og",
  fg: "fg",
  srm: "srm",
  description: "description",
  recipe: "recipe",
  sensory: "sensory",
  history: "history",
};

const ALWAYS_VISIBLE_ALIASES: Readonly<Record<string, true>> = {
  tap_number: true,
  tapNumber: true,
  display_color: true,
  displayColor: true,
  fill_glass: true,
  fillGlass: true,
  remaining_amount: true,
  remainingAmount: true,
  fill_percent: true,
  fillPercent: true,
  forecast: true,
  days: true,
  servings: true,
  servings_remaining: true,
  servingsRemaining: true,
  serving_temperature: true,
  servingTemperature: true,
  serving_temperature_c: true,
  servingTemperatureC: true,
};

const PROTECTED_IDENTITY_ALIASES: Readonly<Record<string, true>> = {
  beverage_name: true,
  beverageName: true,
  custom_tap_name: true,
  customTapName: true,
  custom_name: true,
  customName: true,
  tap_name: true,
  tapName: true,
  tap_display_name: true,
  tapDisplayName: true,
  name: true,
};

function record(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function configFor(input: unknown): AnyRecord {
  const root = record(input);
  const nested = root === null ? null : record(root["config"]);
  return nested ?? root ?? {};
}

function enabledFor(input: unknown): boolean {
  const root = record(input);
  const config = configFor(input);
  return bool(root?.["enabled"]) || bool(root?.["mystery"]) || bool(config["enabled"]);
}

function revealValue(config: AnyRecord, key: MysteryRevealKey): boolean {
  const camel = REVEAL_CONFIG_KEYS[key];
  if (bool(config[camel])) return true;
  if (bool(config[key])) return true;
  const reveal = record(config["reveal"]);
  return reveal === null ? false : bool(reveal[key]);
}

export function isMysteryRevealKey(value: unknown): value is MysteryRevealKey {
  return typeof value === "string" && (MYSTERY_REVEAL_KEYS as readonly string[]).includes(value);
}

export function isMysteryAlwaysVisibleKey(value: unknown): boolean {
  return (
    typeof value === "string" && (MYSTERY_ALWAYS_VISIBLE_KEYS as readonly string[]).includes(value)
  );
}

/** Build one centralized, immutable-looking policy for all public projections. */
export function mysteryVisibilityPolicy(input: unknown): MysteryVisibilityPolicy {
  const enabled = enabledFor(input);
  const config = configFor(input);
  const reveal = {} as Record<MysteryRevealKey, boolean>;
  for (const key of MYSTERY_REVEAL_KEYS) reveal[key] = revealValue(config, key);
  return { title: enabled ? MYSTERY_TITLE : null, enabled, reveal };
}

export const resolveMysteryVisibility = mysteryVisibilityPolicy;
export const buildMysteryVisibilityPolicy = mysteryVisibilityPolicy;

function canonicalField(value: string): MysteryRevealKey | null {
  return CAMEL_FIELDS[value] ?? null;
}

/** Non-Mystery fields are visible; Mystery identity fields never reveal. */
export function isMysteryFieldVisible(field: string, input: unknown): boolean {
  const policy = mysteryVisibilityPolicy(input);
  if (!policy.enabled) return true;
  if (PROTECTED_IDENTITY_ALIASES[field] === true) return false;
  if (ALWAYS_VISIBLE_ALIASES[field] === true) return true;
  const canonical = canonicalField(field);
  if (canonical !== null) return policy.reveal[canonical];
  // Fail closed for fields not in the explicit Mystery allowlist.
  return false;
}

export const isVisible = isMysteryFieldVisible;
export const shouldRevealField = isMysteryFieldVisible;
export const isFieldVisible = isMysteryFieldVisible;

/** Return a public object containing only fields allowed by the policy. */
export function filterMysteryVisibleFields<T extends AnyRecord>(
  value: T,
  input: unknown,
): Partial<T> {
  const visible = {} as Partial<T>;
  for (const [field, fieldValue] of Object.entries(value)) {
    if (isMysteryFieldVisible(field, input)) (visible as AnyRecord)[field] = fieldValue;
  }
  return visible;
}

export const projectVisibleFields = filterMysteryVisibleFields;
export const applyMysteryVisibility = filterMysteryVisibleFields;

export function mysteryTitle(input: unknown): "Mystery Tap" | null {
  return mysteryVisibilityPolicy(input).title;
}

export function publicTitle(input: unknown, normalTitle: string): string {
  return mysteryVisibilityPolicy(input).title ?? normalTitle;
}

export type {
  MysteryRevealConfig,
  MysteryRevealKey,
  MysteryVisibilityInput,
  MysteryVisibilityPolicy,
};
