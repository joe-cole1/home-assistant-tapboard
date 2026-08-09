import crypto from 'node:crypto';

export const TAPBOARD_EVENT_TYPES = Object.freeze([
  'keg_assigned',
  'keg_ended',
  'pour_start',
  'pour_complete',
  'pour_cancelled',
  'low_keg'
]);

const EVENT_TYPES = new Set(TAPBOARD_EVENT_TYPES);
const CONTEXT_KEYS = new Set(['tap_id', 'lifecycle_id', 'batch_id', 'metadata']);
const METADATA_KEYS = new Set(['display_name', 'display_style']);
const DATA_KEYS = {
  keg_assigned: new Set(['assignment_kind']),
  keg_ended: new Set(['reason']),
  pour_start: new Set(['start_volume_oz']),
  pour_complete: new Set(['volume_poured_oz']),
  pour_cancelled: new Set(['reason']),
  low_keg: new Set(['current_percent', 'threshold_percent'])
};
const KEG_END_REASONS = new Set(['end_batch', 'end_keg', 'reassigned', 'cleared']);
const POUR_CANCEL_REASONS = new Set([
  'rebound',
  'timeout',
  'large_change',
  'disconnect',
  'shutdown',
  'hydration_failure',
  'hydration_overflow',
  'auth_invalid',
  'auth_timeout',
  'source_change',
  'hydrate',
  'reset'
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function assertOnlyKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not allowed`);
  }
}

function boundedText(value, max, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label} is invalid`);
  const trimmed = value.trim();
  if (Array.from(trimmed).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw new TypeError(`${label} is invalid`);
  }
  return trimmed;
}

function boundedNumber(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function nullablePositiveInteger(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
  return value;
}

function normalizeContext(context) {
  assertOnlyKeys(context, CONTEXT_KEYS, 'context');
  const metadata = context.metadata === undefined ? {} : context.metadata;
  assertOnlyKeys(metadata, METADATA_KEYS, 'context.metadata');
  const tapId = nullablePositiveInteger(context.tap_id, 'context.tap_id');
  if (tapId !== null && tapId > 6) throw new TypeError('context.tap_id is invalid');
  return {
    tap_id: tapId,
    lifecycle_id: nullablePositiveInteger(context.lifecycle_id, 'context.lifecycle_id'),
    batch_id:
      context.batch_id === null || context.batch_id === undefined
        ? null
        : boundedText(context.batch_id, 256, 'context.batch_id'),
    metadata: {
      ...(metadata.display_name === undefined
        ? {}
        : { display_name: boundedText(metadata.display_name, 160, 'context.metadata.display_name') }),
      ...(metadata.display_style === undefined
        ? {}
        : { display_style: boundedText(metadata.display_style, 120, 'context.metadata.display_style') })
    }
  };
}

function normalizeData(eventType, data) {
  const allowed = DATA_KEYS[eventType];
  assertOnlyKeys(data, allowed, 'data');
  switch (eventType) {
    case 'keg_assigned': {
      const assignmentKind = boundedText(data.assignment_kind, 16, 'data.assignment_kind');
      if (!['brewfather', 'custom', 'override'].includes(assignmentKind))
        throw new TypeError('data.assignment_kind is invalid');
      return { assignment_kind: assignmentKind };
    }
    case 'keg_ended': {
      const reason = boundedText(data.reason, 32, 'data.reason');
      if (!KEG_END_REASONS.has(reason)) throw new TypeError('data.reason is invalid');
      return { reason };
    }
    case 'pour_start':
      return { start_volume_oz: boundedNumber(data.start_volume_oz, 0, 10000, 'data.start_volume_oz') };
    case 'pour_complete':
      return { volume_poured_oz: boundedNumber(data.volume_poured_oz, 0, 10000, 'data.volume_poured_oz') };
    case 'pour_cancelled': {
      const reason = boundedText(data.reason, 64, 'data.reason');
      if (!POUR_CANCEL_REASONS.has(reason)) throw new TypeError('data.reason is invalid');
      return { reason };
    }
    case 'low_keg':
      return {
        current_percent: boundedNumber(data.current_percent, 0, 100, 'data.current_percent'),
        threshold_percent: boundedNumber(data.threshold_percent, 0, 100, 'data.threshold_percent')
      };
  }
}

// This is deliberately a small outbound contract. It carries display-safe
// identities only; operational sensor state and Brewfather/fermentation data
// never enter this event envelope.
export function buildTapboardEvent(
  eventType,
  context,
  data,
  { now = () => new Date(), uuid = crypto.randomUUID } = {}
) {
  if (!EVENT_TYPES.has(eventType)) throw new TypeError(`Unsupported Tapboard event type: ${eventType}`);
  const occurredAt = now();
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime()))
    throw new TypeError('Event timestamp is invalid');
  const normalizedContext = normalizeContext(context);
  return {
    schema_version: 1,
    event_id: boundedText(uuid(), 64, 'event_id'),
    event_type: eventType,
    occurred_at: occurredAt.toISOString(),
    tap_id: normalizedContext.tap_id,
    lifecycle_id: normalizedContext.lifecycle_id,
    batch_id: normalizedContext.batch_id,
    metadata: normalizedContext.metadata,
    data: normalizeData(eventType, data)
  };
}
