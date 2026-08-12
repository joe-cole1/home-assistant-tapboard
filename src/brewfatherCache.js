import crypto from 'node:crypto';

export const BREWFATHER_CACHE_STATUSES = Object.freeze([
  'Planning',
  'Brewing',
  'Fermenting',
  'Conditioning',
  'Completed'
]);

const STATUS_SET = new Set(BREWFATHER_CACHE_STATUSES);
const MAX_DETAIL_BYTES = 262_144;
const MAX_READING_BYTES = 16_384;
const MAX_PUBLIC_BATCHES = 150;
const MAX_HISTORY_PER_BATCH = 5_000;
const MAX_HISTORY_PER_WRITE = 1_000;

function cleanText(value, max, { allowNumber = false } = {}) {
  if (allowNumber && (typeof value === 'number' || typeof value === 'bigint')) value = String(value);
  if (typeof value !== 'string') return null;
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  })
    .join('')
    .trim();
  return normalized ? normalized.slice(0, max) : null;
}

function finiteNumber(value, min = -1_000_000, max = 1_000_000) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number.NaN;
  const epoch = Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric) : Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Cache timestamp is invalid');
  return date.toISOString();
}

function httpsUrl(value) {
  const text = cleanText(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href.slice(0, 2_048) : null;
  } catch {
    return null;
  }
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function souringSignal(value) {
  if (value === true || value === false) return value;
  return cleanText(value, 160);
}

function cleanTextList(value, { limit = 50, max = 160 } = {}) {
  return (Array.isArray(value) ? value : [])
    .slice(0, limit)
    .map((item) => cleanText(typeof item === 'object' ? (item?.name ?? item?.label) : item, max, { allowNumber: true }))
    .filter(Boolean);
}

function numericVector(value, keys, { min = 0, max = 100 } = {}) {
  const source = object(value);
  return Object.fromEntries(
    keys.map((key) => [key, finiteNumber(source[key], min, max)]).filter(([, number]) => number !== null)
  );
}

export function sanitizeSummary(source, { status: requestedStatus } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const recipe = object(source.recipe);
  const style = object(recipe.style ?? source.style);
  const batchId = cleanText(source._id ?? source.id ?? source.batch_id, 256);
  const status = cleanText(source.status ?? requestedStatus, 32);
  if (!batchId || !status || !STATUS_SET.has(status)) return null;
  const summary = {
    batch_id: batchId,
    batch_name: cleanText(source.name, 160),
    batch_number: cleanText(source.batchNo ?? source.batch_number, 64, { allowNumber: true }),
    status,
    brewer: cleanText(source.brewer?.name ?? source.brewer, 120),
    recipe_id: cleanText(recipe._id ?? recipe.id, 256),
    recipe_name: cleanText(recipe.name ?? source.name, 160) || 'Unknown Brew',
    style_id: cleanText(style._id ?? style.id, 256),
    style: cleanText(style.name ?? recipe.style ?? source.style, 120) || '',
    description: cleanText(recipe.description ?? style.description, 2_000),
    brew_date: isoDate(source.brewDate ?? source.brew_date),
    start_date: isoDate(source.startDate ?? source.start_date),
    fermentation_start_date: isoDate(source.fermentationStartDate ?? source.fermentation_start_date),
    conditioning_date: isoDate(source.conditioningDate ?? source.conditioning_date),
    packaging_date: isoDate(source.bottlingDate ?? source.packagingDate ?? source.packaging_date),
    completed_date: isoDate(source.completedDate ?? source.completed_date),
    image_url: httpsUrl(source.image ?? source.imageUrl ?? recipe.image ?? recipe.imageUrl),
    estimated_og: finiteNumber(source.estimatedOg, 0.5, 2),
    estimated_fg: finiteNumber(source.estimatedFg, 0.5, 2),
    measured_og: finiteNumber(source.measuredOg, 0.5, 2),
    measured_fg: finiteNumber(source.measuredFg, 0.5, 2),
    estimated_abv: finiteNumber(source.estimatedAbv, 0, 100),
    measured_abv: finiteNumber(source.measuredAbv, 0, 100),
    estimated_ibu: finiteNumber(source.estimatedIbu ?? recipe.ibu, 0, 2_000),
    estimated_srm: finiteNumber(source.estimatedColor ?? recipe.color ?? recipe.srm, 0, 100),
    carbonation: finiteNumber(source.carbonation, 0, 20),
    carbonation_temp_c: finiteNumber(source.carbonationTemp, -50, 100),
    source_updated_at: isoDate(source.updatedAt ?? source._updatedAt ?? source.modifiedAt),
    content_version: 1
  };
  return { ...summary, summary_fingerprint: fingerprint(summary) };
}

function sanitizeIngredient(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  return {
    id: cleanText(item._id ?? item.id, 256),
    name: cleanText(item.name, 160),
    supplier: cleanText(item.supplier, 120),
    origin: cleanText(item.origin, 120),
    type: cleanText(item.type, 80),
    use: cleanText(item.use, 80),
    category: cleanText(item.category ?? item.subType ?? item.subtype, 80),
    amount: finiteNumber(item.amount),
    unit: cleanText(item.unit, 32),
    percentage: finiteNumber(item.percentage ?? item.percent ?? item.pct, 0, 100),
    alpha: finiteNumber(item.alpha, 0, 100),
    color: finiteNumber(item.color, 0, 1_000),
    attenuation: finiteNumber(item.attenuation, 0, 100),
    time: finiteNumber(item.time, 0, 1_000_000),
    temperature_c: finiteNumber(item.temp ?? item.temperature, -100, 200),
    aroma: cleanTextList(item.aroma ?? item.aromas, { limit: 24, max: 80 }),
    oils: numericVector(item.oils, ['totalOil', 'myrcene', 'humulene', 'caryophyllene', 'farnesene'])
  };
}

function sanitizeIngredients(recipe) {
  const list = (value) => (Array.isArray(value) ? value : []).slice(0, 100).map(sanitizeIngredient).filter(Boolean);
  return {
    fermentables: list(recipe.fermentables),
    hops: list(recipe.hops),
    miscs: list(recipe.miscs),
    yeasts: list(recipe.yeasts)
  };
}

function sanitizeProfileStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return null;
  return {
    name: cleanText(step.name, 120),
    type: cleanText(step.type, 64),
    temperature_c: finiteNumber(step.stepTemp ?? step.temp ?? step.temperature, -50, 150),
    time_minutes: finiteNumber(step.stepTime ?? step.time, 0, 100_000),
    ramp_minutes: finiteNumber(step.rampTime, 0, 100_000),
    pressure: finiteNumber(step.pressure)
  };
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const steps = profile.steps ?? profile.mashSteps ?? profile.fermentationSteps;
  return {
    id: cleanText(profile._id ?? profile.id, 256),
    name: cleanText(profile.name, 160),
    description: cleanText(profile.description, 2_000),
    type: cleanText(profile.type, 80),
    steps: (Array.isArray(steps) ? steps : []).slice(0, 50).map(sanitizeProfileStep).filter(Boolean)
  };
}

function sanitizeStyle(style) {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return null;
  return {
    id: cleanText(style._id ?? style.id, 256),
    name: cleanText(style.name, 160),
    category: cleanText(style.category, 160),
    category_number: cleanText(style.categoryNumber, 32, { allowNumber: true }),
    style_letter: cleanText(style.styleLetter, 16),
    description: cleanText(style.description, 4_000),
    overall_impression: cleanText(style.overallImpression, 4_000),
    aroma: cleanText(style.aroma, 4_000),
    appearance: cleanText(style.appearance, 4_000),
    flavor: cleanText(style.flavor, 4_000),
    mouthfeel: cleanText(style.mouthfeel, 4_000),
    characteristic_ingredients: cleanText(style.ingredients, 4_000),
    examples: cleanText(style.examples, 4_000),
    ranges: {
      og: [finiteNumber(style.ogMin ?? style.og?.min, 0.5, 2), finiteNumber(style.ogMax ?? style.og?.max, 0.5, 2)],
      fg: [finiteNumber(style.fgMin ?? style.fg?.min, 0.5, 2), finiteNumber(style.fgMax ?? style.fg?.max, 0.5, 2)],
      abv: [finiteNumber(style.abvMin ?? style.abv?.min, 0, 100), finiteNumber(style.abvMax ?? style.abv?.max, 0, 100)],
      ibu: [
        finiteNumber(style.ibuMin ?? style.ibu?.min, 0, 2_000),
        finiteNumber(style.ibuMax ?? style.ibu?.max, 0, 2_000)
      ],
      color: [
        finiteNumber(style.colorMin ?? style.srmMin ?? style.color?.min, 0, 100),
        finiteNumber(style.colorMax ?? style.srmMax ?? style.color?.max, 0, 100)
      ]
    }
  };
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  return {
    id: cleanText(event._id ?? event.id, 256),
    name: cleanText(event.name ?? event.title, 160),
    type: cleanText(event.type, 80),
    occurred_at: isoDate(event.time ?? event.date ?? event.createdAt),
    description: cleanText(event.description ?? event.text, 2_000)
  };
}

function sanitizeTaste(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    score: finiteNumber(value.score, 0, 100),
    aroma: cleanText(value.aroma, 2_000),
    appearance: cleanText(value.appearance, 2_000),
    flavor: cleanText(value.flavor, 2_000),
    mouthfeel: cleanText(value.mouthfeel, 2_000),
    overall: cleanText(value.overall ?? value.notes, 4_000),
    recorded_at: isoDate(value.time ?? value.date ?? value.createdAt),
    ratings: numericVector(
      value.ratings ?? value,
      ['malt', 'hops', 'bitterness', 'sweetness', 'roast', 'tartness', 'body', 'alcohol', 'perceivedStrength'],
      { min: 0, max: 100 }
    )
  };
}

function sanitizeMeasurements(source, recipe) {
  const values = {
    target_og: finiteNumber(source.estimatedOg ?? recipe.og, 0.5, 2),
    measured_og: finiteNumber(source.measuredOg, 0.5, 2),
    target_fg: finiteNumber(source.estimatedFg ?? recipe.fg, 0.5, 2),
    measured_fg: finiteNumber(source.measuredFg, 0.5, 2),
    target_abv: finiteNumber(source.estimatedAbv ?? recipe.abv, 0, 100),
    measured_abv: finiteNumber(source.measuredAbv, 0, 100),
    target_attenuation: finiteNumber(source.estimatedAttenuation ?? recipe.attenuation, 0, 100),
    measured_attenuation: finiteNumber(source.measuredAttenuation, 0, 100),
    target_ibu: finiteNumber(source.estimatedIbu ?? recipe.ibu, 0, 2_000),
    measured_ibu: finiteNumber(source.measuredIbu, 0, 2_000),
    target_color_srm: finiteNumber(source.estimatedColor ?? recipe.color ?? recipe.srm, 0, 100),
    measured_color_srm: finiteNumber(source.measuredColor, 0, 100),
    target_batch_volume_l: finiteNumber(recipe.batchSize ?? source.batchSize, 0, 1_000_000),
    measured_batch_volume_l: finiteNumber(source.measuredBatchSize, 0, 1_000_000),
    target_boil_volume_l: finiteNumber(recipe.boilSize ?? source.boilSize, 0, 1_000_000),
    measured_boil_volume_l: finiteNumber(source.measuredBoilSize, 0, 1_000_000),
    target_efficiency: finiteNumber(recipe.efficiency, 0, 100),
    measured_efficiency: finiteNumber(source.measuredEfficiency, 0, 100),
    carbonation_volumes: finiteNumber(source.carbonation ?? recipe.carbonation, 0, 20),
    carbonation_temp_c: finiteNumber(source.carbonationTemp, -50, 100),
    measured_ph: finiteNumber(source.measuredPh ?? source.measuredFgPh, 0, 14)
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

function sanitizeNutrition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    calories: finiteNumber(value.calories, 0, 100_000),
    carbohydrates: finiteNumber(value.carbs ?? value.carbohydrates, 0, 100_000),
    protein: finiteNumber(value.protein, 0, 100_000),
    fat: finiteNumber(value.fat, 0, 100_000)
  };
}

function boundedDetailJson(snapshot) {
  let json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) <= MAX_DETAIL_BYTES) return json;
  const compact = {
    truncated: true,
    batch: snapshot.batch,
    recipe: {
      id: snapshot.recipe.id,
      name: snapshot.recipe.name,
      description: snapshot.recipe.description,
      style: snapshot.recipe.style,
      sensory_v2_souring: snapshot.recipe.sensory_v2_souring,
      ingredients: Object.fromEntries(
        Object.entries(snapshot.recipe.ingredients).map(([key, value]) => [key, value.slice(0, 20)])
      ),
      profiles: snapshot.recipe.profiles
    },
    image_url: snapshot.image_url
  };
  json = JSON.stringify(compact);
  if (Buffer.byteLength(json) > MAX_DETAIL_BYTES)
    throw new TypeError('Sanitized Brewfather detail exceeds cache limit');
  return json;
}

export function sanitizeDetail(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { payload_json: '{}', fingerprint: fingerprint({}) };
  }
  const recipe = object(source.recipe);
  const snapshot = {
    batch: {
      name: cleanText(source.name, 160),
      status: STATUS_SET.has(source.status) ? source.status : null,
      notes: cleanText(source.notes, 8_000),
      brewer: cleanText(source.brewer?.name ?? source.brewer, 120),
      tags: cleanTextList(source.tags, { limit: 50, max: 80 }),
      events: (Array.isArray(source.events) ? source.events : []).slice(0, 200).map(sanitizeEvent).filter(Boolean),
      taste_logs: (Array.isArray(source.tasteLogs ?? source.tastes) ? (source.tasteLogs ?? source.tastes) : [])
        .slice(0, 50)
        .map(sanitizeTaste)
        .filter(Boolean),
      nutrition: sanitizeNutrition(source.nutrition),
      sensory_v2_souring: souringSignal(source.souring),
      measurements: sanitizeMeasurements(source, recipe)
    },
    recipe: {
      id: cleanText(recipe._id ?? recipe.id, 256),
      name: cleanText(recipe.name, 160),
      author: cleanText(recipe.author, 120),
      type: cleanText(recipe.type, 80),
      description: cleanText(recipe.description, 8_000),
      notes: cleanText(recipe.notes, 8_000),
      style: sanitizeStyle(recipe.style),
      sensory_v2_souring: souringSignal(recipe.souring),
      ingredients: sanitizeIngredients(recipe),
      profiles: {
        mash: sanitizeProfile(recipe.mash),
        fermentation: sanitizeProfile(recipe.fermentation),
        equipment: sanitizeProfile(recipe.equipment),
        water: sanitizeProfile(recipe.water)
      },
      nutrition: sanitizeNutrition(recipe.nutrition)
    },
    image_url: httpsUrl(source.image ?? source.imageUrl ?? recipe.image ?? recipe.imageUrl)
  };
  const payloadJson = boundedDetailJson(snapshot);
  return { payload_json: payloadJson, fingerprint: fingerprint(JSON.parse(payloadJson)) };
}

function readingTimestamp(source) {
  const recordedAt = isoDate(source.time ?? source.timestamp ?? source.createdAt);
  return { recorded_at: recordedAt, recorded_at_ms: recordedAt ? Date.parse(recordedAt) : null };
}

export function sanitizeReading(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const reading = {
    remote_id: cleanText(source._id ?? source.readingId, 256),
    ...readingTimestamp(source),
    reading_type: cleanText(source.type, 64),
    device_id: cleanText(source.device?.id ?? source.device?.name ?? source.device ?? source.id, 128),
    sg: finiteNumber(source.sg ?? source.gravity, 0.5, 2),
    temp_c: finiteNumber(source.temp ?? source.temp_c ?? source.temperature, -100, 200),
    pressure: finiteNumber(source.pressure),
    ph: finiteNumber(source.ph ?? source.pH, 0, 14),
    battery: finiteNumber(source.battery, 0, 100_000),
    rssi: finiteNumber(source.rssi, -1_000, 1_000)
  };
  if (!reading.remote_id && !reading.recorded_at && reading.sg === null && reading.temp_c === null) return null;
  const payloadJson = JSON.stringify(reading);
  if (Buffer.byteLength(payloadJson) > MAX_READING_BYTES) return null;
  return {
    ...reading,
    payload_json: payloadJson,
    reading_key:
      reading.remote_id ||
      fingerprint([
        reading.recorded_at_ms,
        reading.reading_type,
        reading.device_id,
        reading.sg,
        reading.temp_c,
        reading.pressure,
        reading.ph
      ])
  };
}

function defaultVisibility(db) {
  return db.prepare('SELECT ondeck_new_batch_default FROM settings WHERE id = 1').get()?.ondeck_new_batch_default
    ? 1
    : 0;
}

export function upsertSummaries(db, remote, { now = Date.now, complete = true } = {}) {
  const at = nowIso(now);
  const rows = (Array.isArray(remote) ? remote : []).map((item) => sanitizeSummary(item)).filter(Boolean);
  const existing = new Map();
  const findExisting = db.prepare('SELECT summary_fingerprint FROM batches WHERE batch_id = ?');
  for (const row of rows) existing.set(row.batch_id, findExisting.get(row.batch_id)?.summary_fingerprint ?? null);
  const changedIds = rows
    .filter((row) => existing.get(row.batch_id) !== row.summary_fingerprint)
    .map((row) => row.batch_id);
  const newIds = rows.filter((row) => existing.get(row.batch_id) === null).map((row) => row.batch_id);
  const visibility = defaultVisibility(db);
  const observePreference = db.prepare(
    'INSERT OR IGNORE INTO brewfather_ondeck_preferences (batch_id, visible) VALUES (?, ?)'
  );
  const upsert = db.prepare(`
    INSERT INTO batches (
      batch_id, batch_name, batch_number, brewer, recipe_id, recipe_name, style_id, style, description,
      brew_date, start_date, fermentation_start_date, conditioning_date, packaging_date, completed_date,
      image_url, og, fg, abv, ibu, srm, status, last_synced_at, estimated_og, estimated_fg, measured_og,
      measured_fg, estimated_abv, measured_abv, estimated_ibu, estimated_srm, carbonation,
      carbonation_temp_c, present, summary_fingerprint, source_updated_at, content_version,
      first_seen_at, last_seen_at, last_attempt_at, last_success_at, error_category
    ) VALUES (
      @batch_id, @batch_name, @batch_number, @brewer, @recipe_id, @recipe_name, @style_id, @style,
      @description, @brew_date, @start_date, @fermentation_start_date, @conditioning_date, @packaging_date,
      @completed_date, @image_url, @og, @fg, @abv, @estimated_ibu, @estimated_srm, @status, @at,
      @estimated_og, @estimated_fg, @measured_og, @measured_fg, @estimated_abv, @measured_abv,
      @estimated_ibu, @estimated_srm, @carbonation, @carbonation_temp_c, 1, @summary_fingerprint,
      @source_updated_at, @content_version, @at, @at, @at, @at, NULL
    )
    ON CONFLICT(batch_id) DO UPDATE SET
      batch_name=excluded.batch_name, batch_number=excluded.batch_number, brewer=excluded.brewer,
      recipe_id=excluded.recipe_id, recipe_name=excluded.recipe_name, style_id=excluded.style_id,
      style=excluded.style, description=excluded.description, brew_date=excluded.brew_date,
      start_date=excluded.start_date, fermentation_start_date=excluded.fermentation_start_date,
      conditioning_date=excluded.conditioning_date, packaging_date=excluded.packaging_date,
      completed_date=excluded.completed_date, image_url=excluded.image_url, og=excluded.og, fg=excluded.fg,
      abv=excluded.abv, ibu=excluded.ibu, srm=excluded.srm, status=excluded.status,
      last_synced_at=excluded.last_synced_at, estimated_og=excluded.estimated_og,
      estimated_fg=excluded.estimated_fg, measured_og=excluded.measured_og, measured_fg=excluded.measured_fg,
      estimated_abv=excluded.estimated_abv, measured_abv=excluded.measured_abv,
      estimated_ibu=excluded.estimated_ibu, estimated_srm=excluded.estimated_srm,
      carbonation=excluded.carbonation, carbonation_temp_c=excluded.carbonation_temp_c, present=1,
      summary_fingerprint=excluded.summary_fingerprint, source_updated_at=excluded.source_updated_at,
      content_version=excluded.content_version, last_seen_at=excluded.last_seen_at,
      last_attempt_at=excluded.last_attempt_at, last_success_at=excluded.last_success_at, error_category=NULL
  `);
  db.transaction(() => {
    if (complete) db.prepare('UPDATE batches SET present = 0 WHERE present = 1').run();
    for (const row of rows) {
      upsert.run({
        ...row,
        at,
        og: row.measured_og ?? row.estimated_og,
        fg: row.measured_fg ?? row.estimated_fg,
        abv: row.measured_abv ?? row.estimated_abv
      });
      observePreference.run(row.batch_id, visibility);
    }
  })();
  return { rows, changedIds, newIds, complete };
}

export function upsertDetail(db, batchId, source, { now = Date.now } = {}) {
  const row = sanitizeDetail(source);
  const at = nowIso(now);
  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO brewfather_batch_details (batch_id, payload_json, fingerprint, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        payload_json=excluded.payload_json, fingerprint=excluded.fingerprint, fetched_at=excluded.fetched_at
      WHERE payload_json <> excluded.payload_json OR fingerprint <> excluded.fingerprint
    `
    ).run(batchId, row.payload_json, row.fingerprint, at);
    db.prepare(
      `
      UPDATE batches SET detail_fingerprint=summary_fingerprint, detail_fetched_at=?, error_category=NULL
      WHERE batch_id=?
    `
    ).run(at, batchId);
  })();
  return row;
}

export function upsertReadings(db, batchId, readings, { maxPerWrite = MAX_HISTORY_PER_WRITE } = {}) {
  const limit = Math.min(Math.max(Number(maxPerWrite) || 1, 1), MAX_HISTORY_PER_WRITE);
  const rows = (Array.isArray(readings) ? readings : [])
    .map(sanitizeReading)
    .filter(Boolean)
    .sort((left, right) => (right.recorded_at_ms ?? 0) - (left.recorded_at_ms ?? 0))
    .slice(0, limit);
  const upsert = db.prepare(`
    INSERT INTO brewfather_batch_readings (
      batch_id, reading_key, remote_id, recorded_at, recorded_at_ms, reading_type, device_id,
      sg, temp_c, pressure, ph, battery, rssi, payload_json
    ) VALUES (
      @batchId, @reading_key, @remote_id, @recorded_at, @recorded_at_ms, @reading_type, @device_id,
      @sg, @temp_c, @pressure, @ph, @battery, @rssi, @payload_json
    )
    ON CONFLICT(batch_id, reading_key) DO UPDATE SET
      remote_id=excluded.remote_id, recorded_at=excluded.recorded_at, recorded_at_ms=excluded.recorded_at_ms,
      reading_type=excluded.reading_type, device_id=excluded.device_id, sg=excluded.sg, temp_c=excluded.temp_c,
      pressure=excluded.pressure, ph=excluded.ph, battery=excluded.battery, rssi=excluded.rssi,
      payload_json=excluded.payload_json
    WHERE payload_json <> excluded.payload_json
  `);
  db.transaction(() => {
    for (const row of rows) upsert.run({ batchId, ...row });
    db.prepare(
      `
      DELETE FROM brewfather_batch_readings
      WHERE rowid IN (
        SELECT rowid FROM brewfather_batch_readings
        WHERE batch_id=? ORDER BY recorded_at_ms DESC, reading_key DESC LIMIT -1 OFFSET ?
      )
    `
    ).run(batchId, MAX_HISTORY_PER_BATCH);
  })();
  return rows;
}

const PUBLIC_SUMMARY_SQL = `
  SELECT batch_id, batch_name, batch_number, recipe_name, style, description, brew_date,
    COALESCE(measured_og, estimated_og, og) AS og,
    COALESCE(measured_fg, estimated_fg, fg) AS fg,
    COALESCE(measured_abv, estimated_abv, abv) AS abv,
    COALESCE(estimated_ibu, ibu) AS ibu,
    COALESCE(estimated_srm, srm) AS srm,
    status, image_url, last_success_at AS last_synced_at, present
  FROM batches
`;

export function publicSummaries(db, { presentOnly = true, limit = MAX_PUBLIC_BATCHES } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 1, 1), MAX_PUBLIC_BATCHES);
  return db
    .prepare(
      `${PUBLIC_SUMMARY_SQL} ${presentOnly ? 'WHERE present=1' : ''}
       ORDER BY brew_date DESC, batch_id LIMIT ?`
    )
    .all(boundedLimit);
}

export function batchSummary(db, batchId) {
  return db.prepare(`${PUBLIC_SUMMARY_SQL} WHERE batch_id=?`).get(batchId) || null;
}

export function assignmentOptions(db, { limit = MAX_PUBLIC_BATCHES } = {}) {
  return publicSummaries(db, { limit }).map((row) => ({
    ...row,
    assignmentOption: `${row.batch_id} | ${row.recipe_name} (${row.status})`
  }));
}

export function onDeckBatches(db, { limit = MAX_PUBLIC_BATCHES } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 1, 1), MAX_PUBLIC_BATCHES);
  return db
    .prepare(
      `
      SELECT b.batch_id, b.batch_name, b.recipe_name, b.style, b.status,
        COALESCE(b.measured_abv, b.estimated_abv, b.abv) AS abv,
        b.brew_date, b.image_url, p.visible, p.target_tap_id AS target_tap_id
      FROM batches b
      JOIN brewfather_ondeck_preferences p ON p.batch_id=b.batch_id
      WHERE b.present=1 AND b.status IN ('Fermenting', 'Conditioning')
      ORDER BY b.brew_date DESC, b.batch_id LIMIT ?
    `
    )
    .all(boundedLimit)
    .map((row) => ({
      ...row,
      visible: row.visible === 1,
      target_tap_id: row.target_tap_id ? Number(row.target_tap_id) : null
    }));
}

export function detailCandidates(db, changedIds = [], limit = 12) {
  const changed = new Set(changedIds);
  return db
    .prepare(
      `
      SELECT b.batch_id,
        CASE WHEN t.batch_id IS NOT NULL THEN 1 ELSE 0 END AS assigned,
        CASE WHEN p.visible=1 THEN 1 ELSE 0 END AS visible,
        b.detail_fingerprint, b.summary_fingerprint
      FROM batches b
      LEFT JOIN taps t ON t.batch_id=b.batch_id
      LEFT JOIN brewfather_ondeck_preferences p ON p.batch_id=b.batch_id
      WHERE b.present=1
      GROUP BY b.batch_id
      ORDER BY assigned DESC, visible DESC, b.last_seen_at DESC, b.batch_id
    `
    )
    .all()
    .filter(
      (row) =>
        changed.has(row.batch_id) ||
        row.detail_fingerprint === null ||
        row.detail_fingerprint !== row.summary_fingerprint
    )
    .slice(0, Math.min(Math.max(Number(limit) || 1, 1), 12))
    .map((row) => row.batch_id);
}

export function latestReadingCandidates(db, limit = 12) {
  return db
    .prepare(
      `
      SELECT b.batch_id, CASE WHEN COUNT(t.tap_id) > 0 THEN 1 ELSE 0 END AS assigned
      FROM batches b
      LEFT JOIN taps t ON t.batch_id=b.batch_id
      LEFT JOIN brewfather_ondeck_preferences p ON p.batch_id=b.batch_id
      JOIN settings s ON s.id=1
      WHERE b.present=1 AND b.status IN ('Brewing', 'Fermenting', 'Conditioning')
        AND (t.tap_id IS NOT NULL OR (p.visible=1 AND s.show_ondeck=1))
      GROUP BY b.batch_id
      ORDER BY assigned DESC, b.last_seen_at DESC, b.batch_id LIMIT ?
    `
    )
    .all(Math.min(Math.max(Number(limit) || 1, 1), 12))
    .map((row) => row.batch_id);
}

export function batchRecipeId(db, batchId) {
  return db.prepare('SELECT recipe_id FROM batches WHERE batch_id=? AND present=1').get(batchId)?.recipe_id ?? null;
}

export function historyCandidates(db, { now = Date.now, intervalMs = 24 * 60 * 60 * 1_000, limit = 12 } = {}) {
  const cutoff = new Date(now() - Math.max(60_000, intervalMs)).toISOString();
  return db
    .prepare(
      `
      SELECT b.batch_id, CASE WHEN COUNT(t.tap_id) > 0 THEN 1 ELSE 0 END AS assigned
      FROM batches b
      LEFT JOIN taps t ON t.batch_id=b.batch_id
      LEFT JOIN brewfather_ondeck_preferences p ON p.batch_id=b.batch_id
      JOIN settings s ON s.id=1
      LEFT JOIN brewfather_history_sync_state h ON h.batch_id=b.batch_id
      WHERE b.present=1 AND b.status IN ('Brewing', 'Fermenting', 'Conditioning')
        AND (t.tap_id IS NOT NULL OR (p.visible=1 AND s.show_ondeck=1))
        AND (h.batch_id IS NULL OR COALESCE(h.last_success_at, h.last_attempt_at) < ?)
      GROUP BY b.batch_id
      ORDER BY assigned DESC, CASE WHEN h.batch_id IS NULL THEN 0 ELSE 1 END,
        COALESCE(h.last_success_at, h.last_attempt_at), b.last_seen_at DESC, b.batch_id
      LIMIT ?
    `
    )
    .all(cutoff, Math.min(Math.max(Number(limit) || 1, 1), 12))
    .map((row) => row.batch_id);
}

export function updateHistorySyncState(db, batchId, fields = {}) {
  const allowed = new Set(['last_attempt_at', 'last_success_at', 'error_category', 'reading_count']);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;
  const insert = {
    last_attempt_at: null,
    last_success_at: null,
    error_category: null,
    reading_count: 0,
    ...Object.fromEntries(entries)
  };
  const updates = entries.map(([key]) => `${key}=excluded.${key}`).join(', ');
  db.prepare(
    `INSERT INTO brewfather_history_sync_state
      (batch_id, last_attempt_at, last_success_at, error_category, reading_count)
     VALUES (@batch_id, @last_attempt_at, @last_success_at, @error_category, @reading_count)
     ON CONFLICT(batch_id) DO UPDATE SET ${updates},
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run({ batch_id: batchId, ...insert });
}

export function markBatchError(db, batchId, category, at) {
  db.prepare('UPDATE batches SET last_attempt_at=?, error_category=? WHERE batch_id=?').run(
    at,
    cleanText(category, 64) || 'unknown',
    batchId
  );
}

export function syncStatus(db) {
  const row = db
    .prepare(
      `
      SELECT last_attempt_at, last_success_at, status, error_category, retry_at,
        freshness_at, last_cycle_requests, last_cycle_batches
      FROM brewfather_sync_state WHERE id=1
    `
    )
    .get();
  return { ...row, stale: !row || !['ok', 'running'].includes(row.status) };
}
