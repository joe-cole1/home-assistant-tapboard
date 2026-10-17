import type { BrewingIngredient, BrewingIngredientRole } from "../../beverages/brewing-types.ts";
import type { FermentableFamily, IngredientFact, IngredientResolution } from "./catalog-types.ts";
import { INGREDIENT_CLASSES, INGREDIENT_FACTS } from "./catalog-data.ts";

export const CATALOG_VERSION = "tapboard-flavor-catalog-2";

/** Bounded exact identity normalization, never substring matching. Accents fold away so
 * "Mittelfruh" and "Mittelfrüh" are one name. */
function identity(value: string | null): string {
  return (value ?? "")
    .slice(0, 240)
    .replace(/[®™℠]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
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
    noticeableGPerL: null,
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
    noticeableGPerL: fact.noticeableGPerL,
    diagnostics: [...diagnostics, ...fact.limitations],
  };
}

const CATEGORY_FAMILIES: Readonly<Record<string, FermentableFamily>> = {
  "base (pilsner)": "pilsner",
  "base (wheat)": "wheat",
  "base (vienna)": "vienna",
  "base (munich)": "munich",
};

/** Acidulated (sour) malt: its producer allows both pH adjustment and sour-beer use. */
export const ACID_MALT = /acidulated|acid malt|sauer|sour malt/i;
/** Souring and mixed cultures are usually named for their bugs, style or blend. */
export const SOURING_CULTURE =
  /lacto|brett|sour|philly|wild|pedio|lachancea|mixed|culture|roeselare|blend|lambic|gueuze|berliner|bruin|flanders|farmhouse|amalgamation|funk|bugs|dregs/i;
/** Concentrated hop products (in name, form or type): no pellet dose equivalence is modelled. */
export const CONCENTRATED_HOP =
  /\b(?:cryo|cryogenic|lupomax|incognito|spectrum|extract|concentrate|oil)\b/i;
/** Colour in °L: explicit Lovibond, then an "NN L" product name, then Brewfather SRM `color`.
 * Custom Brewfather grains sometimes store °L in `color`, so the name wins over conversion. */
export function lovibondOf(item: BrewingIngredient): number | null {
  if (item.lovibond !== null && Number.isFinite(item.lovibond)) return item.lovibond;
  const named = /(\d+(?:\.\d+)?)\s*°?\s*L\b/i.exec(item.name ?? "");
  if (named) return Number(named[1]);
  return item.color !== null && Number.isFinite(item.color) ? (item.color + 0.76) / 1.3546 : null;
}
function classified(
  family: FermentableFamily,
  lovibond: number | null,
  bodyClass: IngredientResolution["bodyClass"] = null,
  id = `property-${family}`,
): IngredientResolution {
  return {
    id,
    level: "family",
    family,
    descriptors: [],
    sourceUrls: ["https://docs.brewfather.app/api/types"],
    souring: null,
    functions: family === "sugar" ? ["fermentable_sugar"] : family === "lactose" ? ["lactose"] : [],
    bodyClass,
    roastClass:
      family === "roasted"
        ? "black"
        : family === "chocolate"
          ? "chocolate"
          : family === "dehusked_roast"
            ? "dehusked"
            : "none",
    noticeableGPerL: null,
    diagnostics: [
      `Classified from Brewfather category and colour${lovibond === null ? "" : ` (${Math.round(lovibond)} °L)`}; product character unresolved.`,
    ],
  };
}
/** Last-resort class from name tokens, Brewfather type/category and colour. Conflicting colour
 * stays unresolved so a data-entry error never becomes roast or base character. */
function propertyResolution(item: BrewingIngredient, name: string): IngredientResolution | null {
  const type = identity(item.type);
  const category = identity(item.grainCategory);
  const lovibond = lovibondOf(item);
  if (type.includes("extract")) return null;
  const wheat = /wheat/.test(name) ? "wheat" : null;
  if (/peat/.test(name)) return classified("peated", lovibond, wheat);
  if (/smoked|rauch/.test(name)) return classified("smoked", lovibond, wheat);
  // Acidulated malt is pilsner malt with lactic acid; the tartness rule still inspects its share.
  if (ACID_MALT.test(name)) return classified("pilsner", lovibond, null, "property-acidulated");
  if (/maltodextrin/.test(name))
    return classified("carapils", lovibond, "carapils", "property-maltodextrin");
  if (/lactose|milk sugar/.test(name)) return classified("lactose", lovibond);
  if (/victory|biscuit|carabrown/.test(name)) return classified("biscuit", lovibond);
  if (/honey malt|brumalt/.test(name)) return classified("aromatic", lovibond);
  if (type === "sugar") return classified("sugar", lovibond);
  if (/flaked|torrefied/.test(name) && ["", "grain", "adjunct"].includes(type))
    return classified(
      "flaked",
      lovibond,
      /oat/.test(name) ? "oats" : /wheat/.test(name) ? "flaked_wheat" : null,
    );
  if ((type !== "" && type !== "grain") || lovibond === null) return null;
  if (category === "roasted" || /chocolate|black|roast|carafa/.test(name)) {
    if (lovibond < 100)
      return unresolved(
        `Roasted category or name at ${Math.round(lovibond)} °L conflicts with roasted malt; not classified.`,
      );
    return classified(
      /chocolate/.test(name)
        ? "chocolate"
        : /special|dehusk/.test(name)
          ? "dehusked_roast"
          : "roasted",
      lovibond,
    );
  }
  if (category.startsWith("crystal") || /cara|crystal|caramel/.test(name))
    return classified(
      lovibond < 3.5 ? "carapils" : lovibond < 75 ? "crystal_light" : "crystal_dark",
      lovibond,
    );
  if (category !== "" && !category.startsWith("base")) return null;
  if (lovibond > 35)
    return unresolved(
      `Base malt at ${Math.round(lovibond)} °L conflicts with its category; not classified.`,
    );
  if (lovibond < 13 && /wheat/.test(name)) return classified("wheat", lovibond, "wheat");
  if (lovibond < 13 && /rye/.test(name)) return classified("rye", lovibond, "rye");
  return classified(
    lovibond < 2.5
      ? "pilsner"
      : lovibond < 5
        ? /vienna/.test(name)
          ? "vienna"
          : "pale"
        : lovibond < 13
          ? "munich"
          : "aromatic",
    lovibond,
  );
}

/** First generic class whose name pattern and Brewfather type fit; null when none does. */
function classResolution(
  role: BrewingIngredientRole,
  item: BrewingIngredient,
  name: string,
  code: string,
  reason?: string,
): IngredientResolution | null {
  const type = identity(item.type);
  const text = role === "yeasts" ? `${name} ${code}`.trim() : name;
  if (
    !name ||
    // Souring cultures and lager strains are never named by an ale-family class.
    (role === "yeasts" && (SOURING_CULTURE.test(text) || /lager/.test(text))) ||
    (role === "fermentables" && /\bmalt|malz|wheat|rye|barley|spelt/.test(name))
  )
    return null;
  const match = INGREDIENT_CLASSES.find(
    (candidate) =>
      candidate.roles.includes(role) &&
      (candidate.types.length === 0 || candidate.types.includes(type)) &&
      candidate.pattern.test(text) &&
      !candidate.exclude?.test(text),
  );
  if (!match) return null;
  return {
    id: match.id,
    level: "family",
    family: role === "fermentables" ? match.family : null,
    descriptors: match.descriptors,
    sourceUrls: [],
    souring: match.souring,
    functions: match.functions,
    bodyClass: null,
    roastClass: "none",
    noticeableGPerL: match.noticeableGPerL,
    diagnostics: [
      `Generic ${match.label} class from the ingredient name; no reviewed product entry.`,
      ...(reason ? [reason] : []),
    ],
  };
}
// Origin and conventional-form words around a hop variety name, e.g. "German Magnum" or
// "Saaz (CZ)". New Zealand and Australian names are distinct cultivars ("NZ Saaz" is not Saaz),
// and concentrated forms are never stripped.
const HOP_QUALIFIERS = [
  /^(?:us|usa|american|german|germany|czech|uk|english|slovenian|yakima)\s+/,
  /\s*\((?:us|usa|de|ger|german|cz|czech|uk|si|slo)\)$/,
  /\s+(?:pellets?|t-?90|whole(?: leaf| cone)?|leaf|hops?)$/,
];
function hopVariety(name: string): string {
  let variety = name;
  for (let previous = ""; previous !== variety;) {
    previous = variety;
    for (const qualifier of HOP_QUALIFIERS) variety = variety.replace(qualifier, "").trim();
  }
  return variety;
}

export function resolveIngredient(
  role: BrewingIngredientRole,
  item: BrewingIngredient,
): IngredientResolution {
  const name = identity(item.name);
  const manufacturer = identity(role === "yeasts" ? item.laboratory : item.supplier);
  const code = identity(item.productId);
  const facts = INGREDIENT_FACTS.filter((fact) => fact.role === role);
  const fallback = (reason: string) =>
    classResolution(role, item, name, code, reason) ?? unresolved(reason);
  if (
    role === "hops" &&
    CONCENTRATED_HOP.test(`${item.name ?? ""} ${item.form ?? ""} ${item.type ?? ""}`)
  )
    return unresolved(
      "Concentrated hop product; dose equivalence is not modelled, so it adds no hop character.",
    );
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
      return fallback("Unknown/conflicting yeast product code prevents name resolution.");
    if (role === "yeasts" && !manufacturer && fact.manufacturer !== null)
      return fallback("Specific yeast laboratory is required for this name.");
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
  if (role === "hops" && name === "arctic blend")
    return unresolved("Proprietary blend composition is not published.");
  if (role === "hops") {
    const variety = hopVariety(name);
    const named =
      variety === name
        ? []
        : facts.filter((fact) => fact.aliases.some((alias) => identity(alias) === variety));
    if (named.length === 1)
      return result(named[0]!, item, [
        "Variety matched after removing origin or form words; growing region and lot can change character.",
      ]);
  }
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
        noticeableGPerL: null,
        diagnostics: [
          "Provider base-grain category supports family only; specific product character unresolved.",
        ],
      };
    }
    // Fruit, spices and processing aids listed as fermentables; grains, sugars and extracts never.
    if (["", "other", "adjunct"].includes(identity(item.type))) {
      const adjunct = classResolution(role, item, name, code);
      if (adjunct) return adjunct;
    }
    const property = propertyResolution(item, name);
    if (property) return property;
    return unresolved(
      name
        ? "Ingredient identity is outside the reviewed catalog."
        : "Ingredient name is missing; no identity inferred.",
    );
  }
  return name
    ? fallback("Ingredient identity is outside the reviewed catalog.")
    : unresolved("Ingredient name is missing; no identity inferred.");
}
