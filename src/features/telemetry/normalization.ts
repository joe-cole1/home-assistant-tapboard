import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../shared/canonical-json.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type {
  ExternalTelemetrySampleInput,
  ExternalTelemetryRequestInput,
  MassUnit,
  NormalizedTelemetrySample,
  PercentageUnit,
  TemperatureUnit,
  VolumeUnit,
} from "./types.ts";
import { TELEMETRY_NORMALIZATION_VERSION as NORMALIZATION_VERSION } from "./types.ts";

export { canonicalizeJson };
export { TELEMETRY_NORMALIZATION_VERSION } from "./types.ts";
export type { MassUnit, VolumeUnit, TemperatureUnit, PercentageUnit, NormalizedTelemetrySample };

const CANONICAL_DECIMAL_PLACES = 6;

// RFC3339 timestamp with the machine API's strict grammar: uppercase T,
// explicit uppercase Z or a complete +/-HH:MM offset.
const RFC3339_EXPLICIT_OFFSET_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const CLIENT_SAMPLE_ID_REGEX = /^[A-Za-z0-9_.:\/-]{1,128}$/;

const MASS_FACTORS_TO_GRAMS: Record<MassUnit, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

const VOLUME_FACTORS_TO_MILLILITERS: Record<VolumeUnit, number> = {
  ml: 1,
  l: 1000,
  us_fl_oz: 29.5735295625,
  us_gal: 3785.411784,
};

export function roundCanonicalNumber(
  value: number,
  decimals: number = CANONICAL_DECIMAL_PLACES,
): number {
  if (!Number.isFinite(value)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_number",
      clientMessage: "Measurement value must be a finite number.",
    });
  }
  const factor = 10 ** decimals;
  const shifted = (value + Number.EPSILON) * factor;
  if (!Number.isFinite(shifted)) {
    return value;
  }
  return Math.round(shifted) / factor;
}

export function parseRfc3339Timestamp(measuredAtRaw: unknown): {
  readonly isoString: string;
  readonly measuredAtEpochMs: number;
} {
  if (typeof measuredAtRaw !== "string" || measuredAtRaw.trim().length === 0) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.missing_measured_at",
      clientMessage: "Measurement timestamp 'measuredAt' is required.",
    });
  }

  if (!RFC3339_EXPLICIT_OFFSET_REGEX.test(measuredAtRaw)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_timestamp_format",
      clientMessage:
        "Measurement timestamp must be an RFC3339/ISO-8601 string with an explicit timezone offset.",
    });
  }

  const parts = RFC3339_EXPLICIT_OFFSET_REGEX.exec(measuredAtRaw);
  // The lexical check above is intentionally followed by calendar/range
  // checks because Date.parse normalizes some impossible calendar dates.
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  const hour = Number(parts?.[4]);
  const minute = Number(parts?.[5]);
  const second = Number(parts?.[6]);
  const offset = parts?.[8];
  const offsetHour = offset === "Z" ? 0 : Number(offset?.slice(1, 3));
  const offsetMinute = offset === "Z" ? 0 : Number(offset?.slice(4, 6));
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_timestamp",
      clientMessage: "Measurement timestamp is not a valid RFC3339 calendar instant.",
    });
  }

  const epochMs = Date.parse(measuredAtRaw);
  if (!Number.isSafeInteger(epochMs)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_timestamp",
      clientMessage: "Measurement timestamp is not a valid RFC3339 calendar instant.",
    });
  }

  const isoString = new Date(epochMs).toISOString();
  return { isoString, measuredAtEpochMs: epochMs };
}

export function isValidClientSampleId(clientSampleId: unknown): boolean {
  if (typeof clientSampleId !== "string") {
    return false;
  }
  if (Buffer.byteLength(clientSampleId, "utf8") > 128) {
    return false;
  }
  return CLIENT_SAMPLE_ID_REGEX.test(clientSampleId);
}

function mapMachineRequestToInternal(
  input: ExternalTelemetryRequestInput,
): ExternalTelemetrySampleInput {
  const measurement = input.measurement;
  if (!measurement || typeof measurement !== "object" || Array.isArray(measurement)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_payload",
      clientMessage: "Telemetry measurement must be a non-null object.",
    });
  }

  const primary =
    measurement.kind === "total_weight"
      ? { totalWeight: { value: measurement.value, unit: measurement.unit } }
      : measurement.kind === "remaining_volume"
        ? { remainingVolume: { value: measurement.value, unit: measurement.unit } }
        : {
            fillPercentage: {
              value: measurement.value,
              unit: measurement.unit,
            },
          };

  return {
    ...(input.client_sample_id !== undefined ? { clientSampleId: input.client_sample_id } : {}),
    measuredAt: input.measured_at,
    ...primary,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
}

export function normalizeExternalTelemetrySample(
  input: ExternalTelemetrySampleInput | ExternalTelemetryRequestInput,
): NormalizedTelemetrySample {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_payload",
      clientMessage: "Telemetry sample payload must be a non-null object.",
    });
  }

  const inputRecord = input as unknown as Readonly<Record<string, unknown>>;
  const internalInput =
    "measurement" in inputRecord || "measured_at" in inputRecord
      ? mapMachineRequestToInternal(input as ExternalTelemetryRequestInput)
      : (input as ExternalTelemetrySampleInput);

  // 1. Validate clientSampleId
  let clientSampleId: string | undefined;
  if (internalInput.clientSampleId !== undefined) {
    if (
      typeof internalInput.clientSampleId !== "string" ||
      !isValidClientSampleId(internalInput.clientSampleId)
    ) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.invalid_client_sample_id",
        clientMessage:
          "Client sample ID must be 1-128 characters containing only alphanumeric characters, underscores, dashes, dots, colons, or slashes.",
      });
    }
    clientSampleId = internalInput.clientSampleId;
  }

  // 2. Parse measuredAt
  const { isoString: measuredAt, measuredAtEpochMs } = parseRfc3339Timestamp(
    internalInput.measuredAt,
  );

  // 3. Normalize primary measurement
  const hasWeight = internalInput.totalWeight !== undefined;
  const hasVolume = internalInput.remainingVolume !== undefined;
  const hasPercentage = internalInput.fillPercentage !== undefined;

  const primaryCount = (hasWeight ? 1 : 0) + (hasVolume ? 1 : 0) + (hasPercentage ? 1 : 0);
  if (primaryCount !== 1) {
    throw new ApplicationError({
      category: "validation",
      code: "telemetry.invalid_primary_measurement",
      clientMessage:
        "Sample must contain exactly one primary measurement: totalWeight, remainingVolume, or fillPercentage.",
    });
  }

  let totalMassG: number | undefined;
  let remainingVolumeMl: number | undefined;
  let fillPercentage: number | undefined;
  let primaryKind: "total_weight" | "remaining_volume" | "fill_percentage";

  if (internalInput.totalWeight !== undefined) {
    primaryKind = "total_weight";
    const { value, unit } = internalInput.totalWeight;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.invalid_weight_value",
        clientMessage: "Total weight value must be a non-negative finite number.",
      });
    }
    if (typeof unit !== "string" || !(unit in MASS_FACTORS_TO_GRAMS)) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.unsupported_weight_unit",
        clientMessage: `Unsupported total weight unit: '${String(unit)}'. Supported: g, kg, oz, lb.`,
      });
    }
    const factor = MASS_FACTORS_TO_GRAMS[unit];
    totalMassG = roundCanonicalNumber(value * factor);
  } else if (internalInput.remainingVolume !== undefined) {
    primaryKind = "remaining_volume";
    const { value, unit } = internalInput.remainingVolume;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.invalid_volume_value",
        clientMessage: "Remaining volume value must be a non-negative finite number.",
      });
    }
    if (typeof unit !== "string" || !(unit in VOLUME_FACTORS_TO_MILLILITERS)) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.unsupported_volume_unit",
        clientMessage: `Unsupported remaining volume unit: '${String(unit)}'. Supported: ml, l, us_fl_oz, us_gal.`,
      });
    }
    const factor = VOLUME_FACTORS_TO_MILLILITERS[unit];
    remainingVolumeMl = roundCanonicalNumber(value * factor);
  } else {
    primaryKind = "fill_percentage";
    const raw = internalInput.fillPercentage;
    let pctValue: number;
    if (typeof raw === "number") {
      pctValue = raw;
    } else if (raw && typeof raw === "object" && typeof raw.value === "number") {
      pctValue = raw.value;
    } else {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.invalid_percentage_value",
        clientMessage: "Fill percentage must be a number or { value, unit? } object.",
      });
    }

    if (!Number.isFinite(pctValue) || pctValue < 0 || pctValue > 100) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.invalid_percentage_range",
        clientMessage: "Fill percentage must be a finite number between 0 and 100.",
      });
    }
    fillPercentage = roundCanonicalNumber(pctValue);
  }

  // 4. Normalize temperature if present
  let temperatureC: number | undefined;
  if (internalInput.temperature !== undefined) {
    const { value, unit } = internalInput.temperature;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.invalid_temperature_value",
        clientMessage: "Temperature value must be a valid finite number.",
      });
    }

    let tempConverted: number;
    if (unit === "c") {
      tempConverted = value;
    } else if (unit === "f") {
      tempConverted = ((value - 32) * 5) / 9;
    } else {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.unsupported_temperature_unit",
        clientMessage: `Unsupported temperature unit: '${String(unit)}'. Supported: c, f.`,
      });
    }

    if (tempConverted < -273.15 || tempConverted > 1000) {
      throw new ApplicationError({
        category: "validation",
        code: "telemetry.temperature_out_of_bounds",
        clientMessage: "Temperature is outside defensible range (-273.15C to 1000C).",
      });
    }
    temperatureC = roundCanonicalNumber(tempConverted);
  }

  return {
    ...(clientSampleId !== undefined ? { clientSampleId } : {}),
    measuredAt,
    measuredAtEpochMs,
    normalizationVersion: NORMALIZATION_VERSION,
    primaryKind,
    ...(totalMassG !== undefined ? { totalMassG } : {}),
    ...(remainingVolumeMl !== undefined ? { remainingVolumeMl } : {}),
    ...(fillPercentage !== undefined ? { fillPercentage } : {}),
    ...(temperatureC !== undefined ? { temperatureC } : {}),
  };
}

export function computeSemanticPayloadDigest(
  sample: NormalizedTelemetrySample,
  tapId: string,
): string {
  const canonicalObject = {
    fill_percentage: sample.fillPercentage ?? null,
    measured_at_epoch_ms: sample.measuredAtEpochMs,
    normalization_version: NORMALIZATION_VERSION,
    primary_kind: sample.primaryKind,
    remaining_volume_ml: sample.remainingVolumeMl ?? null,
    tap_id: tapId,
    temperature_c: sample.temperatureC ?? null,
    total_mass_g: sample.totalMassG ?? null,
  };

  const jsonString = canonicalizeJson(canonicalObject);
  return createHash("sha256").update(jsonString, "utf8").digest("hex");
}
