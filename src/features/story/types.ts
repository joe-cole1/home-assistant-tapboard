import { BEVERAGE_SENSORY_AXES } from "../beverages/types.ts";

/**
 * Public, deterministic types shared by Brew Story's pure helpers.
 *
 * These types intentionally describe only the small public projection.  They
 * do not mirror database rows, source-provider JSON, fingerprints, or IDs.
 */

/** The beverage domain owns the supported-axis catalog. */
export const SENSORY_AXES = BEVERAGE_SENSORY_AXES;

export type SensoryAxis = (typeof SENSORY_AXES)[number];

export type SensorySource = "manual" | "recipe_prediction" | "style_baseline" | "unavailable";

export type SensoryConfidence = "high" | "medium" | "low" | null;

export interface SensoryAxisResult {
  readonly value: number | null;
  readonly source: SensorySource;
  readonly confidence: SensoryConfidence;
  /** Short, non-secret explanation suitable for a public projection. */
  readonly evidence: string;
}

export type SensoryProfile = Readonly<Record<SensoryAxis, SensoryAxisResult>>;
export type StorySensoryProfile = SensoryProfile;

/** A loose public recipe prediction map. Values are still validated at runtime. */
export type SensoryPredictionMap = Partial<Record<SensoryAxis, number | null>>;

/**
 * Inputs accepted by the pure profile resolver. The index signature lets a
 * caller pass a provider-independent DTO while runtime code remains strictly
 * defensive about every value it consumes.
 */
export interface SensoryProfileInput {
  /** Canonical persisted/manual overrides use 0..10; resolver maps them to public 0..5. */
  readonly manual?: SensoryPredictionMap | null;
  /** Canonical persisted/manual overrides use 0..10; resolver maps them to public 0..5. */
  readonly manualOverrides?: SensoryPredictionMap | null;
  /** Canonical persisted/manual overrides use 0..10; resolver maps them to public 0..5. */
  readonly sensoryOverrides?: SensoryPredictionMap | null;
  /** Canonical persisted/manual overrides use 0..10; resolver maps them to public 0..5. */
  readonly overrides?: SensoryPredictionMap | null;
  readonly recipePrediction?: SensoryPredictionMap | null;
  readonly predictions?: SensoryPredictionMap | null;
  readonly recipe?: unknown;
  readonly recipeData?: unknown;
  readonly ingredients?: readonly unknown[] | null;
  readonly grist?: readonly unknown[] | null;
  readonly style?: unknown;
  readonly beverageStyle?: unknown;
  readonly styleName?: unknown;
  readonly strength?: unknown;
  readonly perceived_strength?: unknown;
  readonly perceivedStrength?: unknown;
  readonly beverageType?: unknown;
  readonly ibu?: unknown;
  readonly og?: unknown;
  readonly fg?: unknown;
  readonly abv?: unknown;
  readonly srm?: unknown;
  readonly attenuation?: unknown;
  readonly finalPh?: unknown;
  readonly finalPH?: unknown;
  readonly measuredFinalPh?: unknown;
  readonly ph?: unknown;
  readonly pH?: unknown;
  readonly lactoseGPerL?: unknown;
  readonly lactose_g_per_l?: unknown;
  readonly batchVolumeL?: unknown;
  readonly batchVolumeLiters?: unknown;
  readonly [key: string]: unknown;
}

export interface PublicRecipeIngredient {
  readonly name: string;
  readonly type: string | null;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly percent: number | null;
  readonly note: string | null;
}

export interface PublicRecipeStep {
  readonly text: string;
  readonly name: string | null;
  readonly temperatureC: number | null;
  readonly timeMinutes: number | null;
  readonly note: string | null;
}

export type RecipeProjectionStatus = "available" | "partial" | "unavailable";
export type RecipeProjectionKind = "custom" | "source";

export interface SafeRecipeProvenance {
  /** A caller-supplied display label; no provider identifiers are accepted. */
  readonly label: string | null;
  readonly state: string | null;
  readonly version: number | null;
  readonly capturedAt: string | null;
}

export interface PublicRecipeProjection {
  readonly kind: RecipeProjectionKind;
  readonly status: RecipeProjectionStatus;
  readonly ingredients: readonly PublicRecipeIngredient[];
  readonly steps: readonly PublicRecipeStep[];
  readonly notes: string | null;
  readonly provenance: SafeRecipeProvenance | null;
}

export type PublicRecipe = PublicRecipeProjection;

export const VESSEL_IDS = [
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
] as const;

export type VesselId = (typeof VESSEL_IDS)[number];
export type FillGlassId = VesselId;

export interface VesselDetailPath {
  readonly d: string;
  readonly className: "glass-detail" | "glass-stem" | "glass-base" | "glass-highlight";
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly opacity: number;
}

export interface VesselGeometryDescriptor {
  readonly id: VesselId;
  /** A finite server-owned token. Clients never accept paths outside this catalog. */
  readonly token: string;
  /** The v1 static body contour, carried as a bounded safe descriptor. */
  readonly bodyPath: string;
  /** The matching body contour used to clip the liquid and deterministic foam. */
  readonly clipPath: string;
  readonly rimPath: string;
  readonly viewBox: string;
  readonly topY: number;
  readonly bottomY: number;
  readonly fillX: number;
  readonly fillWidth: number;
  readonly detailPaths: readonly VesselDetailPath[];
}

export interface VesselResolution {
  readonly id: VesselId;
  readonly geometry: VesselGeometryDescriptor;
  readonly source: "explicit" | "style" | "fallback";
}

export const MYSTERY_REVEAL_KEYS = [
  "beverage_type",
  "style",
  "abv",
  "ibu",
  "og",
  "fg",
  "srm",
  "description",
  "recipe",
  "sensory",
  "history",
] as const;

export type MysteryRevealKey = (typeof MYSTERY_REVEAL_KEYS)[number];

export const MYSTERY_ALWAYS_VISIBLE_KEYS = [
  "tap_number",
  "display_color",
  "fill_glass",
  "remaining_amount",
  "fill_percent",
  "forecast",
  "days",
  "servings",
  "servings_remaining",
  "serving_temperature",
] as const;

export type MysteryAlwaysVisibleKey = (typeof MYSTERY_ALWAYS_VISIBLE_KEYS)[number];

export interface MysteryRevealConfig {
  readonly beverage_type?: boolean;
  readonly style?: boolean;
  readonly abv?: boolean;
  readonly ibu?: boolean;
  readonly og?: boolean;
  readonly fg?: boolean;
  readonly srm?: boolean;
  readonly description?: boolean;
  readonly recipe?: boolean;
  readonly sensory?: boolean;
  readonly history?: boolean;
  readonly revealBeverageType?: boolean;
  readonly revealStyle?: boolean;
  readonly revealAbv?: boolean;
  readonly revealIbu?: boolean;
  readonly revealOg?: boolean;
  readonly revealFg?: boolean;
  readonly revealSrm?: boolean;
  readonly revealDescription?: boolean;
  readonly revealRecipe?: boolean;
  readonly revealSensory?: boolean;
  readonly revealHistory?: boolean;
}

export interface MysteryVisibilityInput {
  readonly enabled?: boolean;
  readonly mystery?: boolean;
  readonly reveal?: Partial<Record<MysteryRevealKey, boolean>> | null;
  readonly config?: MysteryRevealConfig | null;
  readonly [key: string]: unknown;
}

export interface MysteryVisibilityPolicy {
  readonly title: "Mystery Tap" | null;
  readonly enabled: boolean;
  readonly reveal: Readonly<Record<MysteryRevealKey, boolean>>;
}

/**
 * A public Story vessel is a finite server-owned catalog entry.  The browser
 * may use the geometry to draw a controlled vessel, but it never receives a
 * user-provided path or SVG fragment.
 */
export interface PublicStoryVesselView {
  readonly graphicId: VesselId;
  readonly graphic: VesselGeometryDescriptor;
  readonly displayColor: string;
}

export interface PublicStoryPresentationView {
  readonly beverageName: string | null;
  readonly beverageType: string | null;
  readonly style: string | null;
  readonly description: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
}

export interface PublicStoryCurrentFillView {
  readonly fillDate: string | null;
  readonly assignedAt: string | null;
  readonly remainingVolumeMl: number | null;
  readonly capacityMl: number | null;
  readonly fillPercent: number | null;
  readonly servingsRemaining: number | null;
  readonly daysRemaining: number | null;
  readonly temperatureC: number | null;
  readonly waitingForMeasurement: boolean;
}

export interface PublicStoryHistoryItem {
  readonly volumeMl: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface PublicStoryRecipesView {
  readonly custom: PublicRecipeProjection | null;
  readonly sources: readonly PublicRecipeProjection[];
}

/** Small, explicit, JSON-safe Story response. */
export interface PublicStoryView {
  readonly tapNumber: number;
  readonly title: string;
  readonly accessibleLabel: string;
  readonly presentation: PublicStoryPresentationView;
  readonly vessel: PublicStoryVesselView;
  readonly currentFill: PublicStoryCurrentFillView;
  readonly sensory: SensoryProfile | null;
  readonly recipes: PublicStoryRecipesView | null;
  readonly history: readonly PublicStoryHistoryItem[] | null;
}

/**
 * Read-only beverage guidance shared by Story and future authenticated
 * surfaces.  It deliberately contains no persistence/source identifiers or
 * source JSON.
 */
export interface PublicBeverageGuidance {
  readonly sensory: SensoryProfile;
  readonly customRecipe: PublicRecipeProjection | null;
  readonly sourceRecipes: readonly PublicRecipeProjection[];
  readonly activeSourceLabel: string | null;
}
