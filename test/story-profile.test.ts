import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSensoryProfile,
  resolveFlavorProfile,
  canonicalSensoryToPublic,
  styleBaselineFor,
  deriveAttenuation,
} from "../src/features/story/profile.ts";
import { SENSORY_AXES } from "../src/features/story/types.ts";
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
  assert.deepEqual(Object.keys(result), SENSORY_AXES);
  for (const axis of SENSORY_AXES) {
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
