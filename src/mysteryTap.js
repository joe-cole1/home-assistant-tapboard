import { HttpError } from './httpSecurity.js';

export const ALL_MYSTERY_CATEGORIES = Object.freeze([
  'name',
  'brewery',
  'style',
  'description',
  'image',
  'sensory',
  'brew_story',
  'recipe',
  'glassware'
]);

const ALL_CATEGORIES_SET = new Set(ALL_MYSTERY_CATEGORIES);

export function defaultRedactedCategories() {
  return [...ALL_MYSTERY_CATEGORIES];
}

export function validateCategories(categories) {
  if (!Array.isArray(categories)) throw new HttpError(400, 'Redacted categories must be an array');
  const valid = [];
  for (const cat of categories) {
    if (typeof cat !== 'string' || !ALL_CATEGORIES_SET.has(cat)) {
      throw new HttpError(400, `Invalid mystery redacted category: ${cat}`);
    }
    if (!valid.includes(cat)) valid.push(cat);
  }
  return valid;
}

export function getMysteryConfig(db, lifecycleId) {
  if (!lifecycleId) return null;
  const row = db
    .prepare(
      `SELECT lifecycle_id, enabled, redacted_categories_json, started_at, revealed_at
       FROM keg_mystery_config WHERE lifecycle_id = ?`
    )
    .get(lifecycleId);
  if (!row) return null;
  let categories;
  try {
    categories = JSON.parse(row.redacted_categories_json);
  } catch {
    categories = defaultRedactedCategories();
  }
  return {
    lifecycleId: row.lifecycle_id,
    lifecycle_id: row.lifecycle_id,
    enabled: row.enabled === 1 ? 1 : 0,
    redactedCategories: categories,
    redacted_categories: categories,
    startedAt: row.started_at,
    started_at: row.started_at,
    revealedAt: row.revealed_at,
    revealed_at: row.revealed_at
  };
}

export function setMysteryConfig(
  db,
  { lifecycleId, enabled, redactedCategories = defaultRedactedCategories(), timestamp = new Date().toISOString() }
) {
  if (!lifecycleId) throw new HttpError(400, 'Lifecycle ID is required');
  const existing = getMysteryConfig(db, lifecycleId);
  if (existing && existing.revealedAt) {
    throw new HttpError(
      409,
      'This keg lifecycle has already been revealed and cannot be placed back into mystery mode'
    );
  }
  const isEnabled = enabled ? 1 : 0;
  const validCategories = validateCategories(redactedCategories);
  const categoriesJson = JSON.stringify(validCategories);

  db.prepare(
    `INSERT INTO keg_mystery_config (lifecycle_id, enabled, redacted_categories_json, started_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(lifecycle_id) DO UPDATE SET
       enabled = excluded.enabled,
       redacted_categories_json = excluded.redacted_categories_json`
  ).run(lifecycleId, isEnabled, categoriesJson, timestamp);

  return getMysteryConfig(db, lifecycleId);
}

export function revealMystery(db, { lifecycleId, timestamp = new Date().toISOString() }) {
  if (!lifecycleId) throw new HttpError(400, 'Lifecycle ID is required');
  const existing = getMysteryConfig(db, lifecycleId);
  if (!existing || (!existing.enabled && !existing.startedAt)) {
    throw new HttpError(404, 'No mystery configuration found for this keg lifecycle');
  }
  if (existing.revealedAt) {
    return existing;
  }
  db.prepare(
    `UPDATE keg_mystery_config
     SET enabled = 0, revealed_at = ?
     WHERE lifecycle_id = ?`
  ).run(timestamp, lifecycleId);

  return getMysteryConfig(db, lifecycleId);
}

export function isMysteryActive(mysteryState) {
  return Boolean(mysteryState && mysteryState.enabled && !mysteryState.revealedAt);
}

export function redactTapProjection(tapData, mysteryState) {
  if (!tapData || typeof tapData !== 'object') return tapData;
  if (!isMysteryActive(mysteryState)) {
    return {
      ...tapData,
      is_mystery: Boolean(mysteryState && (mysteryState.enabled || mysteryState.revealedAt)),
      mystery_revealed: Boolean(mysteryState && mysteryState.revealedAt)
    };
  }

  const redactedSet = new Set(mysteryState.redactedCategories || defaultRedactedCategories());
  const copy = { ...tapData };

  copy.is_mystery = true;
  copy.mystery_revealed = false;
  copy.redacted_categories = Array.from(redactedSet);

  if (redactedSet.has('name')) {
    copy.name = 'Mystery Beer';
    copy.displayName = 'Mystery Beer';
    if (copy.batch) {
      copy.batch.recipe_name = 'Mystery Beer';
      copy.batch.recipeName = 'Mystery Beer';
    }
  }
  if (redactedSet.has('brewery')) {
    copy.brewery = null;
    if (copy.batch) copy.batch.brewer = null;
  }
  if (redactedSet.has('style')) {
    copy.style = 'Mystery Style';
    copy.displayStyle = 'Mystery Style';
    if (copy.batch) copy.batch.style = 'Mystery Style';
  }
  if (redactedSet.has('description')) {
    copy.description = 'Identity hidden in Mystery Tap mode.';
    if (copy.batch) copy.batch.description = 'Identity hidden in Mystery Tap mode.';
  }
  if (redactedSet.has('image')) {
    copy.image_url = null;
    if (copy.batch) copy.batch.image_url = null;
  }
  if (redactedSet.has('sensory')) {
    copy.sensory = null;
    copy.flavor_radar = null;
  }
  if (redactedSet.has('brew_story')) {
    copy.has_story = false;
    copy.story_eligible = false;
  }
  if (redactedSet.has('recipe')) {
    copy.ingredients = null;
    copy.og = null;
    copy.fg = null;
    copy.ibu = null;
    if (copy.batch) {
      copy.batch.og = null;
      copy.batch.fg = null;
      copy.batch.ibu = null;
    }
  }
  if (redactedSet.has('glassware')) {
    copy.glassware = null;
    copy.glassware_recommendation = null;
  }

  return copy;
}

export function redactBrewStory(storyPayload, mysteryState) {
  if (!storyPayload || typeof storyPayload !== 'object') return storyPayload;
  if (!isMysteryActive(mysteryState)) return storyPayload;

  const redactedSet = new Set(mysteryState.redactedCategories || defaultRedactedCategories());
  const copy = JSON.parse(JSON.stringify(storyPayload));

  if (redactedSet.has('name')) {
    copy.name = 'Mystery Beer';
    if (copy.batch) {
      copy.batch.recipe_name = 'Mystery Beer';
      copy.batch.recipeName = 'Mystery Beer';
    }
    if (copy.recipe) copy.recipe.name = 'Mystery Beer';
  }
  if (redactedSet.has('brewery') && copy.batch) {
    copy.batch.brewer = null;
  }
  if (redactedSet.has('style')) {
    copy.style = 'Mystery Style';
    if (copy.batch) copy.batch.style = 'Mystery Style';
    if (copy.recipe) copy.recipe.style = 'Mystery Style';
  }
  if (redactedSet.has('description')) {
    copy.description = 'Recipe and tasting profile redacted during Mystery Tap mode.';
    if (copy.batch) copy.batch.description = 'Recipe and tasting profile redacted during Mystery Tap mode.';
    if (copy.recipe) copy.recipe.description = 'Recipe and tasting profile redacted during Mystery Tap mode.';
  }
  if (redactedSet.has('image')) {
    copy.image = null;
    if (copy.batch) copy.batch.image_url = null;
  }
  if (redactedSet.has('sensory')) {
    copy.sensory = null;
  }
  if (redactedSet.has('recipe')) {
    copy.recipe = null;
  }
  if (redactedSet.has('brew_story')) {
    copy.readings = [];
    copy.fermentation = null;
    copy.chapters = [];
  }

  return copy;
}
