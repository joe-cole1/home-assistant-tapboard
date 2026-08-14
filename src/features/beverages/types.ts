import type { ActivityActorType } from "../activity/types.ts";

export type ActorType = ActivityActorType;

export type BeverageOwnershipType = "custom" | "brewfather";

export const BEVERAGE_TYPES = [
  "beer",
  "cider",
  "mead",
  "seltzer",
  "soda",
  "water",
  "cocktail",
  "kombucha",
  "coffee",
  "other",
] as const;

export type BeverageType = (typeof BEVERAGE_TYPES)[number];

export type BrewfatherCompletionPolicy = "never" | "ask" | "completed";
export type BrewfatherSyncState = "synced" | "stale" | "error" | "pending";
export type RecipeSnapshotState = "linked_current" | "detached" | "superseded";

export interface Beverage {
  readonly id: string;
  readonly ownershipType: BeverageOwnershipType;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BeverageSettings {
  readonly fallbackFg: number;
  readonly brewfatherCompletionPolicy: BrewfatherCompletionPolicy;
  readonly updatedAt: string;
}

export interface CustomBeverageProfile {
  readonly beverageId: string;
  readonly name: string;
  readonly beverageType: BeverageType;
  readonly style: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
  readonly displayColor: string | null;
  readonly description: string | null;
  readonly fillGlass: string | null;
  readonly manualDensityOverride: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomRecipeIngredient {
  readonly id: string;
  readonly recipeId: string;
  readonly sortOrder: number;
  readonly name: string;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly note: string | null;
}

export interface CustomRecipeStep {
  readonly id: string;
  readonly recipeId: string;
  readonly sortOrder: number;
  readonly name: string;
  readonly temperatureC: number | null;
  readonly timeMinutes: number | null;
  readonly note: string | null;
}

export interface CustomRecipe {
  readonly id: string;
  readonly beverageId: string;
  readonly notes: string | null;
  readonly ingredients: readonly CustomRecipeIngredient[];
  readonly steps: readonly CustomRecipeStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BeverageSensoryOverrides {
  readonly beverageId: string;
  readonly bitterness: number | null;
  readonly sweetness: number | null;
  readonly body: number | null;
  readonly roast: number | null;
  readonly tartness: number | null;
  readonly alcohol: number | null;
  readonly updatedAt: string;
}

export interface BrewfatherAccount {
  readonly id: string;
  readonly userId: string;
  readonly enabled: boolean;
  readonly discoveryStatuses: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrewfatherCandidate {
  readonly id: string;
  readonly accountId: string;
  readonly sourceBatchId: string;
  readonly batchName: string | null;
  readonly batchNumber: string | null;
  readonly status: string;
  readonly brewer: string | null;
  readonly recipeName: string | null;
  readonly style: string | null;
  readonly brewDate: string | null;
  readonly estimatedOg: number | null;
  readonly estimatedFg: number | null;
  readonly estimatedAbv: number | null;
  readonly estimatedIbu: number | null;
  readonly estimatedSrm: number | null;
  readonly rawSummaryJson: string | null;
  readonly summaryFingerprint: string;
  readonly syncedAt: string;
}

export interface BrewfatherBeverageLink {
  readonly beverageId: string;
  readonly accountId: string;
  readonly sourceBatchId: string;
  readonly syncState: BrewfatherSyncState;
  readonly lastSyncedAt: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrewfatherSourceProfile {
  readonly beverageId: string;
  readonly name: string;
  readonly beverageType: BeverageType;
  readonly style: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
  readonly displayColor: string | null;
  readonly description: string | null;
  readonly rawSourceJson: string | null;
  readonly sourceFingerprint: string;
  readonly updatedAt: string;
}

export interface BrewfatherPresentationOverrides {
  readonly beverageId: string;
  readonly overrideNamePresent: boolean;
  readonly name: string | null;
  readonly overrideBeverageTypePresent: boolean;
  readonly beverageType: BeverageType | null;
  readonly overrideStylePresent: boolean;
  readonly style: string | null;
  readonly overrideAbvPresent: boolean;
  readonly abv: number | null;
  readonly overrideIbuPresent: boolean;
  readonly ibu: number | null;
  readonly overrideOgPresent: boolean;
  readonly og: number | null;
  readonly overrideFgPresent: boolean;
  readonly fg: number | null;
  readonly overrideSrmPresent: boolean;
  readonly srm: number | null;
  readonly overrideDisplayColorPresent: boolean;
  readonly displayColor: string | null;
  readonly overrideDescriptionPresent: boolean;
  readonly description: string | null;
  readonly overrideFillGlassPresent: boolean;
  readonly fillGlass: string | null;
  readonly overrideManualDensityOverridePresent: boolean;
  readonly manualDensityOverride: number | null;
  readonly updatedAt: string;
}

export interface BeverageSourceRecipeSnapshot {
  readonly id: string;
  readonly beverageId: string;
  readonly accountId: string;
  readonly sourceBatchId: string;
  readonly sourceRecipeId: string | null;
  readonly state: RecipeSnapshotState;
  readonly version: number;
  readonly recipeJson: string;
  readonly recipeFingerprint: string;
  readonly createdAt: string;
}

export interface EffectiveBeveragePresentation {
  readonly name: string;
  readonly beverageType: BeverageType;
  readonly style: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
  readonly displayColor: string | null;
  readonly description: string | null;
  readonly fillGlass: string | null;
  readonly manualDensityOverride: number | null;
}

export type DensitySource = "manual_override" | "fg_derived" | "fallback_fg";

export interface DensityResolution {
  readonly densityGPerMl: number;
  readonly specificGravity: number;
  readonly source: DensitySource;
}

export interface BeverageDeletionImpact {
  readonly beverageId: string;
  readonly name: string;
  readonly ownershipType: BeverageOwnershipType;
  readonly impacts: readonly { readonly code: string; readonly count: number }[];
}

export interface CreateCustomBeverageInput {
  readonly id?: string;
  readonly name: string;
  readonly beverageType?: BeverageType;
  readonly style?: string | null;
  readonly abv?: number | null;
  readonly ibu?: number | null;
  readonly og?: number | null;
  readonly fg?: number | null;
  readonly srm?: number | null;
  readonly displayColor?: string | null;
  readonly description?: string | null;
  readonly fillGlass?: string | null;
  readonly manualDensityOverride?: number | null;
  readonly recipe?: {
    readonly notes?: string | null;
    readonly ingredients?: readonly {
      readonly name: string;
      readonly amount?: number | null;
      readonly unit?: string | null;
      readonly note?: string | null;
    }[];
    readonly steps?: readonly {
      readonly name: string;
      readonly temperatureC?: number | null;
      readonly timeMinutes?: number | null;
      readonly note?: string | null;
    }[];
  } | null;
  readonly sensoryOverrides?: {
    readonly bitterness?: number | null;
    readonly sweetness?: number | null;
    readonly body?: number | null;
    readonly roast?: number | null;
    readonly tartness?: number | null;
    readonly alcohol?: number | null;
  } | null;
}

export interface UpdateCustomBeverageInput {
  readonly name?: string;
  readonly beverageType?: BeverageType;
  readonly style?: string | null;
  readonly abv?: number | null;
  readonly ibu?: number | null;
  readonly og?: number | null;
  readonly fg?: number | null;
  readonly srm?: number | null;
  readonly displayColor?: string | null;
  readonly description?: string | null;
  readonly fillGlass?: string | null;
  readonly manualDensityOverride?: number | null;
  readonly recipe?: {
    readonly notes?: string | null;
    readonly ingredients?: readonly {
      readonly name: string;
      readonly amount?: number | null;
      readonly unit?: string | null;
      readonly note?: string | null;
    }[];
    readonly steps?: readonly {
      readonly name: string;
      readonly temperatureC?: number | null;
      readonly timeMinutes?: number | null;
      readonly note?: string | null;
    }[];
  } | null;
  readonly sensoryOverrides?: {
    readonly bitterness?: number | null;
    readonly sweetness?: number | null;
    readonly body?: number | null;
    readonly roast?: number | null;
    readonly tartness?: number | null;
    readonly alcohol?: number | null;
  } | null;
}

export interface LinkBrewfatherCandidateInput {
  readonly id?: string;
  readonly accountId?: string;
  readonly sourceBatchId: string;
  readonly overrides?: UpdatePresentationOverridesInput;
  readonly sensoryOverrides?: {
    readonly bitterness?: number | null;
    readonly sweetness?: number | null;
    readonly body?: number | null;
    readonly roast?: number | null;
    readonly tartness?: number | null;
    readonly alcohol?: number | null;
  } | null;
}

export interface PresentationOverrideFieldInput<T> {
  readonly inherit?: boolean;
  readonly clear?: boolean;
  readonly value?: T | null;
}

export interface UpdatePresentationOverridesInput {
  readonly name?: PresentationOverrideFieldInput<string>;
  readonly beverageType?: PresentationOverrideFieldInput<BeverageType>;
  readonly style?: PresentationOverrideFieldInput<string>;
  readonly abv?: PresentationOverrideFieldInput<number>;
  readonly ibu?: PresentationOverrideFieldInput<number>;
  readonly og?: PresentationOverrideFieldInput<number>;
  readonly fg?: PresentationOverrideFieldInput<number>;
  readonly srm?: PresentationOverrideFieldInput<number>;
  readonly displayColor?: PresentationOverrideFieldInput<string>;
  readonly description?: PresentationOverrideFieldInput<string>;
  readonly fillGlass?: PresentationOverrideFieldInput<string>;
  readonly manualDensityOverride?: PresentationOverrideFieldInput<number>;
}

export interface UpdateBeverageSettingsInput {
  readonly fallbackFg?: number;
  readonly brewfatherCompletionPolicy?: BrewfatherCompletionPolicy;
}

export interface ConfigureBrewfatherAccountInput {
  readonly accountId?: string;
  readonly userId: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
  readonly discoveryStatuses?: readonly string[];
}

export interface BeverageActorOptions {
  readonly actorType?: ActorType;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}
