const DAY_MS = 86_400_000;
const FORECAST_WINDOW_DAYS = 14;

const roundTenths = (value) => Math.round(value * 10) / 10;

export function calculateKegKickForecast({ db, tapId, currentOz, nowMs = Date.now() }) {
  const lifecycle = db
    .prepare(
      `SELECT lifecycle_id FROM keg_lifecycles
    WHERE tap_id = ? AND closed_at IS NULL`
    )
    .get(tapId);
  if (!lifecycle) {
    return { avgDailyOz: null, estimatedDaysRemaining: null, hasUsageData: false };
  }
  const cutoffEpoch = Math.floor((nowMs - FORECAST_WINDOW_DAYS * DAY_MS) / 1000);
  const stats = db
    .prepare(
      `
    SELECT
      SUM(volume_poured_oz) AS total_oz,
      MIN(timestamp_epoch) AS first_pour_epoch
    FROM pour_logs
    WHERE lifecycle_id = ? AND timestamp_epoch >= ?
  `
    )
    .get(lifecycle.lifecycle_id, cutoffEpoch);

  const totalOz = Number(stats?.total_oz);
  const firstPourEpoch = Number(stats?.first_pour_epoch);
  if (!(totalOz > 0) || !Number.isFinite(firstPourEpoch)) {
    return {
      avgDailyOz: null,
      estimatedDaysRemaining: null,
      hasUsageData: false
    };
  }

  const elapsedDays = (nowMs / 1000 - firstPourEpoch) / (DAY_MS / 1000);
  const historyDays = Math.min(FORECAST_WINDOW_DAYS, Math.max(1, elapsedDays));
  const avgDailyOz = totalOz / historyDays;
  const validCurrentOz = Number(currentOz);

  return {
    avgDailyOz: roundTenths(avgDailyOz),
    estimatedDaysRemaining: validCurrentOz > 0 ? roundTenths(validCurrentOz / avgDailyOz) : null,
    hasUsageData: true
  };
}
