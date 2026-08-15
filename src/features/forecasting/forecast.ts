import { createHash } from "node:crypto";
import type {
  AdminForecastProjection,
  CurrentVolumeInput,
  ForecastAnomalyCounts,
  ForecastConfidenceLevel,
  ForecastInput,
  ForecastRange,
  ForecastReason,
  ForecastStatus,
} from "./types.ts";

export const DAY_MS = 86_400_000;
export const ML_PER_US_FL_OZ = 29.5735295625;
export const FALLBACK_MEDIAN_ML_PER_DAY = 177.441177375;
export const FALLBACK_FAST_ML_PER_DAY = 354.88235475;
export const FALLBACK_SLOW_ML_PER_DAY = 88.7205886875;
const BOOTSTRAP_SAMPLES = 512;
type MutableForecastAnomalyCounts = {
  -readonly [Key in keyof ForecastAnomalyCounts]: ForecastAnomalyCounts[Key];
};

function at(value: string | Date | number): number | null {
  const time =
    value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) return null;
  if (typeof value === "string" && (value.length === 0 || new Date(time).toISOString() !== value))
    return null;
  return time;
}
function dayStart(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}
function iso(time: number): string {
  return new Date(time).toISOString();
}
function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}
function quantile(values: readonly number[], q: number): number {
  const point = (values.length - 1) * q;
  const low = Math.floor(point);
  const high = Math.ceil(point);
  return values[low]! + (values[high]! - values[low]!) * (point - low);
}
function mulberry32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4_294_967_296;
  };
}
function seedFor(fillId: string, startDay: number, total: number): number {
  const totalText = Object.is(total, -0)
    ? "0"
    : Number.isInteger(total)
      ? `${total}`
      : total.toString();
  const digest = createHash("sha256")
    .update(`${fillId}|${iso(startDay)}|${totalText}`)
    .digest();
  return digest.readUInt32BE(0);
}
export function bootstrapDailyRates(
  dailyConsumptionMl: readonly number[],
  fillId: string,
  observationStartDay: number,
): number[] {
  if (dailyConsumptionMl.length === 0) return [];
  const random = mulberry32(
    seedFor(
      fillId,
      observationStartDay,
      dailyConsumptionMl.reduce((sum, amount) => sum + amount, 0),
    ),
  );
  const rates: number[] = [];
  const blocks = Math.ceil(dailyConsumptionMl.length / 7);
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
    const generated: number[] = [];
    for (let block = 0; block < blocks; block++) {
      const index = Math.floor(random() * dailyConsumptionMl.length);
      for (let offset = 0; offset < 7 && generated.length < dailyConsumptionMl.length; offset++) {
        generated.push(dailyConsumptionMl[(index + offset) % dailyConsumptionMl.length]!);
      }
    }
    const rate = generated.reduce((sum, amount) => sum + amount, 0) / generated.length;
    if (Number.isFinite(rate) && rate > 0) rates.push(rate);
  }
  return rates;
}
function emptyAnomalies(): MutableForecastAnomalyCounts {
  return {
    invalidTimestamp: 0,
    futureTimestamp: 0,
    beforeObservationRange: 0,
    fillMismatch: 0,
    invalidVolume: 0,
  };
}
function reasonForCurrent(current: CurrentVolumeInput): ForecastReason {
  if (current.kind === "unavailable") return current.reason ?? "current_volume_unavailable";
  if (current.kind === "stale") return "stale_current_volume";
  if (current.kind === "anomaly") return current.reason;
  return "sufficient_fill_history";
}
function blank(
  input: ForecastInput,
  status: ForecastStatus,
  reason: ForecastReason,
  anomalies = emptyAnomalies(),
  observationStart: string | null = input.fill.observationStart,
): AdminForecastProjection {
  return {
    status,
    reason,
    days: null,
    totalVolumeMl: null,
    servingsRemaining: null,
    servingSizeMl: input.servingSizeMl,
    confidence: { level: "low", status, reason },
    method: null,
    observationStart,
    observationEnd: null,
    dailyConsumptionMl: [],
    qualifyingPours: 0,
    anomalies,
    currentVolume: input.currentVolume,
  };
}
function rangeFromDays(
  earliest: number,
  median: number,
  latest: number,
  today: number,
): ForecastRange {
  return {
    earliestDays: tenths(earliest),
    medianDays: tenths(median),
    latestDays: tenths(latest),
    p10Days: tenths(earliest),
    p50Days: tenths(median),
    p90Days: tenths(latest),
    earliestDepletionAt: iso(today + Math.ceil(earliest) * DAY_MS),
    medianDepletionAt: iso(today + Math.ceil(median) * DAY_MS),
    latestDepletionAt: iso(today + Math.ceil(latest) * DAY_MS),
  };
}
function bootstrapRangeFor(
  volumeMl: number,
  rates: readonly number[],
  today: number,
): ForecastRange {
  const days = rates.map((rate) => volumeMl / rate).sort((a, b) => a - b);
  const earliest = quantile(days, 0.1);
  const median = quantile(days, 0.5);
  const latest = quantile(days, 0.9);
  return rangeFromDays(earliest, median, latest, today);
}
function pourReason(anomalies: ForecastAnomalyCounts): ForecastReason {
  if (anomalies.futureTimestamp > 0) return "future_pour_timestamp";
  if (anomalies.invalidTimestamp > 0) return "invalid_pour_timestamp";
  if (anomalies.beforeObservationRange > 0) return "invalid_observation_range";
  return "invalid_pour_observation";
}

/** A pure, Fill-scoped forecast. `now` is injected; no clock or IO is consulted. */
export function forecastFill(input: ForecastInput): AdminForecastProjection {
  if (!Number.isFinite(input.servingSizeMl) || input.servingSizeMl <= 0)
    throw new RangeError("servingSizeMl must be positive");
  const now = at(input.now);
  if (now === null) throw new RangeError("now must be a valid instant");
  if (input.fill.endedAt !== null) return blank(input, "unavailable", "fill_ended");
  if (input.currentVolume.kind === "unavailable")
    return blank(input, "unavailable", reasonForCurrent(input.currentVolume));
  if (input.currentVolume.kind === "anomaly")
    return blank(input, "anomaly", reasonForCurrent(input.currentVolume));
  if (!Number.isFinite(input.currentVolume.volumeMl))
    return blank(input, "anomaly", "invalid_current_volume");
  if (
    input.currentVolume.capacityMl !== null &&
    (!Number.isFinite(input.currentVolume.capacityMl) ||
      input.currentVolume.capacityMl <= 0 ||
      input.currentVolume.volumeMl > input.currentVolume.capacityMl)
  )
    return blank(input, "anomaly", "capacity_inconsistency");
  const measuredAt = at(input.currentVolume.provenance.measuredAt);
  const volumeAsOf = at(input.currentVolume.provenance.asOf);
  if (
    measuredAt === null ||
    volumeAsOf === null ||
    measuredAt > now ||
    volumeAsOf > now ||
    measuredAt > volumeAsOf
  )
    return blank(input, "anomaly", "invalid_current_volume");
  const start = input.fill.observationStart === null ? null : at(input.fill.observationStart);
  if (start === null)
    return blank(
      input,
      input.fill.observationStart === null ? "unavailable" : "anomaly",
      input.fill.observationStart === null ? "no_assignment_history" : "invalid_observation_range",
    );
  const startDay = dayStart(start);
  if (start > now)
    return blank(input, "anomaly", "invalid_observation_range", emptyAnomalies(), iso(startDay));
  const anomalies = emptyAnomalies();
  const days = Array.from({ length: Math.floor((dayStart(now) - startDay) / DAY_MS) + 1 }, () => 0);
  let qualifyingPours = 0;
  for (const pour of input.pours) {
    if (!pour.attributed || pour.fillId !== input.fill.id) {
      anomalies.fillMismatch++;
      continue;
    }
    if (!Number.isFinite(pour.volumeMl) || pour.volumeMl <= 0) {
      anomalies.invalidVolume++;
      continue;
    }
    if (pour.completedAt === null) {
      anomalies.invalidTimestamp++;
      continue;
    }
    const completed = at(pour.completedAt);
    if (completed === null) {
      anomalies.invalidTimestamp++;
      continue;
    }
    if (completed > now) {
      anomalies.futureTimestamp++;
      continue;
    }
    if (completed < start) {
      anomalies.beforeObservationRange++;
      continue;
    }
    const index = Math.floor((dayStart(completed) - startDay) / DAY_MS);
    if (index < 0 || index >= days.length) {
      anomalies.beforeObservationRange++;
      continue;
    }
    days[index] = days[index]! + pour.volumeMl;
    qualifyingPours++;
  }
  const hasPourAnomaly = Object.values(anomalies).some((count) => count > 0);
  const observationStart = iso(startDay);
  const observationEnd = iso(dayStart(now));
  const totalConsumedVolumeMl = days.reduce((sum, volumeMl) => sum + volumeMl, 0);
  if (input.currentVolume.volumeMl <= 0) {
    const depleted = blank(
      input,
      "depleted",
      "current_volume_depleted",
      anomalies,
      observationStart,
    );
    return {
      ...depleted,
      days: {
        earliestDays: 0,
        medianDays: 0,
        latestDays: 0,
        p10Days: 0,
        p50Days: 0,
        p90Days: 0,
        earliestDepletionAt: iso(now),
        medianDepletionAt: iso(now),
        latestDepletionAt: iso(now),
      },
      totalVolumeMl: totalConsumedVolumeMl,
      servingsRemaining: 0,
      observationEnd,
      dailyConsumptionMl: days,
      qualifyingPours,
    };
  }
  const sufficient = days.length >= 14 && qualifyingPours >= 3;
  const method = sufficient
    ? {
        id: "circular_moving_block_bootstrap_7d" as const,
        bootstrapSamples: BOOTSTRAP_SAMPLES,
        validBootstrapSamples: 0,
        fallback: false,
      }
    : {
        id: "fallback_24oz_per_4d" as const,
        bootstrapSamples: 0,
        validBootstrapSamples: 0,
        fallback: true,
      };
  let rates: number[];
  if (sufficient) {
    rates = bootstrapDailyRates(days, input.fill.id, startDay);
    if (rates.length === 0)
      return {
        ...blank(input, "unavailable", "no_consumption_samples", anomalies, observationStart),
        totalVolumeMl: totalConsumedVolumeMl,
        observationEnd,
        dailyConsumptionMl: days,
        qualifyingPours,
        method,
      };
  } else rates = [FALLBACK_FAST_ML_PER_DAY, FALLBACK_MEDIAN_ML_PER_DAY, FALLBACK_SLOW_ML_PER_DAY];
  rates.sort((a, b) => a - b);
  const today = dayStart(now);
  const withDates = sufficient
    ? bootstrapRangeFor(input.currentVolume.volumeMl, rates, today)
    : rangeFromDays(
        input.currentVolume.volumeMl / FALLBACK_FAST_ML_PER_DAY,
        input.currentVolume.volumeMl / FALLBACK_MEDIAN_ML_PER_DAY,
        input.currentVolume.volumeMl / FALLBACK_SLOW_ML_PER_DAY,
        today,
      );
  const level: ForecastConfidenceLevel =
    hasPourAnomaly || input.currentVolume.kind === "stale"
      ? "low"
      : sufficient && days.length >= 28 && qualifyingPours >= 8
        ? "high"
        : sufficient
          ? "medium"
          : "low";
  const status: ForecastStatus = hasPourAnomaly
    ? "anomaly"
    : input.currentVolume.kind === "stale"
      ? "stale"
      : "available";
  const reason: ForecastReason = hasPourAnomaly
    ? pourReason(anomalies)
    : input.currentVolume.kind === "stale"
      ? "stale_current_volume"
      : sufficient
        ? "sufficient_fill_history"
        : "insufficient_fill_history";
  return {
    status,
    reason,
    days: withDates,
    totalVolumeMl: totalConsumedVolumeMl,
    servingsRemaining: Math.floor(input.currentVolume.volumeMl / input.servingSizeMl),
    servingSizeMl: input.servingSizeMl,
    confidence: { level, status, reason },
    method: { ...method, validBootstrapSamples: sufficient ? rates.length : 0 },
    observationStart,
    observationEnd,
    dailyConsumptionMl: days,
    qualifyingPours,
    anomalies,
    currentVolume: input.currentVolume,
  };
}
