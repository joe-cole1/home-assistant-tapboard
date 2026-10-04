import assert from "node:assert/strict";
import test from "node:test";
import {
  batchFixture,
  corpus,
  evaluateFixture,
  priorityCases,
  corpusReport,
} from "./fixtures/flavor/corpus.ts";
import { resolveIngredient } from "../src/features/story/flavor/catalog.ts";
const result = (id: string) => evaluateFixture(batchFixture(id));
void test("all107 production fixture paths are bounded, immutable, deterministic and every null/zero has a reason", () => {
  assert.equal(corpus.batches.length, 61);
  assert.equal(corpus.recipes.length, 46);
  for (const item of [...corpus.batches, ...corpus.recipes]) {
    const before = structuredClone(item.input),
      kind = corpus.batches.includes(item) ? "batch" : "recipe",
      a = evaluateFixture(item.input, kind),
      b = evaluateFixture(item.input, kind);
    assert.deepEqual(item.input, before, item.caseId);
    assert.deepEqual(a, b, item.caseId);
    assert.ok(a.snapshotBytes <= 262144);
    assert.equal(a.calculation.descriptors.length <= 6, true);
    for (const axis of Object.values(a.calculation.axes)) {
      assert.ok(
        axis.value === null || (Number.isFinite(axis.value) && axis.value >= 0 && axis.value <= 5),
        item.caseId,
      );
      if (axis.value === null || axis.value === 0) assert.ok(axis.reasons.length > 0, item.caseId);
    }
  }
  const report = corpusReport();
  assert.equal(report.cases.length, 107);
  assert.equal(report.priorityNullAndZeroReasons.length, 13);
  assert.ok(report.qualification.includes("no sensory ground-truth"));
});
void test("B064 retains batch source precedence, actual four hop additions, Carapils identity and no water acidity proxy", () => {
  const { inputs: i, calculation: c } = result("B064");
  assert.equal(i.scalars.abv.value, 5.3);
  assert.equal(i.scalars.ibu.value, 24);
  assert.equal(i.scalars.fg.value, 1.01);
  assert.equal(i.scalars.fg.provenance, "batch_estimate");
  assert.deepEqual(
    i.ingredients.hops.items.map((h) => h.boilMinutes),
    [15, 10, 1, 1],
  );
  const carapils = i.ingredients.fermentables.items.find((x) => /carapils/i.test(x.name ?? ""))!;
  assert.equal(resolveIngredient("fermentables", carapils).family, "carapils");
  assert.equal(resolveIngredient("fermentables", carapils).descriptors.includes("caramel"), false);
  assert.ok(c.axes.tartness.value === null || c.axes.tartness.value === 0);
});
void test("B026 recorded barrel context survives rename but cannot alter base beer numbers or invent duration", () => {
  const raw = batchFixture("B026"),
    a = evaluateFixture(raw);
  assert.ok(
    a.inputs.processFacts.some(
      (x) => x.kind === "bourbon_barrel_recorded" && x.timing === "inconsistent",
    ),
  );
  assert.equal(JSON.stringify(a.inputs.processFacts).includes("duration"), false);
  const without = structuredClone(raw);
  delete without.notes;
  delete without.batchNotes;
  assert.deepEqual(a.calculation.profile, evaluateFixture(without).calculation.profile);
  (raw.recipe as Record<string, unknown>).name = "Arbitrary title";
  assert.deepEqual(evaluateFixture(raw).inputs.processFacts, a.inputs.processFacts);
});
void test("B058 very dry saison retains independent attenuation and known yeast without zero body", () => {
  const { inputs: i, calculation: c } = result("B058");
  assert.equal(i.scalars.fg.value, 0.995);
  assert.equal(i.scalars.reportedAttenuation.value, 108.1);
  assert.equal(i.scalars.recipeAttenuation.value, 106.4);
  assert.notEqual(
    i.scalars.apparentAttenuation.sourcePath,
    i.scalars.reportedAttenuation.sourcePath,
  );
  assert.ok(c.axes.sweetness.value! < 1);
  assert.ok(c.axes.body.value! > 0);
  assert.ok(
    i.ingredients.yeasts.items.some(
      (y) => y.productId === "BE-134" && resolveIngredient("yeasts", y).level === "product",
    ),
  );
});
void test("B055 anomalous Munich color cannot become roast and ALDC cannot determine FG", () => {
  const { inputs: i, calculation: c } = result("B055");
  const munich = i.ingredients.fermentables.items.find((x) => x.color === 145.5)!;
  assert.equal(munich.lovibond, 108);
  assert.equal(resolveIngredient("fermentables", munich).family, "munich");
  assert.ok(c.diagnostics.some((d) => /identity\/color conflict/i.test(d)));
  assert.ok(c.axes.roast.value === 0 || c.axes.roast.value === null);
  const aid = i.ingredients.miscs.items.find((x) => x.name === "Brewzyme-D")!;
  assert.ok(resolveIngredient("miscs", aid).functions.includes("aldc"));
  const raw = batchFixture("B055"),
    recipe = raw.recipe as Record<string, unknown>;
  recipe.miscs = (recipe.miscs as Record<string, unknown>[]).filter((x) => x.name !== "Brewzyme-D");
  assert.equal(evaluateFixture(raw).calculation.axes.sweetness.value, c.axes.sweetness.value);
});
for (const id of ["B033", "B043"])
  void test(`${id} retains real repeated stages, opaque day and recorded volume`, () => {
    const raw = batchFixture(id),
      { inputs: i, calculation: c } = evaluateFixture(raw),
      rows = i.ingredients.hops.items;
    assert.equal(rows.length, ((raw.recipe as Record<string, unknown>).hops as unknown[]).length);
    assert.ok(rows.some((x) => x.stage === "dry_hop"));
    assert.ok(
      rows
        .filter((x) => x.stage === "dry_hop")
        .every((x) => x.timeUnit === "days" && x.contactDays === x.time && x.additionDay === null),
    );
    if (id === "B033")
      assert.ok(
        rows.some((x) => x.day === 2 && x.time === 7) &&
          rows.some((x) => x.day === 5 && x.time === 4),
      );
    else {
      assert.equal(i.scalars.volume.value, 26.497883);
      assert.ok(rows.some((x) => x.stage === "mash") && rows.some((x) => x.stage === "whirlpool"));
    }
    for (const h of (raw.recipe as Record<string, unknown>).hops as Record<string, unknown>[]) {
      h.day = 99;
      if (h.use === "Dry Hop") h.time = 99;
    }
    assert.equal(evaluateFixture(raw).calculation.axes.hops.value, c.axes.hops.value);
  });
void test("B049 preserves Cosmic Punch and Phantasm context without fabricated thiol mass or measured FG", () => {
  const { inputs: i } = result("B049");
  const yeast = i.ingredients.yeasts.items.find((x) => x.productId === "OYL-402")!;
  assert.equal(resolveIngredient("yeasts", yeast).level, "product");
  const phantasm = i.ingredients.miscs.items.find((x) => x.name === "Phantasm Powder")!;
  assert.ok(resolveIngredient("miscs", phantasm).functions.includes("thiol_precursor"));
  assert.equal(i.scalars.fg.provenance, "batch_estimate");
  const raw = batchFixture("B049"),
    recipe = raw.recipe as Record<string, unknown>,
    a = evaluateFixture(raw);
  recipe.miscs = (recipe.miscs as Record<string, unknown>[]).filter(
    (x) => x.name !== "Phantasm Powder",
  );
  assert.equal(evaluateFixture(raw).calculation.axes.hops.value, a.calculation.axes.hops.value);
});
void test("B053 retains unnamed dry-hop dose but absent yeast cannot prove clean or nonsour fermentation", () => {
  const raw = batchFixture("B053"),
    a = evaluateFixture(raw),
    unnamed = a.inputs.ingredients.hops.items.find((x) => x.name === null)!;
  assert.equal(unnamed.grams, 28.349523);
  assert.equal(unnamed.stage, "dry_hop");
  assert.equal(resolveIngredient("hops", unnamed).level, "unresolved");
  assert.equal(a.calculation.axes.tartness.value, null);
  const recipe = raw.recipe as Record<string, unknown>;
  recipe.hops = (recipe.hops as Record<string, unknown>[]).filter((x) => x.name);
  assert.ok(evaluateFixture(raw).calculation.axes.hops.value! < a.calculation.axes.hops.value!);
});
void test("B042/B052/B060 retain botanicals and yeast context independently of style", () => {
  const wit = result("B042");
  assert.equal(wit.inputs.scalars.volume.value, 39.746824);
  assert.equal(wit.inputs.scalars.volume.provenance, "recipe_target");
  assert.ok(wit.calculation.descriptors.some((x) => x.role === "miscs" && x.label === "coriander"));
  const wheat = result("B052");
  assert.ok(wheat.inputs.ingredients.yeasts.items.some((x) => x.productId === "3068"));
  assert.ok(wheat.calculation.descriptors.some((x) => x.role === "yeasts" && x.label === "clove"));
  const cloves = result("B060");
  const addition = cloves.inputs.ingredients.miscs.items.find((x) => x.name === "Cloves")!;
  assert.equal(addition.amount, 0.25);
  assert.equal(addition.unit, "oz");
  assert.equal(addition.time, 10);
  assert.ok(cloves.calculation.descriptors.some((x) => x.role === "miscs" && x.label === "clove"));
});
void test("B063 actual volume and blank-code Pomona, B007 low IBU and unresolved blend remain independent", () => {
  const hazy = result("B063");
  assert.equal(hazy.inputs.scalars.volume.value, 18.927059);
  const pomona = hazy.inputs.ingredients.yeasts.items.find((x) => x.name === "Pomona")!;
  assert.equal(pomona.productId, null);
  assert.equal(resolveIngredient("yeasts", pomona).level, "product");
  assert.equal(hazy.calculation.axes.tartness.value, 0);
  const low = result("B007");
  assert.equal(low.inputs.scalars.ibu.value, 5);
  assert.ok(low.calculation.axes.hops.value! > low.calculation.axes.bitterness.value!);
  assert.ok(
    low.inputs.ingredients.hops.items
      .filter((x) => /arctic/i.test(x.name ?? ""))
      .every((x) => resolveIngredient("hops", x).descriptors.length === 0),
  );
});
void test("historical contract inventory covers exactly the supplied13 priority fixtures", () => {
  assert.equal(priorityCases.length, 13);
  assert.deepEqual(
    new Set(priorityCases.map((x) => x.caseId)),
    new Set([
      "B064",
      "B026",
      "B058",
      "B055",
      "B033",
      "B043",
      "B049",
      "B053",
      "B042",
      "B052",
      "B060",
      "B063",
      "B007",
    ]),
  );
});
void test("B016 specific laboratory/product code resolves independently of broad beer style", () => {
  const raw = batchFixture("B016"),
    a = evaluateFixture(raw),
    yeast = a.inputs.ingredients.yeasts.items[0]!;
  assert.equal(yeast.productId, "S-04");
  assert.equal(resolveIngredient("yeasts", yeast).level, "product");
  (raw.recipe as Record<string, unknown>).style = { name: "Unrelated unnamed style" };
  const changed = evaluateFixture(raw).inputs.ingredients.yeasts.items[0]!;
  assert.equal(resolveIngredient("yeasts", changed).id, resolveIngredient("yeasts", yeast).id);
});
