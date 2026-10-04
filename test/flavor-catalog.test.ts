import assert from "node:assert/strict";
import test from "node:test";
import { resolveIngredient, CATALOG_VERSION } from "../src/features/story/flavor/catalog.ts";
import type { BrewingIngredient } from "../src/features/beverages/brewing-types.ts";
const ingredient = (fields: Partial<BrewingIngredient>): BrewingIngredient => ({
  sourcePath: "recipe.ingredients[0]",
  name: null,
  supplier: null,
  laboratory: null,
  productId: null,
  type: null,
  grainCategory: null,
  use: null,
  usage: null,
  form: null,
  amount: null,
  unit: null,
  grams: null,
  percentage: null,
  color: null,
  lovibond: null,
  alpha: null,
  day: null,
  time: null,
  timeUnit: null,
  stage: "unknown",
  boilMinutes: null,
  contactDays: null,
  additionDay: null,
  temperatureC: null,
  aroma: null,
  totalOil: null,
  limitations: [],
  ...fields,
});
void test("manufacturer product guards override misleading grain categories", () => {
  const original = resolveIngredient(
    "fermentables",
    ingredient({ name: "Carapils", supplier: "Briess", grainCategory: "Crystal/Caramel" }),
  );
  assert.equal(original.family, "carapils");
  assert.deepEqual(original.descriptors, []);
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Carapils Copper", supplier: "Briess" }))
      .family,
    "biscuit",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({
        name: "Carapils/Carafoam",
        supplier: "Weyermann",
        grainCategory: "Crystal/Caramel",
      }),
    ).family,
    "crystal_light",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Carapils", grainCategory: "Base (Pilsner)" }),
    ).level,
    "unresolved",
  );
});
void test("Munich conflicts remain diagnostic and Special Roast remains biscuit", () => {
  const munich = resolveIngredient(
    "fermentables",
    ingredient({ name: "Munich", supplier: "Briess", color: 145.5, lovibond: 108 }),
  );
  assert.equal(munich.family, "munich");
  assert.equal(munich.roastClass, "none");
  assert.ok(munich.diagnostics.some((value) => value.includes("conflict")));
  const special = resolveIngredient(
    "fermentables",
    ingredient({ name: "Special Roast", supplier: "Briess", grainCategory: "Roasted" }),
  );
  assert.equal(special.family, "biscuit");
  assert.equal(special.roastClass, "none");
});
void test("specific blank-code names resolve only within matching laboratory", () => {
  assert.equal(
    resolveIngredient(
      "yeasts",
      ingredient({ name: "Pomona", laboratory: "Lallemand (LalBrew)", productId: "" }),
    ).id,
    "lallemand-pomona",
  );
  assert.equal(
    resolveIngredient("yeasts", ingredient({ name: "Pomona", laboratory: "Other" })).level,
    "unresolved",
  );
  assert.equal(resolveIngredient("yeasts", ingredient({ name: "Pomona" })).level, "unresolved");
  assert.equal(
    resolveIngredient("yeasts", ingredient({ name: "Lallemand Verdant IPA Yeast" })).id,
    "lallemand-verdant",
  );
});
void test("lab and code win with diagnostic; unknown codes and generic names do not resolve", () => {
  const yeast = resolveIngredient(
    "yeasts",
    ingredient({ name: "Wrong", laboratory: "Wyeast Labs", productId: "3068" }),
  );
  assert.deepEqual(yeast.descriptors, ["banana", "clove"]);
  assert.ok(yeast.diagnostics.some((value) => value.includes("conflict")));
  assert.equal(
    resolveIngredient(
      "yeasts",
      ingredient({ name: "Weihenstephan Weizen", laboratory: "Wyeast", productId: "9999" }),
    ).level,
    "unresolved",
  );
  assert.equal(
    resolveIngredient("yeasts", ingredient({ name: "German Lager", type: "Lager" })).souring,
    null,
  );
  assert.equal(
    resolveIngredient(
      "yeasts",
      ingredient({ name: "Safale Belgian-Saison", laboratory: "Fermentis", productId: "BE-134" }),
    ).souring,
    false,
  );
});
void test("exact hop identity never fabricates missing varieties or blend constituents", () => {
  assert.equal(
    resolveIngredient("hops", ingredient({ name: "Mosaic", type: "Whole" })).id,
    "hop-mosaic-brand",
  );
  for (const name of [null, "Hallertau", "Arctic Blend", "Citra clone", "Citra extract"])
    assert.equal(resolveIngredient("hops", ingredient({ name })).level, "unresolved");
});
void test("process aids, botanicals and acid context stay distinct", () => {
  assert.deepEqual(resolveIngredient("miscs", ingredient({ name: "Brewzyme-D" })).functions, [
    "aldc",
  ]);
  assert.deepEqual(resolveIngredient("miscs", ingredient({ name: "Phantasm Powder" })).functions, [
    "thiol_precursor",
  ]);
  assert.deepEqual(
    resolveIngredient("miscs", ingredient({ name: "Cloves", type: "Other" })).functions,
    ["botanical"],
  );
  const yeast = resolveIngredient(
    "yeasts",
    ingredient({ name: "Weihenstephan Weizen", laboratory: "Wyeast", productId: "3068" }),
  );
  assert.deepEqual(yeast.functions, []);
  for (const use of ["Mash", "Sparge", "Secondary"])
    assert.deepEqual(
      resolveIngredient("miscs", ingredient({ name: "Lactic Acid", use })).functions,
      ["mash_acid"],
    );
  assert.deepEqual(resolveIngredient("miscs", ingredient({ name: "Ascorbic Acid" })).functions, [
    "antioxidant",
  ]);
  assert.equal(
    resolveIngredient("miscs", ingredient({ name: "Amylase Enzyme" })).level,
    "unresolved",
  );
});
void test("category fallback is restricted to explicit base grain families, never darkness", () => {
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Unlisted", type: "Grain", grainCategory: "Base (Pilsner)" }),
    ).family,
    "pilsner",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Dark mystery", type: "Grain", color: 600, grainCategory: "Roasted" }),
    ).level,
    "unresolved",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Dark Candi Syrup", type: "Sugar", color: 600 }),
    ).roastClass,
    "none",
  );
  assert.ok(CATALOG_VERSION);
});

void test("reviewed yeast priorities and dehusked/product families retain guards", () => {
  const identities: readonly [string, string, string][] = [
    ["Wit", "Omega", "OYL-030"],
    ["Juice", "Imperial Yeast", "A38"],
    ["SafAle German Ale", "Fermentis", "K-97"],
    ["Belgian Saison I Ale", "White Labs", "WLP565"],
    ["Nottingham Yeast", "Lallemand (LalBrew)", ""],
  ];
  for (const [name, laboratory, productId] of identities) {
    assert.equal(
      resolveIngredient("yeasts", ingredient({ name, laboratory, productId })).level,
      "product",
    );
  }
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Carafa Special I", supplier: "Weyermann" }),
    ).roastClass,
    "dehusked",
  );
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Carafa III", supplier: "Weyermann" }))
      .roastClass,
    "black",
  );
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Caramel Malt 120L", supplier: "Briess" }))
      .id,
    "briess-caramel-120",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Candi Syrup, D-180", type: "Sugar", color: 180 }),
    ).roastClass,
    "none",
  );
});

void test("verified priority products retain manufacturer guards and family-only limits", () => {
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "2-Row Malt", supplier: "Canada Malting Co" }),
    ).family,
    "pale",
  );
  assert.deepEqual(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "2-Row Malt", supplier: "Canada Malting Co" }),
    ).descriptors,
    [],
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Pale Malt, Golden Promise", supplier: "Thomas Fawcett" }),
    ).family,
    "pale",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Golden Promise", supplier: "Thomas Fawcett" }),
    ).level,
    "unresolved",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Crystal 40L (Murphy & Rude)", supplier: "Murphy & Rude Malting Co." }),
    ).family,
    "crystal_light",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Crystal 40L (Murphy & Rude)", supplier: "Other" }),
    ).level,
    "unresolved",
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Honey Malt", supplier: "Cargill (Gambrinus)" }),
    ).family,
    "aromatic",
  );
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Honey Malt", supplier: "Cargill" }))
      .level,
    "unresolved",
  );
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Corn Sugar (Dextrose)" })).family,
    "sugar",
  );
  assert.deepEqual(resolveIngredient("miscs", ingredient({ name: "Lactose" })).functions, [
    "lactose",
  ]);
});
