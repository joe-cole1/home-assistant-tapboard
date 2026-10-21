import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolveIngredient, CATALOG_VERSION } from "../src/features/story/flavor/catalog.ts";
import {
  BREWFATHER_COLOUR_SERIES,
  BREWFATHER_NAMES,
  INGREDIENT_CLASSES,
  INGREDIENT_FACTS,
  REVIEWED_FACTS,
} from "../src/features/story/flavor/catalog-data.ts";
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
    "lallemand-verdant-ipa",
  );
});
void test("lab and code win with diagnostic; unknown codes and generic names do not resolve", () => {
  const yeast = resolveIngredient(
    "yeasts",
    ingredient({ name: "Wrong", laboratory: "Wyeast Labs", productId: "3068" }),
  );
  assert.deepEqual(yeast.descriptors, ["banana", "clove", "phenolic"]);
  assert.ok(yeast.diagnostics.some((value) => value.includes("conflict")));
  assert.equal(
    resolveIngredient(
      "yeasts",
      ingredient({ name: "Weihenstephan Weizen", laboratory: "Wyeast", productId: "9999" }),
    ).level,
    "unresolved",
  );
  // An unknown code blocks the product, and no style class stands in for it.
  const unknownCode = resolveIngredient(
    "yeasts",
    ingredient({
      name: "Weihenstephan Weizen",
      laboratory: "Wyeast",
      productId: "9999",
      type: "Wheat",
    }),
  );
  assert.equal(unknownCode.level, "unresolved");
  assert.deepEqual(unknownCode.descriptors, []);
  assert.ok(unknownCode.diagnostics.some((value) => value.includes("Unknown/conflicting")));
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
    "hop-mosaic",
  );
  // Bare Hallertau names a region, not a variety, and Styrian Goldings is either Savinjski
  // Golding or Celeia: neither is guessed.
  for (const name of [
    null,
    "Arctic Blend",
    "Citra clone",
    "Citra extract",
    "Hallertau",
    "Styrian Goldings",
  ])
    assert.equal(resolveIngredient("hops", ingredient({ name })).level, "unresolved");
});
void test("reviewed hop varieties and maker-sourced yeasts resolve by exact name and laboratory", () => {
  const hops: readonly [string, string][] = [
    ["Tettnang", "hop-tettnanger"],
    ["Hersbrucker", "hop-hersbrucker-spat"],
    ["Perle", "hop-perle"],
    ["Nugget", "hop-nugget"],
    ["Crystal", "hop-crystal"],
    ["Mount Hood", "hop-mount-hood"],
    ["Fuggle", "hop-fuggle"],
    ["Centennial", "hop-centennial"],
    ["El Dorado", "hop-el-dorado"],
    ["Bravo", "hop-bravo"],
    ["Mandarina Bavaria", "hop-mandarina-bavaria"],
    ["German Tradition", "hop-hallertauer-tradition"],
    ["Columbus/Tomahawk/Zeus (CTZ)", "hop-columbus"],
    ["East Kent Goldings (EKG)", "hop-east-kent-goldings"],
    ["Hallertauer Mittelfrueh", "hop-hallertauer-mittelfruh"],
    ["Idaho #7", "hop-idaho-7"],
    ["Pahto", "hop-terraflux"],
  ];
  for (const [name, id] of hops)
    assert.equal(resolveIngredient("hops", ingredient({ name })).id, id);
  const yeasts: readonly [string, string, string, string][] = [
    ["London Ale", "White Labs", "WLP013", "white-labs-wlp013"],
    ["London Ale Yeast", "Wyeast Labs", "1028", "wyeast-1028"],
    ["Voss Kveik", "Omega", "OYL-061", "omega-voss-kveik-standard"],
    ["New England", "Lallemand (LalBrew)", "", "lallemand-new-england"],
    ["Belgian Wit", "Mangrove Jack's", "M21", "mangrove-jacks-m21"],
  ];
  for (const [name, laboratory, productId, id] of yeasts)
    assert.equal(resolveIngredient("yeasts", ingredient({ name, laboratory, productId })).id, id);
  // A name shared by two laboratories never crosses manufacturers.
  assert.equal(
    resolveIngredient("yeasts", ingredient({ name: "London Ale", laboratory: "Other Lab" })).level,
    "unresolved",
  );
  assert.equal(
    resolveIngredient(
      "yeasts",
      ingredient({ name: "Voss Kveik", laboratory: "Lallemand (LalBrew)", productId: "" }),
    ).id,
    "lallemand-voss",
  );
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
  // Enzymes are processing aids: no flavour words, and no barrier to "none expected" tartness.
  const enzyme = resolveIngredient("miscs", ingredient({ name: "Amylase Enzyme" }));
  assert.equal(enzyme.id, "class-processing");
  assert.deepEqual(enzyme.functions, ["processing"]);
  assert.deepEqual(enzyme.descriptors, []);
});
void test("category and colour classify unknown grains generically; conflicting colour stays unresolved", () => {
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Unlisted", type: "Grain", grainCategory: "Base (Pilsner)" }),
    ).family,
    "pilsner",
  );
  const dark = resolveIngredient(
    "fermentables",
    ingredient({ name: "Dark mystery", type: "Grain", color: 600, grainCategory: "Roasted" }),
  );
  assert.equal(dark.id, "property-roasted");
  assert.equal(dark.level, "family");
  assert.equal(dark.roastClass, "black");
  assert.deepEqual(dark.descriptors, []);
  assert.ok(dark.diagnostics.some((value) => value.includes("Brewfather category and colour")));
  // Custom Brewfather grains can store °L in `color`; the product name's number wins.
  const crystal = resolveIngredient(
    "fermentables",
    ingredient({ name: "Crystal 40L", type: "Grain", color: 40, grainCategory: "Crystal/Caramel" }),
  );
  assert.equal(crystal.family, "crystal_light");
  assert.ok(crystal.diagnostics.some((value) => value.includes("(40 °L)")));
  for (const conflict of [
    ingredient({ name: "Dark mystery", type: "Grain", color: 3, grainCategory: "Roasted" }),
    ingredient({ name: "Unlisted", type: "Grain", color: 145.5, grainCategory: "Base" }),
  ]) {
    const resolution = resolveIngredient("fermentables", conflict);
    assert.equal(resolution.level, "unresolved");
    assert.ok(resolution.diagnostics.some((value) => value.includes("conflicts")));
  }
  const grain = (name: string) =>
    resolveIngredient(
      "fermentables",
      ingredient({ name, type: "Grain", color: 3, grainCategory: "Base" }),
    );
  assert.equal(grain("Beechwood Smoked Malt").family, "smoked");
  assert.equal(grain("Rauchmalz").family, "smoked");
  assert.equal(grain("Peated Malt").family, "peated");
  assert.equal(grain("Oak Smoked Wheat Malt").bodyClass, "wheat");
  // Acidulated malt is pilsner malt; tartness still inspects its share by name.
  for (const name of ["Acidulated Malt", "Acid Malt", "Sour Malt"]) {
    assert.equal(grain(name).id, "property-acidulated", name);
    assert.equal(grain(name).family, "pilsner", name);
  }
  // Unlisted lactose keeps its sweetness floor; maltodextrin adds body, not sugar.
  const lactose = resolveIngredient(
    "fermentables",
    ingredient({ name: "Lactose Powder", type: "Sugar", color: 0 }),
  );
  assert.equal(lactose.family, "lactose");
  assert.deepEqual(lactose.functions, ["lactose"]);
  const dextrin = resolveIngredient(
    "fermentables",
    ingredient({ name: "Maltodextrin", type: "Sugar", color: 0 }),
  );
  assert.equal(dextrin.id, "property-maltodextrin");
  assert.equal(dextrin.bodyClass, "carapils");
  assert.deepEqual(dextrin.functions, []);
  // A lowercase "l" colour suffix still names the colour.
  assert.ok(
    resolveIngredient(
      "fermentables",
      ingredient({
        name: "Crystal 60l",
        type: "Grain",
        color: 60,
        grainCategory: "Crystal/Caramel",
      }),
    ).diagnostics.some((value) => value.includes("(60 °L)")),
  );
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Mystery DME", type: "Dry Extract", color: 4 }),
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
  // Brewfather's Imperial rows can carry code and name together as both name and product id.
  const rustic = resolveIngredient(
    "yeasts",
    ingredient({ name: "B56 Rustic", laboratory: "Imperial Yeast", productId: "B56 Rustic" }),
  );
  assert.equal(rustic.id, "imperial-b56");
  assert.deepEqual(rustic.diagnostics, []);
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
  // The maltster's entry names the product and its words; the reviewed guard keeps its family.
  const caramel = resolveIngredient(
    "fermentables",
    ingredient({ name: "Caramel Malt 120L", supplier: "Briess" }),
  );
  assert.equal(caramel.id, "briess-caramel-malt-120l");
  assert.equal(caramel.family, "crystal_dark");
  assert.ok(caramel.descriptors.includes("caramel"));
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
  // Another supplier gets only the generic class, never the manufacturer's facts.
  const otherCrystal = resolveIngredient(
    "fermentables",
    ingredient({ name: "Crystal 40L (Murphy & Rude)", supplier: "Other" }),
  );
  assert.equal(otherCrystal.id, "property-crystal_light");
  assert.deepEqual(otherCrystal.descriptors, []);
  assert.equal(
    resolveIngredient(
      "fermentables",
      ingredient({ name: "Honey Malt", supplier: "Cargill (Gambrinus)" }),
    ).family,
    "aromatic",
  );
  // The operator's plain "Cargill" rows are Gambrinus bags (Cargill owns Gambrinus).
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Honey Malt", supplier: "Cargill" })).id,
    "gambrinus-honey-malt",
  );
  const otherHoney = resolveIngredient(
    "fermentables",
    ingredient({ name: "Honey Malt", supplier: "Other" }),
  );
  assert.equal(otherHoney.id, "property-aromatic");
  assert.deepEqual(otherHoney.descriptors, []);
  assert.equal(
    resolveIngredient("fermentables", ingredient({ name: "Corn Sugar (Dextrose)" })).family,
    "sugar",
  );
  assert.deepEqual(resolveIngredient("miscs", ingredient({ name: "Lactose" })).functions, [
    "lactose",
  ]);
});
void test("a yeast's character comes only from its maker; no style class names an unknown strain", () => {
  const yeast = (name: string, productId: string, type = "Ale", laboratory = "Some Lab") =>
    resolveIngredient("yeasts", ingredient({ name, laboratory, productId, type }));
  for (const [name, type] of [
    ["Hefeweizen IV", "Wheat"],
    ["Belgian Witbier", "Wheat"],
    ["French Saison", "Ale"],
    ["Abbey Ale", "Ale"],
    ["American Hefeweizen Ale", "Wheat"],
    ["Lutra Kveik", "Ale"],
    ["Belgian Lager", "Lager"],
    ["Saison Brett Blend", "Ale"],
    ["Berliner Weisse Blend", "Ale"],
  ] as const) {
    const unknown = yeast(name, "X1", type);
    assert.equal(unknown.level, "unresolved", name);
    assert.deepEqual(unknown.descriptors, [], name);
  }
  // The same names from their makers carry the makers' own words.
  assert.deepEqual(yeast("Hefeweizen IV Ale", "WLP380", "Wheat", "White Labs").descriptors, [
    "phenolic",
    "clove",
    "spicy",
    "banana",
    "bubblegum",
  ]);
  assert.deepEqual(yeast("French Saison", "3711", "Ale", "Wyeast Labs").descriptors, [
    "pepper",
    "spicy",
    "citrus",
  ]);
  assert.deepEqual(yeast("Trappist High Gravity", "3787", "Ale", "Wyeast Labs").descriptors, [
    "fruity",
    "phenolic",
  ]);
});
void test("Brewfather library names match their maker-sourced products without a conflict", () => {
  for (const [id, names] of Object.entries(BREWFATHER_NAMES)) {
    const fact = INGREDIENT_FACTS.find((candidate) => candidate.id === id);
    assert.ok(fact, `${id} is not a catalog product`);
    for (const name of names) {
      const resolved = resolveIngredient(
        fact.role,
        fact.role === "yeasts"
          ? ingredient({
              name,
              laboratory: fact.manufacturer,
              productId: fact.codes[0] ?? "",
              type: "Ale",
            })
          : ingredient({ name, supplier: fact.manufacturer }),
      );
      assert.equal(resolved.id, id, name);
      assert.ok(!resolved.diagnostics.some((value) => value.includes("conflict")), name);
    }
  }
});
void test("the operator's renamed and colour-series rows name their maltster products", () => {
  // The operator's rows: supplier, name, colour in SRM and °L, and the product they name.
  const rows: readonly [string, string, number, number | null, string][] = [
    ["Briess", "Munich", 10, null, "briess-bonlander-munich-malt-10l"],
    ["Crisp", "Maris Otter", 4, 3.5, "crisp-finest-maris-otter-ale-malt"],
    ["Crisp", "Maris Otter (Extra Pale)", 1.573604, null, "crisp-extra-pale-maris-otter-malt"],
    ["Rahr", "Pale Malt, 2-Row", 1.8, 1.9, "rahr-the-brewer-s-standard-2-row"],
    ["Cargill", "Pale Malt 2-Row", 2, null, "gambrinus-pale-malt"],
    ["Cargill", "Wheat White", 2.9, null, "gambrinus-organic-wheat-malt"],
    [
      "Simpsons",
      "Pale Ale Golden Promise",
      2.538071,
      null,
      "simpsons-finest-pale-ale-golden-promise",
    ],
    ["Weyermann", "Carafa III", 525, 388.1, "weyermann-carafa-type-3"],
    ["Proximity Malt", "Crystal 120L", 120, null, "proximity-crystal-120"],
    ["BestMälz", "Best Munich Malt Dark", 12.7, null, "bestmalz-munich-dark"],
    ["BestMälz", "Best Pale Ale Malt", 2.5, null, "bestmalz-pale-ale"],
    ["Bairds", "Caramel/Crystal Malt", 12.8, 10, "bairds-light-caramalt"],
    ["Bairds", "Caramel/Crystal Malt", 53.4, 40, "bairds-light-crystal"],
    ["Bairds", "Caramel/Crystal Malt", 75, null, "bairds-medium-crystal"],
    ["Bairds", "Caramel/Crystal Malt", 150, null, "bairds-extra-dark-crystal-malt"],
    ["Bairds", "Caramel/Crystal Malt", 161.8, 120, "bairds-extra-dark-crystal-malt"],
    // Brewfather stored these as SRM from 30 °L and 40 °L.
    ["Briess", "Caramel Malt", 40, null, "briess-caramel-malt-30l"],
    ["Briess", "Caramel Malt", 53.4, 40, "briess-caramel-malt-40l"],
  ];
  const words: Readonly<Record<string, readonly string[]>> = {
    "briess-bonlander-munich-malt-10l": ["malty"],
    "crisp-finest-maris-otter-ale-malt": ["bready", "toffee"],
    "crisp-extra-pale-maris-otter-malt": ["grainy", "bready", "biscuit"],
    "rahr-the-brewer-s-standard-2-row": [],
    "gambrinus-pale-malt": ["bready", "biscuit", "grainy", "honey", "nutty", "tea"],
    "gambrinus-organic-wheat-malt": [],
    "simpsons-finest-pale-ale-golden-promise": ["malty", "nutty", "honey"],
    "weyermann-carafa-type-3": ["roast", "coffee", "cocoa", "chocolate"],
    "proximity-crystal-120": ["dark caramel", "burnt sugar", "dried fruit", "raisin", "prune"],
    "bestmalz-munich-dark": ["honey"],
    "bestmalz-pale-ale": ["grainy"],
    "bairds-light-caramalt": ["malty", "nutty", "toffee", "caramel", "burnt sugar", "raisin"],
    "bairds-light-crystal": ["caramel", "toffee", "nutty", "molasses", "raisin"],
    "bairds-medium-crystal": ["caramel", "raisin", "toffee", "nutty", "molasses"],
    "bairds-extra-dark-crystal-malt": [
      "burnt sugar",
      "dried fruit",
      "toffee",
      "caramel",
      "nutty",
      "molasses",
      "raisin",
    ],
    "briess-caramel-malt-30l": ["caramel", "toffee", "candy"],
    "briess-caramel-malt-40l": ["caramel", "toffee", "candy"],
  };
  for (const [supplier, name, color, lovibond, id] of rows) {
    const resolved = resolveIngredient(
      "fermentables",
      ingredient({ name, supplier, color, lovibond, type: "Grain" }),
    );
    assert.equal(resolved.id, id, `${supplier} ${name} ${color}`);
    assert.equal(resolved.level, "product", `${supplier} ${name} ${color}`);
    assert.deepEqual(resolved.descriptors, words[id], `${supplier} ${name} ${color}`);
  }
  // The 145.5 SRM Munich row is a data-entry error: Bonlander's words, and the conflict stays visible.
  const munich = resolveIngredient(
    "fermentables",
    ingredient({ name: "Munich", supplier: "Briess", color: 145.5, lovibond: 108 }),
  );
  assert.equal(munich.id, "briess-bonlander-munich-malt-10l");
  assert.ok(munich.diagnostics.some((value) => value.includes("identity/color conflict")));
});
void test("a colour series names no product outside its maltster's stated ranges", () => {
  const caramel = (
    supplier: string,
    name: string,
    color: number | null,
    lovibond: number | null = null,
  ) =>
    resolveIngredient(
      "fermentables",
      ingredient({
        name,
        supplier,
        color,
        lovibond,
        grainCategory: "Crystal/Caramel",
        type: "Grain",
      }),
    );
  for (const [supplier, name, color] of [
    // Between Bairds' Light Crystal (50–60 SRM) and Medium Crystal (70–80 SRM): the operator's row.
    ["Bairds", "Caramel/Crystal Malt", 65],
    ["Bairds", "Caramel/Crystal Malt", 12.4],
    ["Bairds", "Caramel/Crystal Malt", 400],
    // 47 SRM is 35 °L, between Briess's 30L and 40L.
    ["Briess", "Caramel Malt", 47],
    ["Briess", "Caramel Malt", null],
    // A series belongs to its maltster.
    ["Simpsons", "Caramel/Crystal Malt", 75],
    ["Bairds", "Caramel Malt", 53.4],
  ] as const) {
    const resolved = caramel(supplier, name, color);
    assert.notEqual(resolved.level, "product", `${supplier} ${name} ${color}`);
    assert.deepEqual(resolved.descriptors, [], `${supplier} ${name} ${color}`);
  }
  // Rounding is to the maltster's whole numbers, never wider.
  assert.equal(caramel("Bairds", "Caramel/Crystal Malt", 12.5).id, "bairds-light-caramalt");
  assert.equal(caramel("Bairds", "Caramel/Crystal Malt", 12.49).id, "property-crystal_light");
});
void test("colour series ranges are their maltsters' own stated colours and never overlap", () => {
  for (const [name, { unit, ranges }] of Object.entries(BREWFATHER_COLOUR_SERIES)) {
    const products = Object.entries(ranges).map(([id, range]) => {
      const fact = INGREDIENT_FACTS.find((candidate) => candidate.id === id);
      assert.ok(fact, `${id} is not a catalog product`);
      const [min, max] = range;
      // Bairds states "13 – 17 °SRM"; Briess names the colour, as in "Caramel Malt 30L".
      assert.ok(
        unit === "srm"
          ? fact.limitations.some((value) => value.includes(`${min} – ${max} °SRM`))
          : min === max && fact.aliases.some((alias) => alias.endsWith(` ${min}L`)),
        `${id} ${min}–${max} ${unit}`,
      );
      // An exact name always wins, so a series name is never one of its products' names.
      assert.ok(!fact.aliases.some((alias) => alias.toLowerCase() === name.toLowerCase()), id);
      return { fact, min, max };
    });
    assert.equal(new Set(products.map(({ fact }) => fact.manufacturer)).size, 1, name);
    const sorted = products.toSorted((a, b) => a.min - b.min);
    for (let index = 1; index < sorted.length; index++)
      assert.ok(sorted[index - 1]!.max < sorted[index]!.min, `${name} ranges overlap`);
  }
});
void test("hop origin and form words fall away; concentrated forms stay unknown with a reason", () => {
  const hop = (name: string, form = "Pellet") =>
    resolveIngredient("hops", ingredient({ name, form }));
  assert.equal(hop("Hallertau Mittelfruh").id, "hop-hallertauer-mittelfruh");
  // Trademark signs never block an exact name.
  assert.equal(hop("Citra™").id, "hop-citra");
  for (const [name, id] of [
    ["German Magnum", "hop-hallertauer-magnum"],
    ["Saaz (CZ)", "hop-saaz"],
    ["Cascade Whole Leaf", "hop-cascade"],
    ["German Tettnang", "hop-tettnanger"],
  ]) {
    const variant = hop(name!);
    assert.equal(variant.id, id, name);
    assert.ok(
      variant.diagnostics.some((value) => value.includes("origin or form")),
      name,
    );
  }
  // Distinct cultivars keep their own identity: NZ Saaz and NZ Hallertau are not the originals.
  assert.equal(hop("Hallertau Blanc").id, "hop-hallertau-blanc");
  for (const name of ["NZ Saaz", "NZ Hallertau"]) assert.equal(hop(name).level, "unresolved", name);
  for (const [name, form] of [
    ["Citra Cryo", "Pellet"],
    ["Citra", "Cryo"],
    ["Mosaic LUPOMAX", "Pellet"],
  ]) {
    const concentrated = hop(name!, form);
    assert.equal(concentrated.level, "unresolved", name);
    assert.ok(concentrated.diagnostics[0]?.startsWith("Concentrated hop product"), name);
  }
});
void test("generic adjunct classes name the ingredient and keep acid, fruit and processing roles", () => {
  const misc = (name: string, type = "Other") =>
    resolveIngredient("miscs", ingredient({ name, type }));
  const peel = misc("Sweet Orange Peel", "Spice");
  assert.deepEqual(peel.descriptors, ["orange"]);
  assert.deepEqual(peel.functions, ["botanical"]);
  assert.equal(peel.noticeableGPerL, 0.4);
  assert.deepEqual(misc("Lime Juice").functions, ["fruit"]);
  for (const [name, word] of [
    ["frozen raspberry", "raspberry"],
    ["Blueberry Puree", "blueberry"],
    ["Pineapple", "pineapple"],
    ["Grapefruit Juice", "grapefruit"],
    ["Jalapeño", "chili"],
    ["Cacao Nibs", "cocoa"],
  ])
    assert.deepEqual(misc(name!).descriptors, [word], name);
  assert.deepEqual(misc("Calcium Carbonate", "Water Agent").functions, ["water_treatment"]);
  assert.deepEqual(misc("Citric Acid", "Water Agent").functions, ["mash_acid"]);
  assert.deepEqual(misc("Biofine Clear", "Fining").functions, ["processing"]);
  for (const name of ["Mystery Spice", "Pickling Lime", "Cherrywood chips"])
    assert.equal(misc(name).level, "unresolved", name);
  // Fruit wins over plant and water classes so acidity is never hidden.
  for (const [name, type, id] of [
    ["Hibiscus Tea", "Herb", "class-hibiscus"],
    ["Chocolate Raspberry Puree", "Flavor", "class-raspberry"],
    ["Lemon Juice", "Water Agent", "class-lemon"],
    ["Orange Peel", "Water Agent", "class-orange-peel"],
    ["Lime", "Water Agent", "class-water-treatment"],
    ["Sauergut", "Water Agent", "class-water-acid"],
    ["Lemon Balm", "Herb", "class-herbs"],
  ])
    assert.equal(misc(name!, type).id, id, name);
  const fermentable = (name: string, type: string, color: number | null = null) =>
    resolveIngredient("fermentables", ingredient({ name, type, color }));
  assert.deepEqual(fermentable("Cherry Puree", "Other").functions, ["fruit"]);
  assert.deepEqual(fermentable("Cocoa Nibs", "Adjunct").descriptors, ["cocoa"]);
  // Grains, malts and sugars never take adjunct classes.
  assert.equal(fermentable("House Chocolate Malt", "").level, "unresolved");
  for (const name of ["Chocolate Wheat", "Pale Chocolate"])
    assert.notEqual(fermentable(name, "Adjunct").id, "class-cocoa", name);
  assert.equal(fermentable("Cherrywood Smoked Malt", "Grain", 5).family, "smoked");
  assert.equal(fermentable("Coconut Sugar", "Sugar").family, "sugar");
});
void test("catalog data stays well formed and every fact is in the sources ledger", () => {
  const ledger = readFileSync(
    new URL("../docs/flavor-catalog-sources.md", import.meta.url),
    "utf8",
  );
  const ids = [...INGREDIENT_FACTS, ...INGREDIENT_CLASSES].map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const fact of REVIEWED_FACTS) {
    assert.ok(fact.sourceUrls.length > 0, fact.id);
    assert.ok(
      fact.sourceUrls.every((url) => url.startsWith("https://")),
      fact.id,
    );
    assert.ok(ledger.includes(`\`${fact.id}\``), `${fact.id} is missing from the sources ledger`);
  }
  for (const entry of INGREDIENT_CLASSES) {
    assert.ok(entry.id.startsWith("class-"), entry.id);
    assert.ok(entry.noticeableGPerL === null || entry.noticeableGPerL > 0, entry.id);
  }
  for (const entry of [...INGREDIENT_FACTS, ...INGREDIENT_CLASSES])
    for (const word of entry.descriptors)
      assert.match(word, /^[a-z]+(?: [a-z]+){0,2}$/, `${entry.id}: ${word}`);
});
