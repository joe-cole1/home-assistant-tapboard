import type { BrewingIngredientRole } from "../../beverages/brewing-types.ts";
export const FERMENTABLE_FAMILIES = [
  "pilsner",
  "pale",
  "wheat",
  "vienna",
  "munich",
  "biscuit",
  "aromatic",
  "crystal_light",
  "crystal_dark",
  "roasted",
  "chocolate",
  "dehusked_roast",
  "flaked",
  "rye",
  "carapils",
  "sugar",
  "lactose",
  "processing",
  "extract_pale",
  "extract_dark",
  "smoked",
  "peated",
] as const;
export type FermentableFamily = (typeof FERMENTABLE_FAMILIES)[number];
export const INGREDIENT_FUNCTIONS = [
  "nonextract",
  "lactose",
  "botanical",
  "mash_acid",
  "antioxidant",
  "aldc",
  "thiol_precursor",
  "finished_acid",
  "fermentable_sugar",
  "water_treatment",
  "processing",
  "fruit",
] as const;
export type IngredientFunction = (typeof INGREDIENT_FUNCTIONS)[number];
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
  /** Dose in g/L at which a flavour adjunct becomes clearly noticeable; null when not dosed. */
  readonly noticeableGPerL: number | null;
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
  readonly noticeableGPerL: number | null;
}
/** Generic class matched by name tokens when no reviewed product or property rule applies. */
export interface IngredientClass {
  readonly id: string;
  readonly label: string;
  readonly roles: readonly BrewingIngredientRole[];
  /** Tested against the accent-folded lowercase name (yeasts: name and product code). */
  readonly pattern: RegExp;
  readonly exclude: RegExp | null;
  /** Lowercase Brewfather types the class applies to; empty means any type. */
  readonly types: readonly string[];
  readonly family: FermentableFamily | null;
  readonly descriptors: readonly string[];
  readonly functions: readonly IngredientFunction[];
  readonly souring: boolean | null;
  readonly noticeableGPerL: number | null;
}
