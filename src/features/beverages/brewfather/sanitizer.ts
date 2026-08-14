import { createHash } from "node:crypto";
import { BEVERAGE_TYPES, type BeverageType } from "../types.ts";

export const BREWFATHER_BATCH_STATUSES = [
  "Planning",
  "Brewing",
  "Fermenting",
  "Conditioning",
  "Completed",
] as const;

export const STATUS_SET = new Set<string>(BREWFATHER_BATCH_STATUSES);

export interface SanitizedBatchSummary {
  readonly batchId: string;
  readonly batchName: string | null;
  readonly batchNumber: string | null;
  readonly status: string;
  readonly brewer: string | null;
  readonly recipeId: string | null;
  readonly recipeName: string | null;
  readonly styleId: string | null;
  readonly style: string | null;
  readonly description: string | null;
  readonly brewDate: string | null;
  readonly estimatedOg: number | null;
  readonly estimatedFg: number | null;
  readonly measuredOg: number | null;
  readonly measuredFg: number | null;
  readonly estimatedAbv: number | null;
  readonly measuredAbv: number | null;
  readonly estimatedIbu: number | null;
  readonly estimatedSrm: number | null;
  readonly rawSummaryJson: string;
  readonly summaryFingerprint: string;
}

export interface SanitizedSourceProfile {
  readonly name: string;
  readonly beverageType: BeverageType;
  readonly style: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
  readonly displayColor: string | null;
  readonly description: string | null;
  readonly rawSourceJson: string;
  readonly sourceFingerprint: string;
}

export interface SanitizedRecipeSnapshot {
  readonly sourceRecipeId: string | null;
  readonly recipeJson: string;
  readonly recipeFingerprint: string;
}

function cleanText(value: unknown, maxLength: number, allowNumber: boolean = false): string | null {
  if (allowNumber && (typeof value === "number" || typeof value === "bigint")) {
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  })
    .join("")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function finiteNumber(
  value: unknown,
  min: number = -1_000_000,
  max: number = 1_000_000,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number.NaN;
  const str = typeof value === "string" ? value : "";
  const epoch = Number.isFinite(numeric)
    ? numeric < 10_000_000_000
      ? numeric * 1000
      : numeric
    : str
      ? Date.parse(str)
      : Number.NaN;
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function sanitizeBatchSummary(
  source: unknown,
  fallbackStatus?: string,
): SanitizedBatchSummary | null {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
  const s = source as Record<string, unknown>;
  const recipe = asObject(s.recipe);
  const style = asObject(recipe.style ?? s.style);

  const batchId = cleanText(s._id ?? s.id ?? s.batch_id, 256);
  const rawStatus = cleanText(s.status ?? fallbackStatus, 32);
  if (!batchId || !rawStatus) return null;

  const status = STATUS_SET.has(rawStatus) ? rawStatus : "Planning";

  const batchName = cleanText(s.name, 160);
  const batchNumber = cleanText(s.batchNo ?? s.batch_number, 64, true);
  const brewer = cleanText((s.brewer as Record<string, unknown>)?.name ?? s.brewer, 120);
  const recipeId = cleanText(recipe._id ?? recipe.id, 256);
  const recipeName = cleanText(recipe.name ?? s.name, 160);
  const styleId = cleanText(style._id ?? style.id, 256);
  const styleName = cleanText(style.name ?? recipe.style ?? s.style, 120);
  const description = cleanText(recipe.description ?? style.description, 2000);

  const brewDate = isoDate(s.brewDate ?? s.brew_date);
  const estimatedOg = finiteNumber(s.estimatedOg, 0.5, 2.0);
  const estimatedFg = finiteNumber(s.estimatedFg, 0.5, 2.0);
  const measuredOg = finiteNumber(s.measuredOg, 0.5, 2.0);
  const measuredFg = finiteNumber(s.measuredFg, 0.5, 2.0);
  const estimatedAbv = finiteNumber(s.estimatedAbv, 0, 100);
  const measuredAbv = finiteNumber(s.measuredAbv, 0, 100);
  const estimatedIbu = finiteNumber(s.estimatedIbu ?? recipe.ibu, 0, 2000);
  const estimatedSrm = finiteNumber(s.estimatedColor ?? recipe.color ?? recipe.srm, 0, 100);

  const summaryRecord = {
    batchId,
    batchName,
    batchNumber,
    status,
    brewer,
    recipeId,
    recipeName,
    styleId,
    style: styleName,
    description,
    brewDate,
    estimatedOg,
    estimatedFg,
    measuredOg,
    measuredFg,
    estimatedAbv,
    measuredAbv,
    estimatedIbu,
    estimatedSrm,
  };

  const rawSummaryJson = JSON.stringify(summaryRecord);
  const summaryFingerprint = sha256Hex(rawSummaryJson);

  return {
    ...summaryRecord,
    rawSummaryJson,
    summaryFingerprint,
  };
}

export function sanitizeBatchToSourceProfile(batchData: unknown): SanitizedSourceProfile | null {
  if (typeof batchData !== "object" || batchData === null || Array.isArray(batchData)) return null;
  const s = batchData as Record<string, unknown>;
  const recipe = asObject(s.recipe);
  const style = asObject(recipe.style ?? s.style);

  const name = cleanText(recipe.name ?? s.name, 160) ?? "Brewfather Batch";
  const styleName = cleanText(style.name ?? recipe.style ?? s.style, 120);
  const description = cleanText(recipe.description ?? style.description, 4000);

  // Preference for measured values over estimated values for actual presentation
  const abv = finiteNumber(s.measuredAbv ?? s.estimatedAbv ?? recipe.abv, 0, 100);
  const ibu = finiteNumber(s.estimatedIbu ?? recipe.ibu, 0, 2000);
  const og = finiteNumber(s.measuredOg ?? s.estimatedOg ?? recipe.og, 0.5, 2.0);
  const fg = finiteNumber(s.measuredFg ?? s.estimatedFg ?? recipe.fg, 0.5, 2.0);
  const srm = finiteNumber(s.estimatedColor ?? recipe.color ?? recipe.srm, 0, 100);

  // Determine beverage type from recipe type or style if possible
  const rawType = cleanText(recipe.type ?? s.type, 32)?.toLowerCase();
  let beverageType: BeverageType = "beer";
  if (rawType && BEVERAGE_TYPES.includes(rawType as BeverageType)) {
    beverageType = rawType as BeverageType;
  } else if (rawType === "cider") {
    beverageType = "cider";
  } else if (rawType === "mead") {
    beverageType = "mead";
  }

  const profileRecord = {
    name,
    beverageType,
    style: styleName,
    abv,
    ibu,
    og,
    fg,
    srm,
    displayColor: null,
    description,
  };

  const rawSourceJson = JSON.stringify(profileRecord);
  const sourceFingerprint = sha256Hex(rawSourceJson);

  return {
    ...profileRecord,
    rawSourceJson,
    sourceFingerprint,
  };
}

function sanitizeRecipeIngredients(recipe: Record<string, unknown>) {
  const sanitizeList = (list: unknown) => {
    if (!Array.isArray(list)) return [];
    return list
      .slice(0, 100)
      .map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
        const i = item as Record<string, unknown>;
        return {
          id: cleanText(i._id ?? i.id, 256),
          name: cleanText(i.name, 160),
          supplier: cleanText(i.supplier, 120),
          origin: cleanText(i.origin, 120),
          type: cleanText(i.type, 80),
          use: cleanText(i.use, 80),
          amount: finiteNumber(i.amount, 0, 1_000_000),
          unit: cleanText(i.unit, 32),
          percentage: finiteNumber(i.percentage ?? i.percent, 0, 100),
          alpha: finiteNumber(i.alpha, 0, 100),
          color: finiteNumber(i.color, 0, 1000),
          time: finiteNumber(i.time, 0, 1_000_000),
          temperatureC: finiteNumber(i.temp ?? i.temperature, -100, 200),
        };
      })
      .filter(Boolean);
  };

  return {
    fermentables: sanitizeList(recipe.fermentables),
    hops: sanitizeList(recipe.hops),
    miscs: sanitizeList(recipe.miscs),
    yeasts: sanitizeList(recipe.yeasts),
  };
}

function sanitizeRecipeSteps(recipe: Record<string, unknown>) {
  const mash = asObject(recipe.mash);
  const steps = Array.isArray(mash.steps)
    ? mash.steps
    : Array.isArray(recipe.steps)
      ? recipe.steps
      : [];
  return steps
    .slice(0, 50)
    .map((step) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) return null;
      const s = step as Record<string, unknown>;
      return {
        name: cleanText(s.name, 120),
        type: cleanText(s.type, 64),
        temperatureC: finiteNumber(s.stepTemp ?? s.temp ?? s.temperature, -50, 150),
        timeMinutes: finiteNumber(s.stepTime ?? s.time, 0, 100_000),
        rampMinutes: finiteNumber(s.rampTime, 0, 100_000),
      };
    })
    .filter(Boolean);
}

export function sanitizeRecipeSnapshot(recipeData: unknown): SanitizedRecipeSnapshot | null {
  if (typeof recipeData !== "object" || recipeData === null || Array.isArray(recipeData))
    return null;
  const r = recipeData as Record<string, unknown>;

  const sourceRecipeId = cleanText(r._id ?? r.id, 256);
  const name = cleanText(r.name, 160) ?? "Recipe";
  const style = asObject(r.style);
  const styleName = cleanText(style.name ?? r.style, 120);

  const sanitized = {
    name,
    style: styleName,
    type: cleanText(r.type, 64),
    author: cleanText(r.author, 120),
    description: cleanText(r.description, 4000),
    og: finiteNumber(r.og, 0.5, 2.0),
    fg: finiteNumber(r.fg, 0.5, 2.0),
    abv: finiteNumber(r.abv, 0, 100),
    ibu: finiteNumber(r.ibu, 0, 2000),
    color: finiteNumber(r.color, 0, 100),
    batchSize: finiteNumber(r.batchSize, 0, 100_000),
    boilTime: finiteNumber(r.boilTime, 0, 1000),
    ingredients: sanitizeRecipeIngredients(r),
    steps: sanitizeRecipeSteps(r),
  };

  const recipeJson = JSON.stringify(sanitized);
  const recipeFingerprint = sha256Hex(recipeJson);

  return {
    sourceRecipeId,
    recipeJson,
    recipeFingerprint,
  };
}
