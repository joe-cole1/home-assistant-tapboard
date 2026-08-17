import assert from "node:assert/strict";
import test from "node:test";

import { buildSensoryRadar } from "../src/features/story/radar.ts";
import type { SensoryAxisResult, SensoryProfile } from "../src/features/story/types.ts";

const resolution = (value: number | null): SensoryAxisResult => ({
  value,
  source: value === null ? "unavailable" : "manual",
  confidence: value === null ? null : "high",
  evidence: value === null ? "No public sensory evidence." : "Manual sensory value.",
});

const profile = (values: readonly (number | null)[]): SensoryProfile => ({
  bitterness: resolution(values[0] ?? null),
  sweetness: resolution(values[1] ?? null),
  body: resolution(values[2] ?? null),
  roast: resolution(values[3] ?? null),
  tartness: resolution(values[4] ?? null),
  alcohol: resolution(values[5] ?? null),
});

void test("sensory radar plots a complete fixed-scale profile", () => {
  const radar = buildSensoryRadar(profile([5, 4, 3, 2, 1, 0]));
  assert.ok(radar);
  assert.equal(radar.complete, true);
  assert.equal(radar.gridPaths.length, 5);
  assert.match(radar.dataPath ?? "", /^M/u);
  assert.deepEqual(
    radar.axes.map((axis) => axis.key),
    ["bitterness", "roast", "body", "sweetness", "tartness", "alcohol"],
  );
  assert.equal(radar.axes.find((axis) => axis.key === "alcohol")?.value, 0);
});

void test("sensory radar never converts missing or invalid values into plotted zeroes", () => {
  const partial = buildSensoryRadar(profile([5, null, 3, Number.NaN, 1, null]));
  assert.ok(partial);
  assert.equal(partial.complete, false);
  assert.equal(partial.dataPath, null);
  assert.equal(partial.axes.filter((axis) => axis.valuePoint !== null).length, 3);
  assert.match(partial.description, /3 of 6/u);
  assert.equal(partial.axes.find((axis) => axis.key === "roast")?.valuePoint, null);
  assert.equal(buildSensoryRadar(null), null);
});
