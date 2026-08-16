import type {
  DisplayAccent,
  DisplayFont,
  DisplayLayoutMode,
  DisplayTheme,
  DisplayUnitSystem,
} from "../display/types.ts";

export interface PublicDisplayDefaultsView {
  readonly revision: number;
  readonly tapboardName: string;
  readonly theme: DisplayTheme;
  readonly font: DisplayFont;
  readonly accent: DisplayAccent;
  readonly unitSystem: DisplayUnitSystem;
  readonly showServingTemperature: boolean;
  readonly layoutMode: DisplayLayoutMode;
}

export interface PublicHeaderView {
  readonly tapboardName: string;
  readonly connectivity: "healthy" | "degraded";
  readonly connectivityLabel: string;
}

export interface PublicTapCardView {
  readonly id: string;
  readonly tapNumber: number;
  readonly tapName: string | null;
  readonly graphicId: string;
  readonly displayColor: string;
  readonly beverageName: string | null;
  readonly style: string | null;
  readonly abv: number | null;
  readonly description: string | null;
  readonly fillId: string | null;
  readonly fillPercent: number | null;
  readonly remainingVolumeMl: number | null;
  readonly capacityMl: number | null;
  readonly servingsRemaining: number | null;
  readonly daysRemaining: number | null;
  readonly temperatureC: number | null;
  readonly waitingForMeasurement: boolean;
  readonly health: "healthy" | "degraded" | "unknown";
}

export interface PublicOnDeckItemView {
  readonly fillId: string;
  readonly name: string;
  readonly style: string | null;
}

export interface PublicOnDeckView {
  readonly items: readonly PublicOnDeckItemView[];
}

export interface PublicDashboardView {
  readonly sharedDisplay: PublicDisplayDefaultsView;
  readonly header: PublicHeaderView;
  readonly taps: readonly PublicTapCardView[];
  readonly onDeck: PublicOnDeckView;
  readonly ssePath: "/api/public/events";
}
