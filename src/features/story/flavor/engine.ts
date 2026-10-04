import { createHash } from "node:crypto";
import type { BrewingInputs } from "../../beverages/brewing-types.ts";
import {
  SENSORY_AXES,
  type SensoryAxis,
  type SensoryProfileInput,
  type FlavorAxisResult,
  type FlavorCalculation,
  type FlavorDescriptor,
  type SensoryAxisResult,
} from "../types.ts";
import { CATALOG_VERSION } from "./catalog.ts";
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

export const MODEL_VERSION = "recipe-flavor-1";
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
    SENSORY_AXES.map((axis) => [axis, result(null, ["missing_relevant_inputs"])]),
  ) as Record<SensoryAxis, FlavorAxisResult>;
  if (inputs.beverageType.toLowerCase() !== "beer")
    return Object.fromEntries(
      SENSORY_AXES.map((axis) => [axis, result(null, ["non_beer_model_not_applicable"])]),
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
      -5 * Math.expm1(-exposure / 5),
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
  const yeasts = features.rows.yeasts;
  const yeastKnown =
    features.coverage.yeasts.complete &&
    yeasts.length > 0 &&
    yeasts.every((row) => row.resolution.souring === false);
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
    yeasts.some((row) => row.resolution.souring === true) ||
    features.rows.miscs.some((row) =>
      row.resolution.functions.some((fn) => ["finished_acid", "fruit"].includes(fn)),
    );
  if (yeastKnown && miscsKnown && grist.absentSupported && inputs.processComplete && !souring)
    axes.tartness = result(
      0,
      ["complete_conventional_recipe_no_souring_evidence"],
      [...refs(yeasts), ...refs(features.rows.miscs)],
      ["none_expected_is_not_measured_zero_acidity"],
    );
  else
    axes.tartness = result(null, [
      souring
        ? "souring_or_finished_acid_requires_separate_model"
        : !yeastKnown
          ? "missing_or_ambiguous_yeast"
          : "incomplete_absence_support",
    ]);
  return axes;
}
function descriptorSelection(
  inputs: BrewingInputs,
  features: ReturnType<typeof resolveFeatures>,
): FlavorDescriptor[] {
  if (inputs.beverageType.toLowerCase() !== "beer") return [];
  const groups: FlavorDescriptor[][] = [];
  const volume = scalar(inputs, "volume");
  const totalHop = features.rows.hops.reduce((sum, row) => sum + (row.exposure ?? 0), 0);
  for (const role of ROLES) {
    const support = new Map<string, { weight: number; refs: string[] }>();
    for (const row of features.rows[role]) {
      if (
        role === "hops" &&
        (volume === null ||
          volume <= 0 ||
          row.exposure === null ||
          row.exposure / volume < 0.1 ||
          totalHop === 0 ||
          row.exposure / totalHop < 0.05)
      )
        continue;
      const weight = role === "hops" ? (row.exposure ?? 0) : role === "fermentables" ? row.mass : 1;
      const providerDescriptors =
        role === "hops" && row.ingredient.aroma
          ? Object.entries(row.ingredient.aroma)
              .filter(
                ([key, value]) =>
                  [
                    "floral",
                    "grassy",
                    "herbal",
                    "earthy",
                    "woody",
                    "onion",
                    "citrus",
                    "fruity",
                  ].includes(key) &&
                  finite(value) &&
                  value > 0 &&
                  value <= 100,
              )
              .map(([key]) => key)
          : [];
      for (const label of new Set([...row.resolution.descriptors, ...providerDescriptors])) {
        const old = support.get(label) ?? { weight: 0, refs: [] };
        old.weight += weight;
        old.refs.push(row.ingredient.sourcePath);
        support.set(label, old);
      }
    }
    groups.push(
      [...support]
        .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0], "en"))
        .map(([label, item]) => ({ label, role, evidenceReferences: [...new Set(item.refs)] })),
    );
  }
  const selected: FlavorDescriptor[] = [];
  const labels = new Set<string>();
  for (let i = 0; i < 6 && selected.length < 6; i++)
    for (const group of groups) {
      const item = group[i];
      if (item && !labels.has(item.label) && selected.length < 6) {
        selected.push(item);
        labels.add(item.label);
      }
    }
  return selected;
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
          SENSORY_AXES.map((axis) => [axis, result(null, ["missing_normalized_inputs"])]),
        ) as Record<SensoryAxis, FlavorAxisResult>)
      : predictions(inputs, features);
  const beer = inputs?.beverageType.toLowerCase() === "beer";
  const baseline = beer ? styleBaseline(inputs.style.name) : {};
  for (const axis of SENSORY_AXES) {
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
    SENSORY_AXES.map((axis) => {
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
