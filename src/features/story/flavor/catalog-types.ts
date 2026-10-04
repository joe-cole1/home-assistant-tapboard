import type { BrewingIngredient, BrewingIngredientRole } from "../../beverages/brewing-types.ts";
export type FermentableFamily =
  | "pilsner"
  | "pale"
  | "wheat"
  | "vienna"
  | "munich"
  | "biscuit"
  | "aromatic"
  | "crystal_light"
  | "crystal_dark"
  | "roasted"
  | "chocolate"
  | "dehusked_roast"
  | "flaked"
  | "rye"
  | "carapils"
  | "sugar"
  | "lactose"
  | "processing"
  | "extract_pale"
  | "extract_dark";
export type IngredientFunction =
  | "nonextract"
  | "lactose"
  | "botanical"
  | "mash_acid"
  | "antioxidant"
  | "aldc"
  | "thiol_precursor"
  | "finished_acid"
  | "fermentable_sugar"
  | "water_treatment"
  | "processing"
  | "fruit";
export interface IngredientResolution {
  readonly id: string | null;
  readonly level: "product" | "family" | "unresolved";
  readonly family: FermentableFamily | null;
  readonly descriptors: readonly string[];
  readonly sourceUrls: readonly string[];
  readonly souring: boolean | null;
  readonly functions: readonly IngredientFunction[];
  readonly bodyClass: "oats" | "flaked_wheat" | "chit" | "rye" | "wheat" | "carapils" | null;
  readonly roastClass: "black" | "chocolate" | "dehusked" | "none" | "unknown";
  readonly diagnostics: readonly string[];
}
export interface IngredientFact {
  readonly id: string;
  readonly role: BrewingIngredientRole;
  readonly manufacturer: string | null;
  readonly manufacturerAliases: readonly string[];
  readonly codes: readonly string[];
  readonly aliases: readonly string[];
  readonly family: FermentableFamily | null;
  readonly descriptors: readonly string[];
  readonly sourceUrls: readonly string[];
  readonly reviewedAt: string;
  readonly scope: string;
  readonly limitations: readonly string[];
  readonly souring: boolean | null;
  readonly functions: readonly IngredientFunction[];
  readonly bodyClass: IngredientResolution["bodyClass"];
  readonly roastClass: IngredientResolution["roastClass"];
}
export type IngredientResolver = (
  role: BrewingIngredientRole,
  ingredient: BrewingIngredient,
) => IngredientResolution;
