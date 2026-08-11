/**
 * Reviewed serving-vessel choices and deterministic style guidance.
 * This module deliberately has no HTTP, database, or UI dependencies.
 */
export const FILL_GRAPHICS = Object.freeze([
  'corny_keg',
  'pint_glass',
  'tulip_glass',
  'wheat_glass',
  'mug',
  'stout_glass',
  'snifter',
  'nonic_pint',
  'shaker_pint',
  'pilsner_flute',
  'stange',
  'goblet',
  'teku',
  'thistle',
  'ipa_glass',
  'tasting_glass',
  'stemmed_lager'
]);

export const SERVING_GLASS_LABELS = Object.freeze({
  nonic_pint: 'Nonic Pint',
  shaker_pint: 'Shaker Pint',
  pilsner_flute: 'Pilsner Flute',
  stange: 'Stange',
  goblet: 'Goblet',
  teku: 'Teku',
  thistle: 'Thistle',
  ipa_glass: 'IPA Glass',
  tasting_glass: 'Tasting Glass',
  stemmed_lager: 'Stemmed Lager',
  pint_glass: 'Pint Glass',
  tulip_glass: 'Tulip Glass',
  wheat_glass: 'Wheat Glass',
  mug: 'Mug',
  stout_glass: 'Stout Glass',
  snifter: 'Snifter'
});

export const SERVING_GLASS_OPTIONS = Object.freeze(['auto', ...Object.keys(SERVING_GLASS_LABELS)]);

const AUTO_RULES = Object.freeze([
  [/wheat|wit/, 'wheat_glass'],
  [/pilsner/, 'pilsner_flute'],
  [/kolsch|kölsch|altbier/, 'stange'],
  [/belgian|abbey|saison/, 'goblet'],
  [/ipa|pale ale/, 'ipa_glass'],
  [/sour|lambic|wild/, 'teku'],
  [/stout|porter/, 'stout_glass'],
  [/wee heavy|scotch/, 'thistle'],
  [/barleywine|strong ale/, 'snifter'],
  [/english bitter|\bmild\b|brown|esb/, 'nonic_pint'],
  [/american amber|\bale\b/, 'shaker_pint'],
  [/lager|helles|marzen|märzen|bock/, 'stemmed_lager']
]);

function validManualSelection(selection) {
  return typeof selection === 'string' && Object.hasOwn(SERVING_GLASS_LABELS, selection);
}

/**
 * Resolve a safe glass ID. A recognized manual selection always has precedence;
 * custom beverages intentionally receive no auto recommendation.
 */
export function resolveServingGlass({ selection, style, isCustom } = {}) {
  if (validManualSelection(selection)) {
    return { id: selection, label: SERVING_GLASS_LABELS[selection], source: 'manual' };
  }

  if (isCustom || selection !== 'auto') {
    return { id: null, label: 'Choose manually', source: 'none' };
  }

  const normalizedStyle = typeof style === 'string' ? style.toLocaleLowerCase() : '';
  const match = AUTO_RULES.find(([pattern]) => pattern.test(normalizedStyle));
  if (!match) return { id: null, label: 'Choose manually', source: 'none' };

  const id = match[1];
  return { id, label: SERVING_GLASS_LABELS[id], source: 'auto' };
}
