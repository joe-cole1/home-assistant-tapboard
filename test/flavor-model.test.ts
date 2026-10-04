import assert from "node:assert/strict";
import test from "node:test";
import type {
  BrewingInputs,
  BrewingIngredient,
  BrewingIngredientRole,
  BrewingScalar,
} from "../src/features/beverages/brewing-types.ts";
import {
  resolveFlavorProfile,
  canonicalSensoryToPublic,
  resolveSensoryAxis,
} from "../src/features/story/profile.ts";
import { interpolateCurve } from "../src/features/story/flavor/math.ts";
const unavailable: BrewingScalar = {
  value: null,
  unit: "sg",
  sourcePath: null,
  provenance: "unavailable",
  limitations: [],
};
export function ingredient(patch: Partial<BrewingIngredient> = {}): BrewingIngredient {
  return {
    sourcePath: "recipe.hops[0]",
    name: "Citra",
    supplier: null,
    laboratory: null,
    productId: null,
    type: null,
    grainCategory: null,
    use: null,
    usage: null,
    form: "Pellet",
    amount: 100,
    unit: "g",
    grams: 100,
    percentage: null,
    color: null,
    lovibond: null,
    alpha: null,
    day: null,
    time: null,
    timeUnit: null,
    stage: "dry_hop",
    boilMinutes: null,
    contactDays: null,
    additionDay: null,
    temperatureC: null,
    aroma: null,
    totalOil: null,
    limitations: [],
    ...patch,
  };
}
export function fixture(): BrewingInputs {
  const collection = {
    present: true,
    originalCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    truncated: false,
    complete: true,
    items: [],
  };
  return {
    schemaVersion: 2,
    format: "custom",
    beverageType: "beer",
    scalars: {
      og: { ...unavailable, value: 1.05 },
      fg: { ...unavailable, value: 1.01 },
      abv: { ...unavailable, value: 6 },
      ibu: { ...unavailable, value: 50 },
      color: unavailable,
      volume: { ...unavailable, value: 20, unit: "l" },
      carbonation: unavailable,
      reportedAttenuation: unavailable,
      recipeAttenuation: unavailable,
      apparentAttenuation: unavailable,
    },
    ingredients: {
      fermentables: collection,
      hops: collection,
      yeasts: collection,
      miscs: collection,
    },
    processFacts: [],
    processComplete: true,
    mash: [],
    fermentation: [],
    water: { sourcePh: null, treatedPh: null, mashPh: null, treatedIons: {} },
    style: { name: null, id: null, guide: null },
    diagnostics: [],
  };
}
function withRows(
  input: BrewingInputs,
  role: BrewingIngredientRole,
  items: BrewingIngredient[],
): BrewingInputs {
  return {
    ...input,
    ingredients: {
      ...input.ingredients,
      [role]: {
        present: true,
        originalCount: items.length,
        acceptedCount: items.length,
        rejectedCount: 0,
        truncated: false,
        complete: true,
        items,
      },
    },
  };
}
void test("prescribed scalar curves and below-water FG remain finite", () => {
  const base = fixture();
  const profile = resolveFlavorProfile({ brewingInputs: base });
  assert.equal(profile.axes.bitterness.value, 3.4);
  assert.equal(profile.axes.alcohol.value, 1.5);
  assert.ok(Math.abs((profile.axes.body.value ?? 0) - 1.64) < 1e-10);
  const dry = resolveFlavorProfile({
    brewingInputs: {
      ...base,
      scalars: {
        ...base.scalars,
        fg: { ...unavailable, value: 0.995 },
        reportedAttenuation: { ...unavailable, value: 108.1, unit: "percent" },
      },
    },
  });
  assert.equal(dry.axes.sweetness.value, 0);
  assert.ok((dry.axes.body.value ?? 0) > 0);
  assert.equal(dry.scalars?.reportedAttenuation.value, 108.1);
});
void test("hop exposure saturates, scales with volume, and does not alter supplied IBU", () => {
  const base = withRows(fixture(), "hops", [ingredient()]);
  const first = resolveFlavorProfile({ brewingInputs: base });
  const doubled = withRows(
    { ...base, scalars: { ...base.scalars, volume: { ...base.scalars.volume, value: 40 } } },
    "hops",
    [ingredient({ grams: 200 })],
  );
  assert.equal(
    first.axes.hops.value,
    resolveFlavorProfile({ brewingInputs: doubled }).axes.hops.value,
  );
  const dose = resolveFlavorProfile({
    brewingInputs: withRows(base, "hops", [ingredient({ grams: 200 })]),
  });
  assert.ok((dose.axes.hops.value ?? 0) < 2 * (first.axes.hops.value ?? 0));
  const early = resolveFlavorProfile({
    brewingInputs: withRows(base, "hops", [ingredient({ stage: "boil", boilMinutes: 60 })]),
  });
  const late = resolveFlavorProfile({
    brewingInputs: withRows(base, "hops", [ingredient({ stage: "boil", boilMinutes: 0 })]),
  });
  assert.ok((late.axes.hops.value ?? 0) > (early.axes.hops.value ?? 0));
  assert.equal(early.axes.bitterness.value, late.axes.bitterness.value);
  assert.equal(
    resolveFlavorProfile({
      brewingInputs: withRows(base, "hops", [ingredient({ form: "unknown extract" })]),
    }).axes.hops.value,
    null,
  );
  assert.equal(
    resolveFlavorProfile({ brewingInputs: withRows(base, "hops", [ingredient({ name: null })]) })
      .axes.hops.value,
    first.axes.hops.value,
  );
});
void test("missing schedules differ from complete empty schedules", () => {
  const input = fixture();
  assert.equal(resolveFlavorProfile({ brewingInputs: input }).axes.hops.value, 0);
  const missing = {
    ...input,
    ingredients: {
      ...input.ingredients,
      hops: { ...input.ingredients.hops, present: false, complete: false },
    },
  };
  assert.equal(resolveFlavorProfile({ brewingInputs: missing }).axes.hops.value, null);
  assert.equal(resolveFlavorProfile({ brewingInputs: input }).axes.roast.value, null);
  assert.equal(resolveFlavorProfile({ brewingInputs: input }).axes.tartness.value, null);
});
void test("manual zero wins, malformed manual fails closed and clearing restores guidance", () => {
  const input = fixture();
  assert.equal(
    resolveFlavorProfile({ brewingInputs: input, manualOverrides: { bitterness: 0 } }).axes
      .bitterness.value,
    0,
  );
  assert.equal(
    resolveFlavorProfile({ brewingInputs: input, manualOverrides: { bitterness: Number.NaN } }).axes
      .bitterness.value,
    null,
  );
  assert.equal(
    resolveFlavorProfile({ brewingInputs: input, manualOverrides: { bitterness: null } }).axes
      .bitterness.value,
    3.4,
  );
  assert.equal(canonicalSensoryToPublic(7.777), 3.8885);
  assert.equal(canonicalSensoryToPublic(10.01), null);
});
void test("non-beer preserves manual overrides but never calculates beer scores", () => {
  const calculation = resolveFlavorProfile({
    brewingInputs: { ...fixture(), beverageType: "cider" },
    manualOverrides: { body: 8 },
  });
  assert.equal(calculation.axes.body.value, 4);
  assert.equal(calculation.axes.bitterness.value, null);
  assert.deepEqual(calculation.descriptors, []);
});
void test("public profile is generic and fingerprints deterministic", () => {
  const input = fixture();
  const calculation = resolveFlavorProfile({ brewingInputs: input });
  assert.equal(
    calculation.fingerprint,
    resolveFlavorProfile({ brewingInputs: structuredClone(input) }).fingerprint,
  );
  assert.ok(Object.values(calculation.profile).every((axis) => axis.confidence === null));
  assert.ok(!JSON.stringify(calculation.profile).includes("sourcePath"));
  assert.notEqual(
    calculation.fingerprint,
    resolveFlavorProfile({ brewingInputs: input, manualOverrides: { body: 0 } }).fingerprint,
  );
});
void test("interpolation rejects invalid configuration and nonfinite inputs", () => {
  assert.equal(
    interpolateCurve(Number.NaN, [
      [0, 0],
      [1, 1],
    ]),
    null,
  );
  assert.equal(
    interpolateCurve(100, [
      [0, 0],
      [1, 1],
    ]),
    1,
  );
  assert.throws(() =>
    interpolateCurve(1, [
      [1, 0],
      [1, 1],
    ]),
  );
});
void test("invalid finite-domain values cannot produce an invented zero", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const input = fixture();
    const output = resolveFlavorProfile({
      brewingInputs: {
        ...input,
        scalars: {
          ...input.scalars,
          ibu: { ...unavailable, value },
          fg: { ...unavailable, value },
          abv: { ...unavailable, value },
        },
      },
    });
    assert.equal(output.axes.bitterness.value, null);
    assert.equal(output.axes.sweetness.value, null);
    assert.equal(output.axes.alcohol.value, null);
  }
  const profile = resolveFlavorProfile({
    brewingInputs: fixture(),
    manualOverrides: { body: true as unknown as number },
  });
  assert.equal(profile.axes.body.value, null);
});
void test("unknown hop timing and truncation never support absence", () => {
  const input = withRows(fixture(), "hops", [ingredient({ stage: "boil", boilMinutes: null })]);
  assert.equal(resolveFlavorProfile({ brewingInputs: input }).axes.hops.value, null);
  const truncated = {
    ...input,
    ingredients: { ...input.ingredients, hops: { ...input.ingredients.hops, truncated: true } },
  };
  assert.equal(resolveFlavorProfile({ brewingInputs: truncated }).axes.hops.value, null);
});
void test("clock, beer title, water pH and color do not invent flavor changes", () => {
  const input = fixture();
  const first = resolveFlavorProfile({ brewingInputs: input, name: "Bright lager" });
  const second = resolveFlavorProfile({
    brewingInputs: {
      ...input,
      water: { ...input.water, sourcePh: 3.1, mashPh: 3.2 },
      scalars: { ...input.scalars, color: { ...unavailable, value: 100 } },
    },
    name: "Bourbon sour roast",
  });
  for (const key of Object.keys(first.axes) as (keyof typeof first.axes)[])
    assert.equal(first.axes[key].value, second.axes[key].value);
});
void test("composition gates separate grain flavor, unknown mass and no-roast absence", () => {
  const pale = ingredient({
    sourcePath: "recipe.fermentables[0]",
    name: "Pale Malt",
    grams: 9500,
    stage: "unknown",
  });
  const carapils = ingredient({
    sourcePath: "recipe.fermentables[1]",
    name: "Carapils",
    supplier: "Briess",
    grams: 500,
    stage: "unknown",
  });
  const base = withRows(fixture(), "fermentables", [pale, carapils]);
  const result = resolveFlavorProfile({ brewingInputs: base });
  assert.ok(Math.abs((result.axes.malt.value ?? 0) - 1.72) < 1e-10);
  assert.equal(result.axes.roast.value, 0);
  const unknown = withRows(base, "fermentables", [
    pale,
    ingredient({ name: "Unresolved mystery specialty", grams: 600 }),
  ]);
  assert.equal(resolveFlavorProfile({ brewingInputs: unknown }).axes.malt.value, null);
  const partial = withRows(base, "fermentables", [
    pale,
    ingredient({ name: "Unresolved mystery specialty", grams: 100 }),
  ]);
  assert.ok(resolveFlavorProfile({ brewingInputs: partial }).axes.malt.value !== null);
  assert.equal(resolveFlavorProfile({ brewingInputs: partial }).axes.roast.value, null);
  const scaled = withRows(base, "fermentables", [
    { ...pale, grams: 19000 },
    { ...carapils, grams: 1000 },
  ]);
  assert.equal(
    resolveFlavorProfile({ brewingInputs: scaled }).axes.malt.value,
    result.axes.malt.value,
  );
  const color = { ...base, scalars: { ...base.scalars, color: { ...unavailable, value: 100 } } };
  assert.equal(resolveFlavorProfile({ brewingInputs: color }).axes.roast.value, 0);
});
void test("tartness absence requires identified nonsouring yeast and complete recipe support", () => {
  const pale = ingredient({ name: "Pale Malt", grams: 5000, stage: "unknown" });
  let input = withRows(fixture(), "fermentables", [pale]);
  input = withRows(input, "yeasts", [
    ingredient({
      name: "SafAle US-05",
      laboratory: "Fermentis",
      productId: "US-05",
      grams: null,
      stage: "unknown",
    }),
  ]);
  assert.equal(resolveFlavorProfile({ brewingInputs: input }).axes.tartness.value, 0);
  assert.equal(
    resolveFlavorProfile({ brewingInputs: { ...input, processComplete: false } }).axes.tartness
      .value,
    null,
  );
  assert.equal(
    resolveFlavorProfile({
      brewingInputs: withRows(input, "miscs", [ingredient({ name: "Unknown powder", grams: 1 })]),
    }).axes.tartness.value,
    null,
  );
});
void test("optional provider aroma contributes generic descriptors without changing intensity", () => {
  const input = withRows(fixture(), "hops", [
    ingredient({ name: null, aroma: { fruity: 80, floral: 0, citrus: 101, unknown: 90 } }),
  ]);
  const result = resolveFlavorProfile({ brewingInputs: input });
  assert.deepEqual(
    result.descriptors.map((note) => note.label),
    ["fruity"],
  );
  assert.equal(
    result.axes.hops.value,
    resolveFlavorProfile({
      brewingInputs: withRows(input, "hops", [ingredient({ name: null, aroma: null })]),
    }).axes.hops.value,
  );
});
void test("named concentrated pellet products do not become conventional exposure", () => {
  for (const name of [
    "Citra Cryo",
    "Mosaic LUPOMAX",
    "Incognito",
    "Spectrum",
    "Hop Oil",
    "Hop Extract",
  ]) {
    const input = withRows(fixture(), "hops", [
      ingredient({ name, form: "Pellet", type: "Pellet" }),
    ]);
    assert.equal(resolveFlavorProfile({ brewingInputs: input }).axes.hops.value, null);
  }
});
void test("water acid names require verified water-treatment stage to support nonsour absence", () => {
  let input = withRows(fixture(), "fermentables", [
    ingredient({ name: "Pale Malt", grams: 5000, stage: "unknown" }),
  ]);
  input = withRows(input, "yeasts", [
    ingredient({
      name: "SafAle US-05",
      laboratory: "Fermentis",
      productId: "US-05",
      grams: null,
      stage: "unknown",
    }),
  ]);
  for (const use of ["Mash", "Sparge"])
    assert.equal(
      resolveFlavorProfile({
        brewingInputs: withRows(input, "miscs", [ingredient({ name: "Phosphoric Acid", use })]),
      }).axes.tartness.value,
      0,
    );
  for (const use of ["Secondary", "Bottling", null])
    assert.equal(
      resolveFlavorProfile({
        brewingInputs: withRows(input, "miscs", [ingredient({ name: "Phosphoric Acid", use })]),
      }).axes.tartness.value,
      null,
    );
});
void test("legacy axis helper retains input then axis signature and grist null reasons are explicit", () => {
  assert.equal(resolveSensoryAxis({ manualOverrides: { body: 8 } }, "body").value, 4);
  assert.equal(
    resolveFlavorProfile({ brewingInputs: fixture() }).axes.malt.reasons[0],
    "unclassified_or_invalid_grist_denominator",
  );
});

void test("explicit zero hop mass remains a supported zero while missing mass stays unavailable", () => {
  const zero = withRows(fixture(), "hops", [ingredient({ amount: 0, grams: 0 })]);
  assert.equal(resolveFlavorProfile({ brewingInputs: zero }).axes.hops.value, 0);
  const missing = withRows(fixture(), "hops", [ingredient({ amount: null, grams: null })]);
  assert.equal(resolveFlavorProfile({ brewingInputs: missing }).axes.hops.value, null);
});
