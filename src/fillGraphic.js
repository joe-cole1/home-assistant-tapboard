/**
 * Display fill graphics and deterministic Brewfather style guidance.
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

// Order is intentional: more specific styles must win before broad ale/lager matches.
const STYLE_RULES = Object.freeze([
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

/** Returns a display graphic ID for a recognized style, otherwise null. */
export function fillGraphicForStyle(style) {
  const normalizedStyle = typeof style === 'string' ? style.toLocaleLowerCase() : '';
  return STYLE_RULES.find(([pattern]) => pattern.test(normalizedStyle))?.[1] ?? null;
}
