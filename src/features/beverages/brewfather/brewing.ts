import type {
  BrewingInputs,
  BrewingInputFormat,
  BrewingIngredient,
  BrewingIngredientRole,
  BrewingScalar,
  BrewingScalarKey,
  BrewingProvenance,
  BrewingStep,
} from "../brewing-types.ts";
import { extractProcessFacts } from "./process.ts";
export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function number(v: unknown, min = 0, max = 1e6): number | null {
  if (
    typeof v !== "number" &&
    !(typeof v === "string" && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()))
  )
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
export function text(v: unknown, max = 160): string | null {
  if (typeof v !== "string") return null;
  return (
    v
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim()
      .slice(0, max) || null
  );
}
const units: Readonly<Record<string, number>> = {
  kg: 1000,
  g: 1,
  mg: 0.001,
  lb: 453.59237,
  lbs: 453.59237,
  oz: 28.349523125,
};
function ingredient(
  row: Record<string, unknown>,
  role: BrewingIngredientRole,
  index: number,
  format: BrewingInputFormat,
): BrewingIngredient {
  const provider = format === "brewfather-api-v2" || format === "brewfather-export-v3";
  const amount = number(row.amount);
  const unit =
    text(row.unit, 32) ??
    (provider ? (role === "fermentables" ? "kg" : role === "hops" ? "g" : null) : null);
  const use = text(row.use, 80);
  const normalized = use?.toLowerCase().replace(/[\s_-]+/g, "");
  const stage =
    normalized === "boil"
      ? "boil"
      : normalized === "dryhop"
        ? "dry_hop"
        : ["aroma", "whirlpool", "hopstand"].includes(normalized ?? "")
          ? "whirlpool"
          : normalized === "firstwort"
            ? "first_wort"
            : normalized === "mash"
              ? "mash"
              : "unknown";
  const time = number(row.time);
  const timeUnit = text(row.timeUnit, 32);
  const limitations: string[] = [];
  for (const key of [
    "percentage",
    "percent",
    "color",
    "lovibond",
    "alpha",
    "day",
    "time",
    "temp",
    "temperature",
  ]) {
    const value = row[key];
    if (
      value !== undefined &&
      value !== null &&
      number(value, key === "temp" || key === "temperature" ? -100 : 0) === null
    )
      limitations.push(`invalid_field:${key}`);
  }
  for (const key of ["name", "laboratory", "productId", "type", "grainCategory", "use", "unit"]) {
    if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string")
      limitations.push(`invalid_field:${key}`);
  }
  if (role === "hops" && stage === "unknown") limitations.push("unknown_hop_stage");
  if (stage === "dry_hop" && format !== "brewfather-api-v2" && !/^(days?|d)$/i.test(timeUnit ?? ""))
    limitations.push("dry_hop_time_semantics_unresolved");
  if (amount !== null && unit && units[unit.toLowerCase()] === undefined)
    limitations.push("nonmass_amount");
  const aroma: Record<string, number> = {};
  for (const key of [
    "floral",
    "grassy",
    "herbal",
    "earthy",
    "woody",
    "onion",
    "citrus",
    "fruity",
  ]) {
    const value = object(row.aroma)[key];
    const n = number(value, 0, 100);
    if (n !== null) aroma[key] = n;
    else if (value !== undefined && value !== null) limitations.push(`invalid_aroma:${key}`);
  }
  if (Object.keys(aroma).length > 0 && Object.values(aroma).every((v) => v === 0))
    limitations.push("all_zero_aroma_meaning_unverified");
  return {
    sourcePath: `recipe.${role}[${index}]`,
    name: text(row.name),
    supplier: text(row.supplier, 120),
    laboratory: text(row.laboratory, 120),
    productId: text(row.productId, 80),
    type: text(row.type, 80),
    grainCategory: text(row.grainCategory, 80),
    use,
    usage: text(row.usage, 80),
    form: text(row.form, 80) ?? (role === "hops" ? text(row.type, 80) : null),
    amount,
    unit,
    grams:
      amount !== null && unit && units[unit.toLowerCase()] !== undefined
        ? amount * units[unit.toLowerCase()]!
        : null,
    percentage: number(row.percentage ?? row.percent, 0, 100),
    color: number(row.color, 0, 1000),
    lovibond: number(row.lovibond, 0, 1000),
    alpha: number(row.alpha, 0, 100),
    day: number(row.day),
    time,
    timeUnit,
    stage,
    boilMinutes:
      stage === "boil" && (!timeUnit || /^(min|minutes?)$/i.test(timeUnit)) ? time : null,
    contactDays:
      stage === "dry_hop" && (/^(days?|d)$/i.test(timeUnit ?? "") || format === "brewfather-api-v2")
        ? time
        : null,
    additionDay: null,
    temperatureC: number(row.temp ?? row.temperature, -100, 200),
    aroma: Object.keys(aroma).length ? aroma : null,
    totalOil: number(row.oil, 0, 100),
    limitations,
  };
}
export function normalizeBrewfatherBrewingInputs(
  recipe: unknown,
  batch?: unknown,
  options: { readonly format?: BrewingInputFormat } = {},
): BrewingInputs {
  const r = object(recipe),
    b = object(batch),
    format = options.format ?? "brewfather-api-v2",
    diagnostics: string[] = [];
  const choose = (
    unit: BrewingScalar["unit"],
    min: number,
    max: number,
    candidates: readonly (readonly [unknown, string, BrewingProvenance])[],
  ): BrewingScalar => {
    for (const [raw, path, provenance] of candidates) {
      if (raw === undefined || raw === null) continue;
      const value = number(raw, min, max);
      if (value !== null)
        return {
          value,
          unit,
          sourcePath: path,
          provenance,
          limitations:
            provenance === "batch_calculated"
              ? ["provider_calculated_not_independent_measurement"]
              : [],
        };
      diagnostics.push(`invalid_candidate:${path}`);
    }
    return { value: null, unit, sourcePath: null, provenance: "unavailable", limitations: [] };
  };
  const scalar = (
    key: string,
    unit: BrewingScalar["unit"],
    min: number,
    max: number,
    reported?: string,
    estimated?: string,
  ): BrewingScalar =>
    choose(unit, min, max, [
      ...(reported
        ? [
            [
              b[reported],
              `batch.${reported}`,
              reported === "measuredAbv" ? "batch_calculated" : "batch_reported",
            ] as const,
          ]
        : []),
      ...(estimated ? [[b[estimated], `batch.${estimated}`, "batch_estimate"] as const] : []),
      [r[key], `recipe.${key}`, "recipe_target"],
      ...(key === "fg" ? [[r.fgEstimated, "recipe.fgEstimated", "recipe_target"] as const] : []),
    ]);
  const equipment = object(r.equipment);
  const scalars: Record<BrewingScalarKey, BrewingScalar> = {
    og: scalar("og", "sg", 0.5, 2, "measuredOg", "estimatedOg"),
    fg: scalar("fg", "sg", 0.5, 2, "measuredFg", "estimatedFg"),
    abv: scalar("abv", "percent", 0, 100, "measuredAbv", "estimatedAbv"),
    ibu: scalar("ibu", "ibu", 0, 2000, undefined, "estimatedIbu"),
    color: scalar("color", "srm", 0, 1000, undefined, "estimatedColor"),
    volume: choose("l", Number.MIN_VALUE, 100000, [
      [b.measuredBatchSize, "batch.measuredBatchSize", "batch_reported"],
      [equipment.fermenterVolume, "recipe.equipment.fermenterVolume", "recipe_target"],
      [
        equipment.efficiencyType === "Kettle" ? undefined : r.batchSize,
        "recipe.batchSize",
        "recipe_target",
      ],
    ]),
    carbonation: scalar("carbonation", "vol_co2", 0, 10),
    reportedAttenuation: choose("percent", 0, 200, [
      [b.measuredAttenuation, "batch.measuredAttenuation", "batch_calculated"],
    ]),
    recipeAttenuation: choose("percent", 0, 200, [
      [
        format === "brewfather-export-v3" && number(r.attenuation, 0, 2) !== null
          ? Number(r.attenuation) * 100
          : format === "brewfather-api-v2" && number(r.attenuation, 2, 200) !== null
            ? r.attenuation
            : undefined,
        "recipe.attenuation",
        "recipe_target",
      ],
    ]),
    apparentAttenuation: choose("percent", -200, 200, []),
  };
  if (scalars.og.value !== null && scalars.og.value > 1 && scalars.fg.value !== null) {
    scalars.apparentAttenuation = {
      value: (100 * (scalars.og.value - scalars.fg.value)) / (scalars.og.value - 1),
      unit: "percent",
      sourcePath: "derived.og_fg",
      provenance: "batch_calculated",
      limitations: ["simple_apparent_attenuation"],
    };
  }
  if (
    r.attenuation !== undefined &&
    format !== "brewfather-export-v3" &&
    scalars.recipeAttenuation.value === null
  )
    diagnostics.push("recipe_attenuation_representation_ambiguous");
  const ingredients = {} as Record<BrewingIngredientRole, BrewingInputs["ingredients"]["hops"]>;
  for (const role of ["fermentables", "hops", "yeasts", "miscs"] as const) {
    const raw = r[role];
    const present = Array.isArray(raw);
    const rows = present ? raw : [];
    const items: BrewingIngredient[] = [];
    let rejectedCount = 0;
    rows.slice(0, 100).forEach((v, index) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        rejectedCount++;
        return;
      }
      const row = ingredient(object(v), role, index, format);
      if (object(v).amount !== null && object(v).amount !== undefined && row.amount === null) {
        rejectedCount++;
        return;
      }
      items.push(row);
    });
    ingredients[role] = {
      present,
      originalCount: rows.length,
      acceptedCount: items.length,
      rejectedCount,
      truncated: rows.length > 100,
      complete:
        present &&
        rows.length <= 100 &&
        rejectedCount === 0 &&
        !items.some((item) =>
          item.limitations.some((reason) => reason.startsWith("invalid_field:")),
        ),
      items,
    };
  }
  const steps = (value: unknown, defaultUnit: string): readonly BrewingStep[] =>
    Array.isArray(value)
      ? value.slice(0, 50).map((v) => {
          const x = object(v);
          return {
            name: text(x.name, 120),
            type: text(x.type, 64),
            temperatureC: number(x.stepTemp ?? x.temp, -100, 200),
            time: number(x.stepTime ?? x.time),
            timeUnit: text(x.timeUnit, 32) ?? defaultUnit,
          };
        })
      : [];
  const water = object(r.water),
    source = object(water.source),
    treated = object(water.total),
    style = object(r.style),
    treatedIons: Record<string, number> = {};
  for (const key of ["calcium", "magnesium", "sodium", "chloride", "sulfate", "bicarbonate"]) {
    const n = number(treated[key], 0, 10000);
    if (n !== null) treatedIons[key] = n;
  }
  const process = extractProcessFacts(b);
  const rawType = text(r.type, 64);
  const beverageType = ["all grain", "extract", "partial mash", "beer"].includes(
    rawType?.toLowerCase() ?? "",
  )
    ? "beer"
    : (rawType?.toLowerCase() ?? "beer");
  return {
    schemaVersion: 2,
    format,
    beverageType,
    scalars,
    ingredients,
    processFacts: process.facts,
    processComplete: process.complete,
    mash: steps(object(r.mash).steps ?? r.steps, "min"),
    fermentation: steps(object(r.fermentation).steps, "day"),
    water: {
      sourcePh: number(source.ph, 0, 14),
      treatedPh: number(treated.ph, 0, 14),
      mashPh: number(water.mashPh, 0, 14),
      treatedIons,
    },
    style: {
      name: text(style.name ?? r.style, 120),
      id: text(style._id ?? style.id, 256),
      guide: text(style.guide, 80),
    },
    diagnostics,
  };
}
