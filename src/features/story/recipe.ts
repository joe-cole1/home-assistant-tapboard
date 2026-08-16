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
  return projectArrays(
    "custom",
    ingredientsFromCustom(recipe),
    stepsFromCustom(recipe),
    notesFrom(recipe),
    safeProvenance,
  );
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
  if (Array.isArray(parsed)) return projectArrays("source", parsed, [], null, safeProvenance);
  const source = record(parsed);
  if (source === null) return emptyProjection("source", "unavailable", safeProvenance);
  return projectArrays(
    "source",
    sourceIngredients(source),
    sourceSteps(source),
    notesFrom(source),
    safeProvenance,
  );
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
