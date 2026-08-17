import type { BeverageService } from "../beverages/service.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import type { FillService } from "../fills/service.ts";
import type { ForecastService } from "../forecasting/service.ts";
import type { HealthService } from "../health/service.ts";
import { createPublicStoryService, type PublicStoryService } from "../story/service.ts";
import type { TapService } from "../taps/service.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import type { PublicTapWarsService } from "../tap-wars/public.ts";
import type {
  PublicDashboardView,
  PublicDisplayDefaultsView,
  PublicHeaderView,
  PublicOnDeckView,
  PublicTapCardView,
} from "./types.ts";

export interface DashboardServiceDependencies {
  readonly displayService: DisplaySettingsService;
  readonly tapService: TapService;
  readonly beverageService: BeverageService;
  readonly fillService: FillService;
  readonly detectorService: DetectorService;
  readonly forecastService: ForecastService;
  readonly healthService: HealthService;
  readonly telemetryService: TelemetryService;
  readonly storyService?: PublicStoryService;
  readonly publicStoryService?: PublicStoryService;
  readonly tapWarsService?: PublicTapWarsService;
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
      remainingMode: this.#dependencies.displayService.getTapCardSettings().remainingMode,
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
      connectivityLabel: degraded ? "Degraded" : "Connected",
    };
  }

  listTaps(): readonly PublicTapCardView[] {
    return this.#storyService().listCards();
  }

  getTap(tapId: string): PublicTapCardView | undefined {
    return this.#storyService().getCard(tapId);
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
      tapWars: this.#dependencies.tapWarsService?.getVisible() ?? null,
      ssePath: "/api/public/events",
    };
  }

  #storyService(): PublicStoryService {
    const injected = this.#dependencies.publicStoryService ?? this.#dependencies.storyService;
    if (injected !== undefined) {
      return injected;
    }
    // Keep direct DashboardService consumers source-compatible while the
    // application supplies the singleton projection service.
    return createPublicStoryService({
      tapService: this.#dependencies.tapService,
      beverageService: this.#dependencies.beverageService,
      fillService: this.#dependencies.fillService,
      detectorService: this.#dependencies.detectorService,
      forecastService: this.#dependencies.forecastService,
      healthService: this.#dependencies.healthService,
      displayService: this.#dependencies.displayService,
    });
  }
}

export function createDashboardService(
  dependencies: DashboardServiceDependencies,
): DashboardService {
  return new DashboardService(dependencies);
}
