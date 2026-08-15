import { ApplicationError } from "../../shared/errors.ts";
import {
  rejectUnknownKeys,
  requireBoundedNonemptyString,
  requireIntegerInRange,
  requirePlainObject,
} from "../../shared/validation.ts";
import {
  isValidClientSampleId,
  parseRfc3339Timestamp,
  type MassUnit,
  type PercentageUnit,
  type TemperatureUnit,
  type VolumeUnit,
} from "./normalization.ts";
import type {
  AssignAuthorityInput,
  CreateTelemetrySourceInput,
  ExternalBatchTelemetryInput,
  ExternalBatchTelemetrySampleInput,
  ExternalBatchTelemetryRequestInput,
  ExternalBatchTelemetryRequestSampleInput,
  ExternalTelemetryMeasurementInput,
  ExternalTelemetryRequestInput,
  ExternalTelemetrySampleInput,
  RenameTelemetrySourceInput,
  RotateTelemetrySourceInput,
  UpdateTelemetrySettingsInput,
} from "./types.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SOURCE_NAME_LENGTH = 120;
const MAX_MACHINE_KEY_LABEL_LENGTH = 120;
const VALID_MASS_UNITS = new Set<MassUnit>(["g", "kg", "oz", "lb"]);
const VALID_VOLUME_UNITS = new Set<VolumeUnit>(["ml", "l", "us_fl_oz", "us_gal"]);
const VALID_TEMP_UNITS = new Set<TemperatureUnit>(["c", "f"]);
const VALID_PERCENT_UNITS = new Set<string>(["percent", "pct", "%"]);
const VALID_EXTERNAL_PERCENT_UNIT = "percent" as const;
const MAX_EXTERNAL_BATCH_SIZE = 100;

function validationError(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

export function validateTelemetrySourceId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim())) {
    throw validationError(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}

export function validateTapId(value: unknown, field = "tapId"): string {
  if (typeof value !== "string" || !UUID_REGEX.test(value.trim())) {
    throw validationError(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}

export function validateTapNumber(value: unknown, field = "tapNumber"): number {
  return requireIntegerInRange(value, field, 1, 1_000_000);
}

export function validateCreateTelemetrySourceInput(input: unknown): CreateTelemetrySourceInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["name", "label"], "body");

  const name = requireBoundedNonemptyString(obj.name, "name", {
    maxLength: MAX_SOURCE_NAME_LENGTH,
  });
  if (Buffer.byteLength(name, "utf8") > MAX_SOURCE_NAME_LENGTH) {
    throw validationError("name", `must not exceed ${MAX_SOURCE_NAME_LENGTH} UTF-8 bytes`);
  }

  let label: string | undefined;
  if (obj.label !== undefined) {
    label = requireBoundedNonemptyString(obj.label, "label", {
      maxLength: MAX_MACHINE_KEY_LABEL_LENGTH,
    });
    if (Buffer.byteLength(label, "utf8") > MAX_MACHINE_KEY_LABEL_LENGTH) {
      throw validationError("label", `must not exceed ${MAX_MACHINE_KEY_LABEL_LENGTH} UTF-8 bytes`);
    }
  }

  return {
    name,
    ...(label !== undefined ? { label } : {}),
  };
}

export function validateRenameTelemetrySourceInput(input: unknown): RenameTelemetrySourceInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["name"], "body");

  const name = requireBoundedNonemptyString(obj.name, "name", {
    maxLength: MAX_SOURCE_NAME_LENGTH,
  });
  if (Buffer.byteLength(name, "utf8") > MAX_SOURCE_NAME_LENGTH) {
    throw validationError("name", `must not exceed ${MAX_SOURCE_NAME_LENGTH} UTF-8 bytes`);
  }

  return { name };
}

export function validateRotateTelemetrySourceInput(input: unknown): RotateTelemetrySourceInput {
  if (input === undefined || input === null || input === "") {
    return {};
  }
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["label"], "body");

  let label: string | undefined;
  if (obj.label !== undefined) {
    label = requireBoundedNonemptyString(obj.label, "label", {
      maxLength: MAX_MACHINE_KEY_LABEL_LENGTH,
    });
    if (Buffer.byteLength(label, "utf8") > MAX_MACHINE_KEY_LABEL_LENGTH) {
      throw validationError("label", `must not exceed ${MAX_MACHINE_KEY_LABEL_LENGTH} UTF-8 bytes`);
    }
  }

  return {
    ...(label !== undefined ? { label } : {}),
  };
}

export function validateAssignAuthorityInput(input: unknown): AssignAuthorityInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["sourceId"], "body");

  let sourceId: string | null = null;
  if (obj.sourceId !== undefined && obj.sourceId !== null && obj.sourceId !== "") {
    sourceId = validateTelemetrySourceId(obj.sourceId, "sourceId");
  }

  return { sourceId };
}

export function validateUpdateTelemetrySettingsInput(input: unknown): UpdateTelemetrySettingsInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(
    obj,
    [
      "maxBatchSize",
      "maxFutureSkewSeconds",
      "reconnectHorizonSeconds",
      "rawRetentionSeconds",
      "receiptRetentionSeconds",
      "rateLimitSamplesPerMinute",
      "rateLimitBurstSamples",
    ],
    "body",
  );

  let maxBatchSize: number | undefined;
  let maxFutureSkewSeconds: number | undefined;
  let reconnectHorizonSeconds: number | undefined;
  let rawRetentionSeconds: number | undefined;
  let receiptRetentionSeconds: number | undefined;
  let rateLimitSamplesPerMinute: number | undefined;
  let rateLimitBurstSamples: number | undefined;

  if (obj.maxBatchSize !== undefined) {
    maxBatchSize = requireIntegerInRange(obj.maxBatchSize, "maxBatchSize", 1, 100);
  }
  if (obj.maxFutureSkewSeconds !== undefined) {
    maxFutureSkewSeconds = requireIntegerInRange(
      obj.maxFutureSkewSeconds,
      "maxFutureSkewSeconds",
      0,
      3600,
    );
  }
  if (obj.reconnectHorizonSeconds !== undefined) {
    reconnectHorizonSeconds = requireIntegerInRange(
      obj.reconnectHorizonSeconds,
      "reconnectHorizonSeconds",
      60,
      86400,
    );
  }
  if (obj.rawRetentionSeconds !== undefined) {
    rawRetentionSeconds = requireIntegerInRange(
      obj.rawRetentionSeconds,
      "rawRetentionSeconds",
      300,
      86400,
    );
  }
  if (obj.receiptRetentionSeconds !== undefined) {
    receiptRetentionSeconds = requireIntegerInRange(
      obj.receiptRetentionSeconds,
      "receiptRetentionSeconds",
      3600,
      604800,
    );
  }
  if (obj.rateLimitSamplesPerMinute !== undefined) {
    rateLimitSamplesPerMinute = requireIntegerInRange(
      obj.rateLimitSamplesPerMinute,
      "rateLimitSamplesPerMinute",
      1,
      6000,
    );
  }
  if (obj.rateLimitBurstSamples !== undefined) {
    rateLimitBurstSamples = requireIntegerInRange(
      obj.rateLimitBurstSamples,
      "rateLimitBurstSamples",
      1,
      1000,
    );
  }

  return {
    ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
    ...(maxFutureSkewSeconds !== undefined ? { maxFutureSkewSeconds } : {}),
    ...(reconnectHorizonSeconds !== undefined ? { reconnectHorizonSeconds } : {}),
    ...(rawRetentionSeconds !== undefined ? { rawRetentionSeconds } : {}),
    ...(receiptRetentionSeconds !== undefined ? { receiptRetentionSeconds } : {}),
    ...(rateLimitSamplesPerMinute !== undefined ? { rateLimitSamplesPerMinute } : {}),
    ...(rateLimitBurstSamples !== undefined ? { rateLimitBurstSamples } : {}),
  };
}

function parseClientSampleId(value: unknown, field = "clientSampleId"): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw validationError(field, "must be a string or omitted");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > 128 || !isValidClientSampleId(trimmed)) {
    throw validationError(
      field,
      "must be between 1 and 128 characters consisting of alphanumeric characters, dashes, underscores, dots, colons, or slashes",
    );
  }
  return trimmed;
}

function parseTotalWeight(
  value: unknown,
  field = "totalWeight",
): { readonly value: number; readonly unit: MassUnit } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["value", "unit"], field);

  if (typeof obj.value !== "number" || !Number.isFinite(obj.value) || obj.value < 0) {
    throw validationError(`${field}.value`, "must be a finite non-negative number");
  }
  if (typeof obj.unit !== "string" || !VALID_MASS_UNITS.has(obj.unit.toLowerCase() as MassUnit)) {
    throw validationError(`${field}.unit`, "must be one of 'g', 'kg', 'oz', 'lb'");
  }

  return {
    value: obj.value,
    unit: obj.unit.toLowerCase() as MassUnit,
  };
}

function parseRemainingVolume(
  value: unknown,
  field = "remainingVolume",
): { readonly value: number; readonly unit: VolumeUnit } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["value", "unit"], field);

  if (typeof obj.value !== "number" || !Number.isFinite(obj.value) || obj.value < 0) {
    throw validationError(`${field}.value`, "must be a finite non-negative number");
  }
  if (
    typeof obj.unit !== "string" ||
    !VALID_VOLUME_UNITS.has(obj.unit.toLowerCase() as VolumeUnit)
  ) {
    throw validationError(`${field}.unit`, "must be one of 'ml', 'l', 'us_fl_oz', 'us_gal'");
  }

  return {
    value: obj.value,
    unit: obj.unit.toLowerCase() as VolumeUnit,
  };
}

function parseFillPercentage(
  value: unknown,
  field = "fillPercentage",
): number | { readonly value: number; readonly unit?: PercentageUnit } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw validationError(field, "must be a finite number between 0 and 100");
    }
    return value;
  }

  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["value", "unit"], field);

  if (
    typeof obj.value !== "number" ||
    !Number.isFinite(obj.value) ||
    obj.value < 0 ||
    obj.value > 100
  ) {
    throw validationError(`${field}.value`, "must be a finite number between 0 and 100");
  }
  if (
    obj.unit !== undefined &&
    (typeof obj.unit !== "string" || !VALID_PERCENT_UNITS.has(obj.unit.toLowerCase()))
  ) {
    throw validationError(`${field}.unit`, "must be one of 'percent', 'pct', '%'");
  }

  return {
    value: obj.value,
    ...(obj.unit ? { unit: obj.unit.toLowerCase() as PercentageUnit } : {}),
  };
}

function parseTemperature(
  value: unknown,
  field = "temperature",
): { readonly value: number; readonly unit: TemperatureUnit } | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["value", "unit"], field);

  if (
    typeof obj.value !== "number" ||
    !Number.isFinite(obj.value) ||
    obj.value < -100 ||
    obj.value > 150
  ) {
    throw validationError(`${field}.value`, "must be a finite temperature number");
  }
  if (
    typeof obj.unit !== "string" ||
    !VALID_TEMP_UNITS.has(obj.unit.toLowerCase() as TemperatureUnit)
  ) {
    throw validationError(`${field}.unit`, "must be one of 'c', 'f'");
  }

  return {
    value: obj.value,
    unit: obj.unit.toLowerCase() as TemperatureUnit,
  };
}

export function validateSingleTelemetryPayload(
  input: unknown,
  prefix = "body",
): ExternalTelemetrySampleInput {
  const obj = requirePlainObject(input, prefix);
  rejectUnknownKeys(
    obj,
    [
      "clientSampleId",
      "measuredAt",
      "totalWeight",
      "remainingVolume",
      "fillPercentage",
      "temperature",
    ],
    prefix,
  );

  if (typeof obj.measuredAt !== "string" || obj.measuredAt.trim().length === 0) {
    throw validationError(`${prefix}.measuredAt`, "must be a valid RFC3339 timestamp string");
  }

  // Validate timestamp RFC3339 syntax early
  try {
    parseRfc3339Timestamp(obj.measuredAt);
  } catch (err) {
    throw validationError(
      `${prefix}.measuredAt`,
      err instanceof Error ? err.message : "invalid RFC3339 timestamp",
    );
  }

  const clientSampleId = parseClientSampleId(obj.clientSampleId, `${prefix}.clientSampleId`);
  const totalWeight = parseTotalWeight(obj.totalWeight, `${prefix}.totalWeight`);
  const remainingVolume = parseRemainingVolume(obj.remainingVolume, `${prefix}.remainingVolume`);
  const fillPercentage = parseFillPercentage(obj.fillPercentage, `${prefix}.fillPercentage`);
  const temperature = parseTemperature(obj.temperature, `${prefix}.temperature`);

  // Assert exclusivity of primary measurement
  const primaryCount =
    (totalWeight !== undefined ? 1 : 0) +
    (remainingVolume !== undefined ? 1 : 0) +
    (fillPercentage !== undefined ? 1 : 0);

  if (primaryCount === 0) {
    throw validationError(
      prefix,
      "must provide exactly one primary measurement (totalWeight, remainingVolume, or fillPercentage)",
    );
  }
  if (primaryCount > 1) {
    throw validationError(
      prefix,
      "cannot provide more than one primary measurement (totalWeight, remainingVolume, and fillPercentage are mutually exclusive)",
    );
  }

  return {
    ...(clientSampleId !== undefined ? { clientSampleId } : {}),
    measuredAt: obj.measuredAt.trim(),
    ...(totalWeight !== undefined ? { totalWeight } : {}),
    ...(remainingVolume !== undefined ? { remainingVolume } : {}),
    ...(fillPercentage !== undefined ? { fillPercentage } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

export function validateBatchTelemetryPayload(
  input: unknown,
  maxBatchSize: number,
): ExternalBatchTelemetryInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["samples"], "body");

  if (!Array.isArray(obj.samples)) {
    throw validationError("body.samples", "must be an array");
  }
  if (obj.samples.length === 0) {
    throw validationError("body.samples", "must contain at least 1 sample");
  }
  if (obj.samples.length > maxBatchSize) {
    throw validationError(
      "body.samples",
      `must not contain more than ${maxBatchSize} samples (received ${obj.samples.length})`,
    );
  }

  const samples: ExternalBatchTelemetrySampleInput[] = [];

  for (let i = 0; i < obj.samples.length; i++) {
    const item: unknown = obj.samples[i];
    const prefix = `body.samples[${i}]`;
    const itemObj = requirePlainObject(item, prefix);
    rejectUnknownKeys(
      itemObj,
      [
        "tapNumber",
        "tapId",
        "clientSampleId",
        "measuredAt",
        "totalWeight",
        "remainingVolume",
        "fillPercentage",
        "temperature",
      ],
      prefix,
    );

    let tapNumber: number | undefined;
    let tapId: string | undefined;

    if (itemObj.tapNumber !== undefined && itemObj.tapId !== undefined) {
      throw validationError(prefix, "must specify exactly one of tapNumber or tapId");
    }
    if (itemObj.tapNumber !== undefined) {
      tapNumber = validateTapNumber(itemObj.tapNumber, `${prefix}.tapNumber`);
    } else if (itemObj.tapId !== undefined) {
      tapId = validateTapId(itemObj.tapId, `${prefix}.tapId`);
    } else {
      throw validationError(prefix, "must specify either tapNumber or tapId");
    }

    const sampleObject = { ...itemObj };
    delete sampleObject.tapNumber;
    delete sampleObject.tapId;
    const baseSample = validateSingleTelemetryPayload(sampleObject, prefix);

    samples.push({
      ...baseSample,
      ...(tapNumber !== undefined ? { tapNumber } : {}),
      ...(tapId !== undefined ? { tapId } : {}),
    });
  }

  return { samples };
}

// --- Machine-facing v1 boundary ---

function parseExternalClientSampleId(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || !isValidClientSampleId(value)) {
    throw validationError(
      field,
      "must be a non-empty string between 1 and 128 characters consisting of alphanumeric characters, dashes, underscores, dots, colons, or slashes",
    );
  }
  return value;
}

function parseExternalMeasuredAt(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(field, "must be a valid RFC3339 timestamp string");
  }
  try {
    parseRfc3339Timestamp(value);
  } catch (err) {
    throw validationError(
      field,
      err instanceof Error ? err.message : "must be a valid RFC3339 timestamp string",
    );
  }
  return value;
}

function parseExternalMeasurement(
  value: unknown,
  field: string,
): ExternalTelemetryMeasurementInput {
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["kind", "value", "unit"], field);

  if (typeof obj.kind !== "string") {
    throw validationError(
      `${field}.kind`,
      "must be one of 'total_weight', 'remaining_volume', 'fill_percentage'",
    );
  }
  if (typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
    throw validationError(`${field}.value`, "must be a finite number");
  }
  if (obj.unit === undefined || typeof obj.unit !== "string") {
    throw validationError(`${field}.unit`, "is required");
  }

  switch (obj.kind) {
    case "total_weight":
      if (obj.value < 0) {
        throw validationError(`${field}.value`, "must be non-negative");
      }
      if (!VALID_MASS_UNITS.has(obj.unit as MassUnit)) {
        throw validationError(`${field}.unit`, "must be one of 'g', 'kg', 'oz', 'lb'");
      }
      return {
        kind: "total_weight",
        value: obj.value,
        unit: obj.unit as MassUnit,
      };
    case "remaining_volume":
      if (obj.value < 0) {
        throw validationError(`${field}.value`, "must be non-negative");
      }
      if (!VALID_VOLUME_UNITS.has(obj.unit as VolumeUnit)) {
        throw validationError(`${field}.unit`, "must be one of 'ml', 'l', 'us_fl_oz', 'us_gal'");
      }
      return {
        kind: "remaining_volume",
        value: obj.value,
        unit: obj.unit as VolumeUnit,
      };
    case "fill_percentage":
      if (obj.value < 0 || obj.value > 100) {
        throw validationError(`${field}.value`, "must be between 0 and 100");
      }
      if (obj.unit !== VALID_EXTERNAL_PERCENT_UNIT) {
        throw validationError(`${field}.unit`, "must be exactly 'percent'");
      }
      return {
        kind: "fill_percentage",
        value: obj.value,
        unit: VALID_EXTERNAL_PERCENT_UNIT,
      };
    default:
      throw validationError(
        `${field}.kind`,
        "must be one of 'total_weight', 'remaining_volume', 'fill_percentage'",
      );
  }
}

function parseExternalTemperature(
  value: unknown,
  field: string,
): { readonly value: number; readonly unit: TemperatureUnit } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const obj = requirePlainObject(value, field);
  rejectUnknownKeys(obj, ["value", "unit"], field);
  if (obj.value === undefined || typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
    throw validationError(`${field}.value`, "must be a finite number");
  }
  if (obj.value < -100 || obj.value > 150) {
    throw validationError(`${field}.value`, "must be between -100 and 150");
  }
  if (obj.unit === undefined || typeof obj.unit !== "string") {
    throw validationError(`${field}.unit`, "is required");
  }
  if (!VALID_TEMP_UNITS.has(obj.unit as TemperatureUnit)) {
    throw validationError(`${field}.unit`, "must be one of 'c', 'f'");
  }
  return { value: obj.value, unit: obj.unit as TemperatureUnit };
}

export function validateExternalTelemetryPayload(
  input: unknown,
  prefix = "body",
): ExternalTelemetryRequestInput {
  const obj = requirePlainObject(input, prefix);
  rejectUnknownKeys(obj, ["client_sample_id", "measured_at", "measurement", "temperature"], prefix);

  const measuredAt = parseExternalMeasuredAt(obj.measured_at, `${prefix}.measured_at`);
  const measurement = parseExternalMeasurement(obj.measurement, `${prefix}.measurement`);
  const clientSampleId = parseExternalClientSampleId(
    obj.client_sample_id,
    `${prefix}.client_sample_id`,
  );
  const temperature = parseExternalTemperature(obj.temperature, `${prefix}.temperature`);

  return {
    ...(clientSampleId !== undefined ? { client_sample_id: clientSampleId } : {}),
    measured_at: measuredAt,
    measurement,
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

export function validateExternalBatchTelemetryPayload(
  input: unknown,
): ExternalBatchTelemetryRequestInput {
  const obj = requirePlainObject(input, "body");
  rejectUnknownKeys(obj, ["samples"], "body");
  if (!Array.isArray(obj.samples)) {
    throw validationError("body.samples", "must be an array");
  }
  if (obj.samples.length < 1 || obj.samples.length > MAX_EXTERNAL_BATCH_SIZE) {
    throw validationError(
      "body.samples",
      `must contain between 1 and ${MAX_EXTERNAL_BATCH_SIZE} samples`,
    );
  }

  const samples: ExternalBatchTelemetryRequestSampleInput[] = [];
  for (let index = 0; index < obj.samples.length; index += 1) {
    const prefix = `body.samples[${index}]`;
    const item = requirePlainObject(obj.samples[index], prefix);
    rejectUnknownKeys(
      item,
      ["tap_number", "client_sample_id", "measured_at", "measurement", "temperature"],
      prefix,
    );
    if (
      typeof item.tap_number !== "number" ||
      !Number.isSafeInteger(item.tap_number) ||
      item.tap_number < 1 ||
      item.tap_number > 1_000_000
    ) {
      throw validationError(`${prefix}.tap_number`, "must be an integer between 1 and 1000000");
    }

    const tapNumber = item.tap_number;
    const sampleBody = { ...item };
    delete sampleBody.tap_number;
    const sample = validateExternalTelemetryPayload(sampleBody, prefix);
    samples.push({ ...sample, tap_number: tapNumber });
  }

  return { samples };
}

export function mapExternalTelemetryPayloadToInternal(
  input: ExternalTelemetryRequestInput,
): ExternalTelemetrySampleInput {
  const measurement = input.measurement;
  const primary =
    measurement.kind === "total_weight"
      ? { totalWeight: { value: measurement.value, unit: measurement.unit } }
      : measurement.kind === "remaining_volume"
        ? { remainingVolume: { value: measurement.value, unit: measurement.unit } }
        : { fillPercentage: { value: measurement.value, unit: measurement.unit } };

  return {
    ...(input.client_sample_id !== undefined ? { clientSampleId: input.client_sample_id } : {}),
    measuredAt: input.measured_at,
    ...primary,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
}

export function mapExternalBatchTelemetryPayloadToInternal(
  input: ExternalBatchTelemetryRequestInput,
): ExternalBatchTelemetryInput {
  return {
    samples: input.samples.map((sample) => ({
      ...mapExternalTelemetryPayloadToInternal(sample),
      tapNumber: sample.tap_number,
    })),
  };
}
