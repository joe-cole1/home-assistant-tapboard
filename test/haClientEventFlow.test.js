import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatSSEFrame } from '../src/sseHub.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'tapboard-ha-client-test-'));
const { HAClient, sanitizeBrewfatherActiveBatches } = await import('../src/haClient.js');

function state(entityId, value, timestamp, unit = 'fl oz') {
  return {
    entity_id: entityId,
    state: String(value),
    attributes: { unit_of_measurement: unit },
    last_updated: new Date(timestamp).toISOString()
  };
}

test('detector and priority pour event run synchronously before display enqueue', () => {
  const order = [];
  const detector = {
    onEvent: null,
    ingest(tapId, volumeOz, timestamp) {
      order.push(`detector:${tapId}:${volumeOz}:${timestamp}`);
      this.onEvent({ type: 'start', tapId, startVolume: volumeOz, timestamp });
    },
    hydrate() {},
    reset() {}
  };
  const displayUpdateCoalescer = {
    enqueue(change) {
      order.push(`display:${change.tapId}`);
    }
  };
  const client = new HAClient({ detector, displayUpdateCoalescer });
  client.on('pour_start', ({ tapId }) => order.push(`pour:${tapId}`));

  const entityId = 'sensor.tap_1_fl_oz';
  client.processStateUpdate({ entity_id: entityId, new_state: state(entityId, 100, 1_000) });

  assert.deepEqual(order, ['detector:1:100:1000', 'pour:1', 'display:1']);
});

test('every fast detector sample is ingested while none is sent to the display coalescer', () => {
  let detectorSamples = 0;
  let displayUpdates = 0;
  const detector = {
    onEvent: null,
    ingest() {
      detectorSamples += 1;
    },
    hydrate() {},
    reset() {}
  };
  const displayUpdateCoalescer = {
    enqueue() {
      displayUpdates += 1;
    }
  };
  const client = new HAClient({ detector, displayUpdateCoalescer });
  const entityId = 'sensor.tap_1_fast';
  client.statesMap.set(entityId, state(entityId, 640, 0));
  client.primaryTapSensors.set(1, entityId);

  for (let sample = 0; sample < 100; sample++) {
    const timestamp = sample * 100;
    client.processStateUpdate({
      entity_id: entityId,
      new_state: state(entityId, 640 - sample / 10, timestamp)
    });
  }

  assert.equal(detectorSamples, 100);
  assert.equal(displayUpdates, 0);
});

test('canonical volume and capacity events publish a coherent tuple while obsolete fill events publish nothing', () => {
  const updates = [];
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({
    detector,
    isTapAssigned: (tapId) => tapId === 1,
    displayUpdateCoalescer: { enqueue: (change) => updates.push(change) }
  });
  const capacityId = 'input_number.tap_1_keg_capacity_oz';
  const volumeId = 'sensor.tap_1_fl_oz';
  client.processStateUpdate({ entity_id: capacityId, new_state: state(capacityId, 640, 1_000) });
  client.processStateUpdate({ entity_id: volumeId, new_state: state(volumeId, 216.63, 2_000) });
  client.processStateUpdate({ entity_id: 'sensor.tap_1_fill', new_state: state('sensor.tap_1_fill', 99, 3_000) });

  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], {
    tapId: 1,
    changes: {
      volumeOz: 216.63,
      capacityOz: 640,
      fillPercent: 33.8,
      pintsRemaining: 13.539375,
      volumeStatus: 'measured'
    },
    timestamp: 2_000
  });
});

test('a sensitive unrelated HA entity is absent from HTTP and SSE public serialization', () => {
  let displayUpdates = 0;
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({
    detector,
    displayUpdateCoalescer: {
      enqueue() {
        displayUpdates += 1;
      }
    }
  });
  const privateEntity = {
    entity_id: 'person.private_resident',
    state: 'home',
    attributes: {
      latitude: 40.1,
      longitude: -73.9,
      access_token: 'must-never-leak'
    },
    last_updated: new Date(1_000).toISOString()
  };
  client.processStateUpdate({ entity_id: privateEntity.entity_id, new_state: privateEntity });

  const snapshot = { schemaVersion: 5, tapStates: client.getPublicTapStates() };
  const httpJson = JSON.stringify(snapshot);
  const sseFrame = formatSSEFrame('snapshot', snapshot);
  for (const output of [httpJson, sseFrame]) {
    assert.equal(output.includes('person.private_resident'), false);
    assert.equal(output.includes('must-never-leak'), false);
    assert.equal(output.includes('latitude'), false);
  }
  assert.equal(displayUpdates, 0);
});

test('Brewfather projection keeps only bounded, unique, eligible batch metadata', () => {
  const batches = sanitizeBrewfatherActiveBatches({
    entity_id: 'sensor.brewfather_active_batches',
    state: '2026-08-08T12:00:00Z',
    attributes: {
      batches: [
        { id: 'planning-1', name: 'Plan <script>', status: 'Planning', style: 'IPA', abv: '5.2' },
        { id: 'fermenting-1', recipe_name: 'Fermenting', status: 'Fermenting' },
        { id: 'conditioning-1', name: 'Conditioning', status: 'Conditioning', abv: 4.8 },
        { id: 'planning-1', name: 'Duplicate', status: 'Planning' },
        { id: 'completed-1', name: 'Completed', status: 'Completed' },
        { id: '', name: 'Missing identity', status: 'Planning' },
        'invalid'
      ]
    }
  });

  assert.deepEqual(batches, [
    { id: 'planning-1', name: 'Plan <script>', status: 'Planning', style: 'IPA', abv: 5.2 },
    { id: 'fermenting-1', name: 'Fermenting', status: 'Fermenting', style: '', abv: null },
    { id: 'conditioning-1', name: 'Conditioning', status: 'Conditioning', style: '', abv: 4.8 }
  ]);
  assert.deepEqual(
    sanitizeBrewfatherActiveBatches({
      entity_id: 'sensor.brewfather_active_batches',
      state: 'ready',
      attributes: { batches: { planning: [] } }
    }),
    []
  );
  assert.deepEqual(
    sanitizeBrewfatherActiveBatches({
      entity_id: 'sensor.brewfather_active_batches',
      state: 'ready',
      attributes: {
        batches: [
          ...Array.from({ length: 151 }, (_, index) => ({
            id: `completed-${index}`,
            name: 'Ineligible',
            status: 'Completed'
          })),
          { id: 'late-valid', name: 'Still eligible', status: 'Planning' }
        ]
      }
    }),
    [{ id: 'late-valid', name: 'Still eligible', status: 'Planning', style: '', abv: null }]
  );
});

test('pour completion uses the lifecycle captured synchronously at pour start', () => {
  let activeLifecycleId = 41;
  let recorded;
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({
    detector,
    displayUpdateCoalescer: { enqueue() {} },
    captureLifecycle: () => ({ lifecycle_id: activeLifecycleId }),
    recordPourFn: (pour) => {
      recorded = pour;
    }
  });

  client.handleDetectorEvent({ type: 'start', tapId: 1, startVolume: 100, timestamp: 1_000 });
  activeLifecycleId = 42;
  client.handleDetectorEvent({ type: 'complete', tapId: 1, volumePouredOz: 6, timestamp: 2_000 });

  assert.equal(recorded.lifecycleId, 41);
  assert.equal(recorded.tapId, 1);
  assert.equal(recorded.volumePouredOz, 6);
});
