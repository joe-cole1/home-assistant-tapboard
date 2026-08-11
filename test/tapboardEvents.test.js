import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrewfatherSyncFailureEvent, buildTapboardEvent, TAPBOARD_EVENT_TYPES } from '../src/tapboardEvents.js';

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

test('catalog covers the wired event types', () => {
  assert.deepEqual(TAPBOARD_EVENT_TYPES, [
    'keg_assigned',
    'keg_ended',
    'pour_start',
    'pour_complete',
    'pour_cancelled',
    'low_keg',
    'first_pour',
    'keg_kicked',
    'brewfather_sync_failed'
  ]);
  assert.throws(() => buildTapboardEvent('fermentation_started', context, {}), /Unsupported/);
});

test('builds a safe Brewfather sync failure envelope from an internal result', () => {
  const event = buildBrewfatherSyncFailureEvent(
    {
      reason: 'scheduled',
      errorCategory: 'rate_limited',
      outcome: 'stale_cache',
      requestCount: 4,
      retryAt: '2026-08-09T12:05:00.000Z',
      tap_id: 6,
      lifecycle_id: 99,
      batch_id: 'remote-batch-id',
      metadata: { display_name: 'Private beer' },
      url: 'https://api.brewfather.app/v2/batches',
      accessToken: 'secret',
      responseBody: { _id: 'remote-id', readings: [{ gravity: 1.01 }] },
      stack: 'Error: remote failure',
      remote: { id: 'remote-id' }
    },
    { now: () => new Date('2026-08-09T12:00:00.000Z'), uuid: () => 'event-sync-failed' }
  );
  assert.deepEqual(event, {
    schema_version: 1,
    event_id: 'event-sync-failed',
    event_type: 'brewfather_sync_failed',
    occurred_at: '2026-08-09T12:00:00.000Z',
    tap_id: null,
    lifecycle_id: null,
    batch_id: null,
    metadata: {},
    data: {
      reason: 'scheduled',
      error_category: 'rate_limited',
      outcome: 'stale_cache',
      request_count: 4,
      retry_at: '2026-08-09T12:05:00.000Z'
    }
  });
  const serialized = JSON.stringify(event);
  for (const forbidden of [
    'remote-batch-id',
    'api.brewfather',
    'secret',
    'responseBody',
    'gravity',
    'stack',
    'remote-id'
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('enforces the Brewfather failure data contract', () => {
  const syncContext = { tap_id: null, lifecycle_id: null, batch_id: null, metadata: {} };
  const data = {
    reason: 'manual',
    error_category: 'network',
    outcome: 'failed',
    request_count: 0,
    retry_at: null
  };
  assert.deepEqual(buildTapboardEvent('brewfather_sync_failed', syncContext, data).data, data);
  assert.throws(() => buildTapboardEvent('brewfather_sync_failed', context, data), /resource identities/);
  assert.throws(
    () =>
      buildTapboardEvent(
        'brewfather_sync_failed',
        { ...syncContext, metadata: { display_name: 'Private batch' } },
        data
      ),
    /resource identities/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, url: 'https://secret.example' }),
    /not allowed/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, reason: 'timer' }),
    /invalid/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, error_category: 'server_error' }),
    /invalid/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, outcome: 'succeeded' }),
    /invalid/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, request_count: -1 }),
    /invalid/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, request_count: 201 }),
    /invalid/
  );
  assert.throws(
    () => buildTapboardEvent('brewfather_sync_failed', syncContext, { ...data, retry_at: '2026-08-09T12:05:00Z' }),
    /invalid/
  );
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

test('lifecycle ceremony events carry only bounded receipt and measurement facts', () => {
  assert.deepEqual(buildTapboardEvent('first_pour', context, { receipt_id: 12, volume_poured_oz: 8 }).data, {
    receipt_id: 12,
    volume_poured_oz: 8
  });
  assert.deepEqual(
    buildTapboardEvent('keg_kicked', context, {
      trigger: 'automatic',
      receipt_id: 12,
      remaining_volume_oz: 1.5,
      threshold_oz: 2
    }).data,
    { trigger: 'automatic', receipt_id: 12, remaining_volume_oz: 1.5, threshold_oz: 2 }
  );
  assert.throws(
    () =>
      buildTapboardEvent('keg_kicked', context, {
        trigger: 'automatic',
        receipt_id: 12,
        remaining_volume_oz: 1,
        threshold_oz: 2,
        sound_url: 'https://example.invalid/bell.mp3'
      }),
    /not allowed/
  );
});
