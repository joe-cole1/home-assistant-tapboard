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
import {
  resolveFlavorProfile as calculate,
  styleBaseline,
  STYLE_BASELINES,
} from "./flavor/engine.ts";
import { finite } from "./flavor/math.ts";
export { interpolateCurve } from "./flavor/math.ts";
export { MODEL_VERSION, sensoryBand } from "./flavor/engine.ts";
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
    summary: calculation.descriptors.length
      ? "Expected character from the recorded recipe and batch data."
      : null,
    modelVersion: calculation.modelVersion,
    catalogVersion: calculation.catalogVersion,
    incomplete: Object.values(calculation.axes).some(
      (axis) => axis.value === null || axis.support !== "supported",
    ),
  };
}
export function styleBaselineFor(style: unknown, _strength?: unknown): SensoryPredictionMap {
  return styleBaseline(style);
}
export const STYLE_BASELINE_RULES = STYLE_BASELINES;
export function deriveAttenuation(ogOrInput: unknown, finalGravity?: unknown): number | null {
  const object =
    typeof ogOrInput === "object" && ogOrInput !== null
      ? (ogOrInput as Record<string, unknown>)
      : null;
  const og = object?.["og"] ?? ogOrInput,
    fg = object?.["fg"] ?? finalGravity;
  return finite(og) && og > 1 && finite(fg) ? (100 * (og - fg)) / (og - 1) : null;
}
function axis(input: unknown, key: SensoryAxis): number | null {
  return resolveFlavorProfile(
    typeof input === "object" && input !== null ? (input as SensoryProfileInput) : {},
  ).axes[key].value;
}
export const predictBitterness = (input: unknown) => axis(input, "bitterness");
export const predictSweetness = (input: unknown) => axis(input, "sweetness");
export const predictBody = (input: unknown) => axis(input, "body");
export const predictRoast = (input: unknown) => axis(input, "roast");
export const predictTartness = (input: unknown) => axis(input, "tartness");
export const predictAlcohol = (input: unknown) => axis(input, "alcohol");
export const calculateSensoryProfile = resolveSensoryProfile;
export const deriveSensoryProfile = resolveSensoryProfile;
export const predictSensoryProfile = resolveSensoryProfile;
export const computeSensoryProfile = resolveSensoryProfile;
export const resolveSensory = resolveSensoryProfile;
export const resolveSensoryAxis = (input: SensoryProfileInput, axisKey: SensoryAxis) =>
  resolveSensoryProfile(input)[axisKey];
export const calculateBitterness = predictBitterness;
export const calculateSweetness = predictSweetness;
export const calculateBody = predictBody;
export const calculateRoast = predictRoast;
export const calculateTartness = predictTartness;
export const calculateAlcohol = predictAlcohol;
export type { SensoryAxis, SensoryProfile, SensoryProfileInput };
