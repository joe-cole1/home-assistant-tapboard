import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTapboardEvent, TAPBOARD_EVENT_TYPES } from '../src/tapboardEvents.js';

const context = {
  tap_id: 1,
  lifecycle_id: 7,
  batch_id: 'batch-7',
  metadata: { display_name: 'Pale Ale', display_style: 'American Pale Ale' }
};

test('builds the versioned, bounded Tapboard event envelope', () => {
  const event = buildTapboardEvent(
    'pour_complete',
    context,
    { volume_poured_oz: 12.5 },
    { now: () => new Date('2026-08-09T12:00:00.000Z'), uuid: () => 'event-1' }
  );
  assert.deepEqual(event, {
    schema_version: 1,
    event_id: 'event-1',
    event_type: 'pour_complete',
    occurred_at: '2026-08-09T12:00:00.000Z',
    tap_id: 1,
    lifecycle_id: 7,
    batch_id: 'batch-7',
    metadata: { display_name: 'Pale Ale', display_style: 'American Pale Ale' },
    data: { volume_poured_oz: 12.5 }
  });
});

test('catalog covers only the wired Batch 7 event types', () => {
  assert.deepEqual(TAPBOARD_EVENT_TYPES, [
    'keg_assigned',
    'keg_ended',
    'pour_start',
    'pour_complete',
    'pour_cancelled',
    'low_keg'
  ]);
  assert.throws(() => buildTapboardEvent('fermentation_started', context, {}), /Unsupported/);
});

test('rejects unknown fields and excludes arbitrary, secret, and fermentation payloads', () => {
  assert.throws(
    () => buildTapboardEvent('pour_start', { ...context, notes: 'private' }, { start_volume_oz: 10 }),
    /not allowed/
  );
  assert.throws(
    () => buildTapboardEvent('pour_start', context, { start_volume_oz: 10, access_token: 'secret' }),
    /not allowed/
  );
  assert.throws(
    () => buildTapboardEvent('low_keg', context, { current_percent: 10, threshold_percent: 20, gravity: 1.01 }),
    /not allowed/
  );
  assert.throws(
    () => buildTapboardEvent('keg_ended', context, { reason: 'ended', controller_ready: true }),
    /not allowed/
  );
});

test('enforces strict per-type data and safe display bounds', () => {
  assert.throws(() => buildTapboardEvent('pour_complete', context, { start_volume_oz: 12 }), /not allowed/);
  assert.throws(
    () =>
      buildTapboardEvent(
        'pour_start',
        { ...context, metadata: { display_name: 'x'.repeat(161) } },
        { start_volume_oz: 1 }
      ),
    /invalid/
  );
  assert.throws(
    () =>
      buildTapboardEvent(
        'pour_start',
        { ...context, metadata: { display_name: 'unsafe\nname' } },
        { start_volume_oz: 1 }
      ),
    /invalid/
  );
  assert.throws(
    () => buildTapboardEvent('low_keg', context, { current_percent: 101, threshold_percent: 20 }),
    /invalid/
  );
});
