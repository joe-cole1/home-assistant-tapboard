import { createHash } from "node:crypto";
import type { BrewingInputs, BrewingIngredientRole } from "../../beverages/brewing-types.ts";
import { BEVERAGE_SENSORY_AXES } from "../../beverages/types.ts";
import type {
  SensoryAxis,
  SensoryProfileInput,
  FlavorAxisResult,
  FlavorCalculation,
  FlavorDescriptor,
  SensoryAxisResult,
} from "../types.ts";
import { CATALOG_VERSION, lovibondOf } from "./catalog.ts";
import { CRYSTAL_CHARACTER, FAMILY_CHARACTER, HONEY_MALT_CHARACTER } from "./catalog-data.ts";
import type { FermentableFamily } from "./catalog-types.ts";
import { composition, resolveFeatures, ROLES, type ResolvedRow } from "./features.ts";
import { clamp, finite, defineCurve, interpolateCurve, stableSerialize } from "./math.ts";
const FIXED_CURVE_0 = defineCurve([
  [0, 0],
  [10, 0.8],
  [20, 1.6],
  [35, 2.5],
  [50, 3.4],
  [70, 4.2],
  [100, 5],
]);
const FIXED_CURVE_1 = defineCurve([
  [1.01, 0],
  [1.02, 0.25],
  [1.03, 0.5],
]);
const FIXED_CURVE_2 = defineCurve([
  [0, 0],
  [0.5, 0.4],
  [2, 1.3],
  [5, 2.8],
  [10, 4.2],
  [15, 5],
]);
const FIXED_CURVE_3 = defineCurve([
  [50, 5],
  [60, 4],
  [70, 3],
  [78, 2],
  [85, 1],
  [92, 0],
]);
const FIXED_CURVE_4 = defineCurve([
  [0.99, 0],
  [1, 0.1],
  [1.004, 0.4],
  [1.008, 0.8],
  [1.012, 1.4],
  [1.018, 2.4],
  [1.026, 3.6],
  [1.04, 5],
]);
const FIXED_CURVE_5 = defineCurve([
  [0, 0],
  [5, 0.2],
  [10, 0.4],
  [20, 0.8],
  [40, 1.5],
]);
const FIXED_CURVE_6 = defineCurve([
  [50, 5],
  [60, 4],
  [70, 2.5],
  [78, 1.5],
  [85, 0.75],
  [92, 0],
]);
const FIXED_CURVE_7 = defineCurve([
  [0.99, 0.3],
  [1, 0.5],
  [1.006, 0.9],
  [1.01, 1.4],
  [1.014, 2],
  [1.02, 2.9],
  [1.028, 3.8],
  [1.04, 5],
]);
const FIXED_CURVE_8 = defineCurve([
  [0, 0],
  [5, 0.15],
  [15, 0.4],
  [30, 0.75],
  [50, 1],
]);
export function sensoryBand(key: SensoryAxis, value: number | null, manual = false): string {
  if (value === null) return "Unknown";
  if (value === 0)
    return manual
      ? "Manual zero"
      : key === "sweetness"
        ? "Very dry expected finish"
        : "None expected";
  if (key === "body")
    return value < 1
      ? "Very light"
      : value < 2
        ? "Light"
        : value < 3
          ? "Medium"
          : value < 4
            ? "Full"
            : "Very full";
  if (key === "sweetness" && value < 1) return "Dry expected finish";
  return value < 1
    ? "Very low"
    : value < 2
      ? "Low"
      : value < 3
        ? "Moderate"
        : value < 4
          ? "High"
          : "Very high";
}

export const MODEL_VERSION = "recipe-flavor-2";
/** Shared saturating dose→intensity map on the 0–5 scale. */
function saturate(units: number): number {
  return -5 * Math.expm1(-units / 5);
}
// Descriptor salience heuristics: relative flavour strength per unit of grist.
const MALT_POTENCY: Readonly<Record<FermentableFamily, number>> = {
  pilsner: 0.55,
  pale: 0.65,
  wheat: 0.55,
  vienna: 1.4,
  munich: 1.8,
  biscuit: 3.5,
  aromatic: 3.5,
  crystal_light: 2.5,
  crystal_dark: 6.5,
  roasted: 15,
  chocolate: 13,
  dehusked_roast: 4.5,
  flaked: 0,
  rye: 1.2,
  carapils: 0,
  sugar: 0,
  lactose: 0,
  processing: 0,
  extract_pale: 0,
  extract_dark: 0,
};
const CRYSTAL_POTENCY = [2.5, 4.5, 6.5] as const;
const EXPRESSIVE_YEAST = new Set(["banana", "clove", "phenolic", "pepper", "spicy"]);
const NOTICEABLE_G_PER_L: Readonly<Record<string, number>> = {
  "botanical-cloves": 0.1,
  "botanical-allspice": 0.1,
  "botanical-cinnamon": 0.15,
  "botanical-ginger": 0.6,
  "botanical-coriander": 0.4,
  "botanical-orange-peel": 0.4,
  "botanical-paradise": 0.08,
  "botanical-chamomile": 0.4,
};
const POSITION_WEIGHTS = [1, 0.85, 0.7, 0.55] as const;
const SOURING_CULTURE = /lacto|brett|sour|philly|wild|pedio|lachancea|mixed|culture|roeselare/i;
const PROVIDER_AROMA = [
  "floral",
  "grassy",
  "herbal",
  "earthy",
  "woody",
  "onion",
  "citrus",
  "fruity",
];
const MALT = {
  pilsner: 1.6,
  pale: 1.8,
  wheat: 1.4,
  vienna: 2.8,
  munich: 3.6,
  biscuit: 4,
  aromatic: 4.4,
  crystal_light: 3.6,
  crystal_dark: 4,
  roasted: 1.8,
  chocolate: 1.8,
  dehusked_roast: 1.8,
  flaked: 0.7,
  rye: 1.4,
  carapils: 0.2,
  sugar: 0,
  lactose: 0,
  processing: 0,
  extract_pale: 0,
  extract_dark: 0,
} as const;
const BODY = { oats: 1, flaked_wheat: 1, chit: 1, rye: 0.8, wheat: 0.5, carapils: 0.4 } as const;
const ROAST = { black: 1, chocolate: 0.8, dehusked: 0.35, none: 0, unknown: 0 } as const;
export const STYLE_BASELINES: Readonly<Record<string, Partial<Record<SensoryAxis, number>>>> = {
  "west coast ipa": { bitterness: 4, body: 2.5 },
  "american ipa": { bitterness: 4, body: 2.5 },
  ipa: { bitterness: 3.5, body: 3 },
  "india pale ale": { bitterness: 3.5, body: 3 },
  "hazy ipa": { bitterness: 2, body: 4 },
  "new england ipa": { bitterness: 2, body: 4 },
  tripel: { sweetness: 1.5, body: 2, alcohol: 4.5 },
  "belgian tripel": { sweetness: 1.5, body: 2, alcohol: 4.5 },
  saison: { body: 1.5 },
  hefeweizen: { body: 3 },
  weissbier: { body: 3 },
  witbier: { body: 3 },
  "vienna lager": { sweetness: 2, body: 3 },
  märzen: { sweetness: 2, body: 3 },
  marzen: { sweetness: 2, body: 3 },
  "munich helles": { bitterness: 2, body: 2 },
  "american pale ale": { bitterness: 2, body: 2 },
  pilsner: { bitterness: 2, body: 2 },
  kölsch: { bitterness: 2, body: 2 },
  kolsch: { bitterness: 2, body: 2 },
  "baltic porter": { sweetness: 3, body: 4, roast: 2.5, alcohol: 4 },
  doppelbock: { sweetness: 3, body: 4, alcohol: 4 },
};
export function styleBaseline(style: unknown): Partial<Record<SensoryAxis, number>> {
  return typeof style === "string"
    ? (STYLE_BASELINES[style.normalize("NFC").trim().toLowerCase()] ?? {})
    : {};
}
function result(
  value: number | null,
  reasons: readonly string[],
  refs: readonly string[] = [],
  limitations: readonly string[] = [],
  limited = false,
): FlavorAxisResult {
  return {
    value: finite(value) ? clamp(value) : null,
    source: !finite(value) ? "unavailable" : "recipe_prediction",
    support: !finite(value) ? "unavailable" : limited ? "limited" : "supported",
    reasons,
    evidenceReferences: refs,
    limitations,
    modelVersion: MODEL_VERSION,
  };
}
function scalar(inputs: BrewingInputs, key: keyof BrewingInputs["scalars"]): number | null {
  const value = inputs.scalars[key].value;
  return finite(value) ? value : null;
}
function refs(rows: readonly ResolvedRow[]): string[] {
  return rows.map((row) => row.ingredient.sourcePath);
}
function predictions(
  inputs: BrewingInputs,
  features: ReturnType<typeof resolveFeatures>,
): Record<SensoryAxis, FlavorAxisResult> {
  const axes = Object.fromEntries(
    BEVERAGE_SENSORY_AXES.map((axis) => [axis, result(null, ["missing_relevant_inputs"])]),
  ) as Record<SensoryAxis, FlavorAxisResult>;
  if (inputs.beverageType.toLowerCase() !== "beer")
    return Object.fromEntries(
      BEVERAGE_SENSORY_AXES.map((axis) => [axis, result(null, ["non_beer_model_not_applicable"])]),
    ) as Record<SensoryAxis, FlavorAxisResult>;
  const fg = scalar(inputs, "fg"),
    og = scalar(inputs, "og"),
    ibu = scalar(inputs, "ibu"),
    abv = scalar(inputs, "abv"),
    volume = scalar(inputs, "volume");
  const validFg = fg !== null && fg >= 0.98 && fg <= 1.06 ? fg : null;
  const validOg = og !== null && og > 1 && og <= 1.2 ? og : null;
  const validAbv = abv !== null && abv >= 0 && abv <= 25 ? abv : null;
  const validIbu = ibu !== null && ibu >= 0 && ibu <= 200 ? ibu : null;
  const selected = (key: keyof BrewingInputs["scalars"]) =>
    inputs.scalars[key].sourcePath ? [inputs.scalars[key].sourcePath] : [];
  const limitations = (...keys: (keyof BrewingInputs["scalars"])[]) =>
    keys.flatMap((key) => [
      ...inputs.scalars[key].limitations,
      ...(inputs.scalars[key].provenance === "batch_estimate" ||
      inputs.scalars[key].provenance === "recipe_target"
        ? ["target_or_estimated_input"]
        : []),
    ]);
  const bitterBase = validIbu === null ? null : interpolateCurve(validIbu, FIXED_CURVE_0)!;
  if (bitterBase !== null)
    axes.bitterness = result(
      bitterBase - (validFg === null ? 0 : interpolateCurve(validFg, FIXED_CURVE_1)!),
      ["ibu_intensity_proxy"],
      selected("ibu"),
      [...limitations("ibu", "fg"), "ibu_is_not_sensory_measurement"],
    );
  if (validAbv !== null)
    axes.alcohol = result((validAbv - 3) / 2, ["abv_warmth_proxy"], selected("abv"), [
      ...limitations("abv"),
      "does_not_model_fusel_aging_or_temperature",
    ]);
  const grist = composition(features.rows.fermentables, features.coverage.fermentables);
  if (!grist.supported) {
    const reason = features.coverage.fermentables.complete
      ? "unclassified_or_invalid_grist_denominator"
      : "incomplete_grist_collection";
    axes.malt = result(null, [reason]);
    axes.roast = result(null, [reason]);
  }
  const unsupportedExtract = grist.fractions.some(
    ({ row, fraction }) =>
      fraction > 0.05 &&
      (row.resolution.family === "extract_pale" || row.resolution.family === "extract_dark"),
  );
  if (unsupportedExtract) {
    axes.malt = result(null, ["extract_not_grist_equivalent"], refs(features.rows.fermentables));
    axes.roast = result(null, ["extract_not_grist_equivalent"], refs(features.rows.fermentables));
  }
  if (grist.supported && !unsupportedExtract) {
    const malt = grist.fractions.reduce(
      (sum, { row, fraction }) =>
        sum + fraction * (row.resolution.family === null ? 0 : MALT[row.resolution.family]),
      0,
    );
    axes.malt = result(
      malt * (validOg === null ? 1 : clamp((validOg - 1) / 0.05, 0.65, 1.35)),
      ["classified_grist_flavor_proxy"],
      refs(features.rows.fermentables),
      validOg === null ? ["missing_strength_context"] : limitations("og"),
      validOg === null || !grist.absentSupported,
    );
    const roastPercent =
      100 *
      grist.fractions.reduce(
        (sum, { row, fraction }) => sum + fraction * ROAST[row.resolution.roastClass],
        0,
      );
    const roastComplete =
      grist.absentSupported &&
      grist.fractions.every(({ row }) => row.resolution.roastClass !== "unknown");
    if (roastPercent > 0 || roastComplete)
      axes.roast = result(
        interpolateCurve(roastPercent, FIXED_CURVE_2),
        [
          roastPercent === 0
            ? "complete_grist_no_roasted_contributors"
            : "identified_roasted_grain_proxy",
        ],
        refs(features.rows.fermentables),
        [],
        !roastComplete,
      );
  }
  const hopRows = features.rows.hops;
  const hopsComplete =
    features.coverage.hops.complete &&
    hopRows.every(
      (row) => finite(row.ingredient.grams) && row.ingredient.grams >= 0 && row.exposure !== null,
    );
  if (hopsComplete && volume !== null && volume > 0 && volume <= 10000) {
    const exposure = hopRows.reduce((sum, row) => sum + (row.exposure ?? 0), 0) / volume;
    axes.hops = result(
      saturate(exposure),
      [
        exposure === 0
          ? "complete_schedule_no_conventional_hop_exposure"
          : "process_weighted_hop_dose_proxy",
      ],
      refs(hopRows),
      [
        ...limitations("volume"),
        "volume_proxy_not_exact_addition_volume",
        ...hopRows.flatMap((row) => row.ingredient.limitations),
        "stage_weights_are_heuristic",
      ],
      hopRows.some((row) => row.resolution.level === "unresolved"),
    );
  } else
    axes.hops = result(
      null,
      [!hopsComplete ? "incomplete_or_unsupported_hop_schedule" : "missing_defensible_volume"],
      refs(hopRows),
    );
  const attenuationKey = (
    ["apparentAttenuation", "reportedAttenuation", "recipeAttenuation"] as const
  ).find((key) => {
    const value = scalar(inputs, key);
    return value !== null && value >= 0 && value <= 150;
  });
  const validAttenuation = attenuationKey === undefined ? null : scalar(inputs, attenuationKey);
  const finishReferences =
    validFg !== null
      ? selected("fg")
      : attenuationKey === undefined
        ? []
        : selected(attenuationKey);
  const finishLimitations =
    validFg !== null
      ? limitations("fg")
      : attenuationKey === undefined
        ? []
        : limitations(attenuationKey);
  const attenuationLimited = validFg === null && validAttenuation !== null;
  let sweetness =
    validFg === null
      ? validAttenuation === null
        ? null
        : interpolateCurve(validAttenuation, FIXED_CURVE_3)
      : interpolateCurve(validFg, FIXED_CURVE_4);
  if (sweetness !== null && bitterBase !== null)
    sweetness = Math.max(0, sweetness - 0.08 * bitterBase);
  const lactose = [...features.rows.fermentables, ...features.rows.miscs].filter(
    (row) => row.resolution.family === "lactose" || row.resolution.functions.includes("lactose"),
  );
  if (volume !== null && volume > 0 && lactose.length > 0 && lactose.every((row) => row.mass > 0)) {
    const floor = interpolateCurve(
      lactose.reduce((sum, row) => sum + row.mass, 0) / volume,
      FIXED_CURVE_5,
    )!;
    sweetness = Math.max(sweetness ?? 0, floor);
  }
  if (sweetness !== null)
    axes.sweetness = result(
      sweetness,
      [attenuationLimited ? "limited_attenuation_finish_proxy" : "fg_residual_extract_proxy"],
      [...finishReferences, ...refs(lactose)],
      [
        ...finishLimitations,
        "not_sugar_concentration",
        ...(attenuationLimited ? ["attenuation_fallback"] : []),
      ],
      attenuationLimited || validFg === null,
    );
  let body =
    validFg === null
      ? validAttenuation === null
        ? null
        : interpolateCurve(validAttenuation, FIXED_CURVE_6)
      : interpolateCurve(validFg, FIXED_CURVE_7);
  if (body !== null) {
    const adjunctPercent =
      grist.supported && !unsupportedExtract
        ? 100 *
          grist.fractions.reduce(
            (sum, { row, fraction }) =>
              sum +
              fraction * (row.resolution.bodyClass === null ? 0 : BODY[row.resolution.bodyClass]),
            0,
          )
        : 0;
    const bonus = interpolateCurve(adjunctPercent, FIXED_CURVE_8)!;
    body += (validAbv === null ? 0 : clamp((validAbv - 3) * 0.08, 0, 0.6)) + bonus * (1 - body / 5);
    axes.body = result(
      body,
      [attenuationLimited ? "limited_attenuation_body_proxy" : "fg_fullness_proxy"],
      finishReferences,
      [
        ...finishLimitations,
        ...limitations("abv"),
        "polymer_composition_not_measured",
        ...(!grist.supported ? ["grist_context_unavailable"] : []),
      ],
      attenuationLimited,
    );
  }
  // Tartness needs positive evidence: grain and hop identity gaps cannot make a beer sour, but
  // yeast, misc, acidulated-malt and process gaps can hide souring.
  const yeasts = features.rows.yeasts;
  const yeastIdentity = (row: ResolvedRow) =>
    `${row.ingredient.name ?? ""} ${row.ingredient.productId ?? ""}`;
  const yeastKnown =
    features.coverage.yeasts.complete &&
    yeasts.length > 0 &&
    yeasts.every(
      (row) =>
        row.resolution.souring === false ||
        (row.resolution.level === "unresolved" &&
          ["ale", "lager", "wheat"].includes(row.ingredient.type?.trim().toLowerCase() ?? "") &&
          !SOURING_CULTURE.test(yeastIdentity(row))),
    );
  const gristShared = grist.fractions.some(({ fraction }) => fraction > 0);
  const acidulated = grist.fractions.some(
    ({ row, fraction }) =>
      /acidulated|sauer/i.test(row.ingredient.name ?? "") && (!gristShared || fraction > 0.03),
  );
  // Unknown grains, adjuncts, sugars and extracts cannot sour a beer; unknown other material
  // (fruit entered as a fermentable, for example) can.
  const unknownMaterial = features.rows.fermentables.some((row) => {
    const type = row.ingredient.type?.trim().toLowerCase() ?? "";
    return (
      row.resolution.level === "unresolved" &&
      !["", "grain", "adjunct", "sugar"].includes(type) &&
      !type.includes("extract")
    );
  });
  const unresolvedAcidStage = features.rows.miscs.some(
    (row) =>
      row.resolution.functions.includes("mash_acid") &&
      !["mash", "sparge"].includes(row.ingredient.use?.trim().toLowerCase() ?? ""),
  );
  const miscsKnown =
    !unresolvedAcidStage &&
    features.coverage.miscs.complete &&
    features.rows.miscs.every(
      (row) =>
        row.resolution.level !== "unresolved" &&
        !row.resolution.functions.some((fn) => ["finished_acid", "fruit"].includes(fn)),
    );
  const souring =
    yeasts.some(
      (row) => row.resolution.souring === true || SOURING_CULTURE.test(yeastIdentity(row)),
    ) ||
    features.rows.miscs.some((row) =>
      row.resolution.functions.some((fn) => ["finished_acid", "fruit"].includes(fn)),
    );
  if (
    yeastKnown &&
    miscsKnown &&
    !acidulated &&
    !unknownMaterial &&
    features.coverage.fermentables.complete &&
    inputs.processComplete &&
    !souring
  )
    axes.tartness = result(
      0,
      ["identified_nonsouring_yeast_and_no_souring_evidence"],
      [...refs(yeasts), ...refs(features.rows.miscs)],
      ["none_expected_is_not_measured_zero_acidity"],
    );
  else
    axes.tartness = result(null, [
      souring
        ? "souring_or_finished_acid_requires_separate_model"
        : !yeastKnown
          ? "missing_or_ambiguous_yeast"
          : acidulated
            ? "acidulated_malt_requires_review"
            : "incomplete_absence_support",
    ]);
  return axes;
}
function descriptorSelection(
  inputs: BrewingInputs,
  features: ReturnType<typeof resolveFeatures>,
): FlavorDescriptor[] {
  if (inputs.beverageType.toLowerCase() !== "beer") return [];
  // Linear "units" per (label, role) are summed before one saturation, so splitting an addition
  // never changes the result and each label belongs to its strongest contributor.
  const contributions = new Map<
    string,
    { units: Map<BrewingIngredientRole, number>; refs: Set<string> }
  >();
  const add = (
    words: readonly string[],
    role: BrewingIngredientRole,
    units: number,
    row: ResolvedRow,
  ) => {
    if (!(units > 0)) return;
    words.forEach((label, index) => {
      const entry = contributions.get(label) ?? { units: new Map(), refs: new Set<string>() };
      const weight = POSITION_WEIGHTS[Math.min(index, POSITION_WEIGHTS.length - 1)]!;
      entry.units.set(role, (entry.units.get(role) ?? 0) + units * weight);
      entry.refs.add(row.ingredient.sourcePath);
      contributions.set(label, entry);
    });
  };
  const og = scalar(inputs, "og");
  const gravity = clamp(og === null ? 1 : (og - 1) / 0.05, 0.65, 1.75);
  const grist = composition(features.rows.fermentables, features.coverage.fermentables);
  let roastPercent = 0;
  for (const { row, fraction } of grist.fractions) {
    roastPercent += 100 * fraction * ROAST[row.resolution.roastClass];
    if (row.resolution.family === "sugar" && /honey/i.test(row.ingredient.name ?? "")) {
      if (fraction >= 0.04) add(["honey"], "fermentables", 25 * fraction, row);
      continue;
    }
    const character = maltCharacter(row);
    const words = row.resolution.descriptors.length ? row.resolution.descriptors : character.words;
    add(words, "fermentables", fraction * character.potency * gravity * 2.2, row);
  }
  const volume = scalar(inputs, "volume");
  if (volume !== null && volume > 0 && volume <= 10000) {
    const exposure =
      features.rows.hops.reduce((sum, row) => sum + Math.max(0, row.exposure ?? 0), 0) / volume;
    // Mixture suppression: each hop's character is its share of one saturating hop aroma.
    const scale =
      exposure > 0 ? (saturate(exposure) / exposure) * (1 - Math.min(0.5, roastPercent / 20)) : 0;
    for (const row of features.rows.hops)
      add(
        [...new Set([...row.resolution.descriptors, ...providerAroma(row)])],
        "hops",
        (Math.max(0, row.exposure ?? 0) / volume) * scale,
        row,
      );
    for (const row of features.rows.miscs) {
      const noticeable =
        row.resolution.id === null ? undefined : NOTICEABLE_G_PER_L[row.resolution.id];
      add(
        row.resolution.descriptors,
        "miscs",
        noticeable !== undefined && row.mass > 0 ? (2.5 * row.mass) / volume / noticeable : 1.5,
        row,
      );
    }
  } else for (const row of features.rows.miscs) add(row.resolution.descriptors, "miscs", 1.5, row);
  // Clean ale and lager strains add no chips; a lager's producer notes describe subtle balance.
  for (const row of features.rows.yeasts) {
    const words = row.resolution.descriptors;
    if (row.ingredient.type?.trim().toLowerCase() === "lager") continue;
    add(words, "yeasts", words.some((word) => EXPRESSIVE_YEAST.has(word)) ? 3 : 1.1, row);
  }
  const ranked = [...contributions]
    .map(([label, entry]) => {
      const role = ROLES.reduce((best, candidate) =>
        (entry.units.get(candidate) ?? 0) > (entry.units.get(best) ?? 0) ? candidate : best,
      );
      const units = [...entry.units.values()].reduce((sum, value) => sum + value, 0);
      return { label, role, salience: saturate(units), evidenceReferences: [...entry.refs] };
    })
    .sort((a, b) => b.salience - a.salience || a.label.localeCompare(b.label, "en"));
  const floor = ranked.filter((item) => item.salience >= 0.75).length >= 3 ? 0.75 : 0.6;
  const perRole = new Map<BrewingIngredientRole, number>();
  const selected: FlavorDescriptor[] = [];
  for (const { label, role, salience, evidenceReferences } of ranked) {
    if (salience < floor || selected.length === 6) break;
    const count = perRole.get(role) ?? 0;
    if (count === 3) continue;
    perRole.set(role, count + 1);
    selected.push({ label, role, evidenceReferences });
  }
  return selected;
}
function maltCharacter(row: ResolvedRow): { words: readonly string[]; potency: number } {
  const family = row.resolution.family;
  if (family === null) return { words: [], potency: 0 };
  if (family === "crystal_light" || family === "crystal_dark") {
    const lovibond = lovibondOf(row.ingredient);
    const band =
      lovibond === null
        ? family === "crystal_dark"
          ? CRYSTAL_CHARACTER.length - 1
          : 0
        : CRYSTAL_CHARACTER.findIndex((item) => lovibond < item.below);
    return { words: CRYSTAL_CHARACTER[band]!.words, potency: CRYSTAL_POTENCY[band]! };
  }
  if (family === "aromatic" && /honey|brumalt/i.test(row.ingredient.name ?? ""))
    return { words: HONEY_MALT_CHARACTER, potency: MALT_POTENCY.aromatic };
  return { words: FAMILY_CHARACTER[family] ?? [], potency: MALT_POTENCY[family] };
}
function providerAroma(row: ResolvedRow): string[] {
  return row.ingredient.aroma
    ? Object.entries(row.ingredient.aroma)
        .filter(
          ([key, value]) =>
            PROVIDER_AROMA.includes(key) && finite(value) && value > 0 && value <= 100,
        )
        .map(([key]) => key)
    : [];
}
/** Version changes invalidate derived guidance even when provider inputs are unchanged. */
export function flavorInputFingerprint(
  inputs: BrewingInputs | null,
  manualMaps: readonly unknown[],
  versions: { readonly modelVersion: string; readonly catalogVersion: string },
): string {
  return createHash("sha256")
    .update(
      stableSerialize({
        inputs,
        manual: manualMaps,
        model: versions.modelVersion,
        catalog: versions.catalogVersion,
      }),
    )
    .digest("hex");
}
export function resolveFlavorProfile(input: SensoryProfileInput): FlavorCalculation {
  const inputs = input.brewingInputs ?? null;
  const features = inputs === null ? null : resolveFeatures(inputs);
  const axes =
    inputs === null || features === null
      ? (Object.fromEntries(
          BEVERAGE_SENSORY_AXES.map((axis) => [axis, result(null, ["missing_normalized_inputs"])]),
        ) as Record<SensoryAxis, FlavorAxisResult>)
      : predictions(inputs, features);
  const beer = inputs?.beverageType.toLowerCase() === "beer";
  const baseline = beer ? styleBaseline(inputs.style.name) : {};
  for (const axis of BEVERAGE_SENSORY_AXES) {
    let manual: unknown = null;
    let present = false;
    for (const map of [
      input.manual,
      input.manualOverrides,
      input.sensoryOverrides,
      input.overrides,
    ])
      if (map && Object.hasOwn(map, axis) && map[axis] !== null && map[axis] !== undefined) {
        manual = map[axis];
        present = true;
        break;
      }
    if (present) {
      axes[axis] =
        finite(manual) && manual >= 0 && manual <= 10
          ? { ...result(manual / 2, ["manual_canonical_scale"]), source: "manual" }
          : result(null, ["invalid_manual_override"]);
    } else if (axes[axis].value === null && baseline[axis] !== undefined)
      axes[axis] = {
        ...result(
          baseline[axis],
          ["reviewed_exact_style_alias"],
          [],
          ["style_is_not_ingredient_evidence"],
          true,
        ),
        source: "style_baseline",
      };
  }
  const emptyCoverage = {
    present: false,
    complete: false,
    acceptedCount: 0,
    resolvedCount: 0,
    eligibleMassG: 0,
    resolvedMassG: 0,
    classifiedFraction: null,
  };
  const coverage =
    features?.coverage ??
    (Object.fromEntries(
      ROLES.map((role) => [role, emptyCoverage]),
    ) as FlavorCalculation["coverage"]);
  const processLabels = {
    bourbon_barrel_recorded: "Bourbon barrel-aged",
    oak_barrel_recorded: "Oak barrel-aged",
    oak_contact_recorded: "Oak contact recorded",
    spirit_addition_recorded: "Spirit addition recorded",
    vanilla_addition_recorded: "Vanilla addition recorded",
  };
  const profile = Object.fromEntries(
    BEVERAGE_SENSORY_AXES.map((axis) => {
      const item = axes[axis];
      const band = sensoryBand(axis, item.value, item.source === "manual");
      const publicAxis: SensoryAxisResult = {
        value: item.value,
        source: item.source,
        confidence: null,
        support: item.support,
        band,
        evidence:
          item.source === "manual"
            ? "Manual override"
            : item.source === "recipe_prediction"
              ? "Estimated from recipe and batch data"
              : item.source === "style_baseline"
                ? "Style baseline"
                : "No usable input",
      };
      return [axis, publicAxis];
    }),
  ) as FlavorCalculation["profile"];
  return {
    profile,
    processFacts: inputs?.processFacts ?? [],
    axes,
    descriptors: inputs && features ? descriptorSelection(inputs, features) : [],
    processTags: inputs
      ? [...new Set(inputs.processFacts.map((fact) => processLabels[fact.kind]))]
      : [],
    coverage,
    scalars: inputs?.scalars ?? null,
    diagnostics: [
      ...(inputs?.diagnostics ?? []),
      ...(features && features.coverage.fermentables.eligibleMassG > 0
        ? features.rows.fermentables
            .filter(
              (row) =>
                row.mass > 0 &&
                finite(row.ingredient.percentage) &&
                Math.abs(
                  (row.mass / features.coverage.fermentables.eligibleMassG) * 100 -
                    row.ingredient.percentage,
                ) > 2,
            )
            .map(
              (row) =>
                `${row.ingredient.sourcePath}: mass/percentage disagreement; eligible positive mass selected.`,
            )
        : []),
      ...(features
        ? ROLES.flatMap((role) => features.rows[role].flatMap((row) => row.resolution.diagnostics))
        : []),
    ].slice(0, 100),
    modelVersion: MODEL_VERSION,
    catalogVersion: CATALOG_VERSION,
    fingerprint: flavorInputFingerprint(
      inputs,
      [input.manual, input.manualOverrides, input.sensoryOverrides, input.overrides],
      { modelVersion: MODEL_VERSION, catalogVersion: CATALOG_VERSION },
    ),
  };
}
