import type { DensityResolution, EffectiveBeveragePresentation } from "./types.ts";

export const DEFAULT_FALLBACK_FG = 1.008;

/**
 * Pure Beverage density resolver implementing the frozen v2 precedence:
 * 1. Manual density override
 * 2. FG-derived density
 * 3. Configured installation fallback FG (default 1.008)
 *
 * Manual density override strictly wins over FG when present.
 */
export function resolveBeverageDensity(
  presentation: Pick<EffectiveBeveragePresentation, "manualDensityOverride" | "fg">,
  fallbackFg: number = DEFAULT_FALLBACK_FG,
): DensityResolution {
  if (
    presentation.manualDensityOverride !== null &&
    presentation.manualDensityOverride !== undefined &&
    Number.isFinite(presentation.manualDensityOverride) &&
    presentation.manualDensityOverride > 0
  ) {
    return {
      densityGPerMl: presentation.manualDensityOverride,
      specificGravity: presentation.manualDensityOverride,
      source: "manual_override",
    };
  }

  if (
    presentation.fg !== null &&
    presentation.fg !== undefined &&
    Number.isFinite(presentation.fg) &&
    presentation.fg > 0
  ) {
    return {
      densityGPerMl: presentation.fg,
      specificGravity: presentation.fg,
      source: "fg_derived",
    };
  }

  const effectiveFallback =
    Number.isFinite(fallbackFg) && fallbackFg > 0 ? fallbackFg : DEFAULT_FALLBACK_FG;

  return {
    densityGPerMl: effectiveFallback,
    specificGravity: effectiveFallback,
    source: "fallback_fg",
  };
}
