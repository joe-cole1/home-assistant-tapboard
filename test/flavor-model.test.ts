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
  publicFlavorGuidance,
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
void test("grain identity gaps cannot block none-expected tartness; acid malt, other material and cultures can", () => {
  const grain = (name: string, grams: number, type = "Grain") =>
    ingredient({ name, type, grams, stage: "unknown", form: null });
  const yeast = (name: string, type = "Ale") =>
    ingredient({ name, type, grams: null, stage: "unknown", form: null });
  const tartness = (fermentables: BrewingIngredient[], yeasts: BrewingIngredient[]) =>
    resolveFlavorProfile({
      brewingInputs: withRows(withRows(fixture(), "fermentables", fermentables), "yeasts", yeasts),
    }).axes.tartness;
  const usO5 = ingredient({
    name: "SafAle US-05",
    laboratory: "Fermentis",
    productId: "US-05",
    grams: null,
    stage: "unknown",
  });
  const base = [grain("Pale Malt", 4800), grain("Mystery grain", 200)];
  assert.equal(tartness(base, [usO5]).value, 0);
  assert.equal(tartness(base, [yeast("London Ale")]).value, 0);
  const cultured = tartness(base, [yeast("Philly Sour")]);
  assert.equal(cultured.value, null);
  assert.deepEqual(cultured.reasons, ["souring_or_finished_acid_requires_separate_model"]);
  // Mixed cultures are named for their style or blend rather than their bugs.
  for (const name of [
    "Belgian Lambic Blend",
    "Berliner Weisse Blend",
    "Oud Bruin Blend",
    "American Farmhouse Blend",
    "Amalgamation",
  ])
    assert.equal(tartness(base, [yeast(name)]).value, null, name);
  const unnamed = tartness(base, [
    ingredient({ name: null, productId: "", type: "Ale", grams: null, stage: "unknown" }),
  ]);
  assert.deepEqual(unnamed.reasons, ["missing_or_ambiguous_yeast"]);
  for (const name of ["Acidulated", "Acid Malt", "Sour Malt", "Sauermalz"]) {
    const acid = tartness([grain("Pale Malt", 4800), grain(name, 200)], [usO5]);
    assert.equal(acid.value, null, name);
    assert.deepEqual(acid.reasons, ["acidulated_malt_requires_review"], name);
  }
  assert.equal(tartness([grain("Pale Malt", 4900), grain("Acidulated", 100)], [usO5]).value, 0);
  assert.equal(
    tartness([grain("Pale Malt", 4000), grain("Raspberry (Fruit)", 1000, "Other")], [usO5]).value,
    null,
  );
});
void test("descriptor salience is associative across split additions and lager notes stay off chips", () => {
  const hops = (count: number) =>
    withRows(
      fixture(),
      "hops",
      Array.from({ length: count }, (_, index) =>
        ingredient({ sourcePath: `recipe.hops[${index}]`, grams: 100 / count }),
      ),
    );
  const labels = (input: BrewingInputs) =>
    resolveFlavorProfile({ brewingInputs: input }).descriptors.map(({ label, role }) => ({
      label,
      role,
    }));
  assert.ok(labels(hops(1)).length > 0);
  assert.deepEqual(labels(hops(4)), labels(hops(1)));
  const lager = ingredient({
    name: "SafLager W-34/70",
    laboratory: "Fermentis",
    productId: "W-34/70",
    type: "Lager",
    grams: null,
    stage: "unknown",
  });
  const descriptors = resolveFlavorProfile({
    brewingInputs: withRows(fixture(), "yeasts", [lager]),
  }).descriptors;
  assert.equal(
    descriptors.some((item) => item.role === "yeasts"),
    false,
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
const grainRow = (name: string, grams: number, patch: Partial<BrewingIngredient> = {}) =>
  ingredient({ name, type: "Grain", grams, stage: "unknown", form: null, ...patch });
const yeastRow = (patch: Partial<BrewingIngredient>) =>
  ingredient({ grams: null, stage: "unknown", form: null, type: "Ale", ...patch });
const us05 = yeastRow({ name: "SafAle US-05", laboratory: "Fermentis", productId: "US-05" });
const profileOf = (
  fermentables: BrewingIngredient[],
  yeasts: BrewingIngredient[] = [us05],
  miscs: BrewingIngredient[] = [],
) =>
  resolveFlavorProfile({
    brewingInputs: withRows(
      withRows(withRows(fixture(), "fermentables", fermentables), "yeasts", yeasts),
      "miscs",
      miscs,
    ),
  });
const labelled = (calculation: ReturnType<typeof resolveFlavorProfile>, role: string) =>
  calculation.descriptors.filter((item) => item.role === role).map((item) => item.label);
void test("fruit entered as a fermentable is dosed per litre, leaves the grist and keeps tartness open", () => {
  const fruit = (grams: number) =>
    grainRow("Raspberry (Fruit)", grams, {
      type: "Other",
      sourcePath: "recipe.fermentables[1]",
      percentage: 20,
    });
  const malt = grainRow("Pale Malt", 4000, { percentage: 80 });
  const strong = profileOf([malt, fruit(1000)]);
  assert.ok(labelled(strong, "fermentables").includes("raspberry"));
  assert.notEqual(strong.axes.malt.value, null);
  assert.equal(strong.axes.tartness.value, null);
  assert.deepEqual(strong.axes.tartness.reasons, [
    "souring_or_finished_acid_requires_separate_model",
  ]);
  // The fruit's own Brewfather share never reads as a grist disagreement.
  assert.equal(
    strong.diagnostics.some((value) => value.includes("mass/percentage disagreement")),
    false,
  );
  assert.equal(labelled(profileOf([malt, fruit(40)]), "fermentables").includes("raspberry"), false);
  // Without masses the grist is the malt's share of the recorded percentages.
  const byPercent = profileOf([
    grainRow("Pale Malt", 0, { grams: null, percentage: 80 }),
    { ...fruit(0), grams: null },
  ]);
  assert.notEqual(byPercent.axes.malt.value, null);
});
void test("flavoured sugars name themselves from a meaningful grist share", () => {
  const sugar = (name: string, grams: number, color: number | null = null) =>
    labelled(
      profileOf([
        grainRow("Pilsner Malt", 5000),
        grainRow(name, grams, { type: "Sugar", color, sourcePath: "recipe.fermentables[1]" }),
      ]),
      "fermentables",
    );
  assert.ok(sugar("Candi Syrup, D-180", 500, 180).includes("dark fruit"));
  assert.ok(sugar("Candi Syrup, D-90", 500, 90).includes("caramel"));
  assert.equal(sugar("Candi Sugar, Clear", 500, 1).includes("caramel"), false);
  assert.ok(sugar("Honey", 600).includes("honey"));
  assert.equal(sugar("Honey", 100).includes("honey"), false);
  assert.ok(sugar("Maple Syrup", 600).includes("maple"));
});
void test("a yeast's words come only from its maker; an unknown strain adds none", () => {
  const malt = [grainRow("Pale Malt", 5000)];
  const hefe = profileOf(malt, [
    yeastRow({
      name: "Hefeweizen IV Ale",
      laboratory: "White Labs",
      productId: "WLP380",
      type: "Wheat",
    }),
  ]);
  assert.deepEqual(labelled(hefe, "yeasts"), ["phenolic", "clove", "spicy"]);
  assert.equal(hefe.axes.tartness.value, 0);
  // An unknown strain gets no style words but keeps the unresolved non-souring tartness path.
  const unknown = profileOf(malt, [
    yeastRow({ name: "Hefeweizen IV", laboratory: "Some Lab", productId: "X1", type: "Wheat" }),
  ]);
  assert.deepEqual(labelled(unknown, "yeasts"), []);
  assert.equal(unknown.axes.tartness.value, 0);
  const untyped = profileOf(malt, [yeastRow({ name: "Belgian Saison", type: "" })]);
  assert.deepEqual(labelled(untyped, "yeasts"), []);
  assert.deepEqual(untyped.axes.tartness.reasons, ["missing_or_ambiguous_yeast"]);
});
void test("catalog gaps name unrecognised ingredients for Admin only", () => {
  const calculation = profileOf(
    [grainRow("Pale Malt", 5000), grainRow("House Special Malt", 200)],
    [
      yeastRow({ name: "Hefeweizen IV", laboratory: "Some Lab", productId: "X1", type: "Wheat" }),
      yeastRow({ name: "Hefeweizen IV", laboratory: "Some Lab", productId: "X1", type: "Wheat" }),
    ],
    [
      ingredient({ name: "Cloves", type: "Spice", grams: 2, stage: "unknown" }),
      ingredient({ name: "Mystery Spice", type: "Spice", grams: 2, stage: "unknown" }),
      ingredient({ name: null, type: "Spice", grams: 2, stage: "unknown" }),
    ],
  );
  assert.deepEqual(
    calculation.catalogGaps.map((gap) => gap.split(":")[0]),
    [
      "Fermentable · House Special Malt",
      "Yeast · Hefeweizen IV (Some Lab X1)",
      "Misc · Mystery Spice",
    ],
  );
  assert.ok(calculation.catalogGaps[1]!.includes("outside the reviewed catalog"));
  const publicGuidance = JSON.stringify(publicFlavorGuidance(calculation));
  assert.equal(publicGuidance.includes("Mystery Spice"), false);
  assert.equal(publicGuidance.includes("catalogGaps"), false);
});
void test("processing rows with their own Brewfather share do not distort the grist", () => {
  const hulls = (grams: number | null) =>
    grainRow("Rice Hulls", grams ?? 0, {
      type: "Adjunct",
      grams,
      percentage: 6,
      sourcePath: "recipe.fermentables[1]",
    });
  const withMass = profileOf([grainRow("Pale Malt", 4700, { percentage: 94 }), hulls(300)]);
  assert.equal(
    withMass.diagnostics.some((value) => value.includes("mass/percentage disagreement")),
    false,
  );
  const byPercent = profileOf([
    grainRow("Pale Malt", 0, { grams: null, percentage: 94 }),
    hulls(null),
  ]);
  assert.notEqual(byPercent.axes.malt.value, null);
});
