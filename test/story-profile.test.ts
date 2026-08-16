import assert from "node:assert/strict";
import { test } from "node:test";
import {
  predictAlcohol,
  predictBitterness,
  predictBody,
  predictSweetness,
  predictRoast,
  predictTartness,
  canonicalSensoryToPublic,
  resolveSensoryProfile,
  styleBaselineFor,
} from "../src/features/story/profile.ts";

void test("canonical measured vector uses the locked bitterness and alcohol formulas", () => {
  assert.equal(predictBitterness({ ibu: 50, og: 1.05, fg: 1.01 }), 3.7);
  assert.equal(predictAlcohol({ abv: 6 }), 1.5);
});

void test("manual, recipe, and style precedence is independent per axis", () => {
  const result = resolveSensoryProfile({
    style: "West Coast IPA",
    manualOverrides: { bitterness: 2.5 },
    recipePrediction: { sweetness: 2.25 },
    ibu: 50,
    og: 1.05,
    fg: 1.01,
    abv: 6,
  });
  assert.deepEqual(result.bitterness, {
    value: 1.25,
    source: "manual",
    confidence: "high",
    evidence: "Manual override (canonical 0–10 mapped to public 0–5)",
  });
  assert.equal(result.sweetness.source, "recipe_prediction");
  assert.equal(result.sweetness.value, 2.25);
  assert.equal(result.body.source, "recipe_prediction");
  assert.equal(result.alcohol.source, "recipe_prediction");
  assert.equal(result.roast.source, "unavailable");
});

void test("invalid non-null manual values fail closed for only that axis", () => {
  const result = resolveSensoryProfile({
    style: "IPA",
    manualOverrides: { bitterness: 8, sweetness: Number.NaN },
    ibu: 50,
    og: 1.05,
    fg: 1.01,
  });
  assert.equal(result.bitterness.value, 4);
  assert.equal(result.bitterness.source, "manual");
  assert.equal(result.sweetness.value, null);
  assert.equal(result.sweetness.source, "unavailable");
  assert.equal(result.body.source, "recipe_prediction");
});

void test("canonical 0..10 manual values map deterministically to public 0..5", () => {
  assert.equal(canonicalSensoryToPublic(0), 0);
  assert.equal(canonicalSensoryToPublic(8), 4);
  assert.equal(canonicalSensoryToPublic(7.777), 3.8885);
  assert.equal(canonicalSensoryToPublic(10), 5);
  assert.equal(canonicalSensoryToPublic(-0.1), null);
  assert.equal(canonicalSensoryToPublic(10.1), null);
  assert.equal(resolveSensoryProfile({ manualOverrides: { body: 8 } }).body.value, 4);
  assert.equal(resolveSensoryProfile({ manualOverrides: { body: 8 } }).body.source, "manual");
  const invalid = resolveSensoryProfile({ manualOverrides: { body: 10.1 } }).body;
  assert.equal(invalid.value, null);
  assert.equal(invalid.source, "unavailable");
});

void test("clearing a manual override exposes the next sensory precedence layer", () => {
  const result = resolveSensoryProfile({
    manualOverrides: { bitterness: null },
    recipePrediction: { bitterness: 2.75 },
  });
  assert.equal(result.bitterness.value, 2.75);
  assert.equal(result.bitterness.source, "recipe_prediction");
});

void test("very low and west-coast bitterness remain bounded", () => {
  assert.equal(predictBitterness({ ibu: 5, og: 1.005, fg: 1.001 }), 1);
  assert.equal(predictBitterness({ ibu: 65, og: 1.065, fg: 1.01 }), 4.45);
  assert.ok((predictBitterness({ ibu: 30, og: 1.1, fg: 1.03 }) ?? 5) < 0.2);
});

void test("roast recognizes dehusked grist and conservatively falls back to SRM", () => {
  const roast = predictRoast({
    grist: [
      { name: "Dehusked Carafa Special", amount: 0.5, unit: "kg" },
      { name: "Pale Malt", amount: 9.5, unit: "kg" },
    ],
  });
  assert.ok((roast ?? 0) > 0);
  assert.equal(predictRoast({ srm: 30 }), 0.5);
  assert.equal(predictRoast({ srm: 20 }), null);
});

void test("tartness uses measured pH or explicit souring, never Brett or fruit alone", () => {
  assert.equal(predictTartness({ finalPh: 3.3 }), 4.5);
  assert.equal(predictTartness({ souring: "kettle sour" }), 4);
  assert.equal(
    predictTartness({ recipe: { ingredients: { yeasts: [{ name: "Philly Sour" }] } } }),
    4,
  );
  assert.equal(predictTartness({ culture: "Brettanomyces" }), null);
  assert.equal(
    predictTartness({ recipe: { ingredients: { yeasts: [{ name: "Brettanomyces" }] } } }),
    null,
  );
  assert.equal(predictTartness({ fruit: "cherry", waterAcid: "phosphoric" }), null);
});

void test("adjunct body union increases body and compound styles compose", () => {
  const plain = predictBody({
    fg: 1.01,
    og: 1.05,
    ingredients: [{ name: "Pale Malt", percent: 100 }],
  });
  const oats = predictBody({
    fg: 1.01,
    og: 1.05,
    ingredients: [
      { name: "Pale Malt", percent: 95 },
      { name: "Flaked Oats", percent: 5 },
    ],
  });
  assert.ok((oats ?? 0) > (plain ?? 0));
  assert.ok((oats ?? 0) < (plain ?? 0) + 2);
  const sourIpa = resolveSensoryProfile({ style: "Sour IPA" });
  assert.equal(sourIpa.tartness.value, 5);
  assert.equal(sourIpa.tartness.source, "style_baseline");
  assert.equal(sourIpa.body.value, 2);
  assert.equal(sourIpa.bitterness.value, 3.5);
  const tripel = styleBaselineFor("Tripel");
  assert.deepEqual(tripel, { sweetness: 1.5, body: 2, alcohol: 4.5 });
  assert.equal(resolveSensoryProfile({ style: "IPA", perceived_strength: 4 }).alcohol.value, 4);
  assert.equal(styleBaselineFor("Imperial IPA").alcohol, undefined);
  assert.equal(resolveSensoryProfile({ style: "Imperial IPA" }).alcohol.value, null);
  assert.equal(
    resolveSensoryProfile({ style: "Imperial IPA", perceived_strength: 4 }).alcohol.value,
    4,
  );
  assert.equal(
    resolveSensoryProfile({ style: "Imperial IPA", perceived_strength: "4" }).alcohol.value,
    null,
  );
});

void test("sweetness/body are available from each independent recipe signal", () => {
  assert.equal(predictSweetness({ fg: 1.02 }), 3.25);
  assert.equal(predictSweetness({ attenuation: 70 }), 3);
  assert.equal(predictSweetness({ lactoseGPerL: 10 }), 0.5);
  assert.equal(predictBody({ fg: 1.01 }), 1.5);
  assert.equal(predictBody({ attenuation: 70 }), 2.5);
  assert.equal(predictBody({ fg: 1.01, attenuation: 70 }), 1.8);
});

void test("grouped recipe ingredients keep grist isolated and recognize sour cultures", () => {
  const grouped = {
    recipe: {
      ingredients: {
        fermentables: [
          { name: "Pale Malt", percent: 95 },
          { name: "Roast Barley", percent: 5 },
        ],
        hops: Array.from({ length: 8 }, () => ({ name: "Cascade", amount: 50, unit: "kg" })),
        yeasts: [{ name: "Lachancea" }],
        miscs: [{ name: "Lactose", amount: 10, unit: "g" }],
      },
    },
    fg: 1.01,
    og: 1.05,
    batchVolumeL: 1,
  };
  assert.equal(predictRoast(grouped), 3);
  assert.equal(predictTartness(grouped), 4);
  assert.equal(predictSweetness(grouped), 2.08);
});

void test("null and empty inputs are safe and unavailable", () => {
  const result = resolveSensoryProfile(null);
  for (const axis of ["bitterness", "sweetness", "body", "roast", "tartness", "alcohol"] as const) {
    assert.equal(result[axis].value, null);
    assert.equal(result[axis].source, "unavailable");
  }
  assert.equal(predictAlcohol({}), null);
});
