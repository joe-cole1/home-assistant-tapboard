const THEMES = new Set(['modern_dark', 'warm_pub', 'cyberpunk', 'light_minimal']);
const TITLE_FONTS = new Set([
  'Outfit',
  'Roboto',
  'Carter One',
  'Balsamiq Sans',
  'Fredoka',
  'Permanent Marker',
  'Montserrat'
]);
const BODY_FONTS = new Set(['Inter', 'Roboto', 'Balsamiq Sans', 'Outfit', 'Fredoka', 'Montserrat']);
const GRAPHICS = new Set(['corny_keg', 'pint_glass', 'tulip_glass', 'wheat_glass', 'mug', 'stout_glass', 'snifter']);
const DISPLAY_UNITS = new Set(['percent', 'pints', 'oz', 'pours_12', 'pours_custom']);
const VOLUME_FORMATS = new Set(['oz', 'pints']);
const LAYOUT_MODES = new Set(['cozy', 'compact']);
// eslint-disable-next-line no-control-regex -- Reject control characters from untrusted request text.
const DISALLOWED_CONTROLS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;
const CANONICAL_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class ValidationError extends Error {
  constructor(message = 'Invalid request body') {
    super(message);
    this.status = 400;
  }
}

export function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError();
}

export function rejectUnknown(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ValidationError();
  }
}

export function tapId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6) return value;
  if (typeof value === 'string' && /^[1-6]$/.test(value)) return Number(value);
  throw new ValidationError('Invalid tap ID');
}

function text(value, max, { required = false, allowEmpty = true, trim = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || DISALLOWED_CONTROLS.test(value)) throw new ValidationError();
  const normalized = trim ? value.trim() : value;
  if ((!allowEmpty && normalized.length === 0) || normalized.length > max) throw new ValidationError();
  return normalized;
}

function boolean(value) {
  if (typeof value !== 'boolean') throw new ValidationError();
  return value;
}

function numeric(value, min, max, { integer = false, allowEmpty = false, allowNull = false, required = false } = {}) {
  if (value === undefined) {
    if (required) throw new ValidationError();
    return undefined;
  }
  if (allowNull && value === null) return null;
  if (allowEmpty && value === '') return '';
  let parsed;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && CANONICAL_NUMBER.test(value.trim())) parsed = Number(value.trim());
  else throw new ValidationError();
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed)))
    throw new ValidationError();
  return parsed;
}

function choice(value, allowed) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw new ValidationError();
  return value;
}

function assignIfDefined(output, key, value) {
  if (value !== undefined) output[key] = value;
}

export function validateAuth(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['pin']));
  const pin = text(body.pin, 4, { required: true, allowEmpty: false });
  if (!/^\d{4}$/.test(pin)) throw new ValidationError('Invalid PIN');
  return { pin };
}

export function validateSettings(body) {
  assertObject(body);
  rejectUnknown(
    body,
    new Set([
      'theme',
      'volume_format',
      'title',
      'font_title',
      'font_body',
      'show_ondeck',
      'layout_mode',
      'ondeck_new_batch_default',
      'tap_visibilities',
      'new_pin'
    ])
  );
  const output = {};
  assignIfDefined(output, 'theme', choice(body.theme, THEMES));
  assignIfDefined(output, 'volume_format', choice(body.volume_format, VOLUME_FORMATS));
  assignIfDefined(output, 'title', text(body.title, 80, { allowEmpty: false }));
  assignIfDefined(output, 'font_title', choice(body.font_title, TITLE_FONTS));
  assignIfDefined(output, 'font_body', choice(body.font_body, BODY_FONTS));
  if (body.show_ondeck !== undefined) output.show_ondeck = boolean(body.show_ondeck);
  assignIfDefined(output, 'layout_mode', choice(body.layout_mode, LAYOUT_MODES));
  if (body.ondeck_new_batch_default !== undefined)
    output.ondeck_new_batch_default = boolean(body.ondeck_new_batch_default);
  if (body.new_pin !== undefined) {
    const pin = text(body.new_pin, 4, { allowEmpty: false });
    if (!/^\d{4}$/.test(pin) || pin === '0000') throw new ValidationError('Invalid PIN');
    output.new_pin = pin;
  }
  if (body.tap_visibilities !== undefined) {
    assertObject(body.tap_visibilities);
    const visibilities = {};
    for (const [id, visible] of Object.entries(body.tap_visibilities)) {
      const canonicalId = tapId(id);
      visibilities[canonicalId] = boolean(visible);
    }
    output.tap_visibilities = visibilities;
  }
  return output;
}

export function validateOndeck(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['batches']));
  if (!Array.isArray(body.batches) || body.batches.length > 150) throw new ValidationError();
  const seen = new Set();
  const batches = body.batches.map((entry) => {
    assertObject(entry);
    rejectUnknown(entry, new Set(['batch_id', 'visible']));
    const batch_id = text(entry.batch_id, 256, { required: true, allowEmpty: false });
    if (seen.has(batch_id)) throw new ValidationError();
    seen.add(batch_id);
    return { batch_id, visible: boolean(entry.visible) };
  });
  return { batches };
}

export function validateCustomBeverage(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['name', 'style', 'abv', 'ibu', 'og', 'fg', 'srm', 'description']));
  return {
    name: text(body.name, 120, { required: true, allowEmpty: false }),
    style: text(body.style, 120, { required: true, allowEmpty: false }),
    abv: numeric(body.abv, 0, 100, { required: true }),
    ibu: numeric(body.ibu, 0, 1_000, { integer: true, required: true }),
    og: numeric(body.og, 0.5, 2, { allowNull: true, required: true }),
    fg: numeric(body.fg, 0.5, 2, { allowNull: true, required: true }),
    srm: numeric(body.srm, 0, 50, { integer: true, required: true }),
    description: text(body.description, 2_000, { required: true })
  };
}

export function validateTap(body) {
  const allowed = new Set([
    'enabled',
    'batch_option',
    'graphic',
    'override_enabled',
    'override_name',
    'override_style',
    'override_abv',
    'override_ibu',
    'override_og',
    'override_fg',
    'override_srm',
    'override_description',
    'badge_low_keg',
    'badge_fresh',
    'display_unit',
    'custom_pour_size',
    'capacity_oz'
  ]);
  assertObject(body);
  rejectUnknown(body, allowed);
  const output = {};
  if (body.enabled !== undefined) output.enabled = boolean(body.enabled);
  if (body.override_enabled !== undefined) output.override_enabled = boolean(body.override_enabled);
  if (body.badge_fresh !== undefined) output.badge_fresh = boolean(body.badge_fresh);
  assignIfDefined(output, 'graphic', choice(body.graphic, GRAPHICS));
  assignIfDefined(output, 'display_unit', choice(body.display_unit, DISPLAY_UNITS));
  assignIfDefined(output, 'batch_option', text(body.batch_option, 512));
  assignIfDefined(output, 'override_name', text(body.override_name, 120));
  assignIfDefined(output, 'override_style', text(body.override_style, 120));
  assignIfDefined(output, 'override_description', text(body.override_description, 2_000));
  assignIfDefined(output, 'override_abv', numeric(body.override_abv, 0, 100, { allowEmpty: true }));
  assignIfDefined(output, 'override_ibu', numeric(body.override_ibu, 0, 1_000, { integer: true, allowEmpty: true }));
  assignIfDefined(output, 'override_og', numeric(body.override_og, 0.5, 2, { allowEmpty: true }));
  assignIfDefined(output, 'override_fg', numeric(body.override_fg, 0.5, 2, { allowEmpty: true }));
  assignIfDefined(output, 'override_srm', numeric(body.override_srm, 0, 50, { integer: true, allowEmpty: true }));
  assignIfDefined(output, 'badge_low_keg', numeric(body.badge_low_keg, 0, 100));
  assignIfDefined(output, 'custom_pour_size', numeric(body.custom_pour_size, 0.5, 128));
  assignIfDefined(output, 'capacity_oz', numeric(body.capacity_oz, 16, 2048, { integer: true }));
  return output;
}

export function validateCatalog(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['name', 'style', 'abv', 'ibu', 'srm_color', 'description', 'on_deck', 'target_tap_id']));
  const output = { name: text(body.name, 120, { required: true, allowEmpty: false }) };
  assignIfDefined(output, 'style', text(body.style, 120));
  assignIfDefined(output, 'description', text(body.description, 2_000));
  assignIfDefined(output, 'abv', numeric(body.abv, 0, 100));
  assignIfDefined(output, 'ibu', numeric(body.ibu, 0, 1_000, { integer: true }));
  assignIfDefined(output, 'srm_color', numeric(body.srm_color, 0, 50, { integer: true }));
  if (body.on_deck !== undefined) output.on_deck = boolean(body.on_deck);
  if (body.target_tap_id === null || body.target_tap_id === '') output.target_tap_id = null;
  else if (body.target_tap_id !== undefined) output.target_tap_id = tapId(body.target_tap_id);
  return output;
}
