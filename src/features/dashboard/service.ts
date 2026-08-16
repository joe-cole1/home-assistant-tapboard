import type { BeverageService } from "../beverages/service.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import type { FillService } from "../fills/service.ts";
import type { ForecastService } from "../forecasting/service.ts";
import type { HealthService } from "../health/service.ts";
import type { TapService } from "../taps/service.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import { isApplicationError } from "../../shared/errors.ts";
import type {
  PublicDashboardView,
  PublicDisplayDefaultsView,
  PublicHeaderView,
  PublicOnDeckView,
  PublicTapCardView,
} from "./types.ts";

const SAFE_COLOR = /^#[0-9A-Fa-f]{6}$/u;
const DEFAULT_COLOR = "#D97706";
const GRAPHIC_IDS = new Set([
  "corny_keg",
  "pint_glass",
  "tulip_glass",
  "wheat_glass",
  "mug",
  "stout_glass",
  "snifter",
  "nonic_pint",
  "shaker_pint",
  "pilsner_flute",
  "stange",
  "goblet",
  "teku",
  "thistle",
  "ipa_glass",
  "tasting_glass",
  "stemmed_lager",
]);

export interface DashboardServiceDependencies {
  readonly displayService: DisplaySettingsService;
  readonly tapService: TapService;
  readonly beverageService: BeverageService;
  readonly fillService: FillService;
  readonly detectorService: DetectorService;
  readonly forecastService: ForecastService;
  readonly healthService: HealthService;
  readonly telemetryService: TelemetryService;
}

function clampedPercent(volumeMl: number | null, capacityMl: number | null): number | null {
  if (
    volumeMl === null ||
    capacityMl === null ||
    !Number.isFinite(volumeMl) ||
    !Number.isFinite(capacityMl) ||
    capacityMl <= 0
  ) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, (volumeMl / capacityMl) * 100)) * 10) / 10;
}

function graphicFor(fillGlass: string | null, style: string | null): string {
  if (fillGlass !== null && GRAPHIC_IDS.has(fillGlass)) return fillGlass;
  const value = style?.toLocaleLowerCase("en-US") ?? "";
  if (/wheat|witbier|hefeweizen/u.test(value)) return "wheat_glass";
  if (/pilsner/u.test(value)) return "pilsner_flute";
  if (/kolsch|kölsch|altbier/u.test(value)) return "stange";
  if (/belgian|abbey|saison/u.test(value)) return "goblet";
  if (/ipa|pale ale/u.test(value)) return "ipa_glass";
  if (/sour|lambic|wild/u.test(value)) return "tulip_glass";
  if (/stout|porter/u.test(value)) return "stout_glass";
  return "pint_glass";
}

export class DashboardService {
  readonly #dependencies: DashboardServiceDependencies;

  constructor(dependencies: DashboardServiceDependencies) {
    this.#dependencies = dependencies;
  }

  getDisplayDefaults(): PublicDisplayDefaultsView {
    const settings = this.#dependencies.displayService.getSettings();
    return {
      revision: settings.revision,
      tapboardName: settings.tapboardName,
      theme: settings.theme,
      font: settings.font,
      accent: settings.accent,
      unitSystem: settings.unitSystem,
      showServingTemperature: settings.showServingTemperature,
      layoutMode: settings.layoutMode,
    };
  }

  getHeader(): PublicHeaderView {
    const shared = this.getDisplayDefaults();
    const enabledTaps = this.#dependencies.tapService
      .listTaps()
      .filter((tap) => tap.enabled && !tap.isRetired);
    let degraded = false;

    for (const tap of enabledTaps) {
      const authority = this.#dependencies.telemetryService.getTapAuthority(tap.id);
      if (authority === undefined) degraded = true;
      try {
        const health = this.#dependencies.healthService.getAdminOverview(tap.id);
        const scale = health.checks.find((check) => check.checkId === "scale_availability");
        if (scale?.severity === "warning" || scale?.severity === "critical") degraded = true;
      } catch {
        degraded = true;
      }
    }

    try {
      const brewfather = this.#dependencies.beverageService.getBrewfatherStatus();
      if (brewfather.account?.enabled === true) {
        if (!brewfather.apiKeyConfigured) degraded = true;
        for (const beverage of this.#dependencies.beverageService.listBeverages()) {
          if (beverage.beverage.ownershipType !== "brewfather") continue;
          const link = this.#dependencies.beverageService.getBeverage(
            beverage.beverage.id,
          ).brewfatherLink;
          if (link?.syncState === "error" || link?.syncState === "stale") degraded = true;
        }
      }
    } catch {
      degraded = true;
    }

    return {
      tapboardName: shared.tapboardName,
      connectivity: degraded ? "degraded" : "healthy",
      connectivityLabel: degraded
        ? "Connectivity needs attention. Open Admin for details."
        : "Tapboard is connected.",
    };
  }

  listTaps(): readonly PublicTapCardView[] {
    return this.#dependencies.tapService
      .listTaps()
      .filter((tap) => tap.enabled && !tap.isRetired)
      .sort((left, right) => left.tapNumber - right.tapNumber)
      .map((tap) => this.#tapView(tap.id));
  }

  getTap(tapId: string): PublicTapCardView | undefined {
    try {
      const tap = this.#dependencies.tapService.getTap(tapId);
      if (!tap.enabled || tap.isRetired) return undefined;
      return this.#tapView(tap.id);
    } catch (error) {
      if (
        isApplicationError(error) &&
        (error.category === "validation" || error.code === "tap.not_found")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  getOnDeck(): PublicOnDeckView {
    return {
      items: this.#dependencies.fillService.getPublicOnDeck().map((item) => ({
        fillId: item.fillId,
        name: item.name,
        style: item.style,
      })),
    };
  }

  getDashboard(): PublicDashboardView {
    return {
      sharedDisplay: this.getDisplayDefaults(),
      header: this.getHeader(),
      taps: this.listTaps(),
      onDeck: this.getOnDeck(),
      ssePath: "/api/public/events",
    };
  }

  #tapView(tapId: string): PublicTapCardView {
    const tap = this.#dependencies.tapService.getTap(tapId);
    const assignment = tap.activeAssignment;
    if (assignment === null) {
      return {
        id: tap.id,
        tapNumber: tap.tapNumber,
        tapName: tap.name,
        graphicId: "pint_glass",
        displayColor: DEFAULT_COLOR,
        beverageName: null,
        style: null,
        abv: null,
        description: null,
        fillId: null,
        fillPercent: null,
        remainingVolumeMl: null,
        capacityMl: null,
        servingsRemaining: null,
        daysRemaining: null,
        temperatureC: null,
        waitingForMeasurement: false,
        health: this.#health(tap.id),
      };
    }

    const beverage = this.#dependencies.beverageService.getBeverage(assignment.beverageId);
    let remainingVolumeMl: number | null = null;
    let capacityMl: number | null = null;
    let temperatureC: number | null = null;
    let waitingForMeasurement = true;
    try {
      const diagnostics = this.#dependencies.detectorService.diagnostics(tap.id);
      remainingVolumeMl = diagnostics.measurement?.publicVolumeMl ?? null;
      capacityMl = diagnostics.epoch?.snapshots.capacityMl ?? null;
      temperatureC = diagnostics.measurement?.canonical.temperatureC ?? null;
      waitingForMeasurement = diagnostics.detector?.waitingForMeasurement ?? true;
    } catch {
      // The authoritative SSR remains useful when measurement enhancement is unavailable.
    }

    let servingsRemaining: number | null = null;
    let daysRemaining: number | null = null;
    try {
      const forecast = this.#dependencies.forecastService.getPublicForecastSummary(
        assignment.fillId,
      );
      servingsRemaining = forecast.servingsRemaining;
      daysRemaining = forecast.days?.medianDays ?? null;
    } catch {
      // Forecast absence must not blank Beverage/Fill identity.
    }

    const presentation = beverage.effectivePresentation;
    return {
      id: tap.id,
      tapNumber: tap.tapNumber,
      tapName: tap.name,
      graphicId: graphicFor(presentation.fillGlass, presentation.style),
      displayColor:
        presentation.displayColor !== null && SAFE_COLOR.test(presentation.displayColor)
          ? presentation.displayColor.toUpperCase()
          : DEFAULT_COLOR,
      beverageName: presentation.name,
      style: presentation.style,
      abv: presentation.abv,
      description: presentation.description,
      fillId: assignment.fillId,
      fillPercent: clampedPercent(remainingVolumeMl, capacityMl),
      remainingVolumeMl,
      capacityMl,
      servingsRemaining,
      daysRemaining,
      temperatureC,
      waitingForMeasurement,
      health: this.#health(tap.id),
    };
  }

  #health(tapId: string): PublicTapCardView["health"] {
    try {
      const aggregate = this.#dependencies.healthService.getAdminOverview(tapId).aggregate;
      if (aggregate.state === "healthy") return "healthy";
      if (aggregate.severity === "warning" || aggregate.severity === "critical") return "degraded";
      return "unknown";
    } catch {
      return "unknown";
    }
  }
}

export function createDashboardService(
  dependencies: DashboardServiceDependencies,
): DashboardService {
  return new DashboardService(dependencies);
}
