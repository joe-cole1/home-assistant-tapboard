import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VESSEL_ID,
  SAFE_DISPLAY_COLOR,
  VESSEL_IDS,
  displayColorForSrm,
  getVesselDescriptor,
  normalizeDisplayColor,
  resolveDisplayColor,
  resolveVessel,
  resolveVesselId,
} from "../src/features/story/vessels.ts";
import {
  MAX_PUBLIC_RECIPE_INGREDIENTS,
  MAX_PUBLIC_RECIPE_STEPS,
  MAX_SOURCE_JSON_BYTES,
  projectCustomRecipe,
  projectSourceRecipe,
} from "../src/features/story/recipe.ts";

void test("all 17 vessel IDs are finite and geometry descriptors are distinct", () => {
  assert.equal(VESSEL_IDS.length, 17);
  assert.equal(new Set(VESSEL_IDS).size, 17);
  const descriptors = VESSEL_IDS.map((id) => getVesselDescriptor(id));
  assert.equal(new Set(descriptors.map((item) => item.token)).size, 17);
  for (const descriptor of descriptors) {
    for (const value of [
      descriptor.width,
      descriptor.height,
      descriptor.bowlWidth,
      descriptor.stemHeight,
    ])
      assert.equal(Number.isFinite(value), true);
  }
});

void test("style mapping is deterministic and explicit safe fill glass wins", () => {
  assert.equal(resolveVesselId({ style: "Wild Lambic" }), "teku");
  assert.equal(resolveVesselId({ style: "Sour Ale" }), "tulip_glass");
  assert.equal(resolveVesselId({ style: "West Coast IPA" }), "ipa_glass");
  assert.equal(resolveVesselId({ style: "Imperial Stout" }), "stout_glass");
  assert.equal(resolveVesselId({ style: "Hefeweizen" }), "wheat_glass");
  assert.equal(resolveVesselId({ style: "Tripel" }), "goblet");
  assert.equal(resolveVesselId({ style: "Unknown beverage" }), DEFAULT_VESSEL_ID);
  assert.equal(resolveVesselId({ fillGlass: "teku", style: "IPA" }), "teku");
  assert.deepEqual(
    resolveVessel({ fillGlass: "<svg onload=alert(1) />", style: "IPA" }).id,
    "ipa_glass",
  );
  assert.equal(resolveVesselId({ fillGlass: "<script>bad</script>" }), DEFAULT_VESSEL_ID);
});

void test("display color validates explicit hex and uses finite SRM palette", () => {
  assert.equal(normalizeDisplayColor(" #aBc123 "), "#ABC123");
  assert.equal(normalizeDisplayColor("#abc"), null);
  assert.equal(normalizeDisplayColor("red"), null);
  assert.equal(resolveDisplayColor({ displayColor: "#aBc123", srm: 50 }), "#ABC123");
  assert.equal(
    resolveDisplayColor({ displayColor: "rgb(1,2,3)", srm: 30 }),
    displayColorForSrm(30),
  );
  assert.equal(resolveDisplayColor({ displayColor: "#bad", srm: Number.NaN }), SAFE_DISPLAY_COLOR);
  assert.equal(resolveDisplayColor({ displayColor: "url(javascript:bad)" }), SAFE_DISPLAY_COLOR);
  assert.equal(displayColorForSrm(3), "#ECE61A");
  assert.equal(displayColorForSrm(30), "#280200");
  assert.match(displayColorForSrm(0) ?? "", /^#[0-9A-F]{6}$/);
  assert.equal(resolveDisplayColor({ srm: "not-a-number" }), SAFE_DISPLAY_COLOR);
  assert.equal(displayColorForSrm(-1), null);
  assert.equal(displayColorForSrm(51), null);
});

void test("recipe projections cap, sanitize, and never expose source internals", () => {
  const ingredients = Array.from({ length: MAX_PUBLIC_RECIPE_INGREDIENTS + 3 }, (_, index) => ({
    id: `secret-${index}`,
    name: `${"n".repeat(160)}-${index}`,
    type: "fermentable-secret-type",
    amount: 1,
    unit: "kilograms-secret-unit",
  }));
  const steps = Array.from({ length: MAX_PUBLIC_RECIPE_STEPS + 2 }, () => ({
    id: "secret-step-id",
    text: "x".repeat(800),
  }));
  const custom = projectCustomRecipe(
    { id: "secret-recipe-id", ingredients, steps, notes: "private note" },
    { label: "My Recipe", state: "detached", version: 2, capturedAt: "2026-01-01T00:00:00.000Z" },
  );
  assert.equal(custom.status, "partial");
  assert.equal(custom.ingredients.length, MAX_PUBLIC_RECIPE_INGREDIENTS);
  assert.equal(custom.steps.length, MAX_PUBLIC_RECIPE_STEPS);
  assert.ok((custom.ingredients[0]?.name.length ?? 0) <= 120);
  assert.ok((custom.ingredients[0]?.type?.length ?? 0) <= 40);
  assert.ok((custom.ingredients[0]?.unit?.length ?? 0) <= 24);
  assert.equal(custom.ingredients[0]?.note, null);
  assert.ok((custom.steps[0]?.text.length ?? 0) <= 500);
  assert.equal(custom.steps[0]?.name, null);
  assert.equal(custom.steps[0]?.temperatureC, null);
  assert.equal(custom.steps[0]?.timeMinutes, null);
  assert.equal("id" in custom, false);
  assert.equal(JSON.stringify(custom).includes("secret-recipe-id"), false);
  assert.equal(JSON.stringify(custom).includes("secret-step-id"), false);
  assert.deepEqual(custom.provenance, {
    label: "My Recipe",
    state: "detached",
    version: 2,
    capturedAt: "2026-01-01T00:00:00.000Z",
  });

  const rich = projectCustomRecipe({
    ingredients: [{ name: "Lactose", amount: 10, unit: "g", note: "sweetener" }],
    steps: [{ name: "Mash", note: "Hold", temperatureC: 67, timeMinutes: 60 }],
  });
  assert.deepEqual(rich.ingredients[0], {
    name: "Lactose",
    type: null,
    amount: 10,
    unit: "g",
    percent: null,
    note: "sweetener",
  });
  assert.deepEqual(rich.steps[0], {
    text: "Hold",
    name: "Mash",
    temperatureC: 67,
    timeMinutes: 60,
    note: "Hold",
  });

  const groupedSource = projectSourceRecipe(
    JSON.stringify({
      ingredients: {
        fermentables: [{ name: "Pale Malt", type: "grain", note: "base" }],
        miscs: [{ name: "Lactose", amount: 10, unit: "g" }],
      },
      steps: [{ name: "Boil", text: "Boil wort", temperatureC: 100, timeMinutes: 60 }],
    }),
  );
  assert.equal(groupedSource.ingredients[0]?.note, "base");
  assert.deepEqual(groupedSource.steps[0], {
    text: "Boil wort",
    name: "Boil",
    temperatureC: 100,
    timeMinutes: 60,
    note: null,
  });
});

void test("malformed and oversized source JSON are safe unavailable projections", () => {
  const malformed = projectSourceRecipe("{not-json", {
    label: "Frozen",
    state: "detached",
    version: 1,
  });
  assert.equal(malformed.status, "unavailable");
  assert.deepEqual(malformed.ingredients, []);
  const oversized = projectSourceRecipe("x".repeat(MAX_SOURCE_JSON_BYTES + 1));
  assert.equal(oversized.status, "unavailable");
  assert.doesNotThrow(() => projectSourceRecipe({ ingredients: [{ name: "Pale Malt" }] }));
});
