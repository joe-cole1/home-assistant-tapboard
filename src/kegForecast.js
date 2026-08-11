const DAY_MS = 86_400_000;
const FALLBACK_DAILY_OZ = 24 / 4;
const MIN_OBSERVATION_DAYS = 14;
const MIN_QUALIFYING_POURS = 3;
const BOOTSTRAP_SAMPLES = 512;
const BLOCK_DAYS = 7;

const roundTenths = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const utcDay = (ms) => Math.floor(ms / DAY_MS);
const dateForDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isoForDay = (day) => new Date(day * DAY_MS).toISOString();

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function bootstrapRates(dailyOz, seed) {
  const random = seededRandom(seed);
  const observationDays = dailyOz.length;
  const blockCount = Math.ceil(observationDays / BLOCK_DAYS);
  const rates = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    let total = 0;
    let count = 0;
    for (let block = 0; block < blockCount; block += 1) {
      const start = Math.floor(random() * observationDays);
      for (let offset = 0; offset < BLOCK_DAYS && count < observationDays; offset += 1) {
        total += dailyOz[(start + offset) % observationDays];
        count += 1;
      }
    }
    rates.push(total / observationDays);
  }
  return rates;
}

function legacyFields({ currentOz, avgDailyOz, hasUsageData, isFallback }) {
  const daily = avgDailyOz > 0 ? avgDailyOz : null;
  return {
    avgDailyOz: roundTenths(daily),
    avgDrinkingDayOz: daily === null ? null : roundTenths(daily * 4),
    avgDrinkingIntervalDays: daily === null ? null : 4,
    estimatedDaysRemaining: currentOz > 0 && daily ? roundTenths(currentOz / daily) : null,
    hasUsageData,
    isFallback
  };
}

function unavailable({ status, reason, lifecycle = null, currentOz = null, anomaly = false }) {
  return {
    schemaVersion: 1,
    lifecycle,
    range: null,
    depletion: { medianDate: null, earliestDate: null, latestDate: null, medianDaysRemaining: null },
    evidence: { observationDays: 0, qualifyingPours: 0, totalOz: 0, method: null, anomaly },
    confidence: { level: 'low', status, reason },
    status,
    reason,
    ...legacyFields({ currentOz, avgDailyOz: null, hasUsageData: false, isFallback: false })
  };
}

/**
 * Forecast the currently open keg lifecycle. All grouping is by UTC calendar
 * day so a host timezone change cannot change the forecast.
 */
export function calculateKegKickForecast({ db, tapId, currentOz, capacityOz, volumeStatus, nowMs = Date.now() }) {
  const lifecycle = db
    .prepare(
      `SELECT lifecycle_id, tap_id, batch_id, started_at FROM keg_lifecycles WHERE tap_id = ? AND closed_at IS NULL`
    )
    .get(tapId);
  if (!lifecycle) return unavailable({ status: 'unavailable', reason: 'no_active_lifecycle', currentOz });

  const startedMs = Date.parse(lifecycle.started_at);
  const effectiveNowMs = Number(nowMs);
  const lifecycleInfo = {
    id: lifecycle.lifecycle_id,
    tapId: lifecycle.tap_id,
    batchId: lifecycle.batch_id ?? null,
    startedAt: lifecycle.started_at
  };
  if (!Number.isFinite(startedMs) || !Number.isFinite(effectiveNowMs) || startedMs > effectiveNowMs) {
    return unavailable({
      status: 'anomaly',
      reason: 'invalid_lifecycle_timestamp',
      lifecycle: lifecycleInfo,
      currentOz,
      anomaly: true
    });
  }

  const effectiveVolumeStatus = volumeStatus ?? 'measured';
  if (!['measured', 'stale'].includes(effectiveVolumeStatus)) {
    return unavailable({
      status: 'unavailable',
      reason: effectiveVolumeStatus === 'assumed_full' ? 'assumed_volume' : 'volume_unavailable',
      lifecycle: lifecycleInfo,
      currentOz
    });
  }

  const validCurrentOz = Number(currentOz);
  const validCapacityOz = Number(capacityOz);
  const capacityInconsistent =
    Number.isFinite(validCapacityOz) && validCapacityOz > 0 && validCurrentOz > validCapacityOz;
  if (!(validCurrentOz > 0)) {
    const result = unavailable({
      status: 'depleted',
      reason: 'empty_or_invalid_volume',
      lifecycle: lifecycleInfo,
      currentOz: validCurrentOz,
      anomaly: capacityInconsistent
    });
    const depletedAt = new Date(effectiveNowMs).toISOString();
    result.depletion = {
      medianDate: depletedAt,
      earliestDate: depletedAt,
      latestDate: depletedAt,
      medianDaysRemaining: 0,
      earliestDaysRemaining: 0,
      latestDaysRemaining: 0
    };
    result.estimatedDaysRemaining = 0;
    return result;
  }

  const startDay = utcDay(startedMs);
  const endDay = utcDay(effectiveNowMs);
  const observationDays = endDay - startDay + 1;
  const rows = db
    .prepare(
      `SELECT volume_poured_oz, timestamp_epoch, timestamp FROM pour_logs WHERE lifecycle_id = ? AND volume_poured_oz > 0`
    )
    .all(lifecycle.lifecycle_id);
  const dailyOz = Array(observationDays).fill(0);
  let qualifyingPours = 0;
  let invalidTimestampCount = 0;
  let futureTimestampCount = 0;
  for (const row of rows) {
    const epoch =
      row.timestamp_epoch === null || row.timestamp_epoch === undefined ? Number.NaN : Number(row.timestamp_epoch);
    const timestampMs = Number.isFinite(epoch) ? epoch * 1000 : Date.parse(row.timestamp);
    if (!Number.isFinite(timestampMs)) {
      invalidTimestampCount += 1;
      continue;
    }
    if (timestampMs > effectiveNowMs) {
      futureTimestampCount += 1;
      continue;
    }
    const day = utcDay(timestampMs);
    if (day < startDay) {
      invalidTimestampCount += 1;
      continue;
    }
    const volume = Number(row.volume_poured_oz);
    if (!(volume > 0) || !Number.isFinite(volume)) continue;
    dailyOz[day - startDay] += volume;
    qualifyingPours += 1;
  }
  const totalOz = dailyOz.reduce((sum, value) => sum + value, 0);
  const stale = effectiveVolumeStatus === 'stale';
  const anomaly = capacityInconsistent || invalidTimestampCount > 0 || futureTimestampCount > 0;
  const sufficient = observationDays >= MIN_OBSERVATION_DAYS && qualifyingPours >= MIN_QUALIFYING_POURS;
  const method = sufficient ? 'circular_moving_block_bootstrap_7d' : 'fallback_24oz_per_4d';
  const sampledRates = sufficient
    ? bootstrapRates(dailyOz, Number(lifecycle.lifecycle_id) ^ startDay ^ Math.round(totalOz * 10))
    : [];
  // A sampled all-zero period carries no depletion information; omitting it
  // avoids turning a finite forecast into Infinity while retaining the 512
  // deterministic samples used to estimate the consuming periods.
  const rates = sampledRates.filter((rate) => rate > 0 && Number.isFinite(rate));
  const daysRemaining = rates.map((rate) => validCurrentOz / rate);
  const p10Days = sufficient ? quantile(daysRemaining, 0.1) : validCurrentOz / (FALLBACK_DAILY_OZ * 2);
  const medianDays = sufficient ? quantile(daysRemaining, 0.5) : validCurrentOz / FALLBACK_DAILY_OZ;
  const p90Days = sufficient ? quantile(daysRemaining, 0.9) : validCurrentOz / (FALLBACK_DAILY_OZ / 2);
  const medianRate = validCurrentOz / medianDays;
  const confidenceLevel =
    !sufficient || stale || anomaly ? 'low' : observationDays >= 28 && qualifyingPours >= 8 ? 'high' : 'medium';
  const reason = anomaly
    ? capacityInconsistent
      ? 'capacity_inconsistency'
      : futureTimestampCount
        ? 'future_pour_timestamp'
        : 'invalid_pour_timestamp'
    : stale
      ? 'stale_volume'
      : sufficient
        ? 'sufficient_lifecycle_history'
        : 'insufficient_lifecycle_history';
  const status = anomaly ? 'anomaly' : stale ? 'stale' : 'available';
  const tappedAgeDays = Math.max(0, Math.floor((effectiveNowMs - startedMs) / DAY_MS));
  const resultLifecycle = { ...lifecycleInfo, tappedAgeDays, startedDayUtc: dateForDay(startDay) };

  return {
    schemaVersion: 1,
    lifecycle: resultLifecycle,
    range: { startDate: dateForDay(startDay), endDate: dateForDay(endDay), observationDays },
    depletion: {
      medianDate: isoForDay(endDay + Math.ceil(medianDays)),
      earliestDate: isoForDay(endDay + Math.ceil(p10Days)),
      latestDate: isoForDay(endDay + Math.ceil(p90Days)),
      medianDaysRemaining: roundTenths(medianDays),
      earliestDaysRemaining: roundTenths(p10Days),
      latestDaysRemaining: roundTenths(p90Days)
    },
    evidence: {
      observationDays,
      qualifyingPours,
      totalOz: roundTenths(totalOz),
      dailyRatesOz: dailyOz.map(roundTenths),
      method,
      bootstrapSamples: sufficient ? BOOTSTRAP_SAMPLES : 0,
      invalidTimestampCount,
      futureTimestampCount,
      anomaly
    },
    confidence: { level: confidenceLevel, status, reason },
    status,
    reason,
    ...legacyFields({
      currentOz: validCurrentOz,
      avgDailyOz: medianRate,
      hasUsageData: qualifyingPours > 0,
      isFallback: !sufficient
    })
  };
}
