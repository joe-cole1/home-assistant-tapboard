import { buildSensoryProfile, SENSORY_AXES } from './sensoryEngine.js';

export const BREW_STORY_SCHEMA_VERSION = 3;
export const BREW_STORY_WINDOWS = Object.freeze(['24h', '7d', 'all']);
export const MAX_STORY_POINTS = 600;
const STALE_AFTER_MS = 12 * 60 * 60 * 1_000;
const READING_FIELDS = ['sg', 'temp_c', 'pressure', 'ph'];
const MAX_BUCKET_SELECTIONS = 2 + READING_FIELDS.length * 2;

export function validBrewfatherBatchId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function parsePayload(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function evenlyThin(points, limit) {
  if (points.length <= limit) return points;
  const output = [points[0]];
  for (let index = 1; index < limit - 1; index++) {
    output.push(points[Math.round((index * (points.length - 1)) / (limit - 1))]);
  }
  output.push(points.at(-1));
  return [...new Map(output.map((point) => [point.reading_key, point])).values()];
}

export function downsampleReadings(points, limit = MAX_STORY_POINTS) {
  if (!Array.isArray(points) || points.length <= limit) return Array.isArray(points) ? points : [];
  const firstTime = points[0].recorded_at_ms;
  const lastTime = points.at(-1).recorded_at_ms;
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime <= firstTime) {
    return evenlyThin(points, limit);
  }
  const bucketCount = Math.max(1, Math.floor(limit / MAX_BUCKET_SELECTIONS));
  const width = Math.max(1, Math.ceil((lastTime - firstTime + 1) / bucketCount));
  const buckets = new Map();
  for (const point of points) {
    const key = Math.min(bucketCount - 1, Math.floor((point.recorded_at_ms - firstTime) / width));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(point);
  }
  const selected = new Map();
  for (const bucket of buckets.values()) {
    selected.set(bucket[0].reading_key, bucket[0]);
    selected.set(bucket.at(-1).reading_key, bucket.at(-1));
    for (const field of READING_FIELDS) {
      const populated = bucket.filter((point) => Number.isFinite(point[field]));
      if (populated.length === 0) continue;
      const minimum = populated.reduce((left, right) => (right[field] < left[field] ? right : left));
      const maximum = populated.reduce((left, right) => (right[field] > left[field] ? right : left));
      selected.set(minimum.reading_key, minimum);
      selected.set(maximum.reading_key, maximum);
    }
  }
  return evenlyThin(
    [...selected.values()].sort((left, right) => left.recorded_at_ms - right.recorded_at_ms),
    limit
  );
}

export function storyIsPublic(db, batchId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM batches b
         WHERE b.batch_id=? AND b.present=1 AND (
           EXISTS (SELECT 1 FROM taps t WHERE t.batch_id=b.batch_id)
           OR EXISTS (
             SELECT 1 FROM brewfather_ondeck_preferences p, settings s
             WHERE p.batch_id=b.batch_id AND p.visible=1 AND s.id=1 AND s.show_ondeck=1
           )
         )`
      )
      .get(batchId)
  );
}

function storyBatch(db, batchId) {
  return (
    db
      .prepare(
        `SELECT batch_id, batch_name, batch_number, brewer, recipe_id, recipe_name, style_id, style,
          description, brew_date, start_date, fermentation_start_date, conditioning_date,
          packaging_date, completed_date, image_url, estimated_og, estimated_fg, measured_og,
          measured_fg, estimated_abv, measured_abv, estimated_ibu, estimated_srm, carbonation,
          carbonation_temp_c, status, source_updated_at, last_success_at, error_category,
          summary_fingerprint, detail_fingerprint, detail_fetched_at
         FROM batches WHERE batch_id=? AND present=1`
      )
      .get(batchId) || null
  );
}

function readingRows(db, batchId, window) {
  const latest = db
    .prepare(
      `SELECT recorded_at_ms FROM brewfather_batch_readings
       WHERE batch_id=? AND recorded_at_ms IS NOT NULL ORDER BY recorded_at_ms DESC LIMIT 1`
    )
    .get(batchId)?.recorded_at_ms;
  let cutoff = null;
  if (Number.isFinite(latest) && window !== 'all') cutoff = latest - (window === '24h' ? 24 : 7 * 24) * 60 * 60 * 1_000;
  return db
    .prepare(
      `SELECT reading_key, recorded_at, recorded_at_ms, reading_type, device_id, sg, temp_c,
        pressure, ph, battery, rssi
       FROM brewfather_batch_readings
       WHERE batch_id=? AND (? IS NULL OR recorded_at_ms >= ?)
       ORDER BY recorded_at_ms, reading_key LIMIT 5000`
    )
    .all(batchId, cutoff, cutoff);
}

function lifecycleChapters(db, batchId, tapStates, forecastForTap) {
  return db
    .prepare(
      `SELECT l.lifecycle_id, l.tap_id, l.started_at, l.closed_at, l.close_reason,
        m.first_pour_at, m.kicked_at, m.kick_trigger,
        COUNT(p.id) AS pour_count, COALESCE(SUM(p.volume_poured_oz), 0) AS poured_oz
       FROM keg_lifecycles l
       LEFT JOIN lifecycle_milestones m ON m.lifecycle_id=l.lifecycle_id
       LEFT JOIN pour_logs p ON p.lifecycle_id=l.lifecycle_id
       WHERE l.batch_id=?
       GROUP BY l.lifecycle_id
       ORDER BY l.started_at DESC, l.lifecycle_id DESC`
    )
    .all(batchId)
    .map((row) => {
      const active = row.closed_at === null;
      const measurement = active ? tapStates?.[String(row.tap_id)] : null;
      return {
        lifecycle_id: row.lifecycle_id,
        tap_id: row.tap_id,
        tapped_at: row.started_at,
        closed_at: row.closed_at,
        close_reason: row.close_reason,
        first_pour_at: row.first_pour_at,
        kicked_at: row.kicked_at,
        kick_trigger: row.kick_trigger,
        active,
        pours: { count: row.pour_count, total_oz: row.poured_oz },
        remaining:
          active && measurement
            ? {
                volume_oz: measurement.volumeOz ?? null,
                fill_percent: measurement.fillPercent ?? null,
                status: measurement.volumeStatus ?? 'unavailable'
              }
            : null,
        forecast: active && typeof forecastForTap === 'function' ? forecastForTap(row.tap_id) : null,
        kick_date: !active && ['end_batch', 'end_keg'].includes(row.close_reason) ? row.closed_at : null
      };
    });
}

export function sensoryOverride(db, batchId) {
  const row = db.prepare('SELECT * FROM brewfather_sensory_overrides WHERE batch_id=?').get(batchId);
  if (!row) return { hidden: false, description_override: null, axes: {} };
  return {
    hidden: row.hidden === 1,
    description_override: row.description_override,
    axes: Object.fromEntries(SENSORY_AXES.filter((axis) => row[axis] !== null).map((axis) => [axis, row[axis]]))
  };
}

export function saveSensoryOverride(db, batchId, value) {
  const axes = value.axis_overrides || {};
  const row = {
    batch_id: batchId,
    hidden: value.hidden ? 1 : 0,
    description_override: value.description_override,
    ...Object.fromEntries(SENSORY_AXES.map((axis) => [axis, axes[axis] ?? null]))
  };
  db.prepare(
    `INSERT INTO brewfather_sensory_overrides
      (batch_id, hidden, description_override, malt, hops, bitterness, sweetness, roast, tartness, body, perceived_strength)
     VALUES (@batch_id, @hidden, @description_override, @malt, @hops, @bitterness, @sweetness, @roast, @tartness, @body, @perceived_strength)
     ON CONFLICT(batch_id) DO UPDATE SET hidden=excluded.hidden,
       description_override=excluded.description_override, malt=excluded.malt, hops=excluded.hops,
       bitterness=excluded.bitterness, sweetness=excluded.sweetness, roast=excluded.roast,
       tartness=excluded.tartness, body=excluded.body, perceived_strength=excluded.perceived_strength,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run(row);
  return sensoryOverride(db, batchId);
}

export function buildBrewStory({
  db,
  batchId,
  window = '7d',
  now = Date.now,
  tapStates = {},
  forecastForTap,
  servingGlass = null,
  includeHiddenSensory = false
} = {}) {
  if (!BREW_STORY_WINDOWS.includes(window)) throw new TypeError('Invalid story window');
  const batch = storyBatch(db, batchId);
  if (!batch) return null;
  const detailRow = db
    .prepare('SELECT payload_json, fetched_at FROM brewfather_batch_details WHERE batch_id=?')
    .get(batchId);
  const detail = parsePayload(detailRow?.payload_json);
  delete detail.image_url;
  const rawReadings = readingRows(db, batchId, window);
  const points = downsampleReadings(rawReadings);
  const latest = rawReadings.at(-1) || null;
  const override = sensoryOverride(db, batchId);
  const generatedSensory = buildSensoryProfile({ summary: batch, detail, override });
  const description = override.description_override ?? generatedSensory.prose;
  let sensory = {
    ...generatedSensory,
    hidden: override.hidden,
    description,
    known_axis_count: Object.values(generatedSensory.axes).filter((axis) => axis.value !== null).length
  };
  if (includeHiddenSensory) {
    sensory.override = {
      hidden: override.hidden,
      description_override: override.description_override,
      axis_overrides: override.axes
    };
  }
  if (override.hidden && !includeHiddenSensory) {
    sensory = {
      hidden: true,
      rules_version: generatedSensory.rules_version,
      description: null,
      axes: {},
      known_axis_count: 0
    };
  }
  const currentTime = now();
  const latestTime = latest?.recorded_at_ms;
  const sync = db.prepare('SELECT status, error_category, last_success_at FROM brewfather_sync_state WHERE id=1').get();
  return {
    schema_version: BREW_STORY_SCHEMA_VERSION,
    batch: {
      ...batch,
      image_url: batch.image_url ? `/api/batches/${encodeURIComponent(batchId)}/image` : null
    },
    freshness: {
      detail_fetched_at: detailRow?.fetched_at ?? null,
      latest_reading_at: latest?.recorded_at ?? null,
      stale: !Number.isFinite(latestTime) || currentTime - latestTime > STALE_AFTER_MS,
      stale_after_hours: 12,
      detail_stale: batch.detail_fingerprint === null || batch.detail_fingerprint !== batch.summary_fingerprint,
      cache_status: sync?.status ?? 'never',
      error_category: batch.error_category ?? sync?.error_category ?? null,
      last_success_at: sync?.last_success_at ?? null
    },
    sections: detail,
    telemetry: {
      units: 'metric',
      latest,
      history: { window, downsampled: points.length < rawReadings.length, total_points: rawReadings.length, points }
    },
    tapboard: { lifecycles: lifecycleChapters(db, batchId, tapStates, forecastForTap), serving_glass: servingGlass },
    sensory
  };
}
