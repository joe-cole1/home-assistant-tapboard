import type {
  DisplayAccent,
  DisplayFont,
  DisplayLayoutMode,
  TapCardRemainingMode,
  DisplayTheme,
  DisplayUnitSystem,
} from "../display/types.ts";
import type { VesselGeometryDescriptor } from "../story/types.ts";

export interface PublicDisplayDefaultsView {
  readonly revision: number;
  readonly tapboardName: string;
  readonly theme: DisplayTheme;
  readonly font: DisplayFont;
  readonly accent: DisplayAccent;
  readonly unitSystem: DisplayUnitSystem;
  readonly showServingTemperature: boolean;
  readonly layoutMode: DisplayLayoutMode;
  readonly remainingMode: TapCardRemainingMode;
}

export interface PublicHeaderView {
  readonly tapboardName: string;
  readonly connectivity: "healthy" | "degraded";
  readonly connectivityLabel: string;
}

export interface PublicTapCardView {
  readonly id: string;
  readonly tapNumber: number;
  /** Legacy tap identity retained for public API consumers. */
  readonly tapName: string | null;
  readonly graphicId: string;
  /** Present on projections produced by PublicStoryService. */
  readonly graphic?: VesselGeometryDescriptor;
  readonly displayColor: string;
  readonly beverageName: string | null;
  readonly style: string | null;
  /** Legacy ABV value retained alongside the display-ready metric rail. */
  readonly abv: number | null;
  readonly metrics: readonly PublicTapMetricView[];
  readonly description: string | null;
  /** Present on projections produced by PublicStoryService. */
  readonly title?: string;
  readonly accessibleLabel?: string;
  readonly storyPath?: string | null;
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

export type PublicTapMetricKey = "abv" | "ibu" | "og" | "fg" | "srm";

export interface PublicTapMetricView {
  readonly key: PublicTapMetricKey;
  readonly label: "ABV" | "IBU" | "OG" | "FG" | "SRM";
  /** A display-ready value. Hidden or unavailable values are not serialized. */
  readonly value: string;
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
