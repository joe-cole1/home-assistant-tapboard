import type { SensoryAxis, SensoryProfile } from "./types.ts";

const CENTER = 180;
const RADIUS = 110;
const MAX = 5;
const ORDER: readonly SensoryAxis[] = [
  "bitterness",
  "roast",
  "body",
  "sweetness",
  "tartness",
  "alcohol",
];

export interface SensoryRadarAxisView {
  readonly key: SensoryAxis;
  readonly label: string;
  readonly value: number | null;
  readonly source: string;
  readonly confidence: string | null;
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
  readonly description: string;
}

function point(axisIndex: number, radius: number): [number, number] {
  const angle = -Math.PI / 2 + (axisIndex * Math.PI) / 3;
  return [
    Math.round((CENTER + Math.cos(angle) * radius) * 100) / 100,
    Math.round((CENTER + Math.sin(angle) * radius) * 100) / 100,
  ];
}

function path(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join(" ") + " Z";
}

function label(key: SensoryAxis): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function validValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX
    ? value
    : null;
}

/** Build a finite, accessible, fixed-scale public sensory chart projection. */
export function buildSensoryRadar(profile: SensoryProfile | null): SensoryRadarView | null {
  if (profile === null) return null;
  const gridPaths = Array.from({ length: MAX }, (_, index) =>
    path(ORDER.map((_, axisIndex) => point(axisIndex, (RADIUS * (index + 1)) / MAX))),
  );
  const axes = ORDER.map((key, axisIndex): SensoryRadarAxisView => {
    const [axisX, axisY] = point(axisIndex, RADIUS);
    const [labelX, labelY] = point(axisIndex, RADIUS + 28);
    const result = profile[key];
    const value = validValue(result?.value);
    const valuePoint = value === null ? null : point(axisIndex, (RADIUS * value) / MAX).join(" ");
    return {
      key,
      label: label(key),
      value,
      source: result?.source.replace(/_/gu, " ") ?? "unavailable",
      confidence: result?.confidence ?? null,
      axisPath: `M${CENTER} ${CENTER} L${axisX} ${axisY}`,
      valuePoint,
      labelX,
      labelY,
    };
  });
  const values = axes
    .filter((axis) => axis.value !== null)
    .map((axis) => point(ORDER.indexOf(axis.key), (RADIUS * (axis.value ?? 0)) / MAX));
  const complete = values.length === ORDER.length;
  const dataPath = complete ? path(values) : null;
  const available = axes.filter((axis) => axis.value !== null).length;
  const description = complete
    ? "Six-axis sensory profile on a fixed zero to five scale."
    : available === 0
      ? "Sensory values are unavailable."
      : `${available} of ${ORDER.length} sensory values are available; missing values are not plotted.`;
  return { gridPaths, axes, dataPath, complete, description };
}
