export type Curve = readonly (readonly [number, number])[];
export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function clamp(value: number, minimum = 0, maximum = 5): number {
  return Math.max(minimum, Math.min(maximum, value));
}
export function validateCurve(curve: Curve): void {
  if (
    curve.length < 2 ||
    curve.some(([x, y], i) => !finite(x) || !finite(y) || (i > 0 && x <= curve[i - 1]![0]))
  )
    throw new Error("Invalid flavor interpolation curve.");
}
const fixedCurves = new WeakSet<object>();
export function defineCurve(curve: Curve): Curve {
  validateCurve(curve);
  const frozen = Object.freeze(curve.map((point) => Object.freeze([point[0], point[1]] as const)));
  fixedCurves.add(frozen);
  return frozen;
}
export function interpolateCurve(value: number, curve: Curve): number | null {
  if (!fixedCurves.has(curve)) validateCurve(curve);
  if (!finite(value)) return null;
  if (value <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [x, y] = curve[i]!;
    const [px, py] = curve[i - 1]!;
    if (value <= x) return py + ((y - py) * (value - px)) / (x - px);
  }
  return curve.at(-1)![1];
}
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
