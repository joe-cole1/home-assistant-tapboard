export const DISPLAY_THEMES = ["modern_dark", "warm_pub", "cyberpunk", "light_minimal"] as const;
export const DISPLAY_FONTS = [
  "system",
  "outfit",
  "inter",
  "roboto",
  "fredoka",
  "montserrat",
] as const;
export const DISPLAY_ACCENTS = ["amber", "sky", "rose", "cyan", "tan", "orange", "blue"] as const;
export const DISPLAY_UNIT_SYSTEMS = ["us", "metric"] as const;
export const DISPLAY_LAYOUT_MODES = ["scroll", "rotation"] as const;

export type DisplayTheme = (typeof DISPLAY_THEMES)[number];
export type DisplayFont = (typeof DISPLAY_FONTS)[number];
export type DisplayAccent = (typeof DISPLAY_ACCENTS)[number];
export type DisplayUnitSystem = (typeof DISPLAY_UNIT_SYSTEMS)[number];
export type DisplayLayoutMode = (typeof DISPLAY_LAYOUT_MODES)[number];

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
