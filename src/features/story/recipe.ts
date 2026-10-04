import { readBrewingInputs } from "../beverages/brewing-inputs.ts";
import type { BrewingInputs, BrewingIngredient, BrewingStep } from "../beverages/brewing-types.ts";
import type {
  PublicRecipeSheet,
  PublicRecipeSheetIngredient,
  PublicRecipeSheetStep,
} from "./types.ts";
import type {
  PublicRecipe,
  PublicRecipeIngredient,
  PublicRecipeProjection,
  PublicRecipeStep,
  RecipeProjectionKind,
  SafeRecipeProvenance,
} from "./types.ts";

const MAX_INGREDIENTS = 50;
const MAX_STEPS = 30;
export const MAX_SOURCE_JSON_BYTES = 256 * 1024;
const MAX_INGREDIENT_NAME = 120;
const MAX_INGREDIENT_TYPE = 40;
const MAX_INGREDIENT_UNIT = 24;
const MAX_INGREDIENT_NOTE = 500;
const MAX_STEP_TEXT = 500;
const MAX_STEP_NAME = 120;
const MAX_RECIPE_AMOUNT = 1_000_000_000;
const MAX_TEMPERATURE_C = 300;
const MAX_TIME_MINUTES = 1_000_000;
const MAX_NOTES = 500;

type AnyRecord = Record<string, unknown>;

function record(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : null;
}

function clipped(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, limit);
}

function safeAmount(value: unknown): number | null {
  const amount = finiteNumber(value);
  return amount !== null && amount >= 0 && amount <= MAX_RECIPE_AMOUNT ? amount : null;
}

function safeNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function safePercent(value: unknown): number | null {
  return safeNumber(value, 0, 100);
}

function safeIngredient(value: unknown): PublicRecipeIngredient | null {
  const item = record(value);
  if (item === null) return null;
  const name = clipped(item["name"] ?? item["ingredient"] ?? item["label"], MAX_INGREDIENT_NAME);
  if (name === null) return null;
  const type = clipped(item["type"] ?? item["category"] ?? item["kind"], MAX_INGREDIENT_TYPE);
  const unit = clipped(item["unit"] ?? item["units"] ?? item["amount_unit"], MAX_INGREDIENT_UNIT);
  const percent = safePercent(
    item["percent"] ?? item["percentage"] ?? item["percentOfGrainBill"] ?? item["amountPercent"],
  );
  return {
    name,
    type,
    amount: safeAmount(item["amount"] ?? item["quantity"] ?? item["weight"]),
    unit,
    percent,
    note: clipped(item["note"] ?? item["notes"], MAX_INGREDIENT_NOTE),
  };
}

function safeStep(value: unknown): PublicRecipeStep | null {
  if (typeof value === "string") {
    const text = clipped(value, MAX_STEP_TEXT);
    return text === null
      ? null
      : { text, name: null, temperatureC: null, timeMinutes: null, note: null };
  }
  const item = record(value);
  if (item === null) return null;
  const name = clipped(item["name"] ?? item["title"], MAX_STEP_NAME);
  const note = clipped(item["note"] ?? item["notes"], MAX_STEP_TEXT);
  const text = clipped(item["text"] ?? item["description"] ?? note ?? name, MAX_STEP_TEXT);
  return text === null
    ? null
    : {
        text,
        name,
        temperatureC: safeNumber(
          item["temperatureC"] ?? item["temperature_c"] ?? item["temperature"],
          -100,
          MAX_TEMPERATURE_C,
        ),
        timeMinutes: safeNumber(
          item["timeMinutes"] ??
            item["time_minutes"] ??
            item["durationMinutes"] ??
            item["duration"],
          0,
          MAX_TIME_MINUTES,
        ),
        note,
      };
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function dedupArrays(values: readonly unknown[]): readonly unknown[][] {
  const result: unknown[][] = [];
  const seen = new Set<unknown[]>();
  for (const value of values) {
    if (!Array.isArray(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function provenance(value: unknown): SafeRecipeProvenance | null {
  const item = record(value);
  if (item === null) return null;
  const version = finiteNumber(item["version"]);
  return {
    label: clipped(item["label"], 120),
    state: clipped(item["state"], 40),
    version: version !== null && Number.isInteger(version) && version >= 0 ? version : null,
    capturedAt: clipped(item["capturedAt"] ?? item["captured_at"], 64),
  };
}

function emptyProjection(
  kind: RecipeProjectionKind,
  status: "unavailable" | "partial",
  source: unknown,
): PublicRecipeProjection {
  return {
    kind,
    status,
    ingredients: [],
    steps: [],
    notes: null,
    provenance: provenance(source),
  };
}

function ingredientsFromCustom(recipe: AnyRecord): readonly unknown[] {
  return array(recipe["ingredients"]);
}

function stepsFromCustom(recipe: AnyRecord): readonly unknown[] {
  return array(recipe["steps"]);
}

function notesFrom(value: AnyRecord): string | null {
  return clipped(value["notes"] ?? value["note"], MAX_NOTES);
}

function projectArrays(
  kind: RecipeProjectionKind,
  ingredientValues: readonly unknown[],
  stepValues: readonly unknown[],
  notes: string | null,
  sourceProvenance: unknown,
): PublicRecipeProjection {
  let ingredientLimit = false;
  let stepLimit = false;
  const ingredients: PublicRecipeIngredient[] = [];
  for (const value of ingredientValues.slice(0, MAX_INGREDIENTS)) {
    const projected = safeIngredient(value);
    if (projected !== null) ingredients.push(projected);
  }
  if (ingredientValues.length > MAX_INGREDIENTS) ingredientLimit = true;
  const steps: PublicRecipeStep[] = [];
  for (const value of stepValues.slice(0, MAX_STEPS)) {
    const projected = safeStep(value);
    if (projected !== null) steps.push(projected);
  }
  if (stepValues.length > MAX_STEPS) stepLimit = true;
  return {
    kind,
    status: ingredientLimit || stepLimit ? "partial" : "available",
    ingredients,
    steps,
    notes,
    provenance: provenance(sourceProvenance),
  };
}

/** Project a Custom recipe without exposing persistence identifiers. */
export function projectCustomRecipe(
  recipeValue: unknown,
  safeProvenance?: unknown,
): PublicRecipeProjection {
  const recipe = record(recipeValue);
  if (recipe === null) return emptyProjection("custom", "unavailable", safeProvenance);
  const projection = projectArrays(
    "custom",
    ingredientsFromCustom(recipe),
    stepsFromCustom(recipe),
    notesFrom(recipe),
    safeProvenance,
  );
  return { ...projection, sheet: simpleSheet(projection) };
}

function parsedSource(sourceJson: unknown): AnyRecord | readonly unknown[] | null {
  if (typeof sourceJson === "string") {
    if (Buffer.byteLength(sourceJson, "utf8") > MAX_SOURCE_JSON_BYTES) return null;
    try {
      const parsed: unknown = JSON.parse(sourceJson);
      return record(parsed) ?? (Array.isArray(parsed) ? parsed : null);
    } catch {
      return null;
    }
  }
  const object = record(sourceJson);
  if (object !== null) {
    const embedded = object["recipeJson"] ?? object["rawRecipeJson"] ?? object["sourceRecipeJson"];
    if (typeof embedded === "string" && embedded !== sourceJson) return parsedSource(embedded);
    return object;
  }
  return Array.isArray(sourceJson) ? sourceJson : null;
}

function sourceIngredients(source: AnyRecord): readonly unknown[] {
  const container = record(source["ingredients"]);
  const values: unknown[] = [];
  const arrays: unknown[] = [
    Array.isArray(source["ingredients"]) ? source["ingredients"] : null,
    source["fermentables"],
    source["malt"],
    source["malts"],
    source["hops"],
    source["miscs"],
    source["miscellaneous"],
    source["yeasts"],
    source["water"],
  ];
  if (container !== null) {
    // A frozen provider object commonly groups fermentables/hops/miscs. Keep
    // the provider's semantic group order while avoiding arbitrary fields.
    for (const key of [
      "fermentables",
      "malt",
      "malts",
      "hops",
      "miscs",
      "miscellaneous",
      "yeasts",
      "water",
    ]) {
      arrays.push(container[key]);
    }
  }
  const nestedRecipe = record(source["recipe"]);
  if (nestedRecipe !== null) {
    arrays.push(nestedRecipe["fermentables"], nestedRecipe["malt"], nestedRecipe["malts"]);
    arrays.push(nestedRecipe["hops"], nestedRecipe["miscs"], nestedRecipe["yeasts"]);
    const nestedIngredients = record(nestedRecipe["ingredients"]);
    if (nestedIngredients !== null) {
      for (const key of [
        "fermentables",
        "malt",
        "malts",
        "hops",
        "miscs",
        "miscellaneous",
        "yeasts",
        "water",
      ])
        arrays.push(nestedIngredients[key]);
    } else {
      arrays.push(nestedRecipe["ingredients"]);
    }
  }
  for (const valuesArray of dedupArrays(arrays)) values.push(...valuesArray);
  return values;
}

function sourceSteps(source: AnyRecord): readonly unknown[] {
  const values: unknown[] = [];
  const arrays: unknown[] = [
    source["steps"],
    source["mash"],
    source["mashSteps"],
    source["boilSteps"],
    source["fermentation"],
    source["fermentationSteps"],
    source["instructions"],
  ];
  const stepsObject = record(source["steps"]);
  if (stepsObject !== null) {
    for (const key of ["mash", "boil", "fermentation", "packaging"]) arrays.push(stepsObject[key]);
  }
  const nestedRecipe = record(source["recipe"]);
  if (nestedRecipe !== null) {
    arrays.push(
      nestedRecipe["steps"],
      nestedRecipe["mash"],
      nestedRecipe["boil"],
      nestedRecipe["fermentation"],
      nestedRecipe["instructions"],
    );
  }
  for (const valuesArray of dedupArrays(arrays)) values.push(...valuesArray);
  return values;
}

/**
 * Parse and project a frozen source recipe. Bad JSON and oversized payloads
 * become an unavailable projection instead of throwing or echoing raw data.
 */
export function projectSourceRecipe(
  sourceJson: unknown,
  safeProvenance?: unknown,
): PublicRecipeProjection {
  const parsed = parsedSource(sourceJson);
  if (parsed === null) return emptyProjection("source", "unavailable", safeProvenance);
  if (Array.isArray(parsed)) {
    const projection = projectArrays("source", parsed, [], null, safeProvenance);
    return { ...projection, sheet: simpleSheet(projection, false) };
  }
  const source = record(parsed);
  if (source === null) return emptyProjection("source", "unavailable", safeProvenance);
  const projection = projectArrays(
    "source",
    sourceIngredients(source),
    sourceSteps(source),
    notesFrom(source),
    safeProvenance,
  );
  const inputs = readBrewingInputs(source);
  const sheet = inputs === null ? simpleSheet(projection, false) : normalizedSheet(source, inputs);
  return {
    ...projection,
    sheet,
    status: sheetCountLimited(inputs) ? "partial" : projection.status,
  };
}

export function parseSourceRecipe(
  sourceJson: unknown,
  safeProvenance?: unknown,
): PublicRecipeProjection {
  return projectSourceRecipe(sourceJson, safeProvenance);
}

export const projectFrozenSourceRecipe = projectSourceRecipe;
export const toPublicSourceRecipe = projectSourceRecipe;
export const toPublicCustomRecipe = projectCustomRecipe;
export const sanitizeSourceRecipe = projectSourceRecipe;
export const sanitizeCustomRecipe = projectCustomRecipe;
export const projectFrozenRecipe = projectSourceRecipe;

/** Dispatch a bounded recipe DTO to the appropriate public projector. */
export function projectRecipe(input: unknown, safeProvenance?: unknown): PublicRecipeProjection {
  const value = record(input);
  if (value === null) return emptyProjection("custom", "unavailable", safeProvenance);
  const kind = value["kind"] === "source" || value["source"] !== undefined ? "source" : "custom";
  if (kind === "source")
    return projectSourceRecipe(
      value["sourceJson"] ?? value["recipeJson"] ?? value["source"],
      safeProvenance,
    );
  return projectCustomRecipe(value["recipe"] ?? value, safeProvenance);
}

export const MAX_PUBLIC_RECIPE_INGREDIENTS = MAX_INGREDIENTS;
export const MAX_PUBLIC_RECIPE_STEPS = MAX_STEPS;

export type {
  PublicRecipe,
  PublicRecipeIngredient,
  PublicRecipeProjection,
  PublicRecipeStep,
  SafeRecipeProvenance,
};

function blankSheet(): PublicRecipeSheet {
  return {
    summary: {
      method: null,
      batchSizeL: null,
      boilTimeMinutes: null,
      og: null,
      fg: null,
      abv: null,
      ibu: null,
      colorSrm: null,
      carbonationVolumes: null,
    },
    ingredients: { fermentables: [], hops: [], miscs: [], yeasts: [], other: [] },
    totals: { fermentablesGrams: null, hopsGrams: null },
    mash: [],
    fermentation: [],
    otherSteps: [],
    water: { mashPh: null, ions: [], sulfateChlorideRatio: null },
    measurements: { og: null, fg: null, fermenterVolumeL: null },
  };
}
function durationUnit(value: string | null): "min" | "day" | null {
  if (/^(min|minutes?)$/i.test(value ?? "")) return "min";
  if (/^(d|days?)$/i.test(value ?? "")) return "day";
  return null;
}
function explicitGrams(amount: number | null, unit: string | null): number | null {
  const factors: Record<string, number> = {
    kg: 1000,
    g: 1,
    mg: 0.001,
    lb: 453.59237,
    lbs: 453.59237,
    oz: 28.349523125,
  };
  const key = unit?.toLowerCase() ?? "";
  const factor = Object.hasOwn(factors, key) ? factors[key] : undefined;
  return amount !== null && factor !== undefined ? safeAmount(amount * factor) : null;
}
function simpleSheet(projection: PublicRecipeProjection, notes = true): PublicRecipeSheet {
  const sheet = blankSheet();
  const groups: Record<keyof PublicRecipeSheet["ingredients"], PublicRecipeSheetIngredient[]> = {
    fermentables: [],
    hops: [],
    miscs: [],
    yeasts: [],
    other: [],
  };
  for (const row of projection.ingredients) {
    const type = row.type?.toLowerCase();
    const role =
      type && /^(fermentables?|malts?|grains?)$/.test(type)
        ? "fermentables"
        : type && /^hops?$/.test(type)
          ? "hops"
          : type && /^yeasts?$/.test(type)
            ? "yeasts"
            : type && /^(miscs?|miscellaneous)$/.test(type)
              ? "miscs"
              : "other";
    groups[role].push({
      name: row.name,
      supplier: null,
      amount: row.amount,
      unit: row.unit,
      grams: explicitGrams(row.amount, row.unit),
      percent: row.percent,
      colorLovibond: null,
      alphaPercent: null,
      stage: null,
      time: null,
      timeUnit: null,
      temperatureC: null,
      note: notes ? row.note : null,
    });
  }
  return {
    ...sheet,
    ingredients: groups,
    otherSteps: projection.steps.map((row) => ({
      name: row.name ?? (notes ? row.text : "Recipe step"),
      temperatureC: row.temperatureC,
      time: row.timeMinutes,
      timeUnit: row.timeMinutes === null ? null : "min",
      note: notes ? row.note : null,
    })),
  };
}
function sheetCountLimited(inputs: BrewingInputs | null): boolean {
  return (
    inputs !== null &&
    ((["fermentables", "hops", "miscs", "yeasts"] as const).reduce(
      (n, role) => n + inputs.ingredients[role].items.length,
      0,
    ) > MAX_INGREDIENTS ||
      inputs.mash.length + inputs.fermentation.length > MAX_STEPS ||
      (["fermentables", "hops", "miscs", "yeasts"] as const).some((role) => {
        const c = inputs.ingredients[role];
        return c.truncated || c.rejectedCount > 0 || c.originalCount > c.items.length;
      }))
  );
}
function normalizedIngredient(row: BrewingIngredient, role: string): PublicRecipeSheetIngredient {
  const unit = durationUnit(row.timeUnit);
  const time =
    row.stage === "boil"
      ? row.boilMinutes
      : row.stage === "dry_hop"
        ? row.contactDays
        : unit === null
          ? null
          : row.time;
  return {
    name:
      clipped(row.name, MAX_INGREDIENT_NAME) ??
      {
        fermentables: "Unnamed fermentable",
        hops: "Unnamed hop",
        miscs: "Unnamed addition",
        yeasts: "Unnamed yeast",
      }[role] ??
      "Unnamed ingredient",
    supplier: clipped(row.supplier, 120),
    amount: safeAmount(row.amount),
    unit: clipped(row.unit, MAX_INGREDIENT_UNIT),
    grams: safeAmount(row.grams),
    percent: safePercent(row.percentage),
    colorLovibond: safeAmount(row.lovibond),
    alphaPercent: safePercent(row.alpha),
    stage: row.stage === "unknown" ? null : row.stage,
    time,
    timeUnit:
      time === null ? null : row.stage === "boil" ? "min" : row.stage === "dry_hop" ? "day" : unit,
    temperatureC: row.temperatureC,
    note: null,
  };
}
function normalizedStep(row: BrewingStep, fallback: string): PublicRecipeSheetStep {
  const unit = durationUnit(row.timeUnit);
  return {
    name: clipped(row.name, MAX_STEP_NAME) ?? fallback,
    temperatureC: row.temperatureC,
    time: unit === null ? null : row.time,
    timeUnit: row.time === null ? null : unit,
    note: null,
  };
}
function normalizedSheet(source: AnyRecord, inputs: BrewingInputs): PublicRecipeSheet {
  const sheet = blankSheet();
  const groups: Record<keyof PublicRecipeSheet["ingredients"], PublicRecipeSheetIngredient[]> = {
    fermentables: [],
    hops: [],
    miscs: [],
    yeasts: [],
    other: [],
  };
  let remaining = MAX_INGREDIENTS;
  for (const role of ["fermentables", "hops", "miscs", "yeasts"] as const) {
    groups[role] = inputs.ingredients[role].items
      .slice(0, remaining)
      .map((row) => normalizedIngredient(row, role));
    remaining -= groups[role].length;
  }
  const total = (role: "fermentables" | "hops"): number | null => {
    const c = inputs.ingredients[role];
    if (
      !c.present ||
      !c.complete ||
      c.truncated ||
      c.rejectedCount !== 0 ||
      c.originalCount !== c.items.length ||
      groups[role].length !== c.items.length ||
      groups[role].some((row) => row.grams === null)
    )
      return null;
    return groups[role].reduce((n, row) => n + row.grams!, 0);
  };
  const mash = inputs.mash.slice(0, MAX_STEPS).map((row) => normalizedStep(row, "Mash step"));
  const fermentation = inputs.fermentation
    .slice(0, MAX_STEPS - mash.length)
    .map((row) => normalizedStep(row, "Fermentation step"));
  const labels = {
    calcium: "Ca",
    magnesium: "Mg",
    sodium: "Na",
    chloride: "Cl",
    sulfate: "SO4",
    bicarbonate: "HCO3",
  } as const;
  const ions: PublicRecipeSheet["water"]["ions"][number][] = [];
  for (const [key, label] of Object.entries(labels)) {
    const value = inputs.water.treatedIons[key];
    if (value !== undefined) ions.push({ label, mgPerL: value });
  }
  const chloride = inputs.water.treatedIons.chloride,
    sulfate = inputs.water.treatedIons.sulfate;
  const measured = (key: "og" | "fg" | "volume") =>
    inputs.scalars[key].provenance === "batch_reported"
      ? safeNumber(
          inputs.scalars[key].value,
          key === "volume" ? Number.MIN_VALUE : 0.5,
          key === "volume" ? 100000 : 2,
        )
      : null;
  const ratio =
    chloride !== undefined && chloride > 0 && sulfate !== undefined ? sulfate / chloride : null;
  const rawMethod = clipped(source.type, 64);
  const method = [
    "all grain",
    "extract",
    "partial mash",
    "beer",
    "cider",
    "mead",
    "wine",
    "kombucha",
    "other",
  ].includes(rawMethod?.toLowerCase() ?? "")
    ? rawMethod
    : null;
  return {
    ...sheet,
    summary: {
      method,
      batchSizeL: safeNumber(source.batchSize, 0, 100000),
      boilTimeMinutes: safeNumber(source.boilTime, 0, MAX_TIME_MINUTES),
      og: safeNumber(source.og, 0.5, 2),
      fg: safeNumber(source.fg, 0.5, 2),
      abv: safePercent(source.abv),
      ibu: safeNumber(source.ibu, 0, 2000),
      colorSrm: safeNumber(source.color, 0, 1000),
      carbonationVolumes:
        inputs.scalars.carbonation.provenance === "recipe_target"
          ? safeNumber(inputs.scalars.carbonation.value, 0, 10)
          : null,
    },
    ingredients: groups,
    totals: { fermentablesGrams: total("fermentables"), hopsGrams: total("hops") },
    mash,
    fermentation,
    water: {
      mashPh: inputs.water.mashPh,
      ions,
      sulfateChlorideRatio: ratio !== null && Number.isFinite(ratio) ? ratio : null,
    },
    measurements: { og: measured("og"), fg: measured("fg"), fermenterVolumeL: measured("volume") },
  };
}
