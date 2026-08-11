import {
  SENSORY_V2_AXES as SENSORY_AXES,
  SENSORY_V2_SCALE_LABELS as SCALE_LABELS,
  SENSORY_V2_STYLE_BASELINES as STYLE_BASELINES
} from './sensoryMappingsV2.js';

export const SENSORY_V2_RULES_VERSION = 'sensory-v2';

const SOURCE_CONFIDENCE = Object.freeze({
  manual: 'high',
  tasting: 'high',
  recipe_prediction: 'medium',
  style_baseline: 'low',
  unsupported: null
});

const METRIC_ALIASES = Object.freeze({
  og: ['measured_og', 'actual_og', 'target_og', 'estimated_og', 'og'],
  fg: ['measured_fg', 'actual_fg', 'target_fg', 'estimated_fg', 'fg', 'final_gravity'],
  ibu: ['measured_ibu', 'actual_ibu', 'target_ibu', 'estimated_ibu', 'ibu', 'bitterness'],
  abv: ['measured_abv', 'actual_abv', 'target_abv', 'estimated_abv', 'abv'],
  attenuation: [
    'measured_attenuation',
    'actual_attenuation',
    'target_attenuation',
    'estimated_attenuation',
    'attenuation'
  ],
  srm: [
    'measured_color_srm',
    'actual_color_srm',
    'target_color_srm',
    'estimated_color_srm',
    'estimated_srm',
    'color_srm',
    'srm'
  ],
  volume: [
    'measured_batch_volume_l',
    'actual_batch_volume_l',
    'target_batch_volume_l',
    'estimated_batch_volume_l',
    'batch_volume_l',
    'batch_size_l',
    'batchSize'
  ],
  ph: ['measured_ph']
});

const IBU_CURVE = Object.freeze([
  [0, 0],
  [10, 0.5],
  [20, 1],
  [35, 2],
  [50, 3],
  [70, 4],
  [100, 5]
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value) {
  return Math.max(0, Math.min(5, value));
}

function curve(value, knots) {
  if (value === null) return null;
  if (value <= knots[0][0]) return knots[0][1];
  for (let index = 1; index < knots.length; index++) {
    if (value > knots[index][0]) continue;
    const [lowX, lowY] = knots[index - 1];
    const [highX, highY] = knots[index];
    return lowY + ((value - lowX) * (highY - lowY)) / (highX - lowX);
  }
  return knots.at(-1)[1];
}

function diminishingUnion(base, bonus) {
  return 5 * (1 - (1 - base / 5) * (1 - bonus / 5));
}

function metric(sources, aliases) {
  for (const alias of aliases) {
    for (const source of sources) {
      const value = finite(source?.[alias]);
      if (value !== null) return value;
    }
  }
  return null;
}

function grams(ingredient) {
  const amount = finite(ingredient?.amount ?? ingredient?.weight);
  if (amount === null || amount < 0) return null;
  const rawUnit = ingredient?.unit ?? ingredient?.amount_unit;
  if (rawUnit === null || rawUnit === undefined || rawUnit === '') return amount * 1_000;
  const unit = String(rawUnit).trim().toLowerCase();
  if (/^(?:mg|milligrams?)$/.test(unit)) return amount / 1_000;
  if (/^(?:g|grams?)$/.test(unit)) return amount;
  if (/^(?:kg|kilograms?)$/.test(unit)) return amount * 1_000;
  return null;
}

function ingredientText(ingredient) {
  return `${ingredient?.name || ''} ${ingredient?.category || ''} ${ingredient?.type || ''} ${ingredient?.use || ''}`;
}

function ingredientList(recipe, ingredients, name) {
  if (Array.isArray(ingredients[name])) return { items: ingredients[name], known: true };
  if (Array.isArray(recipe[name])) return { items: recipe[name], known: true };
  return { items: [], known: false };
}

function gristPercentages(fermentables) {
  if (fermentables.length === 0) return null;
  const percentages = fermentables.map((ingredient) => finite(ingredient?.percentage ?? ingredient?.percent));
  const percentageTotal = percentages.reduce((sum, value) => sum + (value ?? 0), 0);
  if (percentages.every((value) => value !== null) && percentageTotal >= 95 && percentageTotal <= 105) {
    return percentages.map((value) => (value * 100) / percentageTotal);
  }
  const masses = fermentables.map(grams);
  const massTotal = masses.reduce((sum, value) => sum + (value ?? 0), 0);
  if (!masses.every((value) => value !== null) || massTotal <= 0) return null;
  return masses.map((value) => (value * 100) / massTotal);
}

function categoryWeight(name, mappings) {
  return mappings.find(([pattern]) => pattern.test(name))?.[1] ?? 0;
}

function styleName(summary, detail) {
  return (
    [summary.style, summary.style_name, detail.recipe?.style?.name, detail.style, detail.style_name]
      .find((value) => typeof value === 'string' && value.trim())
      ?.trim() || ''
  );
}

function styleBaseline(style) {
  const values = {};
  for (const entry of STYLE_BASELINES) {
    if (!entry.match.test(style)) continue;
    for (const [axis, value] of Object.entries(entry.values)) values[axis] ??= value;
  }
  return values;
}

function ratingValue(ratings, axis) {
  const aliases = axis === 'perceived_strength' ? ['perceived_strength', 'perceivedStrength', 'alcohol'] : [axis];
  for (const alias of aliases) {
    const value = finite(ratings?.[alias]);
    if (value !== null && value >= 0 && value <= 5) return value;
  }
  return null;
}

function tastingValues(detail) {
  const logs = Array.isArray(detail.batch?.taste_logs) ? detail.batch.taste_logs : [];
  const ordered = logs
    .map((log, index) => ({ log, index, time: Date.parse(log?.recorded_at) }))
    .sort((left, right) => {
      const leftDated = Number.isFinite(left.time);
      const rightDated = Number.isFinite(right.time);
      if (leftDated && rightDated) return right.time - left.time || right.index - left.index;
      if (leftDated !== rightDated) return leftDated ? -1 : 1;
      return right.index - left.index;
    });
  const fallback = object(detail.tasting || detail.tasting_notes || detail.sensory);
  return Object.fromEntries(
    SENSORY_AXES.map((axis) => {
      for (const { log } of ordered) {
        const value = ratingValue(object(log?.ratings), axis);
        if (value !== null) return [axis, value];
      }
      return [axis, ratingValue(fallback, axis)];
    }).filter(([, value]) => value !== null)
  );
}

function manualValues(override) {
  const source = object(override);
  const axes = object(source.axes || source.sensory || source);
  return Object.fromEntries(
    SENSORY_AXES.map((axis) => [axis, finite(axes[axis])]).filter(
      ([, value]) => value !== null && value >= 0 && value <= 5
    )
  );
}

function entry(value, sourceLayer, evidence) {
  return Object.freeze({
    value,
    evidence,
    confidence: SOURCE_CONFIDENCE[sourceLayer],
    source_layer: sourceLayer
  });
}

function recipeModel(summary, detail) {
  const recipe = object(detail.recipe);
  const measurements = object(detail.batch?.measurements || detail.measurements);
  const sources = [measurements, summary, detail, recipe];
  const metrics = Object.fromEntries(
    Object.entries(METRIC_ALIASES).map(([name, aliases]) => [name, metric(sources, aliases)])
  );
  if (metrics.attenuation === null && metrics.og !== null && metrics.fg !== null && metrics.og > 1) {
    metrics.attenuation = ((metrics.og - metrics.fg) / (metrics.og - 1)) * 100;
  }

  const ingredients = object(recipe.ingredients);
  const fermentableData = ingredientList(recipe, ingredients, 'fermentables');
  const hopData = ingredientList(recipe, ingredients, 'hops');
  const miscData = ingredientList(recipe, ingredients, 'miscs');
  const yeastData = ingredientList(recipe, ingredients, 'yeasts');
  const fermentables = fermentableData.items;
  const hops = hopData.items;
  const miscs = miscData.items;
  const yeasts = yeastData.items;
  const percentages = gristPercentages(fermentables);
  const values = {};
  const evidence = {};

  if (metrics.ibu !== null) {
    const ibuBase = curve(metrics.ibu, IBU_CURVE);
    const balanceAdjustment =
      metrics.og !== null && metrics.og > 1
        ? curve(metrics.ibu / ((metrics.og - 1) * 1_000), [
            [0, -1],
            [0.3, -0.75],
            [0.5, 0],
            [0.8, 0.5],
            [1, 0.75]
          ])
        : 0;
    const residualMask =
      metrics.fg === null
        ? 0
        : curve(metrics.fg, [
            [1.008, 0],
            [1.014, 0.15],
            [1.02, 0.35],
            [1.03, 0.75],
            [1.04, 1]
          ]);
    values.bitterness = clamp(ibuBase + balanceAdjustment - residualMask);
    evidence.bitterness = [
      'IBU',
      metrics.og !== null ? 'BU:GU balance' : null,
      metrics.fg !== null ? 'FG masking' : null
    ]
      .filter(Boolean)
      .join(' + ');
  }

  const fgSweetness =
    metrics.fg === null
      ? null
      : curve(metrics.fg, [
          [1, 0],
          [1.004, 0.5],
          [1.008, 1],
          [1.012, 2],
          [1.018, 3],
          [1.026, 4],
          [1.036, 5]
        ]);
  const attenuationSweetness =
    metrics.attenuation === null
      ? null
      : curve(metrics.attenuation, [
          [50, 5],
          [60, 4],
          [70, 3],
          [78, 2],
          [85, 1],
          [92, 0]
        ]);
  const baseSweetness =
    fgSweetness === null
      ? attenuationSweetness
      : attenuationSweetness === null
        ? fgSweetness
        : 0.65 * fgSweetness + 0.35 * attenuationSweetness;
  const lactoseIngredients = [...fermentables, ...miscs].filter((ingredient) =>
    /\blactose|milk sugar\b/i.test(ingredientText(ingredient))
  );
  const lactoseMasses = lactoseIngredients.map(grams);
  const lactoseBonus =
    lactoseIngredients.length > 0 &&
    metrics.volume !== null &&
    metrics.volume > 0 &&
    lactoseMasses.every((value) => value !== null)
      ? curve(lactoseMasses.reduce((sum, value) => sum + value, 0) / metrics.volume, [
          [0, 0],
          [5, 0.25],
          [10, 0.5],
          [20, 1],
          [40, 1.5]
        ])
      : null;
  if (baseSweetness !== null || lactoseBonus !== null) {
    values.sweetness = clamp(
      (baseSweetness ?? 0) + (lactoseBonus ?? 0) - (metrics.ibu === null ? 0 : 0.15 * curve(metrics.ibu, IBU_CURVE))
    );
    evidence.sweetness = [
      metrics.fg !== null ? 'FG' : null,
      metrics.attenuation !== null ? 'attenuation' : null,
      lactoseBonus !== null ? 'lactose rate' : null,
      metrics.ibu !== null ? 'IBU masking' : null
    ]
      .filter(Boolean)
      .join(' + ');
  }

  const fgBody =
    metrics.fg === null
      ? null
      : curve(metrics.fg, [
          [1, 0],
          [1.006, 0.75],
          [1.01, 1.5],
          [1.014, 2.25],
          [1.02, 3.25],
          [1.028, 4.25],
          [1.04, 5]
        ]);
  const attenuationBody =
    metrics.attenuation === null
      ? null
      : curve(metrics.attenuation, [
          [50, 5],
          [60, 4],
          [70, 2.5],
          [78, 1.5],
          [85, 0.75],
          [92, 0]
        ]);
  const gravityBody =
    fgBody === null ? attenuationBody : attenuationBody === null ? fgBody : 0.7 * fgBody + 0.3 * attenuationBody;
  if (gravityBody !== null) {
    const adjunctPercentage =
      percentages === null
        ? 0
        : percentages.reduce(
            (sum, percentage, index) =>
              sum +
              percentage *
                categoryWeight(ingredientText(fermentables[index]), [
                  [/\b(?:oats?|flaked wheat|chit)\b/i, 1],
                  [/\brye\b/i, 0.8],
                  [/\bwheat\b/i, 0.5]
                ]),
            0
          );
    const adjunctBonus = curve(adjunctPercentage, [
      [0, 0],
      [5, 0.4],
      [15, 1],
      [30, 1.75],
      [50, 2.5]
    ]);
    values.body = clamp(diminishingUnion(gravityBody, adjunctBonus));
    evidence.body = [
      metrics.fg !== null ? 'FG' : null,
      metrics.attenuation !== null ? 'attenuation' : null,
      percentages !== null ? 'adjunct percentage' : null
    ]
      .filter(Boolean)
      .join(' + ');
  }

  const hopMasses = hops.map(grams);
  if (hopData.known && metrics.volume !== null && metrics.volume > 0 && hopMasses.every((value) => value !== null)) {
    const effectiveHopGrams = hops.reduce((sum, hop, index) => {
      const description = ingredientText(hop);
      const minutes = finite(hop?.time ?? hop?.boil_time);
      const factor = /\b(?:dry|secondary)\b/i.test(description)
        ? 1
        : /\b(?:whirlpool|hopstand|hop stand|aroma|flameout)\b/i.test(description) || minutes === 0
          ? 0.8
          : minutes !== null && minutes <= 10
            ? 0.5
            : minutes !== null && minutes <= 20
              ? 0.25
              : 0;
      return sum + hopMasses[index] * factor;
    }, 0);
    const effectiveRate = effectiveHopGrams / metrics.volume;
    values.hops = clamp(
      curve(effectiveRate, [
        [0, 0],
        [0.25, 0.5],
        [0.5, 1],
        [1.5, 2],
        [3, 3],
        [6, 4],
        [10, 5]
      ])
    );
    evidence.hops = 'Timing-weighted late-hop g/L';
  }

  if (percentages !== null) {
    const characterPercentage = percentages.reduce(
      (sum, percentage, index) =>
        sum +
        percentage *
          categoryWeight(ingredientText(fermentables[index]), [
            [/\b(?:sugar|syrup)\b/i, 0],
            [/\b(?:maris otter|golden promise)\b/i, 0.45],
            [/\bvienna\b/i, 0.6],
            [/\b(?:munich|crystal|caramel)\b/i, 0.8],
            [/\b(?:biscuit|melanoidin|aromatic|toasted)\b/i, 1],
            [/\b(?:roast|black|patent|chocolate|carafa)\b/i, 0.4],
            [/\b(?:pale|pilsner|malt|grain)\b/i, 0.25]
          ]),
      0
    );
    const characterScore = curve(characterPercentage, [
      [0, 0.5],
      [10, 1.5],
      [25, 2.5],
      [45, 3.5],
      [70, 4.5],
      [100, 5]
    ]);
    const gravityScore =
      metrics.og === null
        ? null
        : curve(metrics.og, [
            [1.02, 0.5],
            [1.04, 1.5],
            [1.06, 2.5],
            [1.08, 3.5],
            [1.11, 4.5],
            [1.14, 5]
          ]);
    values.malt = clamp(gravityScore === null ? characterScore : 0.65 * characterScore + 0.35 * gravityScore);
    evidence.malt = gravityScore === null ? 'Weighted grist composition' : 'Weighted grist composition + OG';

    const roastPercentage = percentages.reduce(
      (sum, percentage, index) =>
        sum +
        percentage *
          categoryWeight(ingredientText(fermentables[index]), [
            [/\b(?:dehusked|debittered|carafa special)\b/i, 0.25],
            [/\bcarafa\b/i, 0.6],
            [/\b(?:chocolate|roasted wheat)\b/i, 0.8],
            [/\b(?:roast|black|patent)\b/i, 1]
          ]),
      0
    );
    values.roast = clamp(
      curve(roastPercentage, [
        [0, 0],
        [0.5, 0.5],
        [2, 1.5],
        [5, 3],
        [10, 4.25],
        [15, 5]
      ])
    );
    evidence.roast = 'Weighted roasted-grist percentage';
  } else if (metrics.srm !== null && metrics.srm > 25) {
    values.roast = Math.min(
      1.5,
      curve(metrics.srm, [
        [25, 0],
        [30, 0.5],
        [40, 1],
        [50, 1.5]
      ])
    );
    evidence.roast = 'SRM fallback (capped)';
  }

  if (metrics.ph !== null) {
    values.tartness = clamp(
      curve(metrics.ph, [
        [3.2, 5],
        [3.4, 4],
        [3.6, 3],
        [3.8, 2],
        [4, 1],
        [4.2, 0]
      ])
    );
    evidence.tartness = 'Measured final pH';
  } else if (
    [
      recipe.souring,
      recipe.sensory_v2_souring,
      detail.souring,
      detail.sensory_v2_souring,
      detail.batch?.souring,
      detail.batch?.sensory_v2_souring
    ].some((value) => value === true || (typeof value === 'string' && /\b(?:sour|lactic|kettle)\b/i.test(value))) ||
    [...fermentables, ...miscs, ...yeasts].some((ingredient) =>
      /\b(?:lactobacillus|pediococcus|philly sour|lachancea|sour culture|kettle sour)\b/i.test(
        ingredientText(ingredient)
      )
    )
  ) {
    values.tartness = 4;
    evidence.tartness = 'Recognized souring culture or process';
  }

  if (metrics.abv !== null) {
    values.perceived_strength = clamp((metrics.abv - 3) / 2);
    evidence.perceived_strength = 'ABV';
  }

  return { metrics, values, evidence };
}

export function buildSensoryModelV2({ summary = {}, detail = {} } = {}) {
  const safeSummary = object(summary);
  const safeDetail = object(detail);
  const recipe = recipeModel(safeSummary, safeDetail);
  const style = styleName(safeSummary, safeDetail);
  const baseline = styleBaseline(style);
  const axes = Object.fromEntries(
    SENSORY_AXES.map((axis) => [
      axis,
      Object.hasOwn(recipe.values, axis)
        ? entry(recipe.values[axis], 'recipe_prediction', recipe.evidence[axis])
        : Object.hasOwn(baseline, axis)
          ? entry(baseline[axis], 'style_baseline', `Style baseline: ${style}`)
          : entry(null, 'unsupported', 'No supported evidence')
    ])
  );
  return Object.freeze({
    rules_version: SENSORY_V2_RULES_VERSION,
    axes: Object.freeze(axes),
    metrics: Object.freeze(recipe.metrics),
    values: Object.freeze(recipe.values),
    style: Object.freeze(baseline)
  });
}

export function buildSensoryProfileV2({ summary = {}, detail = {}, override = {} } = {}) {
  const safeSummary = object(summary);
  const safeDetail = object(detail);
  const model = buildSensoryModelV2({ summary: safeSummary, detail: safeDetail });
  const tasting = tastingValues(safeDetail);
  const manual = manualValues(override);
  const axes = Object.fromEntries(
    SENSORY_AXES.map((axis) => [
      axis,
      Object.hasOwn(manual, axis)
        ? entry(manual[axis], 'manual', 'Manual overlay')
        : Object.hasOwn(tasting, axis)
          ? entry(tasting[axis], 'tasting', 'Recorded tasting')
          : model.axes[axis]
    ])
  );
  const prose = SENSORY_AXES.filter((axis) => axes[axis].value !== null)
    .map((axis) => `${axis.replaceAll('_', ' ')}: ${SCALE_LABELS[axis][Math.floor(axes[axis].value + 0.5)]}`)
    .join('; ');
  return Object.freeze({ rules_version: SENSORY_V2_RULES_VERSION, axes: Object.freeze(axes), prose });
}

export { SENSORY_AXES };
