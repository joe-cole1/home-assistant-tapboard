import type { BrewingInputs } from "./brewing-types.ts";
import { normalizeBrewfatherBrewingInputs } from "./brewfather/brewing.ts";
import { object } from "./brewfather/brewing.ts";
const boundedText = (v: unknown, max = 256): boolean =>
  v === null || (typeof v === "string" && v.length <= max);
const finite = (v: unknown, min = -1e9, max = 1e9): boolean =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max);
const strings = (v: unknown, max = 100): boolean =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 256);
export function readBrewingInputs(snapshot: unknown): BrewingInputs | null {
  const value = object(snapshot).brewingInputs,
    input = object(value);
  if (
    input.schemaVersion !== 2 ||
    !["brewfather-api-v2", "brewfather-export-v3", "custom", "legacy"].includes(
      input.format as string,
    ) ||
    typeof input.beverageType !== "string" ||
    input.beverageType.length > 64
  )
    return null;
  const scalars = object(input.scalars),
    ingredients = object(input.ingredients);
  const scalarUnits = {
    og: "sg",
    fg: "sg",
    abv: "percent",
    ibu: "ibu",
    color: "srm",
    volume: "l",
    carbonation: "vol_co2",
    reportedAttenuation: "percent",
    recipeAttenuation: "percent",
    apparentAttenuation: "percent",
  } as const;
  for (const [key, unit] of Object.entries(scalarUnits)) {
    const row = object(scalars[key]);
    if (
      !finite(row.value) ||
      row.unit !== unit ||
      ![
        "operator_override",
        "batch_reported",
        "batch_calculated",
        "batch_estimate",
        "recipe_target",
        "legacy",
        "unavailable",
      ].includes(row.provenance as string) ||
      !boundedText(row.sourcePath) ||
      !strings(row.limitations)
    )
      return null;
  }
  for (const role of ["fermentables", "hops", "yeasts", "miscs"]) {
    const c = object(ingredients[role]);
    if (
      typeof c.present !== "boolean" ||
      typeof c.complete !== "boolean" ||
      typeof c.truncated !== "boolean" ||
      ![c.originalCount, c.acceptedCount, c.rejectedCount].every(
        (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e6,
      ) ||
      !Array.isArray(c.items) ||
      c.items.length > 100 ||
      c.acceptedCount !== c.items.length ||
      Number(c.acceptedCount) + Number(c.rejectedCount) !== Math.min(Number(c.originalCount), 100)
    )
      return null;
    for (const item of c.items) {
      const row = object(item);
      if (
        typeof row.sourcePath !== "string" ||
        row.sourcePath.length > 256 ||
        !strings(row.limitations) ||
        !["boil", "dry_hop", "whirlpool", "first_wort", "mash", "unknown"].includes(
          row.stage as string,
        )
      )
        return null;
      for (const key of [
        "name",
        "supplier",
        "laboratory",
        "productId",
        "type",
        "grainCategory",
        "use",
        "usage",
        "form",
        "unit",
        "timeUnit",
      ]) {
        if (!boundedText(row[key])) return null;
      }
      for (const key of [
        "amount",
        "grams",
        "percentage",
        "color",
        "lovibond",
        "alpha",
        "day",
        "time",
        "boilMinutes",
        "contactDays",
        "additionDay",
        "totalOil",
      ]) {
        if (!finite(row[key], 0, 1e9)) return null;
      }
      if (!finite(row.temperatureC, -100, 200)) return null;
      if (row.aroma !== null) {
        const aroma = object(row.aroma);
        if (
          !row.aroma ||
          typeof row.aroma !== "object" ||
          Array.isArray(row.aroma) ||
          Object.keys(aroma).length > 8 ||
          !Object.entries(aroma).every(
            ([k, v]) =>
              [
                "floral",
                "grassy",
                "herbal",
                "earthy",
                "woody",
                "onion",
                "citrus",
                "fruity",
              ].includes(k) &&
              typeof v === "number" &&
              Number.isFinite(v) &&
              v >= 0 &&
              v <= 100,
          )
        )
          return null;
      }
    }
  }
  if (
    typeof input.processComplete !== "boolean" ||
    !Array.isArray(input.processFacts) ||
    input.processFacts.length > 30
  )
    return null;
  for (const value of input.processFacts) {
    const f = object(value);
    if (
      ![
        "bourbon_barrel_recorded",
        "oak_barrel_recorded",
        "oak_contact_recorded",
        "spirit_addition_recorded",
        "vanilla_addition_recorded",
      ].includes(f.kind as string) ||
      !["batch_note", "batch_notes"].includes(f.sourceCategory as string) ||
      !["unknown", "inconsistent"].includes(f.timing as string) ||
      typeof f.sourcePath !== "string" ||
      f.sourcePath.length > 256
    )
      return null;
  }
  for (const key of ["mash", "fermentation"]) {
    const rows = input[key];
    if (!Array.isArray(rows) || rows.length > 50) return null;
    for (const v of rows) {
      const step = object(v);
      if (
        !boundedText(step.name) ||
        !boundedText(step.type) ||
        !boundedText(step.timeUnit) ||
        !finite(step.temperatureC, -100, 200) ||
        !finite(step.time, 0, 1e6)
      )
        return null;
    }
  }
  const water = object(input.water);
  if (![water.sourcePh, water.treatedPh, water.mashPh].every((v) => finite(v, 0, 14))) return null;
  const ions = object(water.treatedIons);
  if (
    !water.treatedIons ||
    typeof water.treatedIons !== "object" ||
    Array.isArray(water.treatedIons) ||
    Object.keys(ions).length > 6 ||
    !Object.entries(ions).every(
      ([k, v]) =>
        ["calcium", "magnesium", "sodium", "chloride", "sulfate", "bicarbonate"].includes(k) &&
        typeof v === "number" &&
        finite(v, 0, 10000),
    )
  )
    return null;
  const style = object(input.style);
  if (
    !boundedText(style.name) ||
    !boundedText(style.id) ||
    !boundedText(style.guide) ||
    !strings(input.diagnostics, 100)
  )
    return null;
  return value as BrewingInputs;
}
export function normalizeCustomBrewingInputs(
  recipe: unknown,
  presentation: unknown,
): BrewingInputs {
  const p = object(presentation),
    r = object(recipe);
  const collections: Record<string, unknown[]> = {
    fermentables: [],
    hops: [],
    yeasts: [],
    miscs: [],
  };
  for (const value of (Array.isArray(r.ingredients) ? r.ingredients : []).slice(0, 100)) {
    const row = object(value),
      name = typeof row.name === "string" ? row.name.toLowerCase().trim() : "";
    // The Custom schema has no role/stage fields. Recognize only conservative ingredient identities;
    // unknown ingredients stay miscellaneous and cannot prove complete composition or absence.
    const role =
      /\b(malt|barley|wheat|oats|rye|rice hulls|carapils|dextrose|sucrose|candi sugar|lactose)\b/.test(
        name,
      )
        ? "fermentables"
        : /^(citra|mosaic|cascade|saaz|magnum|simcoe|amarillo|willamette|liberty|east kent goldings|hallertau mittelfr[uü]h)$/.test(
              name,
            )
          ? "hops"
          : /\b(yeast|us-05|s-04|w-34\/70|be-134|wlp\d{3})\b/.test(name)
            ? "yeasts"
            : "miscs";
    collections[role]!.push({ name: row.name, amount: row.amount, unit: row.unit });
  }
  const result = normalizeBrewfatherBrewingInputs(
    {
      type: p.beverageType,
      og: p.og,
      fg: p.fg,
      abv: p.abv,
      ibu: p.ibu,
      color: p.srm,
      style: p.style,
      ...collections,
    },
    undefined,
    { format: "custom" },
  );
  return {
    ...result,
    processComplete: false,
    ingredients: Object.fromEntries(
      Object.entries(result.ingredients).map(([key, value]) => [
        key,
        { ...value, complete: false },
      ]),
    ) as BrewingInputs["ingredients"],
    diagnostics: [...result.diagnostics, "custom_recipe_roles_and_schedule_limited"],
  };
}
export function adaptLegacyBrewingInputs(snapshot: unknown, presentation: unknown): BrewingInputs {
  const p = object(presentation),
    r = object(snapshot),
    ingredients = object(r.ingredients);
  const result = normalizeBrewfatherBrewingInputs(
    { ...r, ...ingredients, type: p.beverageType, og: p.og, fg: p.fg, abv: p.abv, ibu: p.ibu },
    undefined,
    { format: "legacy" },
  );
  return {
    ...result,
    diagnostics: [...result.diagnostics, "legacy_snapshot_incomplete"],
    ingredients: Object.fromEntries(
      Object.entries(result.ingredients).map(([key, value]) => [
        key,
        { ...value, complete: false },
      ]),
    ) as BrewingInputs["ingredients"],
    processComplete: false,
  };
}
