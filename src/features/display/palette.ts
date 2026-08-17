import { createHash } from "node:crypto";

import {
  DISPLAY_FONTS,
  DISPLAY_THEMES,
  isDisplayAccent,
  type DisplayAccent,
  type DisplayFont,
  type DisplayTheme,
} from "./types.ts";

export type DisplayStylesheetFont = DisplayFont | "all";
export const DISPLAY_STYLESHEET_VERSION = "1" as const;

type FontWeight = number | `${number} ${number}`;

const NAMED_ACCENTS: Readonly<Record<string, string>> = {
  amber: "#fbc02d",
  sky: "#38bdf8",
  rose: "#fb7185",
  cyan: "#00f0ff",
  tan: "#c5a880",
  orange: "#d97706",
  blue: "#2563eb",
};

const THEMES: Readonly<
  Record<
    DisplayTheme,
    {
      readonly background: string;
      readonly surface: string;
      readonly raised: string;
      readonly text: string;
      readonly muted: string;
      readonly border: string;
      readonly secondary: string;
      readonly shadow: string;
      readonly colorScheme: "dark" | "light";
    }
  >
> = {
  modern_dark: {
    background: "#0b0f19",
    surface: "#111827",
    raised: "#192231",
    text: "#ffffff",
    muted: "#9ca3af",
    border: "rgba(255,255,255,.2)",
    secondary: "#38bdf8",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.25)",
    colorScheme: "dark",
  },
  warm_pub: {
    background: "#1c0a00",
    surface: "#2d1204",
    raised: "#3a1b0a",
    text: "#fdf6e2",
    muted: "#c5a880",
    border: "rgba(212,175,55,.3)",
    secondary: "#c5a880",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.3)",
    colorScheme: "dark",
  },
  cyberpunk: {
    background: "#0d0221",
    surface: "#19053b",
    raised: "#26075a",
    text: "#00f0ff",
    muted: "#c52cff",
    border: "#00f0ff",
    secondary: "#00f0ff",
    shadow: "0 .5rem 1.5rem rgba(0,0,0,.35)",
    colorScheme: "dark",
  },
  light_minimal: {
    background: "#f8fafc",
    surface: "#ffffff",
    raised: "#ffffff",
    text: "#0f172a",
    muted: "#64748b",
    border: "#cbd5e1",
    secondary: "#2563eb",
    shadow: "0 .5rem 1.5rem rgba(15,23,42,.12)",
    colorScheme: "light",
  },
};

const FONT_FILES: Readonly<
  Record<
    Exclude<DisplayFont, "system">,
    {
      readonly family: string;
      readonly file: string;
      readonly weight: FontWeight;
    }
  >
> = {
  outfit: { family: "Outfit", file: "outfit-6c18d579.woff2", weight: "100 900" },
  inter: { family: "Inter", file: "inter-3100e775.woff2", weight: "100 900" },
  roboto: { family: "Roboto", file: "roboto-1404ca34.woff2", weight: "100 900" },
  fredoka: { family: "Fredoka", file: "fredoka-99d6c78e.woff2", weight: "400 700" },
  montserrat: { family: "Montserrat", file: "montserrat-06b16db7.woff2", weight: "100 900" },
  barlow_condensed: {
    family: "Barlow Condensed",
    file: "barlow_condensed-7fff1bb2.woff2",
    weight: 400,
  },
  bree_serif: { family: "Bree Serif", file: "bree_serif-ca092b41.woff2", weight: 400 },
  bungee: { family: "Bungee", file: "bungee-126eec70.woff2", weight: 400 },
  rye: { family: "Rye", file: "rye-00de26ff.woff2", weight: 400 },
  special_elite: {
    family: "Special Elite",
    file: "special_elite-770493d8.woff2",
    weight: 400,
  },
};

function hexRgb(hex: string): readonly [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  return hexRgb(hex)
    .map((value) => value / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
}

export function contrastRatio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function mix(hex: string, other: "#000000" | "#ffffff", amount: number): string {
  const [r, g, b] = hexRgb(hex);
  const [or, og, ob] = hexRgb(other);
  return `#${[r, g, b]
    .map((value, index) =>
      Math.round(value + ([or, og, ob][index]! - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function meetsContrast(candidate: string, surfaces: readonly string[], minimum: number): boolean {
  return surfaces.every((surface) => contrastRatio(candidate, surface) >= minimum);
}

function onAccent(accent: string): string {
  return contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#000000")
    ? "#ffffff"
    : "#000000";
}

function nearestContrastRole(accent: string, surfaces: readonly string[], minimum: number): string {
  if (meetsContrast(accent, surfaces, minimum)) return accent;
  const candidates = (["#000000", "#ffffff"] as const).flatMap((toward) => {
    if (!meetsContrast(toward, surfaces, minimum)) return [];
    let low = 0;
    let high = 1;
    for (let index = 0; index < 32; index += 1) {
      const amount = (low + high) / 2;
      if (meetsContrast(mix(accent, toward, amount), surfaces, minimum)) high = amount;
      else low = amount;
    }
    return [{ amount: high, color: mix(accent, toward, high) }];
  });
  return (
    candidates.sort((first, second) => first.amount - second.amount)[0]?.color ??
    (luminance(surfaces[0] ?? "#ffffff") > 0.5 ? "#000000" : "#ffffff")
  );
}

function shiftedContrastRole(accent: string, surfaces: readonly string[], minimum: number): string {
  const minimumVisibleShift = 0.08;
  const candidates = (["#000000", "#ffffff"] as const).flatMap((toward) => {
    const atMinimum = mix(accent, toward, minimumVisibleShift);
    if (meetsContrast(atMinimum, surfaces, minimum)) {
      return [{ amount: minimumVisibleShift, color: atMinimum }];
    }
    if (!meetsContrast(mix(accent, toward, 1), surfaces, minimum)) return [];
    let low = minimumVisibleShift;
    let high = 1;
    for (let index = 0; index < 32; index += 1) {
      const amount = (low + high) / 2;
      if (meetsContrast(mix(accent, toward, amount), surfaces, minimum)) high = amount;
      else low = amount;
    }
    return [{ amount: high, color: mix(accent, toward, high) }];
  });
  const selected = candidates.sort((first, second) => first.amount - second.amount)[0];
  if (selected !== undefined && selected.color !== accent) return selected.color;
  const fallback = mix(accent, luminance(accent) > 0.5 ? "#000000" : "#ffffff", 0.08);
  return meetsContrast(fallback, surfaces, minimum)
    ? fallback
    : nearestContrastRole(accent, surfaces, minimum);
}

export interface DisplayPaletteRoles {
  readonly accent: string;
  readonly accentReadable: string;
  readonly accentStrong: string;
  readonly accentHover: string;
  readonly onAccent: string;
  readonly onAccentHover: string;
}

export function resolveDisplayPaletteRoles(
  theme: DisplayTheme,
  accent: DisplayAccent,
): DisplayPaletteRoles {
  const palette = THEMES[theme];
  const accentHex = resolveAccent(accent);
  const surfaces = [palette.background, palette.surface] as const;
  const accentReadable = nearestContrastRole(accentHex, surfaces, 4.5);
  const accentStrong = nearestContrastRole(accentHex, surfaces, 3);
  const accentHover = shiftedContrastRole(accentHex, surfaces, 3);
  return {
    accent: accentHex,
    accentReadable,
    accentStrong,
    accentHover,
    onAccent: onAccent(accentHex),
    onAccentHover: onAccent(accentHover),
  };
}

export function resolveAccent(accent: DisplayAccent): string {
  return NAMED_ACCENTS[accent] ?? accent;
}

function fontFace(font: Exclude<DisplayFont, "system">): string {
  const source = FONT_FILES[font];
  return `@font-face{font-family:"${source.family}";font-style:normal;font-weight:${source.weight};font-display:swap;src:url("/assets/fonts/${source.file}") format("woff2");}`;
}

function fontFamily(font: DisplayFont): string {
  if (font === "system") return 'system-ui,-apple-system,"Segoe UI",sans-serif';
  return `"${FONT_FILES[font].family}",system-ui,sans-serif`;
}

export function validateStylesheetParams(
  theme: unknown,
  accent: unknown,
  font: unknown,
):
  | {
      readonly theme: DisplayTheme;
      readonly accent: DisplayAccent;
      readonly font: DisplayStylesheetFont;
    }
  | undefined {
  if (!DISPLAY_THEMES.includes(theme as DisplayTheme) || !isDisplayAccent(accent)) return undefined;
  if (font !== "all" && !DISPLAY_FONTS.includes(font as DisplayFont)) return undefined;
  return {
    theme: theme as DisplayTheme,
    accent,
    font: font as DisplayStylesheetFont,
  };
}

export interface GeneratedDisplayStylesheet {
  readonly css: string;
  readonly etag: string;
}

export function generateDisplayStylesheet(
  theme: DisplayTheme,
  accent: DisplayAccent,
  font: DisplayStylesheetFont,
): GeneratedDisplayStylesheet {
  const palette = THEMES[theme];
  const roles = resolveDisplayPaletteRoles(theme, accent);
  const faces =
    font === "all"
      ? (Object.keys(FONT_FILES) as Exclude<DisplayFont, "system">[]).map(fontFace).join("")
      : font === "system"
        ? ""
        : fontFace(font);
  const selectedFamily = font === "all" ? fontFamily("system") : fontFamily(font);
  const previewFonts =
    font === "all"
      ? Object.entries(FONT_FILES)
          .map(
            ([name, value]) =>
              `.display-preview[data-preview-font="${name}"]{--preview-font:"${value.family}",system-ui,sans-serif}`,
          )
          .join("")
      : "";
  const css = `${faces}:root{--background:${palette.background};--surface:${palette.surface};--surface-raised:${palette.raised};--text:${palette.text};--muted:${palette.muted};--border:${palette.border};--accent:${roles.accent};--accent-readable:${roles.accentReadable};--accent-strong:${roles.accentStrong};--accent-hover:${roles.accentHover};--on-accent:${roles.onAccent};--on-accent-hover:${roles.onAccentHover};--secondary:${palette.secondary};--shadow:${palette.shadow};--font-family:${selectedFamily};color-scheme:${palette.colorScheme}}.admin-shell,html[data-admin-accent] .admin-shell{--accent:${roles.accent};--accent-readable:${roles.accentReadable};--accent-strong:${roles.accentStrong};--accent-hover:${roles.accentHover};--on-accent:${roles.onAccent};--on-accent-hover:${roles.onAccentHover}}.display-preview{--preview-accent:${roles.accent};--preview-accent-readable:${roles.accentReadable};--preview-accent-strong:${roles.accentStrong};--preview-accent-hover:${roles.accentHover};--preview-on-accent:${roles.onAccent};--preview-on-accent-hover:${roles.onAccentHover};--preview-font:${selectedFamily}}${previewFonts}`;
  return { css, etag: `"${createHash("sha256").update(css).digest("hex")}"` };
}

export function displayStylesheetHref(
  theme: DisplayTheme,
  accent: DisplayAccent,
  font: DisplayStylesheetFont,
): string {
  return `/assets/css/display.css?v=${DISPLAY_STYLESHEET_VERSION}&theme=${encodeURIComponent(theme)}&accent=${encodeURIComponent(accent)}&font=${encodeURIComponent(font)}`;
}

export const displayFontFiles = FONT_FILES;
