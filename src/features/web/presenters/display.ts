import type {
  DisplaySettings,
  TapCardDisplaySettings,
  EffectiveTapCardDisplaySettings,
} from "../../display/types.ts";

type OverrideChoice = "inherit" | "show" | "hide";
type TapOverrideResource = Readonly<
  Record<"showAbv" | "showIbu" | "showOg" | "showFg" | "showSrm", OverrideChoice>
>;
function overrideChoice(value: boolean | null | undefined): OverrideChoice {
  return value === null || value === undefined ? "inherit" : value ? "show" : "hide";
}
export function safeDisplayResource(
  settings: DisplaySettings,
): Omit<DisplaySettings, "revision" | "updatedAt"> {
  return {
    tapboardName: settings.tapboardName,
    theme: settings.theme,
    font: settings.font,
    accent: settings.accent,
    unitSystem: settings.unitSystem,
    showServingTemperature: settings.showServingTemperature,
    layoutMode: settings.layoutMode,
  };
}

export function safeTapCardResource(
  settings: TapCardDisplaySettings,
): Omit<TapCardDisplaySettings, "revision" | "updatedAt"> {
  return {
    showAbv: settings.showAbv,
    showIbu: settings.showIbu,
    showOg: settings.showOg,
    showFg: settings.showFg,
    showSrm: settings.showSrm,
    remainingMode: settings.remainingMode,
  };
}

export function safeTapOverrideResource(
  settings: EffectiveTapCardDisplaySettings,
): TapOverrideResource {
  return {
    showAbv: overrideChoice(settings.override?.showAbv),
    showIbu: overrideChoice(settings.override?.showIbu),
    showOg: overrideChoice(settings.override?.showOg),
    showFg: overrideChoice(settings.override?.showFg),
    showSrm: overrideChoice(settings.override?.showSrm),
  };
}
