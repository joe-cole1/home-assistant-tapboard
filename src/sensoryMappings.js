/**
 * Reviewed, deliberately small style baselines. Values are only supplied for
 * traits the named family conventionally supports; absence is meaningful.
 */
export const SENSORY_AXES = Object.freeze([
  'malt',
  'hops',
  'bitterness',
  'sweetness',
  'roast',
  'tartness',
  'body',
  'perceived_strength'
]);

export const STYLE_BASELINES = Object.freeze([
  Object.freeze({
    match: /\b(?:imperial|double)\s+(?:stout|porter)\b/i,
    values: { malt: 4, roast: 5, body: 5, perceived_strength: 5, bitterness: 3 }
  }),
  Object.freeze({ match: /\b(?:stout|porter|schwarzbier)\b/i, values: { malt: 4, roast: 4, body: 4, bitterness: 2 } }),
  Object.freeze({ match: /\b(?:new england|hazy|neipa)\b/i, values: { hops: 5, bitterness: 3, body: 4, malt: 2 } }),
  Object.freeze({ match: /\b(?:ipa|india pale ale)\b/i, values: { hops: 5, bitterness: 4, body: 3, malt: 2 } }),
  Object.freeze({
    match: /\b(?:sour|gose|berliner|lambic|gueuze|wild ale)\b/i,
    values: { tartness: 5, body: 2, malt: 2 }
  }),
  Object.freeze({
    match: /\b(?:barleywine|wee heavy|strong ale|tripel|quadrupel)\b/i,
    values: { malt: 4, sweetness: 4, body: 4, perceived_strength: 5 }
  }),
  Object.freeze({
    match: /\b(?:pale ale|blonde|kolsch|kölsch|lager|pilsner|helles)\b/i,
    values: { malt: 2, hops: 2, bitterness: 2, body: 2 }
  })
]);

export const INGREDIENT_CHARACTER_MAP = Object.freeze([
  Object.freeze({ match: /\b(?:roast|black|chocolate|carafa|patent)\b/i, axis: 'roast', weight: 1.5 }),
  Object.freeze({ match: /\b(?:crystal|caramel|cara(?:malt|munich|pils)|dextrin)\b/i, axis: 'sweetness', weight: 1 }),
  Object.freeze({ match: /\b(?:oat|wheat|rye|flaked|chit)\b/i, axis: 'body', weight: 1 }),
  Object.freeze({
    match: /\b(?:pale|pilsner|vienna|munich|maris otter|golden promise)\b/i,
    axis: 'malt',
    weight: 0.75
  }),
  Object.freeze({ match: /\b(?:lactic|phosphoric|citric|acidulated)\b/i, axis: 'water_treatment', weight: 0 }),
  Object.freeze({
    match: /\b(?:lactobacillus|brettanomyces|sour culture|kettle sour|fruit puree|fruit purée)\b/i,
    axis: 'tartness',
    weight: 2
  })
]);

export const SCALE_LABELS = Object.freeze({
  malt: Object.freeze(['very low', 'light', 'moderate', 'forward', 'rich', 'intense']),
  hops: Object.freeze(['very low', 'light', 'moderate', 'noticeable', 'high', 'intense']),
  bitterness: Object.freeze(['very low', 'low', 'moderate', 'firm', 'high', 'intense']),
  sweetness: Object.freeze(['very dry', 'dry', 'balanced', 'noticeable', 'sweet', 'very sweet']),
  roast: Object.freeze(['none', 'trace', 'light', 'moderate', 'roasty', 'intense']),
  tartness: Object.freeze(['none', 'trace', 'light', 'moderate', 'tart', 'very tart']),
  body: Object.freeze(['very light', 'light', 'medium-light', 'medium', 'full', 'very full']),
  perceived_strength: Object.freeze(['very low', 'low', 'moderate', 'warming', 'strong', 'very strong'])
});

export const RULES_VERSION = 'sensory-v1';
