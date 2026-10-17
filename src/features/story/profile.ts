import {
  adaptLegacyBrewingInputs,
  normalizeCustomBrewingInputs,
} from "../beverages/brewing-inputs.ts";
import type {
  SensoryAxis,
  SensoryPredictionMap,
  SensoryProfile,
  SensoryProfileInput,
  PublicFlavorGuidance,
  FlavorCalculation,
} from "./types.ts";
import { resolveFlavorProfile as calculate, sensoryBand, styleBaseline } from "./flavor/engine.ts";
import { finite } from "./flavor/math.ts";
export { sensoryBand } from "./flavor/engine.ts";
export function canonicalSensoryToPublic(value: number): number | null {
  return finite(value) && value >= 0 && value <= 10 ? value / 2 : null;
}
function inputFor(input: SensoryProfileInput | null | undefined): SensoryProfileInput {
  if (!input) return {};
  if (input.brewingInputs) return input;
  const brewingInputs =
    input.recipe &&
    typeof input.recipe === "object" &&
    Object.hasOwn(input.recipe, "ingredients") &&
    Array.isArray((input.recipe as Record<string, unknown>)["ingredients"])
      ? normalizeCustomBrewingInputs(input.recipe, input)
      : adaptLegacyBrewingInputs(input.recipe ?? {}, input);
  return { ...input, brewingInputs };
}
export function resolveFlavorProfile(
  input: SensoryProfileInput | null | undefined,
): FlavorCalculation {
  return calculate(inputFor(input));
}
export function resolveSensoryProfile(
  input: SensoryProfileInput | null | undefined,
): SensoryProfile {
  return resolveFlavorProfile(input).profile;
}
export function publicFlavorGuidance(
  calculation: FlavorCalculation,
  includeProcessTags = false,
): PublicFlavorGuidance {
  return {
    descriptors: calculation.descriptors.map(({ label, role }) => ({ label, role })),
    processTags: includeProcessTags ? calculation.processTags : [],
    summary: flavorSummary(calculation),
    modelVersion: calculation.modelVersion,
    catalogVersion: calculation.catalogVersion,
    incomplete: Object.values(calculation.axes).some(
      (axis) => axis.value === null || axis.support !== "supported",
    ),
  };
}
function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
const FINISH: Readonly<Record<string, string>> = {
  "Very dry expected finish": "a very dry finish",
  "Dry expected finish": "a dry finish",
  Low: "a lightly sweet finish",
  Moderate: "a moderately sweet finish",
  High: "a sweet finish",
  "Very high": "a very sweet finish",
};
/** One sentence from the effective axes and top descriptors, worded like the bar bands. It names
 * no style, ABV or IBU, so the sensory reveal alone governs it under Mystery. */
export function flavorSummary(calculation: FlavorCalculation): string | null {
  const value = (axis: SensoryAxis) => calculation.profile[axis].value;
  const band = (axis: SensoryAxis) => sensoryBand(axis, value(axis)).toLowerCase();
  const body = value("body"),
    bitterness = value("bitterness"),
    tartness = value("tartness"),
    sweetness = value("sweetness");
  const clauses = [
    body ? `a ${band("body")} body` : null,
    bitterness ? `${band("bitterness")} bitterness` : null,
    tartness !== null && tartness >= 1 ? `${band("tartness")} tartness` : null,
    sweetness === null ? null : FINISH[sensoryBand("sweetness", sweetness)]!,
  ].filter((clause): clause is string => clause !== null);
  const character = calculation.descriptors.slice(0, 3).map(({ label }) => label);
  const lead = character.length
    ? `${listed(character)} character${clauses.length ? ` with ${listed(clauses)}` : ""}.`
    : clauses.length >= 2
      ? `${listed(clauses)}.`
      : null;
  if (lead === null) return null;
  const alcohol = value("alcohol");
  const warmth = alcohol !== null && alcohol >= 2.5 ? " Noticeable alcohol warmth." : "";
  return `${lead[0]!.toUpperCase()}${lead.slice(1)}${warmth}`;
}
export function styleBaselineFor(style: unknown, _strength?: unknown): SensoryPredictionMap {
  return styleBaseline(style);
}
export function deriveAttenuation(ogOrInput: unknown, finalGravity?: unknown): number | null {
  const object =
    typeof ogOrInput === "object" && ogOrInput !== null
      ? (ogOrInput as Record<string, unknown>)
      : null;
  const og = object?.["og"] ?? ogOrInput,
    fg = object?.["fg"] ?? finalGravity;
  return finite(og) && og > 1 && finite(fg) ? (100 * (og - fg)) / (og - 1) : null;
}
export const resolveSensoryAxis = (input: SensoryProfileInput, axisKey: SensoryAxis) =>
  resolveSensoryProfile(input)[axisKey];
