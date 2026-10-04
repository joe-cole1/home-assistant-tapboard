import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBrewfatherBrewingInputs } from "../src/features/beverages/brewfather/brewing.ts";
import { projectSourceRecipe, projectCustomRecipe } from "../src/features/story/recipe.ts";

function snapshot(recipe: Record<string, unknown>, batch: Record<string, unknown> = {}) {
  return { ...recipe, brewingInputs: normalizeBrewfatherBrewingInputs(recipe, batch) };
}
void test("sheet distinguishes recipe targets from reported measurements and retains repeated additions", () => {
  const source = snapshot(
    {
      type: "All Grain",
      og: 1.06,
      fg: 1.014,
      abv: 6.3,
      batchSize: 20,
      boilTime: 60,
      carbonation: 0,
      fermentables: [{ name: "Malt", amount: 4, lovibond: 3 }],
      hops: [15, 10, 1].map((time) => ({ name: "Hop", amount: 10, use: "Boil", time })),
      fermentation: { steps: [{ temp: 19, time: 7 }] },
      mash: { steps: [{ stepTemp: 65, stepTime: 0 }] },
      water: { mashPh: 5.3, total: { sulfate: 100, chloride: 50, calcium: 0 } },
      author: "PRIVATE_AUTHOR",
      _id: "PRIVATE_ID",
      notes: "PRIVATE_NOTES",
      style: { name: "PRIVATE_STYLE" },
    },
    { measuredOg: 1.05, measuredFg: 1.01, measuredBatchSize: 18, measuredAbv: 5.3 },
  );
  const sheet = projectSourceRecipe(source).sheet!;
  assert.equal(sheet.summary.abv, 6.3);
  assert.equal(sheet.summary.og, 1.06);
  assert.deepEqual(sheet.measurements, { og: 1.05, fg: 1.01, fermenterVolumeL: 18 });
  assert.deepEqual(
    sheet.ingredients.hops.map((row) => row.time),
    [15, 10, 1],
  );
  assert.equal(sheet.totals.fermentablesGrams, 4000);
  assert.equal(sheet.totals.hopsGrams, 30);
  assert.equal(sheet.summary.carbonationVolumes, 0);
  assert.equal(sheet.mash[0]?.time, 0);
  assert.equal(sheet.fermentation[0]?.timeUnit, "day");
  assert.equal(sheet.fermentation[0]?.name, "Fermentation step");
  assert.equal(sheet.water.sulfateChlorideRatio, 2);
  assert.equal(sheet.water.ions.find((row) => row.label === "Ca")?.mgPerL, 0);
  assert.ok(!JSON.stringify(sheet).includes("PRIVATE"));
});
void test("unnamed additions and unknown timing survive without invented durations or units", () => {
  const sheet = projectSourceRecipe(
    snapshot({
      hops: [{ amount: 0.01, use: "Unknown", time: 20 }],
      miscs: [{ amount: 1, unit: "item" }],
    }),
  ).sheet!;
  assert.equal(sheet.ingredients.hops[0]?.name, "Unnamed hop");
  assert.equal(sheet.ingredients.hops[0]?.grams, 0.01);
  assert.equal(sheet.ingredients.hops[0]?.time, null);
  assert.equal(sheet.ingredients.miscs[0]?.unit, "item");
  assert.equal(sheet.ingredients.miscs[0]?.grams, null);
});
void test("caps apply across groups and incomplete or truncated collections cannot claim totals", () => {
  const sheet = projectSourceRecipe(
    snapshot({
      fermentables: Array.from({ length: 49 }, () => ({ name: "Malt", amount: 1 })),
      hops: [
        { name: "Hop", amount: 1 },
        { name: "Hop", amount: 2 },
      ],
    }),
  ).sheet!;
  assert.equal(Object.values(sheet.ingredients).flat().length, 50);
  assert.equal(sheet.totals.hopsGrams, null);
  const source = snapshot({ fermentables: [{ name: "Malt", amount: 1 }, null] });
  assert.equal(projectSourceRecipe(source).sheet!.totals.fermentablesGrams, null);
  const steps = projectSourceRecipe(
    snapshot({
      mash: { steps: Array.from({ length: 25 }, () => ({ temp: 65, time: 1 })) },
      fermentation: { steps: Array.from({ length: 10 }, () => ({ temp: 19, time: 1 })) },
    }),
  ).sheet!;
  assert.equal(steps.mash.length + steps.fermentation.length, 30);
});
void test("estimated batch scalars are never measurements and malformed inputs safely fall back", () => {
  const source = snapshot({ og: 1.06 }, { estimatedOg: 1.05 });
  assert.equal(projectSourceRecipe(source).sheet!.measurements.og, null);
  assert.equal(projectSourceRecipe(source).sheet!.summary.og, 1.06);
  const malformed = { ...source, brewingInputs: { ...source.brewingInputs, schemaVersion: 9 } };
  assert.doesNotThrow(() => projectSourceRecipe(malformed));
  assert.equal(projectSourceRecipe("{").status, "unavailable");
});
void test("Custom and legacy leaves preserve compatibility while sheets use explicit units and types", () => {
  const recipe = {
    ingredients: [
      { name: "Malt", type: "fermentable", amount: 1, unit: "kg", note: "Public note" },
      { name: "Unknown", amount: 2 },
    ],
    steps: ["Do this"],
  };
  const custom = projectCustomRecipe(recipe);
  assert.equal(custom.ingredients[0]?.unit, "kg");
  assert.equal(custom.sheet!.ingredients.fermentables[0]?.grams, 1000);
  assert.equal(custom.sheet!.ingredients.other[0]?.grams, null);
  assert.equal(custom.sheet!.ingredients.fermentables[0]?.note, "Public note");
  const legacy = projectSourceRecipe(recipe);
  assert.equal(legacy.sheet!.ingredients.fermentables[0]?.note, null);
  assert.equal(legacy.sheet!.totals.fermentablesGrams, null);
});

void test("saved B064 corpus retains its actual recipe and four boil additions", () => {
  const corpus = JSON.parse(
    readFileSync(new URL("./fixtures/flavor/development-corpus.json", import.meta.url), "utf8"),
  ) as { batches: { caseId: string; input: Record<string, unknown> }[] };
  const batch = corpus.batches.find((row) => row.caseId === "B064")!.input;
  const recipe = batch.recipe as Record<string, unknown>;
  const sheet = projectSourceRecipe(snapshot(recipe, batch)).sheet!;
  assert.equal(sheet.summary.abv, 6.3);
  assert.deepEqual(
    sheet.ingredients.hops.map((row) => row.time),
    [15, 10, 1, 1],
  );
  assert.deepEqual(
    sheet.fermentation.map((row) => [row.time, row.timeUnit]),
    [
      [6, "day"],
      [1, "day"],
      [1, "day"],
      [2, "day"],
      [14, "day"],
      [31, "day"],
    ],
  );
  assert.equal(sheet.measurements.og, batch.measuredOg);
});

void test("v2-only collections report partial for caps, rejected rows and truncation", () => {
  for (const rows of [
    Array.from({ length: 51 }, () => ({ amount: 1 })),
    Array.from({ length: 101 }, () => ({ amount: 1 })),
    [{ amount: 1 }, null],
  ]) {
    const source = snapshot({ hops: rows });
    const projection = projectSourceRecipe({ brewingInputs: source.brewingInputs });
    assert.equal(projection.status, "partial");
    assert.equal(projection.sheet!.totals.hopsGrams, null);
  }
});
void test("public measurements and water ratio enforce display-safe numeric bounds", () => {
  const original = snapshot({ water: { total: { sulfate: 10000, chloride: Number.MIN_VALUE } } });
  const inputs = original.brewingInputs;
  const source = {
    brewingInputs: {
      ...inputs,
      scalars: {
        ...inputs.scalars,
        og: { ...inputs.scalars.og, value: 3, provenance: "batch_reported" },
        fg: { ...inputs.scalars.fg, value: -1, provenance: "batch_reported" },
        volume: { ...inputs.scalars.volume, value: 100001, provenance: "batch_reported" },
      },
    },
  };
  const sheet = projectSourceRecipe(source).sheet!;
  assert.deepEqual(sheet.measurements, { og: null, fg: null, fermenterVolumeL: null });
  assert.equal(sheet.water.sulfateChlorideRatio, null);
  assert.equal(
    projectCustomRecipe({ ingredients: [{ name: "Unspecified", amount: 1, unit: "constructor" }] })
      .sheet!.ingredients.other[0]?.grams,
    null,
  );
});

void test("unknown v2 ingredient metadata does not change or break the public projection", () => {
  const source = snapshot({ hops: [{ name: "Hop", amount: 2 }] });
  const expected = projectSourceRecipe(source);
  for (const unexpected of [{}, null]) {
    const enriched = {
      ...source,
      brewingInputs: {
        ...source.brewingInputs,
        ingredients: { ...source.brewingInputs.ingredients, unexpected },
      },
    };
    assert.deepEqual(projectSourceRecipe(enriched), expected);
  }
});
