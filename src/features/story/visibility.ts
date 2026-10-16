import {
  MYSTERY_REVEAL_KEYS,
  type MysteryRevealConfig,
  type MysteryRevealKey,
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

/** Build one centralized, immutable-looking policy for all public projections. */
export function mysteryVisibilityPolicy(input: unknown): MysteryVisibilityPolicy {
  const enabled = enabledFor(input);
  const config = configFor(input);
  const reveal = {} as Record<MysteryRevealKey, boolean>;
  for (const key of MYSTERY_REVEAL_KEYS) reveal[key] = revealValue(config, key);
  return { title: enabled ? MYSTERY_TITLE : null, enabled, reveal };
}
