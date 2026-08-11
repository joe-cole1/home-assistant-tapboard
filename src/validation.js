import { FILL_GRAPHICS } from './fillGraphic.js';

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
const GRAPHICS = new Set(FILL_GRAPHICS);
const CEREMONY_SOUNDS = new Set(['pub_bell', 'fanfare', 'last_call']);
const DISPLAY_UNITS = new Set(['percent', 'pints', 'oz', 'pours_12', 'pours_custom']);
const VOLUME_FORMATS = new Set(['oz', 'pints']);
const LAYOUT_MODES = new Set(['cozy', 'compact']);
export const HEALTH_CHECK_IDS = new Set([
  'low_keg',
  'scale_availability',
  'suspected_leak',
  'serving_temperature',
  'line_cleaning_due'
]);
export const TAP_CAPABILITIES = new Set(['standard', 'nitro', 'high_carbonation', 'custom_non_beer']);
const SENSORY_AXES = new Set([
  'malt',
  'hops',
  'bitterness',
  'sweetness',
  'roast',
  'tartness',
  'body',
  'perceived_strength'
]);
// eslint-disable-next-line no-control-regex -- Reject control characters from untrusted request text.
const DISALLOWED_CONTROLS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;
const CANONICAL_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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

function dateOnly(value, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError('Invalid date');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new ValidationError('Invalid date');
  return value;
}

function canonicalIso(value, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string') throw new ValidationError('Invalid timestamp');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    throw new ValidationError('Invalid timestamp');
  return value;
}

function capabilities(value) {
  if (!Array.isArray(value) || value.length > TAP_CAPABILITIES.size) throw new ValidationError('Invalid capabilities');
  const output = [];
  for (const item of value) {
    const normalized = choice(item, TAP_CAPABILITIES);
    if (output.includes(normalized)) throw new ValidationError('Duplicate capability');
    output.push(normalized);
  }
  return output;
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
      'primary_color',
      'secondary_color',
      'first_pour_effects',
      'kick_effects',
      'ceremony_sound'
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
  if (body.first_pour_effects !== undefined) output.first_pour_effects = boolean(body.first_pour_effects);
  if (body.kick_effects !== undefined) output.kick_effects = boolean(body.kick_effects);
  assignIfDefined(output, 'ceremony_sound', choice(body.ceremony_sound, CEREMONY_SOUNDS));
  for (const key of ['primary_color', 'secondary_color']) {
    if (body[key] === null) output[key] = null;
    else if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || !HEX_COLOR.test(body[key])) throw new ValidationError('Invalid color');
      output[key] = body[key].toUpperCase();
    }
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

export function validatePinChange(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['current_pin', 'new_pin', 'confirm_new_pin']));
  const current_pin = text(body.current_pin, 4, { required: true, allowEmpty: false });
  const new_pin = text(body.new_pin, 4, { required: true, allowEmpty: false });
  const confirm_new_pin = text(body.confirm_new_pin, 4, { required: true, allowEmpty: false });
  if (![current_pin, new_pin, confirm_new_pin].every((pin) => /^\d{4}$/.test(pin))) {
    throw new ValidationError('Invalid PIN');
  }
  if (new_pin === '0000') throw new ValidationError('Invalid PIN');
  if (new_pin !== confirm_new_pin) throw new ValidationError('New PINs do not match');
  if (new_pin === current_pin) throw new ValidationError('New PIN must be different');
  return { current_pin, new_pin, confirm_new_pin };
}

export function validateOndeck(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['batches', 'show_ondeck']));
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
  return {
    batches,
    ...(body.show_ondeck === undefined ? {} : { show_ondeck: boolean(body.show_ondeck) })
  };
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

export function validateSensoryOverride(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['hidden', 'description_override', 'axis_overrides']));
  const output = {};
  if (body.hidden !== undefined) output.hidden = boolean(body.hidden);
  if (body.description_override === null) output.description_override = null;
  else assignIfDefined(output, 'description_override', text(body.description_override, 2_000));
  if (body.axis_overrides !== undefined) {
    assertObject(body.axis_overrides);
    rejectUnknown(body.axis_overrides, SENSORY_AXES);
    output.axis_overrides = {};
    for (const [axis, raw] of Object.entries(body.axis_overrides)) {
      const value = numeric(raw, 0, 5, { allowNull: true });
      if (value !== null && !Number.isInteger(value * 2)) throw new ValidationError('Sensory scores use half steps');
      output.axis_overrides[axis] = value;
    }
  }
  if (Object.keys(output).length === 0) throw new ValidationError();
  return output;
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
    'capacity_oz',
    'kick_threshold_oz',
    'capabilities'
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
  assignIfDefined(output, 'kick_threshold_oz', numeric(body.kick_threshold_oz, 0, 128, { allowNull: true }));
  if (body.capabilities !== undefined) output.capabilities = capabilities(body.capabilities);
  return output;
}

const HEALTH_CONFIG_FIELDS = {
  low_keg: {
    warning_percent: [0, 100],
    critical_percent: [0, 100],
    cooldown_minutes: [1, 10_080]
  },
  scale_availability: {
    stale_minutes: [1, 10_080],
    unavailable_minutes: [1, 10_080],
    cooldown_minutes: [1, 10_080]
  },
  suspected_leak: {
    loss_oz: [1, 128],
    window_minutes: [1, 1_440],
    pour_grace_minutes: [0, 120],
    settling_minutes: [1, 1_440],
    cooldown_minutes: [1, 10_080]
  },
  serving_temperature: {
    warning_min_c: [-50, 100],
    warning_max_c: [-50, 100],
    critical_min_c: [-50, 100],
    critical_max_c: [-50, 100],
    duration_minutes: [1, 1_440],
    cooldown_minutes: [1, 10_080]
  },
  line_cleaning_due: {
    warning_days: [1, 365],
    critical_days: [1, 730],
    cooldown_minutes: [1, 10_080]
  }
};

export function validateEffectiveHealthConfig(checkId, config) {
  if (checkId === 'low_keg') {
    if (config.critical_percent === undefined || config.warning_percent === undefined) return;
    if (config.critical_percent > config.warning_percent) throw new ValidationError('Invalid low-keg thresholds');
  }
  if (checkId === 'serving_temperature') {
    const values = [config.critical_min_c, config.warning_min_c, config.warning_max_c, config.critical_max_c];
    if (values.some((value) => value === undefined)) return;
    if (!(values[0] <= values[1] && values[1] < values[2] && values[2] <= values[3]))
      throw new ValidationError('Invalid temperature thresholds');
  }
  if (checkId === 'line_cleaning_due') {
    if (config.warning_days === undefined || config.critical_days === undefined) return;
    if (config.warning_days > config.critical_days) throw new ValidationError('Invalid cleaning thresholds');
  }
}

export function validateHealthConfig(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['check_id', 'tap_id', 'enabled', 'config']));
  const check_id = choice(body.check_id, HEALTH_CHECK_IDS);
  if (!check_id) throw new ValidationError('Invalid health check');
  const effectiveTapId = body.tap_id === null || body.tap_id === undefined ? 0 : tapId(body.tap_id);
  const enabled = boolean(body.enabled);
  assertObject(body.config);
  const fields = HEALTH_CONFIG_FIELDS[check_id];
  rejectUnknown(
    body.config,
    new Set([...Object.keys(fields), ...(check_id === 'serving_temperature' ? ['entity_id'] : [])])
  );
  const config = {};
  for (const [key, [min, max]] of Object.entries(fields)) {
    if (body.config[key] !== undefined) config[key] = numeric(body.config[key], min, max);
  }
  if (check_id === 'serving_temperature' && body.config.entity_id !== undefined) {
    if (body.config.entity_id === null || body.config.entity_id === '') config.entity_id = null;
    else {
      const entity = text(body.config.entity_id, 255, { allowEmpty: false }).toLowerCase();
      if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entity)) throw new ValidationError('Invalid entity ID');
      config.entity_id = entity;
    }
  }
  validateEffectiveHealthConfig(check_id, config);
  return { check_id, tap_id: effectiveTapId, enabled, config };
}

export function validateHealthAcknowledgement(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['check_id', 'tap_id', 'incident_id']));
  return {
    check_id: choice(body.check_id, HEALTH_CHECK_IDS),
    tap_id: tapId(body.tap_id),
    incident_id: text(body.incident_id, 128, { required: true, allowEmpty: false })
  };
}

export function validateMaintenance(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['completed_at', 'tap_ids', 'method', 'notes', 'next_due_at']));
  if (!Array.isArray(body.tap_ids) || body.tap_ids.length < 1 || body.tap_ids.length > 6)
    throw new ValidationError('Invalid affected taps');
  const tap_ids = body.tap_ids.map(tapId);
  if (new Set(tap_ids).size !== tap_ids.length) throw new ValidationError('Duplicate affected tap');
  return {
    completed_at: canonicalIso(body.completed_at),
    tap_ids,
    method: text(body.method, 160, { required: true, allowEmpty: false }),
    notes: text(body.notes ?? '', 1_000),
    next_due_at: body.next_due_at === undefined ? null : canonicalIso(body.next_due_at, { allowNull: true })
  };
}

export function validateReadinessPolicy(body) {
  assertObject(body);
  const fields = new Set([
    'fallback_fermentation_min_days',
    'fallback_fermentation_max_days',
    'packaging_min_days',
    'packaging_max_days',
    'conditioning_min_days',
    'conditioning_max_days',
    'planning_uncertainty_days',
    'stale_after_hours',
    'cooldown_hours'
  ]);
  rejectUnknown(body, fields);
  const output = {};
  for (const key of fields) {
    if (body[key] !== undefined)
      output[key] = numeric(body[key], key.includes('hours') ? 1 : 0, key.includes('hours') ? 720 : 365, {
        integer: true
      });
  }
  if (Object.keys(output).length === 0) throw new ValidationError();
  for (const [minKey, maxKey] of [
    ['fallback_fermentation_min_days', 'fallback_fermentation_max_days'],
    ['packaging_min_days', 'packaging_max_days'],
    ['conditioning_min_days', 'conditioning_max_days']
  ]) {
    if (output[minKey] !== undefined && output[maxKey] !== undefined && output[minKey] > output[maxKey])
      throw new ValidationError('Invalid readiness range');
  }
  return output;
}

export function validateReadinessOverride(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['earliest_date', 'latest_date', 'confirmed', 'required_capabilities']));
  const earliest_date = dateOnly(body.earliest_date, { allowNull: true });
  const latest_date = dateOnly(body.latest_date, { allowNull: true });
  if ((earliest_date === null) !== (latest_date === null) || (earliest_date && earliest_date > latest_date))
    throw new ValidationError('Invalid readiness range');
  const confirmed = boolean(body.confirmed);
  if (confirmed && earliest_date === null) throw new ValidationError('A confirmed readiness requires a date range');
  return {
    earliest_date,
    latest_date,
    confirmed,
    required_capabilities: capabilities(body.required_capabilities)
  };
}

export function validateEndKeg(body) {
  assertObject(body);
  rejectUnknown(body, new Set(['reason']));
  if (body.reason === undefined) return { reason: 'end_keg' };
  return { reason: choice(body.reason, new Set(['kicked', 'removed', 'other'])) };
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
