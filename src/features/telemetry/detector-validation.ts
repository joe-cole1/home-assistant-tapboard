import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import {
  DETECTOR_CONFIG_FIELDS,
  type DetectorConfig,
  type DetectorConfigOverride,
} from "./detector-config.ts";
import { validateTapId } from "./telemetry-validation.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG_FIELDS: readonly string[] = DETECTOR_CONFIG_FIELDS;
const INTEGER_FIELDS = new Set([
  "candidateSamples",
  "candidateSampleWindowMs",
  "candidateLookbackMs",
  "arbitrationMs",
  "quietPeriodMs",
  "hardTimeoutMs",
  "jumpStableSamples",
  "jumpStableSpanMs",
  "baselineSamples",
  "baselineSpanMs",
  "settledSamples",
  "settledSpanMs",
  "cooldownMs",
  "historyMs",
]);
const NONNEGATIVE_FIELDS = new Set([
  "candidateSampleWindowMs",
  "candidateLookbackMs",
  "arbitrationMs",
  "quietPeriodMs",
  "jumpStableSpanMs",
  "jumpBandMl",
  "baselineSpanMs",
  "baselineBandMl",
  "settledSpanMs",
  "settledBandMl",
  "cooldownMs",
]);

function invalid(field: string, reason: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

function requireNonemptyObject(input: unknown): Record<string, unknown> {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, CONFIG_FIELDS, "body");
  if (Object.keys(object).length === 0) invalid("body", "must not be empty");
  return object;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    invalid(field, "must be a finite number");
  return value;
}

export function validateGlobalDetectorConfigPatch(input: unknown): Partial<DetectorConfig> {
  const object = requireNonemptyObject(input);
  const result: { -readonly [K in keyof DetectorConfig]?: DetectorConfig[K] } = {};
  for (const field of DETECTOR_CONFIG_FIELDS) {
    if (object[field] !== undefined) result[field] = finiteNumber(object[field], field);
  }
  return result;
}

/** Validates the complete effective global configuration before the service persists it. */
export function validateCompleteDetectorConfig(config: DetectorConfig): void {
  for (const field of DETECTOR_CONFIG_FIELDS) {
    const value = config[field];
    if (!Number.isFinite(value)) invalid(field, "must be a finite number");
    if (INTEGER_FIELDS.has(field) && !Number.isSafeInteger(value))
      invalid(field, "must be a safe integer");
    if (NONNEGATIVE_FIELDS.has(field) ? value < 0 : value <= 0)
      invalid(field, "is outside its allowed range");
  }
  if (config.arbitrationDominanceRatio < 1)
    invalid("arbitrationDominanceRatio", "must be at least 1");
  if (config.candidateSampleWindowMs > config.candidateLookbackMs)
    invalid("candidateSampleWindowMs", "must not exceed candidateLookbackMs");
  if (config.quietPeriodMs > config.hardTimeoutMs)
    invalid("quietPeriodMs", "must not exceed hardTimeoutMs");
  if (config.historyMs < config.candidateLookbackMs)
    invalid("historyMs", "must not be less than candidateLookbackMs");
}

export function validateDetectorTapOverridePatch(input: unknown): DetectorConfigOverride {
  const object = requireNonemptyObject(input);
  const result: { -readonly [K in keyof DetectorConfig]?: DetectorConfig[K] | null } = {};
  for (const field of DETECTOR_CONFIG_FIELDS) {
    if (object[field] !== undefined)
      result[field] = object[field] === null ? null : finiteNumber(object[field], field);
  }
  return result;
}

function validateGroupName(value: unknown): string {
  if (typeof value !== "string") invalid("name", "must be a string");
  const name = value.trim();
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes < 1 || bytes > 128) invalid("name", "must contain between 1 and 128 UTF-8 bytes");
  return name;
}

function validateTapIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 1000)
    invalid("tapIds", "must be an array containing at most 1000 Tap IDs");
  const tapIds = value.map((tapId, index) => validateTapId(tapId, `tapIds[${index}]`));
  if (new Set(tapIds).size !== tapIds.length)
    invalid("tapIds", "must not contain duplicate Tap IDs");
  return tapIds;
}

export function validateDetectorArbitrationGroupCreate(input: unknown): {
  readonly name: string;
  readonly tapIds: readonly string[];
} {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["name", "tapIds"], "body");
  return { name: validateGroupName(object.name), tapIds: validateTapIds(object.tapIds) };
}

export function validateDetectorArbitrationGroupPatch(input: unknown): {
  readonly name?: string;
  readonly tapIds?: readonly string[];
} {
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, ["name", "tapIds"], "body");
  if (Object.keys(object).length === 0) invalid("body", "must not be empty");
  return {
    ...(object.name !== undefined ? { name: validateGroupName(object.name) } : {}),
    ...(object.tapIds !== undefined ? { tapIds: validateTapIds(object.tapIds) } : {}),
  };
}

export function validateDetectorGroupId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim()))
    invalid(field, "must be a valid UUID");
  return value.trim().toLowerCase();
}

export function validateEmptyOptionalBody(input: unknown): void {
  if (input === undefined) return;
  const object = requirePlainObject(input, "body");
  rejectUnknownKeys(object, [], "body");
}
