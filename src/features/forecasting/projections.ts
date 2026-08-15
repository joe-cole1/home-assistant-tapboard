import type { AdminForecastProjection, PublicForecastProjection } from "./types.ts";

/** Deliberately whitelists the public forecast contract and excludes telemetry provenance. */
export function toPublicForecastProjection(
  forecast: AdminForecastProjection,
): PublicForecastProjection {
  return {
    status: forecast.status,
    reason: forecast.reason,
    days: forecast.days,
    servingsRemaining: forecast.servingsRemaining,
    servingSizeMl: forecast.servingSizeMl,
    confidence: forecast.confidence,
    method:
      forecast.method === null
        ? null
        : { id: forecast.method.id, fallback: forecast.method.fallback },
  };
}
