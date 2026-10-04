import { sensoryBand } from "./profile.ts";
export { sensoryBand } from "./profile.ts";
import { SENSORY_AXES, type SensoryAxis, type SensoryProfile } from "./types.ts";
const CENTER = 200;
const RADIUS = 120;
const MAX = 5;
export const SENSORY_LABELS: Readonly<Record<SensoryAxis, string>> = {
  malt: "Malt character",
  hops: "Hop character",
  bitterness: "Bitterness",
  sweetness: "Sweetness",
  body: "Body",
  roast: "Roast",
  tartness: "Tartness",
  alcohol: "Alcohol warmth",
};
export interface SensoryRadarAxisView {
  readonly key: SensoryAxis;
  readonly label: string;
  readonly value: number | null;
  readonly source: string;
  readonly confidence: null;
  readonly band: string;
  readonly percent: number | null;
  readonly axisPath: string;
  readonly valuePoint: string | null;
  readonly labelX: number;
  readonly labelY: number;
}
export interface SensoryRadarView {
  readonly gridPaths: readonly string[];
  readonly axes: readonly SensoryRadarAxisView[];
  readonly dataPath: string | null;
  readonly complete: boolean;
  readonly eligible: boolean;
  readonly description: string;
}
function point(index: number, radius: number): [number, number] {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / SENSORY_AXES.length;
  return [
    Math.round((CENTER + Math.cos(angle) * radius) * 100) / 100,
    Math.round((CENTER + Math.sin(angle) * radius) * 100) / 100,
  ];
}
function path(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ") + " Z";
}
function validValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX
    ? value
    : null;
}
/** Only finite, supported, complete profiles can form a fixed eight-axis polygon. */
export function buildSensoryRadar(profile: SensoryProfile | null): SensoryRadarView | null {
  if (profile === null) return null;
  const axes = SENSORY_AXES.map((key, index): SensoryRadarAxisView => {
    const result = profile[key];
    const value = validValue(result?.value);
    const [x, y] = point(index, RADIUS);
    const [labelX, labelY] = point(index, RADIUS + 36);
    return {
      key,
      label: SENSORY_LABELS[key],
      value,
      source: result?.source ?? "unavailable",
      confidence: null,
      band: sensoryBand(key, value, result?.source === "manual"),
      percent: value === null ? null : (value / MAX) * 100,
      axisPath: `M${CENTER} ${CENTER} L${x} ${y}`,
      valuePoint: value === null ? null : point(index, (RADIUS * value) / MAX).join(" "),
      labelX,
      labelY,
    };
  });
  const complete = axes.every((axis) => axis.value !== null);
  const eligible =
    complete &&
    SENSORY_AXES.every(
      (key) =>
        profile[key].source === "manual" ||
        (profile[key].source === "recipe_prediction" && profile[key].support === "supported"),
    );
  const available = axes.filter((axis) => axis.value !== null).length;
  return {
    axes,
    complete,
    eligible,
    gridPaths: Array.from({ length: MAX }, (_, index) =>
      path(SENSORY_AXES.map((_, axisIndex) => point(axisIndex, (RADIUS * (index + 1)) / MAX))),
    ),
    dataPath: eligible
      ? path(axes.map((axis, index) => point(index, (RADIUS * (axis.value ?? 0)) / MAX)))
      : null,
    description: eligible
      ? "Eight flavor intensities on a fixed zero to five scale. Larger values mean stronger intensity, not better quality."
      : `${available} of eight flavor intensities are available. Unknown values are distinct from none expected; bars show available estimates.`,
  };
}
