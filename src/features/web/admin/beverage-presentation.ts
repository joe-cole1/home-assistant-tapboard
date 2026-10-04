import { VESSEL_IDS } from "../../story/index.ts";
import { getVesselDescriptor } from "../../story/vessels.ts";
import {
  BEVERAGE_SENSORY_AXES,
  BEVERAGE_SENSORY_CANONICAL_MAX,
  BEVERAGE_SENSORY_CANONICAL_MIN,
  type BeverageListRecord,
  type BrewfatherCandidate,
  type UpdateCustomBeverageInput,
} from "../../beverages/types.ts";
import type { BeverageDetailResult } from "../../beverages/service.ts";
import { invalidForm, nullableNumber } from "./forms.ts";

export function safeSensoryOverride(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= BEVERAGE_SENSORY_CANONICAL_MIN &&
    value <= BEVERAGE_SENSORY_CANONICAL_MAX
    ? value
    : null;
}

export function recipeFromForm(
  form: Readonly<Record<string, string>>,
): UpdateCustomBeverageInput["recipe"] {
  const serialized = form.recipeJson ?? "";
  // Whitespace-only input is the no-JS delete affordance. Do not trim a
  // non-empty payload: the service owns validation and the JSON values must
  // retain every supported character exactly as entered.
  if (serialized.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    invalidForm("Recipe must contain valid JSON.");
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    invalidForm("Recipe must be a JSON object.");
  }
  return parsed;
}

export function sensoryOverridesFromForm(
  form: Readonly<Record<string, string>>,
): UpdateCustomBeverageInput["sensoryOverrides"] | undefined {
  if (!ADMIN_BEVERAGE_SENSORY_AXES.some((axis) => form[axis] !== undefined)) return undefined;
  return Object.fromEntries(
    ADMIN_BEVERAGE_SENSORY_AXES.flatMap((axis) => {
      const value = nullableNumber(form[axis]);
      if (
        value !== undefined &&
        value !== null &&
        (!Number.isFinite(value) ||
          value < BEVERAGE_SENSORY_CANONICAL_MIN ||
          value > BEVERAGE_SENSORY_CANONICAL_MAX)
      )
        invalidForm("Sensory overrides must be numbers from 0 to 10.", axis);
      return value === undefined ? [] : [[axis, value]];
    }),
  );
}

export function vesselFromForm(
  value: string | undefined,
  field = "fillGlass",
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!(VESSEL_IDS as readonly string[]).includes(trimmed)) {
    invalidForm("Fill Glass must be selected from the supported catalog.", field);
  }
  return trimmed;
}

export function safeVesselForDisplay(value: unknown): string | null {
  return typeof value === "string" && (VESSEL_IDS as readonly string[]).includes(value)
    ? value
    : null;
}

export function safeColorForDisplay(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : null;
}

export function vesselDisplayName(value: string): string {
  const names: Readonly<Record<string, string>> = {
    corny_keg: "Corny keg",
    pint_glass: "Pint glass",
    tulip_glass: "Tulip glass",
    wheat_glass: "Wheat glass",
    mug: "Mug",
    stout_glass: "Stout glass",
    snifter: "Snifter",
    nonic_pint: "Nonic pint",
    shaker_pint: "Shaker pint",
    pilsner_flute: "Pilsner flute",
    stange: "Stange",
    goblet: "Goblet",
    teku: "Teku",
    thistle: "Thistle",
    ipa_glass: "IPA glass",
    tasting_glass: "Tasting glass",
    stemmed_lager: "Stemmed lager",
  };
  return names[value] ?? value;
}

export function fillGlassOptions() {
  return VESSEL_IDS.map((id) => ({
    id,
    label: vesselDisplayName(id),
    graphic: getVesselDescriptor(id),
  }));
}

export const ADMIN_BEVERAGE_SENSORY_AXES = BEVERAGE_SENSORY_AXES;

export function boundedAdminString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, maxBytes);
}

export function boundedAdminNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function safeAdminRecipe(value: unknown): {
  readonly notes: string | null;
  readonly ingredients: readonly {
    readonly name: string;
    readonly amount: number | null;
    readonly unit: string | null;
    readonly note: string | null;
  }[];
  readonly steps: readonly {
    readonly name: string;
    readonly temperatureC: number | null;
    readonly timeMinutes: number | null;
    readonly note: string | null;
  }[];
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawIngredients = Array.isArray(record.ingredients) ? record.ingredients : [];
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const ingredients = rawIngredients.slice(0, 200).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const ingredient = item as Record<string, unknown>;
    const name = boundedAdminString(ingredient.name, 160);
    if (name === null) return [];
    return [
      {
        name,
        amount: boundedAdminNumber(ingredient.amount),
        unit: boundedAdminString(ingredient.unit, 32),
        note: boundedAdminString(ingredient.note, 255),
      },
    ];
  });
  const steps = rawSteps.slice(0, 100).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const step = item as Record<string, unknown>;
    const name = boundedAdminString(step.name, 160);
    if (name === null) return [];
    return [
      {
        name,
        temperatureC: boundedAdminNumber(step.temperatureC),
        timeMinutes: boundedAdminNumber(step.timeMinutes),
        note: boundedAdminString(step.note, 1000),
      },
    ];
  });
  return {
    notes: boundedAdminString(record.notes, 4000),
    ingredients,
    steps,
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function boundedStrings(value: unknown, limit = 20): string[] {
  return Array.isArray(value)
    ? value.slice(0, limit).flatMap((item) => {
        const text = boundedAdminString(item, 240);
        return text === null ? [] : [text];
      })
    : [];
}
export function safeAdminFlavorDetails(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = object(value);
  const scalars = object(raw.scalars);
  const coverage = object(raw.coverage);
  const axes = object(raw.axes);
  return {
    modelVersion: boundedAdminString(raw.modelVersion, 80),
    catalogVersion: boundedAdminString(raw.catalogVersion, 80),
    scalars: [
      "og",
      "fg",
      "abv",
      "ibu",
      "color",
      "volume",
      "carbonation",
      "reportedAttenuation",
      "recipeAttenuation",
      "apparentAttenuation",
    ].map((key) => {
      const item = object(scalars[key]);
      return {
        key,
        value: boundedAdminNumber(item.value),
        unit: boundedAdminString(item.unit, 24),
        provenance: boundedAdminString(item.provenance, 40),
        sourcePath: boundedAdminString(item.sourcePath, 160),
        limitations: boundedStrings(item.limitations, 5),
      };
    }),
    coverage: ["fermentables", "hops", "yeasts", "miscs"].map((key) => {
      const item = object(coverage[key]);
      return {
        key,
        present: item.present === true,
        complete: item.complete === true,
        acceptedCount: boundedAdminNumber(item.acceptedCount),
        resolvedCount: boundedAdminNumber(item.resolvedCount),
        classifiedFraction: boundedAdminNumber(item.classifiedFraction),
      };
    }),
    axes: ADMIN_BEVERAGE_SENSORY_AXES.map((key) => {
      const item = object(axes[key]);
      return {
        key,
        value: boundedAdminNumber(item.value),
        source: boundedAdminString(item.source, 40),
        support: boundedAdminString(item.support, 24),
        reasons: boundedStrings(item.reasons, 8),
        limitations: boundedStrings(item.limitations, 8),
      };
    }),
    diagnostics: boundedStrings(raw.diagnostics, 30),
  };
}

export function safeAdminGuidance(value: unknown): {
  readonly sensory: Readonly<
    Record<
      string,
      {
        readonly value: number | null;
        readonly source: string;
        readonly confidence: string | null;
        readonly evidence: string;
      }
    >
  >;
  readonly customRecipe: ReturnType<typeof safeAdminRecipe>;
  readonly sourceRecipes: readonly unknown[];
  readonly activeSourceLabel: string | null;
  readonly flavorDetails: ReturnType<typeof safeAdminFlavorDetails>;
  readonly brewingEnrichmentPending: boolean;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawSensory =
    typeof record.sensory === "object" && record.sensory !== null
      ? (record.sensory as Record<string, unknown>)
      : {};
  const sensory: Record<
    string,
    {
      readonly value: number | null;
      readonly source: string;
      readonly confidence: string | null;
      readonly evidence: string;
    }
  > = {};
  for (const axis of ADMIN_BEVERAGE_SENSORY_AXES) {
    const raw = rawSensory[axis];
    const result = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    sensory[axis] = {
      value: boundedAdminNumber(result.value),
      source: boundedAdminString(result.source, 64) ?? "unavailable",
      confidence: boundedAdminString(result.confidence, 32),
      evidence: boundedAdminString(result.evidence, 240) ?? "Guidance unavailable.",
    };
  }
  const rawSourceRecipes = Array.isArray(record.sourceRecipes) ? record.sourceRecipes : [];
  const sourceRecipes = rawSourceRecipes.slice(0, 5).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const recipe = raw as Record<string, unknown>;
    const ingredients = Array.isArray(recipe.ingredients)
      ? recipe.ingredients.slice(0, 200).flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const ingredient = item as Record<string, unknown>;
          const name = boundedAdminString(ingredient.name, 160);
          if (name === null) return [];
          return [
            {
              name,
              amount: boundedAdminNumber(ingredient.amount),
              unit: boundedAdminString(ingredient.unit, 32),
              note: boundedAdminString(ingredient.note, 255),
            },
          ];
        })
      : [];
    const steps = Array.isArray(recipe.steps)
      ? recipe.steps.slice(0, 100).flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const step = item as Record<string, unknown>;
          return [
            {
              name: boundedAdminString(step.name, 160),
              text: boundedAdminString(step.text, 4000),
              temperatureC: boundedAdminNumber(step.temperatureC),
              timeMinutes: boundedAdminNumber(step.timeMinutes),
              note: boundedAdminString(step.note, 1000),
            },
          ];
        })
      : [];
    return [
      {
        kind: boundedAdminString(recipe.kind, 32),
        status: boundedAdminString(recipe.status, 32),
        notes: boundedAdminString(recipe.notes, 4000),
        ingredients,
        steps,
        provenance:
          typeof recipe.provenance === "object" && recipe.provenance !== null
            ? {
                label: boundedAdminString(
                  (recipe.provenance as Record<string, unknown>).label,
                  120,
                ),
                state: boundedAdminString((recipe.provenance as Record<string, unknown>).state, 32),
                version: boundedAdminNumber((recipe.provenance as Record<string, unknown>).version),
                capturedAt: boundedAdminString(
                  (recipe.provenance as Record<string, unknown>).capturedAt,
                  64,
                ),
              }
            : null,
      },
    ];
  });
  return {
    sensory,
    customRecipe: safeAdminRecipe(record.customRecipe),
    sourceRecipes,
    activeSourceLabel: boundedAdminString(record.activeSourceLabel, 120),
    flavorDetails: safeAdminFlavorDetails(record.flavorDetails),
    brewingEnrichmentPending: record.brewingEnrichmentPending === true,
  };
}

export function adminBeverageListItem(item: BeverageListRecord): Record<string, unknown> {
  const fillGlass = safeVesselForDisplay(item.effectivePresentation.fillGlass);
  return {
    id: item.beverage.id,
    name: item.effectivePresentation.name,
    ownershipType: item.beverage.ownershipType,
    source: item.beverage.ownershipType === "brewfather" ? "Brewfather" : "Custom",
    beverageType: item.effectivePresentation.beverageType,
    style: item.effectivePresentation.style,
    abv: item.effectivePresentation.abv,
    displayColor: safeColorForDisplay(item.effectivePresentation.displayColor),
    fillGlass: fillGlass === null ? null : vesselDisplayName(fillGlass),
    graphic: getVesselDescriptor(fillGlass ?? "pint_glass"),
    fillPercent: 100,
    currentUsage:
      Number.isFinite(item.currentUsage) && item.currentUsage >= 0 ? item.currentUsage : 0,
    updatedAt: item.beverage.updatedAt,
  };
}

export function adminBrewfatherCandidate(candidate: BrewfatherCandidate): Record<string, unknown> {
  return {
    sourceBatchId: boundedAdminString(candidate.sourceBatchId, 256) ?? "",
    name: boundedAdminString(candidate.batchName ?? candidate.recipeName, 160) ?? "Unnamed batch",
    number: boundedAdminString(candidate.batchNumber, 64),
    status: boundedAdminString(candidate.status, 32) ?? "Unknown",
    style: boundedAdminString(candidate.style, 120),
  };
}

export function adminBeverageDetailDto(
  detail: BeverageDetailResult,
  usage: { readonly current: number; readonly total: number },
  deletionImpacts: readonly { readonly code: string; readonly count: number }[],
  guidance: unknown,
): Record<string, unknown> {
  const effective = detail.effectivePresentation;
  const source = detail.brewfatherSourceProfile;
  const overrides = detail.presentationOverrides;
  const customRecipe = safeAdminRecipe(detail.customRecipe);
  const sourceProjection =
    source === undefined
      ? null
      : {
          name: source.name,
          beverageType: source.beverageType,
          style: source.style,
          abv: source.abv,
          ibu: source.ibu,
          og: source.og,
          fg: source.fg,
          srm: source.srm,
          displayColor: safeColorForDisplay(source.displayColor),
          description: source.description,
          updatedAt: source.updatedAt,
        };
  const overrideProjection = {
    name: overrides?.name ?? null,
    beverageType: overrides?.beverageType ?? null,
    style: overrides?.style ?? null,
    abv: overrides?.abv ?? null,
    ibu: overrides?.ibu ?? null,
    og: overrides?.og ?? null,
    fg: overrides?.fg ?? null,
    srm: overrides?.srm ?? null,
    displayColor: safeColorForDisplay(overrides?.displayColor),
    description: overrides?.description ?? null,
    fillGlass: safeVesselForDisplay(overrides?.fillGlass),
    manualDensityOverride: overrides?.manualDensityOverride ?? null,
    overrideNamePresent: overrides?.overrideNamePresent ?? false,
    overrideBeverageTypePresent: overrides?.overrideBeverageTypePresent ?? false,
    overrideStylePresent: overrides?.overrideStylePresent ?? false,
    overrideAbvPresent: overrides?.overrideAbvPresent ?? false,
    overrideIbuPresent: overrides?.overrideIbuPresent ?? false,
    overrideOgPresent: overrides?.overrideOgPresent ?? false,
    overrideFgPresent: overrides?.overrideFgPresent ?? false,
    overrideSrmPresent: overrides?.overrideSrmPresent ?? false,
    overrideDisplayColorPresent: overrides?.overrideDisplayColorPresent ?? false,
    overrideDescriptionPresent: overrides?.overrideDescriptionPresent ?? false,
    overrideFillGlassPresent: overrides?.overrideFillGlassPresent ?? false,
    overrideManualDensityOverridePresent: overrides?.overrideManualDensityOverridePresent ?? false,
  };
  return {
    id: detail.beverage.id,
    ownershipType: detail.beverage.ownershipType,
    name: effective.name,
    beverageType: effective.beverageType,
    style: effective.style,
    abv: effective.abv,
    ibu: effective.ibu,
    og: effective.og,
    fg: effective.fg,
    srm: effective.srm,
    displayColor: safeColorForDisplay(effective.displayColor),
    description: effective.description,
    fillGlass: safeVesselForDisplay(effective.fillGlass),
    manualDensityOverride: effective.manualDensityOverride,
    createdAt: detail.beverage.createdAt,
    updatedAt: detail.beverage.updatedAt,
    density: detail.density,
    usage,
    source: sourceProjection,
    overrides: source === undefined ? null : overrideProjection,
    syncState: detail.brewfatherLink?.syncState ?? null,
    lastSyncedAt: detail.brewfatherLink?.lastSyncedAt ?? null,
    sensoryOverrides:
      detail.sensoryOverrides === undefined
        ? null
        : Object.fromEntries(
            ADMIN_BEVERAGE_SENSORY_AXES.map((axis) => [
              axis,
              safeSensoryOverride(detail.sensoryOverrides?.[axis]),
            ]),
          ),
    customRecipe,
    customRecipeJson: customRecipe === null ? "" : JSON.stringify(customRecipe, null, 2),
    guidance: safeAdminGuidance(guidance),
    deletionImpacts: deletionImpacts.map((impact) => ({
      code: boundedAdminString(impact.code, 80) ?? "related records",
      count: Number.isFinite(impact.count) && impact.count >= 0 ? impact.count : 0,
    })),
  };
}
