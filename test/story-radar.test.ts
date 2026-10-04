import assert from "node:assert/strict";
import test from "node:test";
import { buildSensoryRadar, sensoryBand } from "../src/features/story/radar.ts";
import {
  SENSORY_AXES,
  type SensoryAxisResult,
  type SensoryProfile,
} from "../src/features/story/types.ts";
const resolution = (value: number | null): SensoryAxisResult => ({
  value,
  source: value === null ? "unavailable" : "manual",
  support: value === null ? "unavailable" : "supported",
  confidence: null,
  evidence: "Generic guidance",
});
const profile = (values: readonly (number | null)[]): SensoryProfile =>
  Object.fromEntries(
    SENSORY_AXES.map((axis, index) => [axis, resolution(values[index] ?? null)]),
  ) as SensoryProfile;
void test("radar plots eight fixed axes with supported values and fixed scale", () => {
  const radar = buildSensoryRadar(profile([5, 4, 3, 2, 1, 0, 2, 0]));
  assert.ok(radar);
  assert.equal(radar.complete, true);
  assert.equal(radar.eligible, true);
  assert.equal(radar.gridPaths.length, 5);
  assert.match(radar.dataPath ?? "", /^M/u);
  assert.deepEqual(
    radar.axes.map((axis) => axis.key),
    SENSORY_AXES,
  );
  assert.equal(radar.axes.find((axis) => axis.key === "alcohol")?.value, 0);
  assert.equal(radar.axes[2]?.axisPath, "M200 200 L320 200");
});
void test("missing invalid limited and style-only profiles never get a polygon", () => {
  const partial = buildSensoryRadar(profile([5, null, 3, Number.NaN, 1, null, 2, null]));
  assert.ok(partial);
  assert.equal(partial.complete, false);
  assert.equal(partial.eligible, false);
  assert.equal(partial.dataPath, null);
  assert.equal(partial.axes.filter((axis) => axis.valuePoint !== null).length, 4);
  assert.match(partial.description, /4 of eight/u);
  assert.equal(partial.axes.find((axis) => axis.key === "hops")?.percent, null);
  assert.equal(buildSensoryRadar(null), null);
  const full = profile([1, 2, 3, 4, 1, 2, 3, 4]);
  const style = Object.fromEntries(
    SENSORY_AXES.map((axis) => [
      axis,
      { ...full[axis], source: "style_baseline", support: "limited" },
    ]),
  ) as SensoryProfile;
  assert.equal(buildSensoryRadar(style)?.dataPath, null);
  const limited = {
    ...full,
    hops: { ...full.hops, source: "recipe_prediction" as const, support: "limited" as const },
  };
  assert.equal(buildSensoryRadar(limited)?.dataPath, null);
});
void test("bands distinguish zero unknown manual and expected dry finish", () => {
  assert.equal(sensoryBand("roast", 0), "None expected");
  assert.equal(sensoryBand("roast", 0, true), "Manual zero");
  assert.equal(sensoryBand("sweetness", 0.4), "Dry expected finish");
  assert.equal(sensoryBand("roast", null), "Unknown");
});
