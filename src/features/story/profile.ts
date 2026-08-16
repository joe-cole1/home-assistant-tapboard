import {
  SENSORY_AXES,
  type SensoryAxis,
  type SensoryAxisResult,
  type SensoryConfidence,
  type SensoryPredictionMap,
  type SensoryProfile,
  type SensoryProfileInput,
  type SensorySource,
} from "./types.ts";

type AnyRecord = Record<string, unknown>;
type Curve = readonly (readonly [number, number])[];

const SCALE_MIN = 0;
const SCALE_MAX = 5;

const BITTERNESS_IBU_CURVE: Curve = [
  [0, 0],
  [10, 0.5],
  [20, 1],
  [35, 2],
  [50, 3],
  [70, 4],
  [100, 5],
];
const BITTERNESS_BU_GU_CURVE: Curve = [
  [0, -1],
  [0.3, -0.75],
  [0.5, 0],
  [0.8, 0.5],
  [1, 0.75],
];
const BITTERNESS_FG_MASK_CURVE: Curve = [
  [1.008, 0],
  [1.014, 0.15],
  [1.02, 0.35],
  [1.03, 0.75],
  [1.04, 1],
];
const SWEETNESS_FG_CURVE: Curve = [
  [1, 0],
  [1.004, 0.5],
  [1.008, 1],
  [1.012, 2],
  [1.018, 3],
  [1.026, 4],
  [1.036, 5],
];
const ATTENUATION_CURVE: Curve = [
  [50, 5],
  [60, 4],
  [70, 3],
  [78, 2],
  [85, 1],
  [92, 0],
];
const SWEETNESS_LACTOSE_CURVE: Curve = [
  [0, 0],
  [5, 0.25],
  [10, 0.5],
  [20, 1],
  [40, 1.5],
];
const BODY_FG_CURVE: Curve = [
  [1, 0],
  [1.006, 0.75],
  [1.01, 1.5],
  [1.014, 2.25],
  [1.02, 3.25],
  [1.028, 4.25],
  [1.04, 5],
];
const BODY_ATTENUATION_CURVE: Curve = [
  [50, 5],
  [60, 4],
  [70, 2.5],
  [78, 1.5],
  [85, 0.75],
  [92, 0],
];
const ADJUNCT_PERCENT_CURVE: Curve = [
  [0, 0],
  [5, 0.4],
  [15, 1],
  [30, 1.75],
  [50, 2.5],
];
const ROAST_PERCENT_CURVE: Curve = [
  [0, 0],
  [0.5, 0.5],
  [2, 1.5],
  [5, 3],
  [10, 4.25],
  [15, 5],
];
const ROAST_SRM_CURVE: Curve = [
  [25, 0],
  [30, 0.5],
  [40, 1],
  [50, 1.5],
];
const TARTNESS_PH_CURVE: Curve = [
  [3.2, 5],
  [3.4, 4],
  [3.6, 3],
  [3.8, 2],
  [4, 1],
  [4.2, 0],
];

/** Piecewise-linear interpolation with endpoint clamping. */
export function interpolateCurve(value: number, curve: Curve): number | null {
  if (!Number.isFinite(value) || curve.length === 0) return null;
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (first === undefined || last === undefined) return null;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let index = 1; index < curve.length; index++) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (previous === undefined || current === undefined) continue;
    if (value <= current[0]) {
      const span = current[0] - previous[0];
      if (span <= 0) return current[1];
      const fraction = (value - previous[0]) / span;
      return previous[1] + fraction * (current[1] - previous[1]);
    }
  }
  return last[1];
}

function record(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function validScale(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= SCALE_MIN && number <= SCALE_MAX ? number : null;
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));
}

function publicScale(value: number): number {
  return Math.round(clampScale(value) * 100) / 100;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function rootRecord(input: unknown): AnyRecord {
  return record(input) ?? {};
}

function nestedRecords(root: AnyRecord): readonly AnyRecord[] {
  const values: AnyRecord[] = [root];
  for (const key of ["recipe", "recipeData", "sourceRecipe", "data"]) {
    const nested = record(root[key]);
    if (nested !== null) values.push(nested);
  }
  return values;
}

function firstValue(root: AnyRecord, keys: readonly string[]): unknown {
  for (const source of nestedRecords(root)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined)
        return source[key];
    }
  }
  return undefined;
}

function firstNumber(root: AnyRecord, keys: readonly string[]): number | null {
  return finiteNumber(firstValue(root, keys));
}

function mapValue(map: unknown, axis: SensoryAxis): { found: boolean; value: unknown } {
  const object = record(map);
  if (object === null || !Object.prototype.hasOwnProperty.call(object, axis))
    return { found: false, value: undefined };
  return { found: true, value: object[axis] };
}

function manualValue(
  root: AnyRecord,
  axis: SensoryAxis,
):
  | { readonly present: false }
  | { readonly present: true; readonly invalid: boolean; readonly value: number | null } {
  for (const key of ["manual", "manualOverrides", "sensoryOverrides", "overrides"]) {
    const found = mapValue(root[key], axis);
    if (!found.found || found.value === null || found.value === undefined) continue;
    // A persisted manual number is deliberately stricter than provider text.
    if (typeof found.value !== "number" || !Number.isFinite(found.value))
      return { present: true, invalid: true, value: null };
    if (found.value < SCALE_MIN || found.value > SCALE_MAX)
      return { present: true, invalid: true, value: null };
    return { present: true, invalid: false, value: found.value };
  }
  return { present: false };
}

function predictionValue(
  root: AnyRecord,
  axis: SensoryAxis,
): { readonly present: false } | { readonly present: true; readonly value: number | null } {
  const containers: unknown[] = [root["recipePrediction"], root["predictions"]];
  for (const nested of nestedRecords(root)) {
    containers.push(nested["recipePrediction"], nested["predictions"], nested["prediction"]);
  }
  for (const container of containers) {
    const found = mapValue(container, axis);
    if (!found.found || found.value === null || found.value === undefined) continue;
    const value = validScale(found.value);
    return { present: true, value };
  }
  return { present: false };
}

function attenuationFor(root: AnyRecord): number | null {
  const supplied = firstNumber(root, [
    "measuredAttenuation",
    "actualAttenuation",
    "targetAttenuation",
    "estimatedAttenuation",
    "attenuation",
    "attenuationPercent",
    "attenuation_pct",
    "apparentAttenuation",
  ]);
  if (supplied !== null && supplied >= 0 && supplied <= 100) return supplied;
  const og = firstNumber(root, ["og", "originalGravity", "original_gravity"]);
  const fg = firstNumber(root, ["fg", "finalGravity", "final_gravity"]);
  if (og === null || fg === null || og <= 1) return null;
  const derived = ((og - fg) / (og - 1)) * 100;
  return Number.isFinite(derived) && derived >= 0 && derived <= 100 ? derived : null;
}

/** Derive attenuation from OG and FG when a recipe did not supply it. */
export function deriveAttenuation(ogOrInput: unknown, finalGravity?: unknown): number | null {
  if (finalGravity !== undefined) {
    const og = finiteNumber(ogOrInput);
    const fg = finiteNumber(finalGravity);
    if (og === null || fg === null || og <= 1) return null;
    const value = ((og - fg) / (og - 1)) * 100;
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }
  return attenuationFor(rootRecord(ogOrInput));
}

function ibuFor(root: AnyRecord): number | null {
  const value = firstNumber(root, [
    "measuredIbu",
    "actualIbu",
    "targetIbu",
    "estimatedIbu",
    "ibu",
    "ibus",
    "estimated_ibu",
  ]);
  return value !== null && value >= 0 ? value : null;
}

function ogFor(root: AnyRecord): number | null {
  const value = firstNumber(root, [
    "measuredOg",
    "actualOg",
    "targetOg",
    "estimatedOg",
    "og",
    "originalGravity",
    "original_gravity",
  ]);
  return value !== null && value > 0 ? value : null;
}

function fgFor(root: AnyRecord): number | null {
  const value = firstNumber(root, [
    "measuredFg",
    "actualFg",
    "targetFg",
    "estimatedFg",
    "fg",
    "finalGravity",
    "final_gravity",
  ]);
  return value !== null && value > 0 ? value : null;
}

function abvFor(root: AnyRecord): number | null {
  const value = firstNumber(root, [
    "measuredAbv",
    "actualAbv",
    "targetAbv",
    "estimatedAbv",
    "abv",
    "alcoholByVolume",
    "alcohol_by_volume",
  ]);
  return value !== null && value >= 0 ? value : null;
}

function attenuationComponent(root: AnyRecord, curve: Curve): number | null {
  const attenuation = attenuationFor(root);
  return attenuation === null ? null : interpolateCurve(attenuation, curve);
}

/** Predict bitterness from recipe metadata on the public 0..5 scale. */
export function predictBitterness(input: unknown): number | null {
  const root = rootRecord(input);
  const ibu = ibuFor(root);
  if (ibu === null) return null;
  const base = interpolateCurve(ibu, BITTERNESS_IBU_CURVE);
  if (base === null) return null;
  let result = base;
  const og = ogFor(root);
  if (og !== null && og > 1) {
    const ratio = ibu / ((og - 1) * 1_000);
    const adjustment = interpolateCurve(ratio, BITTERNESS_BU_GU_CURVE);
    if (adjustment !== null) result += adjustment;
  }
  const fg = fgFor(root);
  if (fg !== null) {
    const mask = interpolateCurve(fg, BITTERNESS_FG_MASK_CURVE);
    if (mask !== null) result -= mask;
  }
  return publicScale(result);
}

function lactoseGPerL(root: AnyRecord): number | null {
  const direct = firstNumber(root, [
    "lactoseGPerL",
    "lactose_g_per_l",
    "lactosePerLiter",
    "lactose",
  ]);
  if (direct !== null && direct >= 0) return direct;
  const volume = firstNumber(root, ["batchVolumeL", "batchVolumeLiters", "batch_volume_l"]);
  if (volume === null || volume <= 0) return null;
  const ingredients = ingredientRows(root, ["fermentables", "miscs"]);
  const grams = ingredients.reduce((sum, item) => {
    if (!/\blactose\b/i.test(item.name)) return sum;
    return sum + (item.grams ?? 0);
  }, 0);
  return grams > 0 ? grams / volume : null;
}

/** Predict sweetness from final gravity, attenuation, lactose, and IBU. */
export function predictSweetness(input: unknown): number | null {
  const root = rootRecord(input);
  const fg = fgFor(root);
  const fgPart = fg === null ? null : interpolateCurve(fg, SWEETNESS_FG_CURVE);
  const attenuationPart = attenuationComponent(root, ATTENUATION_CURVE);
  const base =
    fgPart === null
      ? attenuationPart
      : attenuationPart === null
        ? fgPart
        : fgPart * 0.65 + attenuationPart * 0.35;
  const lactoseRate = lactoseGPerL(root);
  const lactose =
    lactoseRate === null ? null : interpolateCurve(lactoseRate, SWEETNESS_LACTOSE_CURVE);
  const ibu = ibuFor(root);
  const ibuBase = ibu === null ? 0 : (interpolateCurve(ibu, BITTERNESS_IBU_CURVE) ?? 0);
  if (base === null && lactose === null) return null;
  return publicScale((base ?? 0) + (lactose ?? 0) - 0.15 * ibuBase);
}

interface IngredientRow {
  readonly name: string;
  readonly type: string | null;
  readonly role: IngredientRole;
  readonly suppliedPercent: number | null;
  readonly grams: number | null;
}

type IngredientRole = "fermentables" | "miscs" | "hops" | "yeasts";

function unitGrams(amount: number, unit: unknown): number | null {
  const normalized = typeof unit === "string" ? unit.trim().toLowerCase() : "kg";
  if (normalized === "mg") return amount / 1_000;
  if (normalized === "g" || normalized === "gram" || normalized === "grams") return amount;
  if (normalized === "kg" || normalized === "kilogram" || normalized === "kilograms")
    return amount * 1_000;
  return null;
}

function ingredientRole(value: AnyRecord): IngredientRole {
  const phrase =
    `${text(value["name"] ?? value["ingredient"] ?? value["label"]) ?? ""} ${text(value["type"] ?? value["category"] ?? value["kind"] ?? value["use"]) ?? ""}`.toLowerCase();
  if (/yeast|lactobacillus|pediococcus|philly\s*sour|lachancea|brett/.test(phrase)) return "yeasts";
  if (/hop\b|hops\b/.test(phrase)) return "hops";
  if (/lactose|milk\s+sugar|fruit|acid|spice|salt|misc/.test(phrase)) return "miscs";
  return "fermentables";
}

function sourceArrays(root: AnyRecord): readonly {
  readonly role: IngredientRole;
  readonly values: readonly unknown[];
  readonly inferRole: boolean;
}[] {
  const arrays: {
    readonly role: IngredientRole;
    readonly values: readonly unknown[];
    readonly inferRole: boolean;
  }[] = [];
  const seen = new Set<unknown[]>();
  const add = (value: unknown, role: IngredientRole, inferRole = false): void => {
    if (!Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    arrays.push({ role, values: value, inferRole });
  };
  for (const source of nestedRecords(root)) {
    const grouped = record(source["ingredients"]);
    if (grouped !== null) {
      for (const key of ["fermentables", "malt", "malts"]) add(grouped[key], "fermentables");
      for (const key of ["miscs", "miscellaneous"]) add(grouped[key], "miscs");
      add(grouped["hops"], "hops");
      add(grouped["yeasts"], "yeasts");
    } else if (Array.isArray(source["ingredients"])) {
      add(source["ingredients"], "fermentables", true);
    }
    add(source["grist"], "fermentables");
    for (const key of ["fermentables", "malt", "malts"]) add(source[key], "fermentables");
    for (const key of ["miscs", "miscellaneous"]) add(source[key], "miscs");
    add(source["hops"], "hops");
    add(source["yeasts"], "yeasts");
  }
  return arrays;
}

function ingredientRows(
  root: AnyRecord,
  roles: readonly IngredientRole[] = ["fermentables", "miscs", "hops", "yeasts"],
): readonly IngredientRow[] {
  const allowed = new Set(roles);
  const rows: IngredientRow[] = [];
  for (const collection of sourceArrays(root)) {
    for (const value of collection.values) {
      const item = record(value);
      if (item === null) continue;
      const role = collection.inferRole ? ingredientRole(item) : collection.role;
      if (!allowed.has(role)) continue;
      const name = text(item["name"] ?? item["ingredient"] ?? item["label"]);
      if (name === null) continue;
      const type = text(item["type"] ?? item["category"] ?? item["kind"]);
      const amount = finiteNumber(item["amount"] ?? item["quantity"] ?? item["weight"]);
      const unit = item["unit"] ?? item["units"] ?? item["amount_unit"];
      const grams = amount === null || amount < 0 ? null : unitGrams(amount, unit);
      const declaredPercent = finiteNumber(
        item["percent"] ??
          item["percentage"] ??
          item["percentOfGrainBill"] ??
          item["amountPercent"],
      );
      const suppliedPercent =
        declaredPercent ??
        (typeof unit === "string" && unit.trim() === "%" && amount !== null ? amount : null);
      rows.push({
        name,
        type,
        role,
        suppliedPercent: suppliedPercent !== null && suppliedPercent >= 0 ? suppliedPercent : null,
        grams,
      });
    }
  }
  if (rows.length === 0) return rows;
  const percentageRows = rows.filter((row) => row.suppliedPercent !== null);
  const suppliedTotal = percentageRows.reduce((sum, row) => sum + (row.suppliedPercent ?? 0), 0);
  if (percentageRows.length === rows.length && suppliedTotal >= 95 && suppliedTotal <= 105) {
    return rows.map((row) => ({
      ...row,
      suppliedPercent:
        row.suppliedPercent === null ? null : (row.suppliedPercent / suppliedTotal) * 100,
    }));
  }
  const massTotal = rows.reduce((sum, row) => sum + (row.grams ?? 0), 0);
  if (massTotal <= 0 || rows.some((row) => row.grams === null))
    return rows.map((row) => ({ ...row, suppliedPercent: null }));
  return rows.map((row) => ({
    ...row,
    suppliedPercent: row.grams === null ? null : (row.grams / massTotal) * 100,
  }));
}

function adjunctWeight(name: string): number | null {
  const normalized = name.toLowerCase();
  if (/\boats\b|oatmeal|flaked\s+oat/.test(normalized)) return 1;
  if (/flaked\s+wheat|wheat\s+flakes|\bchit\b/.test(normalized)) return 1;
  if (/\brye\b/.test(normalized)) return 0.8;
  if (/\bwheat\b/.test(normalized)) return 0.5;
  return null;
}

function adjunctUnionPercent(root: AnyRecord): number | null {
  const rows = ingredientRows(root, ["fermentables"]);
  let weightedPercent = 0;
  let found = false;
  for (const row of rows) {
    const weight = adjunctWeight(row.name);
    if (weight === null || row.suppliedPercent === null) continue;
    weightedPercent += row.suppliedPercent * weight;
    found = true;
  }
  return found ? weightedPercent : null;
}

function diminishingUnion(base: number, bonus: number): number {
  return 5 * (1 - (1 - base / 5) * (1 - bonus / 5));
}

/** Predict body, including a diminishing adjunct contribution. */
export function predictBody(input: unknown): number | null {
  const root = rootRecord(input);
  const fg = fgFor(root);
  const fgPart = fg === null ? null : interpolateCurve(fg, BODY_FG_CURVE);
  const attenuationPart = attenuationComponent(root, BODY_ATTENUATION_CURVE);
  const base =
    fgPart === null
      ? attenuationPart
      : attenuationPart === null
        ? fgPart
        : fgPart * 0.7 + attenuationPart * 0.3;
  if (base === null) return null;
  const adjunctPercent = adjunctUnionPercent(root);
  const adjunct =
    adjunctPercent === null ? 0 : (interpolateCurve(adjunctPercent, ADJUNCT_PERCENT_CURVE) ?? 0);
  return publicScale(diminishingUnion(base, adjunct));
}

function gristRoastWeight(name: string): number {
  const normalized = name.toLowerCase();
  if (/dehusked|debittered|carafa\s+special/.test(normalized)) return 0.25;
  if (/\bcarafa\b/.test(normalized)) return 0.6;
  if (/chocolate|roasted\s+wheat/.test(normalized)) return 0.8;
  if (/roast|black|patent/.test(normalized)) return 1;
  return 0;
}

/** Predict roast from grist composition, with a conservative SRM fallback. */
export function predictRoast(input: unknown): number | null {
  const root = rootRecord(input);
  const rows = ingredientRows(root, ["fermentables"]);
  const usable = rows.filter((row) => row.suppliedPercent !== null);
  if (usable.length > 0) {
    const weightedPercent = usable.reduce(
      (sum, row) => sum + (row.suppliedPercent ?? 0) * gristRoastWeight(row.name),
      0,
    );
    return publicScale(interpolateCurve(weightedPercent, ROAST_PERCENT_CURVE) ?? 0);
  }
  const srm = firstNumber(root, ["srm", "color", "estimatedSrm", "estimated_srm"]);
  if (srm === null || srm <= 25) return null;
  return publicScale(interpolateCurve(srm, ROAST_SRM_CURVE) ?? 1.5);
}

function finalPhFor(root: AnyRecord): number | null {
  const value = firstNumber(root, [
    "measuredPh",
    "measured_pH",
    "finalPh",
    "finalPH",
    "measuredFinalPh",
    "measured_final_ph",
    "ph",
    "pH",
  ]);
  return value !== null && value > 0 ? value : null;
}

function explicitSouring(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some((item) => explicitSouring(item));
  const item = record(value);
  if (item !== null)
    return ["name", "type", "method", "culture", "process"].some((key) =>
      explicitSouring(item[key]),
    );
  const phrase = text(value);
  if (phrase === null) return false;
  return /kettle\s*sour|sour(?:ed|ing)?|lactobac|\blacto\b|pediococcus|philly\s*sour|lachancea|sour\s+cultur|sour\s*mash|lactic\s+cultur/.test(
    phrase.toLowerCase(),
  );
}

function hasRecognizedSouring(root: AnyRecord): boolean {
  for (const source of nestedRecords(root)) {
    for (const key of [
      "souring",
      "soured",
      "sour",
      "kettleSour",
      "kettle_sour",
      "sourMash",
      "culture",
      "cultures",
      "acidification",
      "acidificationProcess",
    ]) {
      if (explicitSouring(source[key])) return true;
    }
  }
  return ingredientRows(root, ["fermentables", "miscs", "yeasts"]).some((item) =>
    /lactobacillus|pediococcus|philly\s*sour|lachancea|sour\s+cultur|kettle\s*sour/i.test(
      `${item.name} ${item.type ?? ""}`,
    ),
  );
}

/** Predict tartness only from measured final pH or explicit souring/culture evidence. */
export function predictTartness(input: unknown): number | null {
  const root = rootRecord(input);
  const ph = finalPhFor(root);
  if (ph !== null) return publicScale(interpolateCurve(ph, TARTNESS_PH_CURVE) ?? 0);
  return hasRecognizedSouring(root) ? 4 : null;
}

/** Predict alcohol intensity from ABV using the v1 clamp. */
export function predictAlcohol(input: unknown): number | null {
  const abv = abvFor(rootRecord(input));
  return abv === null ? null : publicScale((abv - 3) / 2);
}

export interface StyleBaselineRule {
  readonly name: string;
  readonly matches: RegExp;
  readonly values: Partial<Record<SensoryAxis, number>>;
}

/** Ordered and composable: the first matching rule providing an axis wins. */
export const STYLE_BASELINE_RULES: readonly StyleBaselineRule[] = [
  {
    name: "common sour family",
    matches: /sour|gose|berliner|lambic|gueuze|wild\s+ale|flemish/i,
    values: { body: 2, tartness: 5 },
  },
  {
    name: "hazy/ne ipa",
    matches: /new\s+england|hazy|ne\s*ipa|neipa/i,
    values: { bitterness: 2, body: 4 },
  },
  {
    name: "west coast/american ipa",
    matches: /\b(?:west\s+coast|american)\s+ipa\b/i,
    values: { bitterness: 4, body: 2.5 },
  },
  {
    name: "generic ipa",
    matches: /\bipa\b|india\s+pale/i,
    values: { bitterness: 3.5, body: 3 },
  },
  {
    name: "pastry stout",
    matches: /\bpastry\s+stout\b/i,
    values: { sweetness: 5, body: 5, roast: 3, alcohol: 4 },
  },
  {
    name: "imperial/double stout/porter",
    matches: /\b(?:imperial|double)\s+(?:stout|porter)\b/i,
    values: { bitterness: 3, body: 5, roast: 5, alcohol: 5 },
  },
  {
    name: "baltic porter",
    matches: /\bbaltic\s+porter\b/i,
    values: { sweetness: 3, body: 4, roast: 2.5, alcohol: 4 },
  },
  {
    name: "ordinary stout/porter/schwarz",
    matches: /\b(?:stout|porter|schwarz)\b/i,
    values: { bitterness: 2, body: 4, roast: 4 },
  },
  {
    name: "tripel",
    matches: /\btripel\b/i,
    values: { sweetness: 1.5, body: 2, alcohol: 4.5 },
  },
  {
    name: "strong ales",
    matches: /\b(?:barleywine|wee\s+heavy|strong\s+ale|quadrupel|quad)\b/i,
    values: { sweetness: 4, body: 4, alcohol: 5 },
  },
  {
    name: "doppelbock/strong lager",
    matches: /\b(?:doppelbock|strong lager)\b/i,
    values: { sweetness: 3, body: 4, alcohol: 4 },
  },
  {
    name: "brown/amber",
    matches: /\b(?:brown|amber)\b/i,
    values: { sweetness: 2, body: 3, roast: 1 },
  },
  {
    name: "vienna/marzen",
    matches: /\b(?:vienna|märzen|marzen|oktoberfest)\b/i,
    values: { sweetness: 2, body: 3 },
  },
  {
    name: "wheat",
    matches: /\b(?:wheat|hefe|wit)\b/i,
    values: { body: 3 },
  },
  {
    name: "saison",
    matches: /\b(?:saison|farmhouse)\b/i,
    values: { body: 1.5 },
  },
  {
    name: "pale/lager",
    matches: /\b(?:pale ale|blonde|kolsch|kölsch|lager|pils|helles)\b/i,
    values: { bitterness: 2, body: 2 },
  },
] as const;

function strengthAlcohol(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= SCALE_MIN && value <= SCALE_MAX ? value : null;
}

export function styleBaselineFor(
  styleValue: unknown,
  perceivedStrength?: unknown,
): Partial<Record<SensoryAxis, number>> {
  const styleObject = record(styleValue);
  const style = text(
    styleObject === null
      ? styleValue
      : firstValue(styleObject, ["style", "styleName", "beverageStyle"]),
  );
  if (style === null) return {};
  const baseline: Partial<Record<SensoryAxis, number>> = {};
  const normalized = style.toLowerCase();
  for (const rule of STYLE_BASELINE_RULES) {
    if (!rule.matches.test(normalized)) continue;
    for (const axis of SENSORY_AXES) {
      if (baseline[axis] === undefined && rule.values[axis] !== undefined)
        baseline[axis] = rule.values[axis];
    }
  }
  if (baseline.alcohol === undefined) {
    const suppliedStrength =
      perceivedStrength ??
      (styleObject === null
        ? undefined
        : firstValue(styleObject, ["perceived_strength", "perceivedStrength"]));
    const alcohol = strengthAlcohol(suppliedStrength);
    if (alcohol !== null) baseline.alcohol = alcohol;
  }
  return baseline;
}

function axisFormula(axis: SensoryAxis, root: AnyRecord): number | null {
  switch (axis) {
    case "bitterness":
      return predictBitterness(root);
    case "sweetness":
      return predictSweetness(root);
    case "body":
      return predictBody(root);
    case "roast":
      return predictRoast(root);
    case "tartness":
      return predictTartness(root);
    case "alcohol":
      return predictAlcohol(root);
  }
}

function axisResult(
  value: number | null,
  source: SensorySource,
  confidence: SensoryConfidence,
  evidence: string,
): SensoryAxisResult {
  return {
    value: value === null ? null : clampScale(value),
    source,
    confidence,
    evidence,
  };
}

/** Resolve all axes using manual -> recipe prediction -> composable style order. */
export function resolveSensoryProfile(
  input: SensoryProfileInput | null | undefined,
): SensoryProfile {
  const root = rootRecord(input);
  const style = firstValue(root, ["style", "beverageStyle", "styleName"]);
  const baseline = styleBaselineFor(
    style,
    firstValue(root, ["perceived_strength", "perceivedStrength"]),
  );
  const result = {} as Record<SensoryAxis, SensoryAxisResult>;
  for (const axis of SENSORY_AXES) {
    const manual = manualValue(root, axis);
    if (manual.present) {
      result[axis] = manual.invalid
        ? axisResult(null, "unavailable", null, "Invalid manual value")
        : axisResult(manual.value, "manual", "high", "Manual override");
      continue;
    }
    const prediction = predictionValue(root, axis);
    if (prediction.present && prediction.value !== null) {
      result[axis] = axisResult(prediction.value, "recipe_prediction", "high", "Recipe prediction");
      continue;
    }
    const formula = axisFormula(axis, root);
    if (formula !== null) {
      result[axis] = axisResult(formula, "recipe_prediction", "medium", "Recipe inputs");
      continue;
    }
    const styleValue = baseline[axis];
    if (styleValue !== undefined) {
      result[axis] = axisResult(styleValue, "style_baseline", "low", "Style baseline");
      continue;
    }
    result[axis] = axisResult(null, "unavailable", null, "No usable input");
  }
  return result;
}

export const calculateSensoryProfile = resolveSensoryProfile;
export const deriveSensoryProfile = resolveSensoryProfile;
export const predictSensoryProfile = resolveSensoryProfile;
export const computeSensoryProfile = resolveSensoryProfile;
export const resolveSensory = resolveSensoryProfile;
export const styleBaseline = styleBaselineFor;

export function resolveSensoryAxis(
  input: SensoryProfileInput | null | undefined,
  axis: SensoryAxis,
): SensoryAxisResult {
  return resolveSensoryProfile(input)[axis];
}

export const calculateBitterness = predictBitterness;
export const calculateSweetness = predictSweetness;
export const calculateBody = predictBody;
export const calculateRoast = predictRoast;
export const calculateTartness = predictTartness;
export const calculateAlcohol = predictAlcohol;

export type {
  SensoryAxis,
  SensoryAxisResult,
  SensoryConfidence,
  SensoryPredictionMap,
  SensoryProfile,
  SensoryProfileInput,
};
