import type { BrewingIngredient, BrewingIngredientRole } from "../../beverages/brewing-types.ts";
import type { FermentableFamily, IngredientFact, IngredientResolution } from "./catalog-types.ts";
import { INGREDIENT_FACTS } from "./catalog-data.ts";

export const CATALOG_VERSION = "tapboard-flavor-catalog-1";

/** Bounded exact identity normalization, never substring matching. */
function identity(value: string | null): string {
  return (value ?? "")
    .slice(0, 240)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/[‐‑–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
function manufacturerMatches(fact: IngredientFact, manufacturer: string): boolean {
  return (
    fact.manufacturer === null ||
    [fact.manufacturer, ...fact.manufacturerAliases].some((name) => identity(name) === manufacturer)
  );
}
function unresolved(reason: string): IngredientResolution {
  return {
    id: null,
    level: "unresolved",
    family: null,
    descriptors: [],
    sourceUrls: [],
    souring: null,
    functions: [],
    bodyClass: null,
    roastClass: "unknown",
    diagnostics: [reason],
  };
}
function result(
  fact: IngredientFact,
  item: BrewingIngredient,
  diagnostics: string[] = [],
): IngredientResolution {
  if (fact.id === "briess-munich") {
    diagnostics.push("Munich family requires product disambiguation.");
    if ((item.color !== null && item.color > 35) || (item.lovibond !== null && item.lovibond > 30))
      diagnostics.push(
        "Munich identity/color conflict retained; not reclassified as roasted grain.",
      );
  }
  if (fact.family === "roasted" && item.color !== null && item.color < 30)
    diagnostics.push("Roasted ingredient identity/color conflict retained.");
  if (fact.id === "briess-special-roast" && identity(item.grainCategory) === "roasted")
    diagnostics.push(
      "Special Roast is biscuit-style; provider category does not establish black roast.",
    );
  return {
    id: fact.id,
    level: fact.id.startsWith("family-") || fact.id === "briess-munich" ? "family" : "product",
    family: fact.family,
    descriptors: fact.descriptors,
    sourceUrls: fact.sourceUrls,
    souring: fact.souring,
    functions: fact.functions,
    bodyClass: fact.bodyClass,
    roastClass: fact.roastClass,
    diagnostics: [...diagnostics, ...fact.limitations],
  };
}

const CATEGORY_FAMILIES: Readonly<Record<string, FermentableFamily>> = {
  "base (pilsner)": "pilsner",
  "base (wheat)": "wheat",
  "base (vienna)": "vienna",
  "base (munich)": "munich",
};

export function resolveIngredient(
  role: BrewingIngredientRole,
  item: BrewingIngredient,
): IngredientResolution {
  const name = identity(item.name);
  const manufacturer = identity(role === "yeasts" ? item.laboratory : item.supplier);
  const code = identity(item.productId);
  const facts = INGREDIENT_FACTS.filter((fact) => fact.role === role);
  // Manufacturer + code is the strongest contract; conflicting identity is retained as a diagnostic.
  if (code && manufacturer) {
    const coded = facts.filter(
      (fact) =>
        fact.manufacturer !== null &&
        manufacturerMatches(fact, manufacturer) &&
        fact.codes.some((candidate) => identity(candidate) === code),
    );
    if (coded.length === 1) {
      const fact = coded[0]!;
      const conflicts =
        name && !fact.aliases.some((alias) => identity(alias) === name)
          ? ["Product code/name conflict; manufacturer and code selected."]
          : [];
      return result(fact, item, conflicts);
    }
  }
  const exactNamed = facts.filter(
    (fact) =>
      fact.aliases.some((alias) => identity(alias) === name) &&
      manufacturerMatches(fact, manufacturer),
  );
  const manufacturerNamed = exactNamed.filter((fact) => fact.manufacturer !== null);
  const named = manufacturerNamed.length ? manufacturerNamed : exactNamed;
  if (named.length === 1) {
    const fact = named[0]!;
    // An unknown populated yeast code cannot be silently discarded to force a familiar name.
    if (
      role === "yeasts" &&
      code &&
      fact.codes.length &&
      !fact.codes.some((candidate) => identity(candidate) === code)
    )
      return unresolved("Unknown/conflicting yeast product code prevents name resolution.");
    if (role === "yeasts" && !manufacturer && fact.manufacturer !== null)
      return unresolved("Specific yeast laboratory is required for this name.");
    return result(fact, item);
  }
  // Exception only for a full exact branded name with no laboratory or product code.
  if (role === "yeasts" && !manufacturer && !code && name === "lallemand verdant ipa yeast") {
    return result(
      INGREDIENT_FACTS.find((fact) => fact.id === "lallemand-verdant")!,
      item,
      ["Laboratory established by exact branded product name."],
    );
  }
  if (
    role === "hops" &&
    ["hallertau", "arctic blend", "columbus/tomahawk/zeus (ctz)"].includes(name)
  )
    return unresolved(
      name === "hallertau"
        ? "Hallertau is ambiguous; no specific variety inferred."
        : "Blend composition is not resolved.",
    );
  if (role === "fermentables") {
    // Product exceptions must not fall through into misleading source categories.
    if (
      [
        "carapils",
        "cara-pils",
        "carapils copper",
        "carapils/carafoam",
        "carafoam",
        "special roast",
        "special roast malt",
      ].includes(name)
    )
      return unresolved(
        "Manufacturer-specific product requires reviewed identity; category fallback blocked.",
      );
    const family = CATEGORY_FAMILIES[identity(item.grainCategory)];
    if (family && identity(item.type) === "grain") {
      return {
        id: "category-" + family,
        level: "family",
        family,
        descriptors: [],
        sourceUrls: ["https://docs.brewfather.app/api/types"],
        souring: null,
        functions: [],
        bodyClass: family === "wheat" ? "wheat" : null,
        roastClass: "none",
        diagnostics: [
          "Provider base-grain category supports family only; specific product character unresolved.",
        ],
      };
    }
  }
  return unresolved(
    name
      ? "Ingredient identity is outside the reviewed catalog."
      : "Ingredient name is missing; no identity inferred.",
  );
}
