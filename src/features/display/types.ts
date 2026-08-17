export const DISPLAY_THEMES = ["modern_dark", "warm_pub", "cyberpunk", "light_minimal"] as const;
export const DISPLAY_FONTS = [
  "system",
  "outfit",
  "inter",
  "roboto",
  "fredoka",
  "montserrat",
  "barlow_condensed",
  "bree_serif",
  "bungee",
  "rye",
  "special_elite",
] as const;
export const DISPLAY_ACCENTS = ["amber", "sky", "rose", "cyan", "tan", "orange", "blue"] as const;
export const DISPLAY_UNIT_SYSTEMS = ["us", "metric"] as const;
export const DISPLAY_LAYOUT_MODES = ["scroll", "rotation"] as const;
export const TAP_CARD_DISPLAY_METRICS = ["abv", "ibu", "og", "fg", "srm"] as const;
export const TAP_CARD_REMAINING_MODES = ["percent", "pints", "pours", "volume"] as const;

export type DisplayTheme = (typeof DISPLAY_THEMES)[number];
export type DisplayFont = (typeof DISPLAY_FONTS)[number];
/** Named accents plus the strict, canonical lowercase custom hex contract. */
export type DisplayCustomAccent = `#${string}`;
export type DisplayAccent = (typeof DISPLAY_ACCENTS)[number] | DisplayCustomAccent;
export type DisplayUnitSystem = (typeof DISPLAY_UNIT_SYSTEMS)[number];
export type DisplayLayoutMode = (typeof DISPLAY_LAYOUT_MODES)[number];
export type TapCardDisplayMetric = (typeof TAP_CARD_DISPLAY_METRICS)[number];
export type TapCardRemainingMode = (typeof TAP_CARD_REMAINING_MODES)[number];

export interface DisplaySettings {
  readonly revision: number;
  readonly tapboardName: string;
  readonly theme: DisplayTheme;
  readonly font: DisplayFont;
  readonly accent: DisplayAccent;
  readonly unitSystem: DisplayUnitSystem;
  readonly showServingTemperature: boolean;
  readonly layoutMode: DisplayLayoutMode;
  readonly updatedAt: string;
}

export interface UpdateDisplaySettingsInput {
  readonly expectedRevision: number;
  readonly tapboardName: string;
  readonly theme: DisplayTheme;
  readonly font: DisplayFont;
  readonly accent: DisplayAccent;
  readonly unitSystem: DisplayUnitSystem;
  readonly showServingTemperature: boolean;
  readonly layoutMode: DisplayLayoutMode;
}

export interface TapCardDisplaySettings {
  readonly revision: number;
  readonly showAbv: boolean;
  readonly showIbu: boolean;
  readonly showOg: boolean;
  readonly showFg: boolean;
  readonly showSrm: boolean;
  readonly remainingMode: TapCardRemainingMode;
  readonly updatedAt: string;
}

export interface UpdateTapCardDisplaySettingsInput {
  readonly expectedRevision: number;
  readonly showAbv: boolean;
  readonly showIbu: boolean;
  readonly showOg: boolean;
  readonly showFg: boolean;
  readonly showSrm: boolean;
  readonly remainingMode: TapCardRemainingMode;
}

export interface TapCardDisplayOverride {
  readonly tapId: string;
  readonly showAbv: boolean | null;
  readonly showIbu: boolean | null;
  readonly showOg: boolean | null;
  readonly showFg: boolean | null;
  readonly showSrm: boolean | null;
  readonly updatedAt: string;
}

export interface TapCardDisplayOverridePatch {
  readonly showAbv?: boolean | null;
  readonly showIbu?: boolean | null;
  readonly showOg?: boolean | null;
  readonly showFg?: boolean | null;
  readonly showSrm?: boolean | null;
}

export interface EffectiveTapCardDisplaySettings {
  readonly tapId: string;
  readonly settings: Omit<TapCardDisplaySettings, "revision" | "updatedAt">;
  readonly override: TapCardDisplayOverride | null;
}

const CUSTOM_DISPLAY_ACCENT = /^#[0-9a-f]{6}$/;

export function isDisplayAccent(value: unknown): value is DisplayAccent {
  return (
    typeof value === "string" &&
    (DISPLAY_ACCENTS.includes(value as (typeof DISPLAY_ACCENTS)[number]) ||
      CUSTOM_DISPLAY_ACCENT.test(value))
  );
}
