import { Buffer } from "node:buffer";

import { isApplicationError } from "../../shared/errors.ts";
import type { BeverageDetailResult, BeverageService } from "../beverages/service.ts";
import type {
  BeverageSourceRecipeSnapshot,
  EffectiveBeveragePresentation,
} from "../beverages/types.ts";
import type { PublicTapCardView, PublicTapMetricView } from "../dashboard/types.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import type { FillService } from "../fills/service.ts";
import type { AdminFillView } from "../fills/types.ts";
import type { ForecastService } from "../forecasting/service.ts";
import type { HealthService } from "../health/service.ts";
import type { TapService } from "../taps/service.ts";
import type {
  ActiveAssignmentDetails,
  AdminTapView,
  PublicTapView,
  TapAssignmentMysteryConfig,
} from "../taps/types.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import { MAX_SOURCE_JSON_BYTES, projectCustomRecipe, projectSourceRecipe } from "./recipe.ts";
import { resolveSensoryProfile } from "./profile.ts";
import type {
  PublicBeverageGuidance,
  PublicStoryCurrentFillView,
  PublicStoryHistoryItem,
  PublicStoryPresentationView,
  PublicStoryRecipesView,
  PublicStoryView,
  PublicStoryVesselView,
  SensoryProfileInput,
} from "./types.ts";
import { mysteryVisibilityPolicy, type MysteryVisibilityPolicy } from "./visibility.ts";
import { resolveDisplayColor, resolveVessel } from "./vessels.ts";

const MAX_SOURCE_SNAPSHOTS = 5;
const DEFAULT_COLOR = "#D97706";
const DEFAULT_MYSTERY: TapAssignmentMysteryConfig = {
  enabled: false,
  revealBeverageType: false,
  revealStyle: false,
  revealAbv: false,
  revealIbu: false,
  revealOg: false,
  revealFg: false,
  revealSrm: false,
  revealDescription: false,
  revealRecipe: false,
  revealSensory: false,
  revealHistory: false,
};

export interface PublicStoryServiceDependencies {
  readonly tapService: TapService;
  readonly beverageService: BeverageService;
  readonly fillService: FillService;
  readonly detectorService: DetectorService;
  readonly forecastService: ForecastService;
  readonly healthService: HealthService;
  readonly displayService?: DisplaySettingsService;
}

interface StoryContext {
  readonly tap: AdminTapView;
  readonly assignment: ActiveAssignmentDetails | null;
  readonly mystery: TapAssignmentMysteryConfig;
  readonly beverage: BeverageDetailResult | null;
  readonly fill: AdminFillView | null;
}

interface RuntimeProjection {
  readonly remainingVolumeMl: number | null;
  readonly capacityMl: number | null;
  readonly temperatureC: number | null;
  readonly waitingForMeasurement: boolean;
  readonly servingsRemaining: number | null;
  readonly daysRemaining: number | null;
  readonly fillPercent: number | null;
  readonly health: PublicTapCardView["health"];
}

type SafeSnapshotState = "linked_current" | "detached" | "superseded";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function isBeerLike(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "beer";
}

function sourceLabel(state: SafeSnapshotState): string {
  if (state === "linked_current") return "Brewfather source recipe";
  if (state === "detached") return "Detached Brewfather source recipe";
  return "Superseded Brewfather source recipe";
}

function safeSnapshotState(value: unknown): SafeSnapshotState | null {
  return value === "linked_current" || value === "detached" || value === "superseded"
    ? value
    : null;
}

function safeSnapshotProvenance(snapshot: BeverageSourceRecipeSnapshot): {
  readonly label: string;
  readonly state: SafeSnapshotState;
  readonly version: number;
  readonly capturedAt: string | null;
} | null {
  const state = safeSnapshotState(snapshot.state);
  if (state === null) return null;
  return {
    label: sourceLabel(state),
    state,
    version: Number.isInteger(snapshot.version) && snapshot.version >= 0 ? snapshot.version : 0,
    capturedAt: safeTimestamp(snapshot.createdAt),
  };
}

function boundedFreeze(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    const result = value.slice(0, 200).map((item) => boundedFreeze(item, depth + 1));
    return Object.freeze(result);
  }
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).slice(0, 200)) {
    result[key] = boundedFreeze(source[key], depth + 1);
  }
  return Object.freeze(result);
}

function parseBoundedSourceRecipe(value: unknown): unknown {
  if (typeof value !== "string") return boundedFreeze(value);
  if (Buffer.byteLength(value, "utf8") > MAX_SOURCE_JSON_BYTES) return null;
  try {
    return boundedFreeze(JSON.parse(value));
  } catch {
    return null;
  }
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeHistoryItem(value: {
  readonly canonicalVolumeMl: number;
  readonly startedAt: string;
  readonly completedAt: string;
}): PublicStoryHistoryItem | null {
  const volumeMl = finiteNumber(value.canonicalVolumeMl);
  const startedAt = safeTimestamp(value.startedAt);
  const completedAt = safeTimestamp(value.completedAt);
  if (volumeMl === null || startedAt === null || completedAt === null) return null;
  return { volumeMl, startedAt, completedAt };
}

function visible(
  policy: MysteryVisibilityPolicy,
  key: keyof MysteryVisibilityPolicy["reveal"],
): boolean {
  return !policy.enabled || policy.reveal[key];
}

const DEFAULT_TAP_CARD_METRICS = Object.freeze({
  showAbv: true,
  showIbu: true,
  showOg: true,
  showFg: true,
  showSrm: false,
});

function metricValue(key: PublicTapMetricView["key"], value: number): PublicTapMetricView {
  const labels = { abv: "ABV", ibu: "IBU", og: "OG", fg: "FG", srm: "SRM" } as const;
  const formatted =
    key === "abv"
      ? `${value.toFixed(1)}%`
      : key === "ibu"
        ? `${Math.round(value)}`
        : key === "og" || key === "fg"
          ? value.toFixed(3)
          : value.toFixed(1);
  return { key, label: labels[key], value: formatted };
}

export class PublicStoryService {
  readonly #dependencies: PublicStoryServiceDependencies;

  constructor(dependencies: PublicStoryServiceDependencies) {
    this.#dependencies = dependencies;
  }

  listCards(): readonly PublicTapCardView[] {
    return this.#dependencies.tapService
      .listTaps()
      .filter((tap) => tap.enabled && !tap.isRetired)
      .sort((left, right) => left.tapNumber - right.tapNumber)
      .map((tap) => this.#cardForContext(this.#contextForTap(tap.id)));
  }

  getCard(tapId: string): PublicTapCardView | undefined {
    try {
      const context = this.#contextForTap(tapId);
      if (!context.tap.enabled || context.tap.isRetired) return undefined;
      return this.#cardForContext(context);
    } catch (error) {
      if (
        isApplicationError(error) &&
        (error.category === "validation" ||
          error.code === "tap.not_found" ||
          error.code === "fill.not_found" ||
          error.code === "beverage.not_found")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Resolve only the safe title for one exact assignment.  This intentionally
   * does not require the Tap to be enabled: Tap Wars may remain visible after
   * an original competitor is disabled, while replacement assignments must
   * never supply its title.
   */
  getTitleForAssignment(tapId: string, assignmentId: string): string | undefined {
    try {
      const tap = this.#dependencies.tapService.getTap(tapId);
      const assignment = tap.activeAssignment;
      if (tap.isRetired || assignment === null || assignment.id !== assignmentId) return undefined;

      const mystery = this.#dependencies.tapService.getAssignmentMystery(tap.id);
      const policy = mysteryVisibilityPolicy(mystery);
      if (policy.title !== null) return policy.title;
      return this.#dependencies.beverageService.getBeverage(assignment.beverageId)
        .effectivePresentation.name;
    } catch (error) {
      if (
        isApplicationError(error) &&
        (error.category === "validation" ||
          error.code === "tap.not_found" ||
          error.code === "beverage.not_found")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  listLegacyTaps(): readonly PublicTapView[] {
    return this.#dependencies.tapService
      .listTaps()
      .filter((tap) => tap.enabled && !tap.isRetired)
      .sort((left, right) => left.tapNumber - right.tapNumber)
      .map((tap) => this.#legacyForContext(this.#contextForTap(tap.id)));
  }

  getStory(tapId: string): PublicStoryView | undefined {
    try {
      const context = this.#contextForTap(tapId);
      if (
        !context.tap.enabled ||
        context.tap.isRetired ||
        context.assignment === null ||
        context.beverage === null ||
        context.fill === null
      ) {
        return undefined;
      }
      return this.#storyForContext(context);
    } catch (error) {
      if (
        isApplicationError(error) &&
        (error.category === "validation" ||
          error.code === "tap.not_found" ||
          error.code === "fill.not_found" ||
          error.code === "beverage.not_found")
      ) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Return the same redacted guidance used by Story.  This is intentionally a
   * read-only helper for future authenticated surfaces; it does not return
   * persistence IDs, fingerprints, or source JSON.
   */
  getBeverageGuidance(beverageId: string): PublicBeverageGuidance {
    const detail = this.#dependencies.beverageService.getBeverage(beverageId);
    const snapshots = [...this.#recipeSnapshots(detail, beverageId)].sort(
      (left, right) => right.version - left.version,
    );
    const customRecipe = detail.customRecipe ? projectCustomRecipe(detail.customRecipe) : null;
    const sourceRecipes = snapshots.slice(0, MAX_SOURCE_SNAPSHOTS).map((snapshot) => {
      const provenance = safeSnapshotProvenance(snapshot);
      return projectSourceRecipe(parseBoundedSourceRecipe(snapshot.recipeJson), provenance);
    });

    const activeSnapshot = snapshots.find((snapshot) => {
      const state = safeSnapshotState(snapshot.state);
      return state === "linked_current" || state === "detached";
    });
    const predictionRecipe =
      detail.customRecipe != null
        ? boundedFreeze(detail.customRecipe)
        : activeSnapshot === undefined
          ? null
          : parseBoundedSourceRecipe(activeSnapshot.recipeJson);
    const sensoryInput: SensoryProfileInput = {
      ...detail.effectivePresentation,
      manualOverrides: detail.sensoryOverrides
        ? {
            bitterness: detail.sensoryOverrides.bitterness,
            sweetness: detail.sensoryOverrides.sweetness,
            body: detail.sensoryOverrides.body,
            roast: detail.sensoryOverrides.roast,
            tartness: detail.sensoryOverrides.tartness,
            alcohol: detail.sensoryOverrides.alcohol,
          }
        : null,
      recipe: predictionRecipe,
    };

    return {
      sensory: resolveSensoryProfile(sensoryInput),
      customRecipe,
      sourceRecipes,
      activeSourceLabel:
        detail.customRecipe != null
          ? "Custom recipe"
          : activeSnapshot === undefined
            ? null
            : sourceLabel(safeSnapshotState(activeSnapshot.state) ?? "superseded"),
    };
  }

  #recipeSnapshots(
    detail: BeverageDetailResult,
    beverageId: string,
  ): readonly BeverageSourceRecipeSnapshot[] {
    try {
      return this.#dependencies.beverageService.getRecipeSnapshots(beverageId);
    } catch {
      // A persisted current snapshot is sufficient for a cached Story.
    }
    return detail.recipeSnapshot === undefined ? [] : [detail.recipeSnapshot];
  }

  #contextForTap(tapId: string): StoryContext {
    const tap = this.#dependencies.tapService.getTap(tapId);
    if (!tap.enabled || tap.isRetired) {
      return { tap, assignment: null, mystery: DEFAULT_MYSTERY, beverage: null, fill: null };
    }
    const assignment = tap.activeAssignment;
    const mystery = this.#dependencies.tapService.getAssignmentMystery(tap.id);
    if (assignment === null) return { tap, assignment: null, mystery, beverage: null, fill: null };
    return {
      tap,
      assignment,
      mystery,
      beverage: this.#dependencies.beverageService.getBeverage(assignment.beverageId),
      fill: this.#dependencies.fillService.getFill(assignment.fillId),
    };
  }

  #runtimeFor(context: StoryContext): RuntimeProjection {
    if (context.assignment === null) {
      return {
        remainingVolumeMl: null,
        capacityMl: null,
        temperatureC: null,
        waitingForMeasurement: false,
        servingsRemaining: null,
        daysRemaining: null,
        fillPercent: null,
        health: this.#health(context.tap.id),
      };
    }

    let remainingVolumeMl: number | null = null;
    let capacityMl: number | null = null;
    let temperatureC: number | null = null;
    let waitingForMeasurement = true;
    try {
      const diagnostics = this.#dependencies.detectorService.diagnostics(context.tap.id);
      remainingVolumeMl = finiteNumber(diagnostics.measurement?.publicVolumeMl);
      capacityMl = finiteNumber(diagnostics.epoch?.snapshots.capacityMl);
      temperatureC = finiteNumber(diagnostics.measurement?.canonical.temperatureC);
      waitingForMeasurement = diagnostics.detector?.waitingForMeasurement ?? true;
    } catch {
      // Identity remains useful when telemetry enhancement is unavailable.
    }

    let servingsRemaining: number | null = null;
    let daysRemaining: number | null = null;
    try {
      const forecast = this.#dependencies.forecastService.getPublicForecastSummary(
        context.assignment.fillId,
      );
      servingsRemaining = finiteNumber(forecast.servingsRemaining);
      daysRemaining = finiteNumber(forecast.days?.medianDays);
    } catch {
      // Forecast absence must not blank Beverage/Fill identity.
    }

    return {
      remainingVolumeMl,
      capacityMl,
      temperatureC,
      waitingForMeasurement,
      servingsRemaining,
      daysRemaining,
      fillPercent: clampedPercent(remainingVolumeMl, capacityMl),
      health: this.#health(context.tap.id),
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

  #vessel(presentation: EffectiveBeveragePresentation): PublicStoryVesselView {
    // Glass/color are explicit Mystery exemptions.  Their deterministic
    // output therefore still uses the effective style/SRM evidence even when
    // the corresponding text fields are hidden.
    const srm = isBeerLike(presentation.beverageType) ? presentation.srm : null;
    const vessel = resolveVessel({
      fillGlass: presentation.fillGlass,
      style: presentation.style,
    });
    return {
      graphicId: vessel.id,
      graphic: vessel.geometry,
      displayColor: resolveDisplayColor({ displayColor: presentation.displayColor }, srm),
    };
  }

  #presentation(
    presentation: EffectiveBeveragePresentation,
    policy: MysteryVisibilityPolicy,
  ): PublicStoryPresentationView {
    return {
      beverageName: policy.enabled ? null : presentation.name,
      beverageType: visible(policy, "beverage_type") ? presentation.beverageType : null,
      style: visible(policy, "style") ? presentation.style : null,
      description: visible(policy, "description") ? presentation.description : null,
      abv: visible(policy, "abv") ? presentation.abv : null,
      ibu: visible(policy, "ibu") ? presentation.ibu : null,
      og: visible(policy, "og") ? presentation.og : null,
      fg: visible(policy, "fg") ? presentation.fg : null,
      srm:
        visible(policy, "srm") && isBeerLike(presentation.beverageType) ? presentation.srm : null,
    };
  }

  #metricsFor(
    tapId: string,
    presentation: PublicStoryPresentationView,
  ): readonly PublicTapMetricView[] {
    let settings: {
      readonly showAbv: boolean;
      readonly showIbu: boolean;
      readonly showOg: boolean;
      readonly showFg: boolean;
      readonly showSrm: boolean;
    } = DEFAULT_TAP_CARD_METRICS;
    if (this.#dependencies.displayService !== undefined) {
      try {
        settings = this.#dependencies.displayService.getEffectiveTapCardSettings(tapId).settings;
      } catch {
        // Display preference failures must not make configured-hidden metrics visible.
        return [];
      }
    }
    const values: readonly [PublicTapMetricView["key"], boolean, number | null][] = [
      ["abv", settings.showAbv, presentation.abv],
      ["ibu", settings.showIbu, presentation.ibu],
      ["og", settings.showOg, presentation.og],
      ["fg", settings.showFg, presentation.fg],
      ["srm", settings.showSrm, presentation.srm],
    ];
    return values
      .filter(
        (entry): entry is [PublicTapMetricView["key"], true, number] =>
          entry[1] && typeof entry[2] === "number" && Number.isFinite(entry[2]),
      )
      .map(([key, _enabled, value]) => metricValue(key, value));
  }

  #cardForContext(context: StoryContext): PublicTapCardView {
    const tap = context.tap;
    if (context.assignment === null || context.beverage === null || context.fill === null) {
      const vessel = resolveVessel({ fillGlass: null, style: null });
      return {
        id: tap.id,
        tapNumber: tap.tapNumber,
        tapName: tap.name,
        graphicId: vessel.id,
        graphic: vessel.geometry,
        displayColor: DEFAULT_COLOR,
        beverageName: null,
        style: null,
        abv: null,
        metrics: [],
        description: null,
        title: "Empty Tap",
        accessibleLabel: `Tap ${tap.tapNumber}, Empty Tap`,
        storyPath: null,
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

    const presentation = context.beverage.effectivePresentation;
    const policy = mysteryVisibilityPolicy(context.mystery);
    const runtime = this.#runtimeFor(context);
    const visiblePresentation = this.#presentation(presentation, policy);
    const vessel = this.#vessel(presentation);
    const title = policy.title ?? presentation.name;
    return {
      id: tap.id,
      tapNumber: tap.tapNumber,
      tapName: policy.enabled ? null : tap.name,
      graphicId: vessel.graphicId,
      graphic: vessel.graphic,
      displayColor: vessel.displayColor,
      beverageName: visiblePresentation.beverageName,
      style: visiblePresentation.style,
      abv: visiblePresentation.abv,
      metrics: this.#metricsFor(tap.id, visiblePresentation),
      description: visiblePresentation.description,
      title,
      accessibleLabel: policy.enabled
        ? `Tap ${tap.tapNumber}, Mystery Tap`
        : `Tap ${tap.tapNumber}, ${title}`,
      storyPath: `/taps/${encodeURIComponent(tap.id)}/story`,
      fillId: policy.enabled ? null : context.assignment.fillId,
      fillPercent: runtime.fillPercent,
      remainingVolumeMl: runtime.remainingVolumeMl,
      capacityMl: runtime.capacityMl,
      servingsRemaining: runtime.servingsRemaining,
      daysRemaining: runtime.daysRemaining,
      temperatureC: runtime.temperatureC,
      waitingForMeasurement: runtime.waitingForMeasurement,
      health: runtime.health,
    };
  }

  #legacyForContext(context: StoryContext): PublicTapView {
    const policy = mysteryVisibilityPolicy(context.mystery);
    if (context.assignment === null || context.beverage === null || context.fill === null) {
      return { tapNumber: context.tap.tapNumber, name: context.tap.name, activeFill: null };
    }
    const presentation = context.beverage.effectivePresentation;
    return {
      tapNumber: context.tap.tapNumber,
      name: policy.enabled ? null : context.tap.name,
      activeFill: {
        fillId: policy.enabled ? null : context.assignment.fillId,
        beverageName: policy.enabled ? null : presentation.name,
        beverageType: visible(policy, "beverage_type") ? presentation.beverageType : null,
        beverageStyle: visible(policy, "style") ? presentation.style : null,
        beverageAbv: visible(policy, "abv") ? presentation.abv : null,
      },
    };
  }

  #storyForContext(context: StoryContext): PublicStoryView {
    const assignment = context.assignment!;
    const beverage = context.beverage!;
    const fill = context.fill!;
    const policy = mysteryVisibilityPolicy(context.mystery);
    const presentation = beverage.effectivePresentation;
    const visiblePresentation = this.#presentation(presentation, policy);
    const vessel = this.#vessel(presentation);
    const runtime = this.#runtimeFor(context);
    const guidance = this.getBeverageGuidance(assignment.beverageId);
    const recipes: PublicStoryRecipesView | null = visible(policy, "recipe")
      ? { custom: guidance.customRecipe, sources: guidance.sourceRecipes }
      : null;
    const history = this.#history(fill.id, visible(policy, "history"));
    const title = policy.title ?? presentation.name;

    const currentFill: PublicStoryCurrentFillView = {
      fillDate: visible(policy, "history") ? fill.fillDate : null,
      assignedAt: visible(policy, "history") ? assignment.assignedAt : null,
      remainingVolumeMl: runtime.remainingVolumeMl,
      capacityMl: runtime.capacityMl,
      fillPercent: runtime.fillPercent,
      servingsRemaining: runtime.servingsRemaining,
      daysRemaining: runtime.daysRemaining,
      temperatureC: runtime.temperatureC,
      waitingForMeasurement: runtime.waitingForMeasurement,
    };

    return {
      tapNumber: context.tap.tapNumber,
      title,
      accessibleLabel: policy.enabled
        ? `Tap ${context.tap.tapNumber}, Mystery Tap`
        : `Tap ${context.tap.tapNumber}, ${title}`,
      presentation: visiblePresentation,
      vessel,
      currentFill,
      sensory: visible(policy, "sensory") ? guidance.sensory : null,
      recipes,
      history,
    };
  }

  #history(fillId: string, isVisible: boolean): readonly PublicStoryHistoryItem[] | null {
    if (!isVisible) return null;
    try {
      const page = this.#dependencies.forecastService.getPourHistory(fillId, { limit: 50 });
      return page.pours
        .filter((pour) => pour.fillId === fillId)
        .slice(0, 50)
        .map(safeHistoryItem)
        .filter((item): item is PublicStoryHistoryItem => item !== null);
    } catch {
      return null;
    }
  }
}

export function createPublicStoryService(
  dependencies: PublicStoryServiceDependencies,
): PublicStoryService {
  return new PublicStoryService(dependencies);
}
