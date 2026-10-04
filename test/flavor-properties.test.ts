import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { batchFixture, evaluateFixture } from "./fixtures/flavor/corpus.ts";
import { resolveIngredient } from "../src/features/story/flavor/catalog.ts";
import { flavorInputFingerprint } from "../src/features/story/flavor/engine.ts";
import { resolveFlavorProfile } from "../src/features/story/profile.ts";
import { readBrewingInputs } from "../src/features/beverages/brewing-inputs.ts";
import { sanitizeRecipeSnapshot } from "../src/features/beverages/brewfather/sanitizer.ts";
import { extractProcessFacts } from "../src/features/beverages/brewfather/process.ts";
const base = () => ({
  measuredOg: 1.05,
  measuredFg: 1.01,
  measuredAbv: 5,
  estimatedIbu: 25,
  measuredBatchSize: 20,
  recipe: {
    name: "Fixture",
    type: "All Grain",
    og: 1.05,
    fg: 1.01,
    batchSize: 20,
    fermentables: [{ name: "Pilsner", grainCategory: "Base", amount: 4, unit: "kg" }],
    hops: [{ name: "Citra", type: "Pellet", use: "Dry Hop", amount: 100, unit: "g", time: 5 }],
    yeasts: [
      {
        name: "Safale American",
        laboratory: "Fermentis",
        productId: "US-05",
        amount: 1,
        unit: "pkg",
      },
    ],
    miscs: [] as Record<string, unknown>[],
  },
});
const values = (raw: unknown) =>
  Object.fromEntries(
    Object.entries(evaluateFixture(raw).calculation.axes).map(([key, value]) => [key, value.value]),
  );
void test("P1/P2 metric provider preference and equivalent supported mass units preserve concentrations under uniform scaling", () => {
  const a = base(),
    expected = values(a);
  const g = structuredClone(a);
  g.recipe.fermentables[0]!.amount = 4000;
  g.recipe.fermentables[0]!.unit = "g";
  assert.deepEqual(values(g), expected);
  const scaled = structuredClone(a);
  scaled.measuredBatchSize *= 2;
  scaled.recipe.batchSize *= 2;
  scaled.recipe.fermentables.forEach((x) => (x.amount *= 2));
  scaled.recipe.hops.forEach((x) => (x.amount *= 2));
  assert.deepEqual(values(scaled), expected);
  const preference = { ...a, unitSystem: "imperial", defaults: { weight: "lb", volume: "gal" } };
  assert.deepEqual(values(preference), expected);
});
void test("P3 inventory mirrors cannot change real recipe additions; repeated rows are preserved", () => {
  const raw = batchFixture("B033"),
    a = evaluateFixture(raw);
  raw.batchHops = [{ name: "Wrong", amount: 99999, time: 60 }];
  (raw.recipe as Record<string, unknown>).data = { hops: raw.batchHops };
  assert.deepEqual(
    values(raw),
    Object.fromEntries(Object.entries(a.calculation.axes).map(([k, v]) => [k, v.value])),
  );
  const recipe = raw.recipe as Record<string, unknown>;
  recipe.hops = [...(recipe.hops as unknown[]), (recipe.hops as unknown[])[0]];
  assert.equal(
    evaluateFixture(raw).inputs.ingredients.hops.acceptedCount,
    a.inputs.ingredients.hops.acceptedCount + 1,
  );
});
void test("P4/P5 late stage and saturating dry dose respond independently of IBU alpha or day", () => {
  const raw = base();
  raw.recipe.hops[0]!.use = "Boil";
  raw.recipe.hops[0]!.time = 60;
  const early = evaluateFixture(raw).calculation;
  raw.recipe.hops[0]!.time = 0;
  const late = evaluateFixture(raw).calculation;
  assert.ok(late.axes.hops.value! > early.axes.hops.value!);
  assert.equal(late.axes.bitterness.value, early.axes.bitterness.value);
  raw.recipe.hops[0]!.use = "Dry Hop";
  const dose = evaluateFixture(raw).calculation.axes.hops.value!;
  raw.recipe.hops[0]!.amount *= 2;
  const doubled = evaluateFixture(raw).calculation.axes.hops.value!;
  assert.ok(doubled > dose && doubled < dose * 2);
  const initial = evaluateFixture(raw).calculation.axes.hops.value;
  Object.assign(raw.recipe.hops[0]!, { alpha: 99, day: 99, time: 99 });
  raw.estimatedIbu = 100;
  assert.equal(evaluateFixture(raw).calculation.axes.hops.value, initial);
});
void test("P6 unnamed hop dose survives descriptor loss and concentrated unknown product cannot impersonate pellets", () => {
  const raw = base(),
    named = evaluateFixture(raw);
  Object.assign(raw.recipe.hops[0]!, { name: null });
  const unnamed = evaluateFixture(raw);
  assert.equal(unnamed.calculation.axes.hops.value, named.calculation.axes.hops.value);
  assert.ok(
    unnamed.calculation.descriptors.filter((x) => x.role === "hops").length <
      named.calculation.descriptors.filter((x) => x.role === "hops").length,
  );
  Object.assign(raw.recipe.hops[0]!, { name: "Unknown concentrate", type: "Extract" });
  assert.equal(evaluateFixture(raw).calculation.axes.hops.value, null);
});
void test("P7 unknown/truncated arrays cannot prove absence; titles cannot change recipe numeric guidance", () => {
  const raw = base(),
    a = evaluateFixture(raw);
  assert.equal(a.calculation.axes.roast.value, 0);
  raw.recipe.fermentables = Array.from({ length: 101 }, () => ({ ...raw.recipe.fermentables[0]! }));
  assert.equal(evaluateFixture(raw).calculation.axes.roast.value, null);
  const renamed = base();
  renamed.recipe.name = "Bourbon black sour banana imperial cider";
  assert.deepEqual(values(renamed), values(base()));
});
void test("P8/P9 distinct invalid candidates fall through; zero FG below1 and percentabove100 retain explicit semantics", () => {
  for (const invalid of [null, undefined, "bad", true, false, NaN, Infinity]) {
    const raw = base();
    Object.assign(raw, { measuredFg: invalid, estimatedFg: 0.995 });
    const input = evaluateFixture(raw).inputs;
    assert.equal(input.scalars.fg.value, 0.995);
    assert.equal(input.scalars.fg.sourcePath, "batch.estimatedFg");
  }
  const raw = base();
  raw.estimatedIbu = 0;
  Object.assign(raw, { measuredFg: 0.995, measuredAttenuation: 108.1 });
  Object.assign(raw.recipe, { attenuation: 1.064 });
  const result = evaluateFixture(raw);
  assert.equal(result.calculation.axes.bitterness.value, 0);
  assert.equal(result.inputs.scalars.recipeAttenuation.value, 106.4);
  assert.ok(result.calculation.axes.body.value! > 0);
  assert.ok(result.calculation.axes.sweetness.value! < 1);
});
void test("P10 dark context sugar does not create roast; fermentable sugar dilutes grain contribution", () => {
  const raw = base(),
    a = evaluateFixture(raw);
  Object.assign(raw, { estimatedColor: 100 });
  Object.assign(raw.recipe.fermentables[0]!, { color: 300 });
  assert.equal(evaluateFixture(raw).calculation.axes.roast.value, a.calculation.axes.roast.value);
  raw.recipe.fermentables.push({ name: "Dextrose", grainCategory: "Sugar", amount: 4, unit: "kg" });
  const sugar = evaluateFixture(raw);
  assert.ok(sugar.calculation.axes.malt.value! < a.calculation.axes.malt.value!);
  assert.equal(sugar.calculation.axes.roast.value, 0);
});
void test("P11 water/mash pH bottling yield pressure and yeast specification cannot impersonate finished metrics", () => {
  const raw = base(),
    a = values(raw);
  Object.assign(raw, { measuredMashPh: 3, measuredBottlingSize: 1 });
  Object.assign(raw.recipe, {
    water: { source: { ph: 3 }, total: { ph: 3, chloride: 0 }, mashPh: 3 },
    carbonationForce: 100,
    carbonation: 2.4,
  });
  Object.assign(raw.recipe.yeasts[0]!, { attenuation: 40 });
  assert.deepEqual(values(raw), a);
});
void test("P12/P13 fingerprints include normalized inputs and explicit manual values; clock alone changes nothing", () => {
  const inputs = evaluateFixture(base()).inputs,
    before = structuredClone(inputs),
    a = resolveFlavorProfile({ brewingInputs: inputs }),
    zero = resolveFlavorProfile({ brewingInputs: inputs, manual: { hops: 0 } });
  assert.notEqual(a.fingerprint, zero.fingerprint);
  assert.equal(zero.axes.hops.value, 0);
  assert.equal(zero.axes.hops.source, "manual");
  assert.equal(zero.axes.body.value, a.axes.body.value);
  const old = Date.now;
  try {
    Date.now = () => 9e12;
    assert.deepEqual(resolveFlavorProfile({ brewingInputs: inputs }), a);
  } finally {
    Date.now = old;
  }
  assert.deepEqual(inputs, before);
  assert.ok(a.modelVersion && a.catalogVersion);
});
void test("P16 malformed normalized envelopes, oversized arrays and untrusted note fields remain bounded", () => {
  const raw = base();
  Object.assign(raw.recipe, {
    description: "<script>attack()</script>".repeat(10000),
    hops: Array(1000).fill(raw.recipe.hops[0]),
  });
  const snapshot = sanitizeRecipeSnapshot(raw.recipe, raw, { format: "brewfather-export-v3" });
  assert.ok(snapshot);
  assert.ok(Buffer.byteLength(snapshot.recipeJson) <= 262144);
  const input = readBrewingInputs(JSON.parse(snapshot.recipeJson));
  assert.ok(input?.ingredients.hops.truncated);
  const malformed = JSON.parse(snapshot.recipeJson) as {
    brewingInputs: { ingredients: { hops: { items: unknown } } };
  };
  malformed.brewingInputs.ingredients.hops.items = "malicious";
  assert.equal(readBrewingInputs(malformed), null);
  const text = base();
  Object.assign(text, { tasteNotes: "Added to bourbon barrel.", tasteRating: 5 });
  Object.assign(text.recipe, { notes: "Added to bourbon barrel." });
  assert.deepEqual(evaluateFixture(text).inputs.processFacts, []);
});
const textCases = JSON.parse(
  readFileSync(new URL("./fixtures/flavor/synthetic-contract-cases.json", import.meta.url), "utf8"),
) as { barrel_process_cases: { text: string; field?: string; expected: string }[] };
for (const entry of textCases.barrel_process_cases)
  void test(`completed process contract: ${entry.expected}: ${entry.text}`, () => {
    const facts = extractProcessFacts(entry.field ? {} : { batchNotes: entry.text }).facts;
    const kinds = facts.map((x) => x.kind);
    if (entry.expected === "bourbon_barrel_recorded")
      assert.ok(kinds.includes("bourbon_barrel_recorded"));
    else if (entry.expected === "oak_barrel_recorded_not_bourbon") {
      assert.ok(kinds.includes("oak_barrel_recorded"));
      assert.equal(kinds.includes("bourbon_barrel_recorded"), false);
    } else if (entry.expected === "wood_and_spirit_contact_not_full_barrel_no_spirit_dose") {
      assert.ok(kinds.includes("oak_contact_recorded"));
      assert.equal(kinds.includes("bourbon_barrel_recorded"), false);
      assert.equal(kinds.includes("spirit_addition_recorded"), false);
    } else if (entry.expected === "spirit_addition_not_barrel_aging_no_abv_without_proof") {
      assert.ok(kinds.includes("spirit_addition_recorded"));
      assert.equal(kinds.includes("bourbon_barrel_recorded"), false);
    } else if (entry.expected === "vanilla_addition_not_oak_or_bourbon")
      assert.deepEqual(kinds, ["vanilla_addition_recorded"]);
    else assert.deepEqual(facts, []);
    assert.equal(JSON.stringify(facts).includes("dose"), false);
  });

void test("P12 model or catalog version changes invalidate derived fingerprint without changing authoritative/manual inputs", () => {
  const inputs = evaluateFixture(base()).inputs,
    manual = [{ hops: 0 }, undefined, undefined, undefined],
    before = structuredClone(inputs),
    a = resolveFlavorProfile({ brewingInputs: inputs, manual: { hops: 0 } }),
    versions = { modelVersion: a.modelVersion, catalogVersion: a.catalogVersion };
  const original = flavorInputFingerprint(inputs, manual, versions);
  assert.equal(original, a.fingerprint);
  assert.notEqual(
    flavorInputFingerprint(inputs, manual, {
      ...versions,
      modelVersion: versions.modelVersion + "-next",
    }),
    original,
  );
  assert.notEqual(
    flavorInputFingerprint(inputs, manual, {
      ...versions,
      catalogVersion: versions.catalogVersion + "-next",
    }),
    original,
  );
  assert.deepEqual(inputs, before);
  assert.equal(manual[0]?.hops, 0);
});
void test("nonbeer automatic formulas stay unavailable while explicit manual values remain usable", () => {
  const raw = base();
  raw.recipe.type = "Cider";
  const inputs = evaluateFixture(raw).inputs,
    a = resolveFlavorProfile({ brewingInputs: inputs, manual: { body: 0 } });
  assert.equal(a.axes.body.source, "manual");
  assert.equal(a.axes.body.value, 0);
  assert.ok(
    Object.entries(a.axes)
      .filter(([key]) => key !== "body")
      .every(([, value]) => value.value === null),
  );
});
void test("lactose can provide a limited sweetness floor without affecting hop character or creating roast", () => {
  const raw = base();
  raw.measuredFg = 0.995;
  raw.recipe.miscs = [{ name: "Lactose", amount: 800, unit: "g", use: "Boil" }];
  const withLactose = evaluateFixture(raw);
  raw.recipe.miscs = [];
  const without = evaluateFixture(raw);
  assert.ok(
    withLactose.calculation.axes.sweetness.value! > without.calculation.axes.sweetness.value!,
  );
  assert.equal(withLactose.calculation.axes.hops.value, without.calculation.axes.hops.value);
  assert.equal(withLactose.calculation.axes.roast.value, without.calculation.axes.roast.value);
});
void test("P10 original Carapils and Carapils Copper do not share neutral flavor identity", () => {
  const original = evaluateFixture(batchFixture("B064")).inputs.ingredients.fermentables.items.find(
      (x) => /carapils/i.test(x.name ?? ""),
    )!,
    copper = evaluateFixture(batchFixture("B060")).inputs.ingredients.fermentables.items.find((x) =>
      /carapils/i.test(x.name ?? ""),
    )!;
  assert.notEqual(original.name, copper.name);
  const a = resolveIngredient("fermentables", original),
    b = resolveIngredient("fermentables", copper);
  assert.equal(a.family, "carapils");
  assert.notEqual(b.family, "carapils");
  assert.notEqual(a.id, b.id);
});

void test("invalid apparent attenuation cannot mask a valid reported finish fallback", () => {
  const raw = base();
  raw.measuredFg = 1.3;
  Object.assign(raw, { measuredAttenuation: 75 });
  const { inputs, calculation } = evaluateFixture(raw);
  assert.equal(inputs.scalars.fg.value, 1.3);
  assert.ok(inputs.scalars.apparentAttenuation.value! < 0);
  for (const axis of ["sweetness", "body"] as const) {
    assert.ok(calculation.axes[axis].value !== null);
    assert.equal(calculation.axes[axis].support, "limited");
    assert.ok(calculation.axes[axis].evidenceReferences.includes("batch.measuredAttenuation"));
    assert.ok(!calculation.axes[axis].evidenceReferences.includes("batch.measuredFg"));
  }
});
void test("process clause truncation cannot support nonsour absence", () => {
  const raw = base();
  Object.assign(raw, {
    batchNotes: "Completed routine step. ".repeat(40) + "Kettle soured before fermentation.",
  });
  const { inputs, calculation } = evaluateFixture(raw);
  assert.equal(inputs.processComplete, false);
  assert.equal(calculation.axes.tartness.value, null);
});
