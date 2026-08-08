const DAY_SECONDS = 86_400;
const DEFAULT_DRINKING_DAY_OZ = 24;
const DEFAULT_DRINKING_INTERVAL_DAYS = 4;

const roundTenths = (value) => Math.round(value * 10) / 10;

function forecastResult({ currentOz, avgDrinkingDayOz, avgDrinkingIntervalDays, hasUsageData, isFallback }) {
  const avgDailyOz = avgDrinkingDayOz / avgDrinkingIntervalDays;
  const validCurrentOz = Number(currentOz);
  return {
    avgDailyOz: roundTenths(avgDailyOz),
    avgDrinkingDayOz: roundTenths(avgDrinkingDayOz),
    avgDrinkingIntervalDays: roundTenths(avgDrinkingIntervalDays),
    estimatedDaysRemaining: validCurrentOz > 0 ? roundTenths(validCurrentOz / avgDailyOz) : null,
    hasUsageData,
    isFallback
  };
}

export function calculateKegKickForecast({ db, tapId, currentOz }) {
  const lifecycle = db
    .prepare(
      `SELECT lifecycle_id FROM keg_lifecycles
    WHERE tap_id = ? AND closed_at IS NULL`
    )
    .get(tapId);
  if (!lifecycle) {
    return { avgDailyOz: null, estimatedDaysRemaining: null, hasUsageData: false };
  }
  const stats = db
    .prepare(
      `
    WITH daily_usage AS (
      SELECT
        date(timestamp_epoch, 'unixepoch') AS drinking_day,
        SUM(volume_poured_oz) AS daily_oz
      FROM pour_logs
      WHERE lifecycle_id = ? AND volume_poured_oz > 0
      GROUP BY drinking_day
    )
    SELECT
      SUM(daily_oz) AS total_oz,
      COUNT(*) AS drinking_days,
      MIN(unixepoch(drinking_day)) AS first_drinking_day_epoch,
      MAX(unixepoch(drinking_day)) AS last_drinking_day_epoch
    FROM daily_usage
  `
    )
    .get(lifecycle.lifecycle_id);

  const totalOz = Number(stats?.total_oz);
  const drinkingDays = Number(stats?.drinking_days);
  if (!(totalOz > 0) || !(drinkingDays > 0)) {
    return forecastResult({
      currentOz,
      avgDrinkingDayOz: DEFAULT_DRINKING_DAY_OZ,
      avgDrinkingIntervalDays: DEFAULT_DRINKING_INTERVAL_DAYS,
      hasUsageData: false,
      isFallback: true
    });
  }

  const firstDrinkingDayEpoch = Number(stats.first_drinking_day_epoch);
  const lastDrinkingDayEpoch = Number(stats.last_drinking_day_epoch);
  const observedIntervalDays =
    drinkingDays > 1 && Number.isFinite(firstDrinkingDayEpoch) && Number.isFinite(lastDrinkingDayEpoch)
      ? (lastDrinkingDayEpoch - firstDrinkingDayEpoch) / DAY_SECONDS / (drinkingDays - 1)
      : DEFAULT_DRINKING_INTERVAL_DAYS;

  return forecastResult({
    currentOz,
    avgDrinkingDayOz: totalOz / drinkingDays,
    avgDrinkingIntervalDays: Math.max(1, observedIntervalDays),
    hasUsageData: true,
    isFallback: false
  });
}
