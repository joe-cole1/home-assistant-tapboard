import {
  INGREDIENT_CHARACTER_MAP,
  RULES_VERSION,
  SCALE_LABELS,
  SENSORY_AXES,
  STYLE_BASELINES
} from './sensoryMappings.js';

const SOURCE_CONFIDENCE = Object.freeze({
  manual: 'high',
  tasting: 'high',
  recipe_prediction: 'medium',
  style_baseline: 'low',
  unsupported: null
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function score(value) {
  const number = finite(value);
  if (number === null) return null;
  const normalized = number > 5 && number <= 100 ? number / 20 : number;
  return Math.max(0, Math.min(5, Math.round(normalized * 2) / 2));
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function pickNumber(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = finite(object?.[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function scaled(value, thresholds) {
  if (value === null) return null;
  return thresholds.reduce((result, threshold) => result + Number(value >= threshold), 0);
}

function styleName(summary, detail) {
  return (
    [summary.style, summary.style_name, detail.recipe?.style?.name, detail.style, detail.style_name]
      .find((value) => typeof value === 'string' && value.trim())
      ?.trim() || ''
  );
}

function baselineFor(style) {
  return STYLE_BASELINES.find((entry) => entry.match.test(style))?.values || {};
}

function recipePredictions(summary, detail) {
  const recipe = firstObject(detail.recipe, detail);
  const measurements = firstObject(detail.batch?.measurements, detail.measurements);
  const sources = [summary, measurements, detail, recipe];
  const ibu = pickNumber(sources, ['ibu', 'estimated_ibu', 'bitterness']);
  const abv = pickNumber(sources, ['abv', 'estimated_abv']);
  const srm = pickNumber(sources, ['srm', 'color_srm', 'estimated_srm']);
  const fg = pickNumber(sources, ['fg', 'final_gravity']);
  const fermentables = Array.isArray(recipe.ingredients?.fermentables)
    ? recipe.ingredients.fermentables
    : Array.isArray(recipe.fermentables)
      ? recipe.fermentables
      : [];
  const hops = Array.isArray(recipe.ingredients?.hops)
    ? recipe.ingredients.hops
    : Array.isArray(recipe.hops)
      ? recipe.hops
      : [];
  const miscs = Array.isArray(recipe.ingredients?.miscs) ? recipe.ingredients.miscs : [];
  const yeasts = Array.isArray(recipe.ingredients?.yeasts) ? recipe.ingredients.yeasts : [];
  const explicitSouring = [recipe.souring, detail.souring].some(
    (value) => value === true || (typeof value === 'string' && /sour|lactic|kettle/i.test(value))
  );
  // Water-treatment acid can adjust mash chemistry, but is not sensory souring.
  const values = {};
  if (ibu !== null) values.bitterness = scaled(ibu, [15, 30, 50, 75, 100]);
  if (abv !== null) values.perceived_strength = scaled(abv, [4, 6, 8, 10, 12]);
  if (srm !== null) values.roast = scaled(srm, [10, 20, 30, 40, 50]);
  if (fg !== null) values.sweetness = scaled(fg, [1.008, 1.012, 1.016, 1.022, 1.03]);
  if (fermentables.length) {
    values.malt = Math.min(5, 1.5 + Number(fermentables.length >= 3) + Number(fermentables.length >= 6));
  }
  if (hops.length) {
    const lateHops = hops.filter((hop) => /dry|whirlpool|aroma/i.test(`${hop.use || ''} ${hop.type || ''}`));
    values.hops = Math.min(
      5,
      1.5 + Number(hops.length >= 2) + Number(lateHops.length > 0) + Number(lateHops.length >= 2)
    );
  }
  for (const ingredient of [...fermentables, ...miscs, ...yeasts]) {
    const name = `${ingredient.name || ''} ${ingredient.category || ''} ${ingredient.use || ''}`;
    for (const mapping of INGREDIENT_CHARACTER_MAP) {
      if (!mapping.match.test(name) || mapping.axis === 'water_treatment') continue;
      values[mapping.axis] = Math.min(5, (values[mapping.axis] ?? 0) + mapping.weight);
    }
  }
  if (fg !== null || values.body !== undefined) {
    values.body = Math.max(values.body ?? 0, scaled(fg, [1.006, 1.01, 1.014, 1.02, 1.028]) ?? 0);
  }
  if (explicitSouring) values.tartness = Math.max(values.tartness ?? 0, 4);
  return values;
}

function latestTasting(logs) {
  const dated = logs
    .map((log, index) => ({ log, index, time: Date.parse(log?.recorded_at) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((left, right) => right.time - left.time || right.index - left.index);
  return dated[0]?.log ?? logs.at(-1);
}

function tastingValues(detail) {
  const logs = Array.isArray(detail.batch?.taste_logs) ? detail.batch.taste_logs : [];
  const tasting = firstObject(latestTasting(logs)?.ratings, detail.tasting, detail.tasting_notes, detail.sensory);
  return Object.fromEntries(
    SENSORY_AXES.map((axis) => {
      const aliases = axis === 'perceived_strength' ? ['perceived_strength', 'perceivedStrength', 'alcohol'] : [axis];
      return [axis, score(pickNumber([tasting], aliases))];
    }).filter(([, value]) => value !== null)
  );
}

function manualValues(override) {
  const axes = firstObject(override.axes, override.sensory, override);
  return Object.fromEntries(
    SENSORY_AXES.map((axis) => [axis, score(axes[axis])]).filter(([, value]) => value !== null)
  );
}

function entry(axis, value, sourceLayer, evidence) {
  return Object.freeze({ value, evidence, confidence: SOURCE_CONFIDENCE[sourceLayer], source_layer: sourceLayer });
}

/**
 * Build a bounded presentation-ready profile from already-sanitized beer data.
 * The function is pure: callers may safely cache or compare its result.
 */
export function buildSensoryProfile({ summary = {}, detail = {}, override = {} } = {}) {
  const style = styleName(summary, detail);
  const baseline = baselineFor(style);
  const prediction = recipePredictions(summary, detail);
  const tasting = tastingValues(detail);
  const manual = manualValues(override);
  const axes = {};

  for (const axis of SENSORY_AXES) {
    if (Object.hasOwn(manual, axis)) axes[axis] = entry(axis, manual[axis], 'manual', 'Manual overlay');
    else if (Object.hasOwn(tasting, axis)) axes[axis] = entry(axis, tasting[axis], 'tasting', 'Recorded tasting');
    else if (Object.hasOwn(prediction, axis))
      axes[axis] = entry(axis, prediction[axis], 'recipe_prediction', 'Recipe data');
    else if (Object.hasOwn(baseline, axis))
      axes[axis] = entry(axis, baseline[axis], 'style_baseline', `Style baseline: ${style}`);
    else axes[axis] = entry(axis, null, 'unsupported', 'No supported evidence');
  }

  const prose = SENSORY_AXES.filter((axis) => axes[axis].value !== null)
    .map((axis) => `${axis.replaceAll('_', ' ')}: ${SCALE_LABELS[axis][Math.round(axes[axis].value)]}`)
    .join('; ');
  return Object.freeze({ rules_version: RULES_VERSION, axes: Object.freeze(axes), prose });
}

export const buildSensoryProfileV1 = buildSensoryProfile;

export function buildSensoryModelV1({ summary = {}, detail = {} } = {}) {
  const batch = firstObject(detail.batch);
  return buildSensoryProfile({
    summary,
    detail: {
      ...detail,
      batch: { ...batch, taste_logs: [] },
      tasting: null,
      tasting_notes: null,
      sensory: null
    }
  });
}

export { RULES_VERSION, SENSORY_AXES };
