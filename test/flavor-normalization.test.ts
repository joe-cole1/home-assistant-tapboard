import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  sanitizeRecipeSnapshot,
  sanitizeBatchToSourceProfile,
} from "../src/features/beverages/brewfather/sanitizer.ts";
import {
  readBrewingInputs,
  adaptLegacyBrewingInputs,
} from "../src/features/beverages/brewing-inputs.ts";
import { normalizeBrewfatherBrewingInputs } from "../src/features/beverages/brewfather/brewing.ts";
import { extractProcessFacts } from "../src/features/beverages/brewfather/process.ts";
const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/flavor/development-corpus.json", import.meta.url), "utf8"),
) as {
  batches: { caseId: string; input: Record<string, unknown> }[];
  recipes: { caseId: string; input: Record<string, unknown> }[];
};
function batch(id: string) {
  const value = corpus.batches.find((c) => c.caseId === id)!.input;
  const snapshot = sanitizeRecipeSnapshot(value.recipe, value, { format: "brewfather-export-v3" });
  assert.ok(snapshot);
  const inputs = readBrewingInputs(JSON.parse(snapshot.recipeJson));
  assert.ok(inputs);
  return inputs;
}
void test("all supplied cases pass production snapshot normalization with bounded selected data", () => {
  let maximum = 0;
  for (const value of [...corpus.recipes, ...corpus.batches]) {
    const isBatch = corpus.batches.includes(value);
    const snapshot = sanitizeRecipeSnapshot(
      isBatch ? value.input.recipe : value.input,
      isBatch ? value.input : undefined,
      { format: "brewfather-export-v3" },
    );
    assert.ok(snapshot, value.caseId);
    maximum = Math.max(maximum, Buffer.byteLength(snapshot.recipeJson));
    assert.ok(readBrewingInputs(JSON.parse(snapshot.recipeJson)));
    assert.equal(snapshot.recipeJson.includes("tasteNotes"), false);
  }
  assert.ok(maximum < 262144);
});
void test("historical producer contracts retain scalar precedence, attenuation, stage, identity and barrel facts", () => {
  const amber = batch("B064");
  assert.equal(amber.scalars.fg.sourcePath, "batch.estimatedFg");
  assert.equal(amber.ingredients.hops.items.length, 4);
  assert.deepEqual(
    amber.ingredients.hops.items.map((h) => h.boilMinutes),
    [15, 10, 1, 1],
  );
  assert.equal(
    amber.ingredients.fermentables.items.some((i) => i.name?.includes("Carapils")),
    true,
  );
  const saison = batch("B058");
  assert.equal(saison.scalars.fg.value, 0.995);
  assert.equal(saison.scalars.reportedAttenuation.value, 108.1);
  assert.ok(saison.scalars.recipeAttenuation.value! > 100);
  assert.ok(saison.scalars.apparentAttenuation.value! > 100);
  const barrel = batch("B026");
  assert.ok(
    barrel.processFacts.some(
      (f) => f.kind === "bourbon_barrel_recorded" && f.timing === "inconsistent",
    ),
  );
  assert.equal(JSON.stringify(barrel).includes("Added to bourbon"), false);
  assert.ok(batch("B053").ingredients.hops.items.some((h) => h.name === null && h.grams! > 0));
  assert.equal(batch("B053").ingredients.yeasts.items.length, 0);
  assert.ok(
    batch("B033").ingredients.yeasts.items.some(
      (y) => y.laboratory?.includes("Lallemand") && y.productId === null,
    ),
  );
  assert.equal(batch("B042").scalars.volume.sourcePath, "recipe.equipment.fermenterVolume");
});
void test("invalid preferred scalars fall through and booleans never coerce", () => {
  const raw = {
    measuredOg: true,
    estimatedOg: 1.05,
    measuredFg: "bad",
    estimatedFg: 0.995,
    measuredAbv: Infinity,
    estimatedAbv: 0,
    recipe: { og: 1.04, fg: 1.01 },
  };
  const inputs = normalizeBrewfatherBrewingInputs(raw.recipe, raw);
  assert.equal(inputs.scalars.og.value, 1.05);
  assert.equal(inputs.scalars.fg.value, 0.995);
  assert.equal(inputs.scalars.abv.value, 0);
  assert.equal(sanitizeBatchToSourceProfile(raw)?.og, 1.05);
  assert.equal(inputs.diagnostics.length, 3);
});
void test("role units normalize metric provider once and explicit custom masses equivalently", () => {
  for (const [amount, unit] of [
    [1, "kg"],
    [1000, "g"],
    [1000 / 453.59237, "lb"],
    [1000 / 28.349523125, "oz"],
  ] as const) {
    const inputs = normalizeBrewfatherBrewingInputs(
      { fermentables: [{ amount, unit }] },
      undefined,
      { format: "custom" },
    );
    assert.ok(Math.abs(inputs.ingredients.fermentables.items[0]!.grams! - 1000) < 1e-8);
  }
  const provider = normalizeBrewfatherBrewingInputs({
    fermentables: [{ amount: 1 }],
    hops: [{ amount: 1 }],
    yeasts: [{ amount: 1, unit: "pkg" }],
    miscs: [{ amount: 1, unit: "fl oz" }],
  });
  assert.equal(provider.ingredients.fermentables.items[0]!.grams, 1000);
  assert.equal(provider.ingredients.hops.items[0]!.grams, 1);
  assert.equal(provider.ingredients.yeasts.items[0]!.grams, null);
  assert.equal(provider.ingredients.miscs.items[0]!.grams, null);
});
void test("missing empty rejected truncated and legacy collections cannot be confused", () => {
  const inputs = normalizeBrewfatherBrewingInputs({
    hops: [],
    yeasts: [null],
    miscs: Array(101).fill({ name: "x" }),
  });
  assert.equal(inputs.ingredients.fermentables.present, false);
  assert.equal(inputs.ingredients.hops.complete, true);
  assert.equal(inputs.ingredients.yeasts.complete, false);
  assert.equal(inputs.ingredients.miscs.truncated, true);
  assert.equal(
    adaptLegacyBrewingInputs({ ingredients: { hops: [] } }, { beverageType: "beer" }).ingredients
      .hops.complete,
    false,
  );
  assert.equal(readBrewingInputs({ brewingInputs: { schemaVersion: 2 } }), null);
});
void test("process negatives do not create barrel facts and bounded text never persists", () => {
  for (const note of [
    "No barrel aging.",
    "Will add to bourbon barrel next batch.",
    "Maybe added to bourbon barrel.",
    "Added 3 kg per barrel.",
    "Added vanilla extract.",
    "Added bourbon directly.",
    "Added spirit-soaked oak cubes.",
  ]) {
    const facts = extractProcessFacts({ batchNotes: note }).facts;
    assert.equal(
      facts.some((f) => f.kind === "bourbon_barrel_recorded" || f.kind === "oak_barrel_recorded"),
      false,
      note,
    );
  }
  assert.equal(
    extractProcessFacts({ batchNotes: "Added to bourbon barrel.".repeat(1000) }).complete,
    false,
  );
});
void test("optional aroma uses documented percent attributes independently, malformed fields limit completeness", () => {
  const input = normalizeBrewfatherBrewingInputs({
    hops: [
      {
        name: "Citra",
        amount: 5,
        use: "Dry Hop",
        time: 3,
        aroma: { citrus: 80, fruity: 0, earthy: true, hidden: 100 },
      },
    ],
  });
  assert.deepEqual(input.ingredients.hops.items[0]?.aroma, { citrus: 80, fruity: 0 });
  assert.equal(input.ingredients.hops.items[0]?.contactDays, 3);
  const exportInput = normalizeBrewfatherBrewingInputs(
    { hops: [{ amount: 5, use: "Dry Hop", time: 3, day: 2 }] },
    undefined,
    { format: "brewfather-export-v3" },
  );
  assert.equal(exportInput.ingredients.hops.items[0]?.contactDays, null);
  assert.equal(exportInput.ingredients.hops.items[0]?.day, 2);
  assert.equal(
    normalizeBrewfatherBrewingInputs({ fermentables: [{ amount: 1, name: true }] }).ingredients
      .fermentables.complete,
    false,
  );
});

void test("persisted normalized enums and units are structural, without coercion", () => {
  const original = sanitizeRecipeSnapshot({ hops: [], fermentables: [], yeasts: [], miscs: [] })!;
  for (const mutate of [
    (v: Record<string, unknown>) => {
      v.format = ["custom"];
    },
    (v: Record<string, unknown>) => {
      (v.scalars as Record<string, { unit: unknown }>).og!.unit = "l";
    },
    (v: Record<string, unknown>) => {
      (v.water as Record<string, unknown>).treatedIons = [];
    },
  ]) {
    const envelope = JSON.parse(original.recipeJson) as { brewingInputs: Record<string, unknown> };
    mutate(envelope.brewingInputs);
    assert.equal(readBrewingInputs(envelope), null);
  }
  assert.equal(
    extractProcessFacts({ batchNotes: "Kettle soured before fermentation." }).complete,
    false,
  );
});
