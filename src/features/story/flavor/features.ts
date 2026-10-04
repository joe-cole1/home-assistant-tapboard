import type {
  BrewingInputs,
  BrewingIngredient,
  BrewingIngredientRole,
} from "../../beverages/brewing-types.ts";
import type { FlavorCoverage } from "../types.ts";
import { resolveIngredient } from "./catalog.ts";
import type { IngredientResolution } from "./catalog-types.ts";
import { finite, defineCurve, interpolateCurve } from "./math.ts";
const FIXED_CURVE_0 = defineCurve([
  [0, 0.5],
  [5, 0.4],
  [10, 0.3],
  [20, 0.15],
  [30, 0.08],
  [60, 0.025],
]);
export interface ResolvedRow {
  readonly ingredient: BrewingIngredient;
  readonly resolution: IngredientResolution;
  readonly mass: number;
  readonly exposure: number | null;
}
export const ROLES = ["fermentables", "hops", "yeasts", "miscs"] as const;
export function hopWeight(item: BrewingIngredient): number | null {
  switch (item.stage) {
    case "boil":
      return finite(item.boilMinutes) && item.boilMinutes >= 0
        ? interpolateCurve(item.boilMinutes, FIXED_CURVE_0)
        : null;
    case "first_wort":
      return 0.02;
    case "whirlpool":
      return 0.6;
    case "dry_hop":
      return 1;
    case "mash":
      return 0;
    default:
      return null;
  }
}
export function conventionalHop(item: BrewingIngredient): boolean {
  const form = item.form?.trim().toLowerCase();
  if (
    /\b(?:cryo|lupomax|incognito|spectrum|extract)\b|hop[ -]?oil/i.test(
      `${item.name ?? ""} ${item.form ?? ""} ${item.type ?? ""}`,
    )
  )
    return false;
  if (
    item.type &&
    ["extract", "oil", "concentrate", "cryogenic", "cryo"].includes(item.type.trim().toLowerCase())
  )
    return false;
  return (
    form == null ||
    form === "" ||
    ["pellet", "pellets", "t-90", "t90", "whole", "leaf", "whole leaf"].includes(form)
  );
}
export function resolveFeatures(inputs: BrewingInputs): {
  rows: Readonly<Record<BrewingIngredientRole, readonly ResolvedRow[]>>;
  coverage: Readonly<Record<BrewingIngredientRole, FlavorCoverage>>;
} {
  const rows = {} as Record<BrewingIngredientRole, ResolvedRow[]>;
  const coverage = {} as Record<BrewingIngredientRole, FlavorCoverage>;
  for (const role of ROLES) {
    const collection = inputs.ingredients[role];
    rows[role] = collection.items.map((ingredient) => {
      const resolution = resolveIngredient(role, ingredient);
      const mass = finite(ingredient.grams) && ingredient.grams > 0 ? ingredient.grams : 0;
      const weight = role === "hops" && conventionalHop(ingredient) ? hopWeight(ingredient) : null;
      return { ingredient, resolution, mass, exposure: weight === null ? null : mass * weight };
    });
    const eligible = rows[role].filter(
      (row) =>
        !row.resolution.functions.includes("nonextract") && row.resolution.family !== "processing",
    );
    const eligibleMassG = eligible.reduce((total, row) => total + row.mass, 0);
    const resolvedMassG = eligible
      .filter((row) => row.resolution.level !== "unresolved")
      .reduce((total, row) => total + row.mass, 0);
    coverage[role] = {
      present: collection.present,
      complete:
        collection.present &&
        collection.complete &&
        !collection.truncated &&
        collection.rejectedCount === 0 &&
        collection.acceptedCount === collection.items.length &&
        collection.originalCount === collection.acceptedCount,
      acceptedCount: collection.acceptedCount,
      resolvedCount: rows[role].filter((row) => row.resolution.level !== "unresolved").length,
      eligibleMassG,
      resolvedMassG,
      classifiedFraction: eligibleMassG > 0 ? resolvedMassG / eligibleMassG : null,
    };
  }
  return { rows, coverage };
}
export function composition(
  rows: readonly ResolvedRow[],
  coverage: FlavorCoverage,
): {
  fractions: readonly { row: ResolvedRow; fraction: number }[];
  supported: boolean;
  absentSupported: boolean;
} {
  const eligible = rows.filter(
    (row) =>
      !row.resolution.functions.includes("nonextract") && row.resolution.family !== "processing",
  );
  const massComplete = eligible.length > 0 && eligible.every((row) => row.mass > 0);
  const percentages = eligible.map((row) => row.ingredient.percentage);
  const percentageComplete =
    eligible.length > 0 &&
    percentages.every((value) => finite(value) && value >= 0) &&
    Math.abs(percentages.reduce<number>((sum, value) => sum + (value ?? 0), 0) - 100) <= 0.5;
  const fractions = eligible.map((row) => ({
    row,
    fraction: massComplete
      ? row.mass / coverage.eligibleMassG
      : percentageComplete
        ? (row.ingredient.percentage ?? 0) / 100
        : 0,
  }));
  const resolvedFraction = fractions
    .filter(({ row }) => row.resolution.family !== null)
    .reduce((sum, item) => sum + item.fraction, 0);
  const highImpact = fractions.some(
    ({ row, fraction }) => row.resolution.family === null && fraction > 0.05,
  );
  const denominator = massComplete || percentageComplete;
  return {
    fractions,
    supported: coverage.complete && denominator && resolvedFraction >= 0.85 && !highImpact,
    absentSupported: coverage.complete && denominator && resolvedFraction >= 1 - 1e-9,
  };
}
