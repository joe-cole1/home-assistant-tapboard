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
export const SCALE_LABELS = Object.freeze({
  malt: ['very low', 'light', 'moderate', 'forward', 'rich', 'intense'],
  hops: ['very low', 'light', 'moderate', 'noticeable', 'high', 'intense'],
  bitterness: ['very low', 'low', 'moderate', 'firm', 'high', 'intense'],
  sweetness: ['very dry', 'dry', 'balanced', 'noticeable', 'sweet', 'very sweet'],
  roast: ['none', 'trace', 'light', 'moderate', 'roasty', 'intense'],
  tartness: ['none', 'trace', 'light', 'moderate', 'tart', 'very tart'],
  body: ['very light', 'light', 'medium-light', 'medium', 'full', 'very full'],
  perceived_strength: ['very low', 'low', 'moderate', 'warming', 'strong', 'very strong']
});
export const STYLE_BASELINES = Object.freeze(
  [
    [/\bpastry stout\b/i, { sweetness: 5, body: 5, roast: 3, perceived_strength: 4, malt: 4 }],
    [
      /\b(?:imperial|double)\s+(?:stout|porter)\b/i,
      { malt: 4, roast: 5, body: 5, perceived_strength: 5, bitterness: 3 }
    ],
    [/\bbaltic porter\b/i, { malt: 4, roast: 2.5, body: 4, sweetness: 3, perceived_strength: 4 }],
    [/\b(?:stout|porter|schwarz)\b/i, { malt: 4, roast: 4, body: 4, bitterness: 2 }],
    [/\b(?:sour|gose|berliner|lambic|gueuze|wild ale|flemish)\b/i, { tartness: 5, body: 2, malt: 2 }],
    [/\b(?:new england|hazy|neipa)\b/i, { hops: 5, bitterness: 2, body: 4, malt: 2 }],
    [/\b(?:west coast|american)\s+ipa\b/i, { hops: 5, bitterness: 4, body: 2.5, malt: 2 }],
    [/\b(?:ipa|india pale ale)\b/i, { hops: 4.5, bitterness: 3.5, body: 3, malt: 2 }],
    [/\btripel\b/i, { malt: 3, sweetness: 1.5, body: 2, perceived_strength: 4.5 }],
    [
      /\b(?:barleywine|wee heavy|strong ale|quadrupel|quad)\b/i,
      { malt: 4, sweetness: 4, body: 4, perceived_strength: 5 }
    ],
    [/\b(?:doppelbock|strong lager)\b/i, { malt: 4.5, sweetness: 3, body: 4, perceived_strength: 4 }],
    [/\b(?:brown|amber)\b/i, { malt: 3, sweetness: 2, roast: 1, body: 3 }],
    [/\b(?:vienna|märzen|marzen|oktoberfest)\b/i, { malt: 4, sweetness: 2, body: 3 }],
    [/\b(?:wheat|hefe|wit)\b/i, { malt: 2, body: 3 }],
    [/\b(?:saison|farmhouse)\b/i, { malt: 2, hops: 2, body: 1.5 }],
    [/\b(?:pale ale|blonde|kolsch|kölsch|lager|pils|helles)\b/i, { malt: 2, hops: 2, bitterness: 2, body: 2 }]
  ].map(([match, values]) => Object.freeze({ match, values: Object.freeze(values) }))
);
