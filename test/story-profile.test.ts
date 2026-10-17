import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSensoryProfile,
  resolveFlavorProfile,
  canonicalSensoryToPublic,
  styleBaselineFor,
  deriveAttenuation,
  flavorSummary,
} from "../src/features/story/profile.ts";
import { batchFixture, evaluateFixture } from "./fixtures/flavor/corpus.ts";
import { BEVERAGE_SENSORY_AXES } from "../src/features/beverages/types.ts";
void test("manual canonical scale remains independent per axis and invalid values fail closed", () => {
  const profile = resolveSensoryProfile({
    manualOverrides: { bitterness: 8, sweetness: Number.NaN, body: 0 },
  });
  assert.equal(profile.bitterness.value, 4);
  assert.equal(profile.bitterness.source, "manual");
  assert.equal(profile.sweetness.value, null);
  assert.equal(profile.body.value, 0);
  assert.equal(canonicalSensoryToPublic(0), 0);
  assert.equal(canonicalSensoryToPublic(10), 5);
  assert.equal(canonicalSensoryToPublic(-0.1), null);
});
void test("fixed eight axes are available as explicit unknown results", () => {
  const result = resolveSensoryProfile(null);
  assert.deepEqual(Object.keys(result), BEVERAGE_SENSORY_AXES);
  for (const axis of BEVERAGE_SENSORY_AXES) {
    assert.equal(result[axis].value, null);
    assert.equal(result[axis].source, "unavailable");
  }
});
void test("style matching is exact and cannot turn titles into ingredients", () => {
  assert.deepEqual(styleBaselineFor("Belgian Tripel"), { sweetness: 1.5, body: 2, alcohol: 4.5 });
  assert.deepEqual(styleBaselineFor("Bourbon black banana imperial IPA"), {});
  const result = resolveFlavorProfile({
    recipe: { name: "Bourbon barrel sour" },
    srm: 50,
    ph: 3.2,
  });
  assert.equal(result.axes.roast.value, null);
  assert.equal(result.axes.tartness.value, null);
  assert.deepEqual(result.processTags, []);
});
void test("simple apparent attenuation retains values above100", () => {
  assert.ok((deriveAttenuation(1.05, 0.995) ?? 0) > 100);
  assert.equal(deriveAttenuation(1, 0.995), null);
  assert.equal(deriveAttenuation(true, 0.995), null);
});
void test("flavor summary is one sentence of character, band-worded axes and warmth only", () => {
  const stout = flavorSummary(evaluateFixture(batchFixture("B011")).calculation)!;
  assert.equal(
    stout,
    "Coffee, chocolate and roast character with a full body, very high bitterness and a moderately sweet finish. Noticeable alcohol warmth.",
  );
  const kolsch = flavorSummary(evaluateFixture(batchFixture("B027")).calculation)!;
  assert.match(kolsch, /^Grainy and cracker character with a very light body/u);
  assert.equal(kolsch.includes("warmth"), false);
  // Numbers, metric names and style words never appear, so Mystery's sensory reveal suffices.
  for (const sentence of [stout, kolsch]) {
    assert.doesNotMatch(sentence, /\d|%|ABV|IBU|SRM|stout|kölsch|kolsch/iu);
  }
});
void test("flavor summary omits unknown axes and needs a descriptor or two known clauses", () => {
  const manualOnly = resolveFlavorProfile({ manualOverrides: { body: 6, bitterness: 2 } });
  assert.deepEqual(manualOnly.descriptors, []);
  assert.equal(flavorSummary(manualOnly), "A full body and low bitterness.");
  assert.equal(flavorSummary(resolveFlavorProfile({ manualOverrides: { body: 6 } })), null);
  assert.equal(flavorSummary(resolveFlavorProfile({})), null);
  const zeroBitterness = resolveFlavorProfile({
    manualOverrides: { body: 6, bitterness: 0, sweetness: 0 },
  });
  assert.equal(
    flavorSummary(zeroBitterness),
    "A full body, no expected bitterness and a very dry finish.",
  );
});
