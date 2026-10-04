/** Provider-independent, bounded recipe/batch inputs. Source values are authoritative;
 * Story's versioned heuristics are derived and never written into this contract. */
export const BREWING_INPUT_SCHEMA_VERSION = 2 as const;
export type BrewingInputFormat = "brewfather-api-v2" | "brewfather-export-v3" | "custom" | "legacy";
export type BrewingProvenance =
  | "operator_override"
  | "batch_reported"
  | "batch_calculated"
  | "batch_estimate"
  | "recipe_target"
  | "legacy"
  | "unavailable";
export type BrewingScalarKey =
  | "og"
  | "fg"
  | "abv"
  | "ibu"
  | "color"
  | "volume"
  | "carbonation"
  | "reportedAttenuation"
  | "recipeAttenuation"
  | "apparentAttenuation";
export interface BrewingScalar {
  readonly value: number | null;
  readonly unit: "sg" | "percent" | "ibu" | "srm" | "l" | "vol_co2";
  readonly sourcePath: string | null;
  readonly provenance: BrewingProvenance;
  readonly limitations: readonly string[];
}
export type BrewingIngredientRole = "fermentables" | "hops" | "yeasts" | "miscs";
export type HopStage = "boil" | "dry_hop" | "whirlpool" | "first_wort" | "mash" | "unknown";
export interface BrewingIngredient {
  readonly sourcePath: string;
  readonly name: string | null;
  readonly supplier: string | null;
  readonly laboratory: string | null;
  readonly productId: string | null;
  readonly type: string | null;
  readonly grainCategory: string | null;
  readonly use: string | null;
  readonly usage: string | null;
  readonly form: string | null;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly grams: number | null;
  readonly percentage: number | null;
  readonly color: number | null;
  readonly lovibond: number | null;
  readonly alpha: number | null;
  readonly day: number | null;
  readonly time: number | null;
  readonly timeUnit: string | null;
  readonly stage: HopStage;
  readonly boilMinutes: number | null;
  readonly contactDays: number | null;
  readonly additionDay: number | null;
  readonly temperatureC: number | null;
  readonly aroma: Readonly<Record<string, number>> | null;
  readonly totalOil: number | null;
  readonly limitations: readonly string[];
}
export interface BrewingCollection {
  readonly present: boolean;
  readonly originalCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly items: readonly BrewingIngredient[];
}
export type BrewingProcessKind =
  | "bourbon_barrel_recorded"
  | "oak_barrel_recorded"
  | "oak_contact_recorded"
  | "spirit_addition_recorded"
  | "vanilla_addition_recorded";
export interface BrewingProcessFact {
  readonly kind: BrewingProcessKind;
  readonly sourcePath: string;
  readonly sourceCategory: "batch_note" | "batch_notes";
  readonly timing: "unknown" | "inconsistent";
  /** Deliberately no raw note, timestamp, inferred duration, dose or intensity. */
}
export interface BrewingStep {
  readonly name: string | null;
  readonly type: string | null;
  readonly temperatureC: number | null;
  readonly time: number | null;
  readonly timeUnit: string | null;
}
export interface BrewingInputs {
  readonly schemaVersion: typeof BREWING_INPUT_SCHEMA_VERSION;
  readonly format: BrewingInputFormat;
  readonly beverageType: string;
  readonly scalars: Readonly<Record<BrewingScalarKey, BrewingScalar>>;
  readonly ingredients: Readonly<Record<BrewingIngredientRole, BrewingCollection>>;
  readonly processFacts: readonly BrewingProcessFact[];
  readonly processComplete: boolean;
  readonly mash: readonly BrewingStep[];
  readonly fermentation: readonly BrewingStep[];
  readonly water: {
    readonly sourcePh: number | null;
    readonly treatedPh: number | null;
    readonly mashPh: number | null;
    readonly treatedIons: Readonly<Record<string, number>>;
  };
  readonly style: {
    readonly name: string | null;
    readonly id: string | null;
    readonly guide: string | null;
  };
  readonly diagnostics: readonly string[];
}
