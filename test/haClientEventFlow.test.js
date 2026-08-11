import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatSSEFrame } from '../src/sseHub.js';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'tapboard-ha-client-test-'));
const { HAClient } = await import('../src/haClient.js');

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

  const snapshot = { schemaVersion: 7, tapStates: client.getPublicTapStates() };
  const httpJson = JSON.stringify(snapshot);
  const sseFrame = formatSSEFrame('snapshot', snapshot);
  for (const output of [httpJson, sseFrame]) {
    assert.equal(output.includes('person.private_resident'), false);
    assert.equal(output.includes('must-never-leak'), false);
    assert.equal(output.includes('latitude'), false);
  }
  assert.equal(displayUpdates, 0);
});

test('HA Brewfather projection entities are retained privately but never produce public display changes', () => {
  const changes = [];
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({ detector, displayUpdateCoalescer: { enqueue: (change) => changes.push(change) } });
  for (const entity of [
    { entity_id: 'sensor.brewfather_active_batches', state: 'ready', attributes: { batches: [{ id: 'secret' }] } },
    { entity_id: 'sensor.tap_1_batch_info', state: 'active', attributes: { notes: 'private' } },
    { entity_id: 'select.tap_1_batch_select', state: 'secret', attributes: { options: ['secret'] } }
  ]) {
    client.processStateUpdate({ entity_id: entity.entity_id, new_state: entity });
  }
  assert.deepEqual(changes, []);
  assert.equal(JSON.stringify(client.getPublicTapStates()).includes('secret'), false);
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

test('completion records before best-effort HA publishing and a publish failure stays nonfatal', async () => {
  const order = [];
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({
    detector,
    displayUpdateCoalescer: { enqueue() {} },
    captureLifecycle: () => ({ lifecycle_id: 21, batch_id: 'batch-21' }),
    recordPourFn: () => order.push('record')
  });
  client.fireEvent = () => {
    order.push('fire');
    return Promise.reject(new Error('offline'));
  };
  client.on('pour_complete', () => order.push('sse'));

  client.handleDetectorEvent({ type: 'start', tapId: 1, startVolume: 100, timestamp: 1_000 });
  client.handleDetectorEvent({ type: 'complete', tapId: 1, volumePouredOz: 6, timestamp: 2_000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ['fire', 'record', 'fire', 'sse']);
});

test('an unassigned pour publishes nullable lifecycle and batch identities', () => {
  const events = [];
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({
    detector,
    displayUpdateCoalescer: { enqueue() {} },
    captureLifecycle: () => null,
    recordPourFn: () => {}
  });
  client.fireEvent = (_eventType, eventData) => {
    events.push(eventData);
    return Promise.resolve();
  };
  client.handleDetectorEvent({ type: 'start', tapId: 1, startVolume: 100, timestamp: 1_000 });
  client.handleDetectorEvent({ type: 'complete', tapId: 1, volumePouredOz: 6, timestamp: 2_000 });

  assert.equal(events[1].event_type, 'pour_complete');
  assert.equal(events[1].lifecycle_id, null);
  assert.equal(events[1].batch_id, null);
});

test('hydration never emits synthetic outbound pour events', () => {
  let fires = 0;
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({ detector, displayUpdateCoalescer: { enqueue() {} } });
  client.fireEvent = () => {
    fires += 1;
    return Promise.resolve();
  };
  const entityId = 'sensor.tap_1_fl_oz';
  client.statesMap.set(entityId, state(entityId, 100, 1_000));
  client.rehydrateDetectorFromCurrentPrimaries('hydrate');
  assert.equal(fires, 0);
});

test('automatic kick requires a stable measured threshold and emits once after its durable claim', () => {
  let scheduled;
  let now = Date.parse('2026-08-11T00:00:00.000Z');
  let measurement = { volumeStatus: 'measured', volumeOz: 1.5 };
  const claims = [];
  const events = [];
  const detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} };
  const client = new HAClient({
    detector,
    displayUpdateCoalescer: { enqueue() {} },
    captureLifecycle: () => ({ lifecycle_id: 31 }),
    now: () => now,
    setTimeout: (callback) => {
      scheduled = callback;
      return 1;
    },
    clearTimeout() {},
    kickStabilityMs: 30_000,
    claimKickFn: (claim) => {
      claims.push(claim);
      return { claimed: true, milestone: { kicked_at: claim.timestamp } };
    }
  });
  client.getPublicTapStates = () => ({ 1: measurement });
  client.fireEvent = () => Promise.resolve();
  client.on('keg_kicked', (event) => events.push(event));

  client.beginKickCandidate({
    tapId: 1,
    lifecycleId: 31,
    beerName: 'Test IPA',
    pourId: 8,
    thresholdOz: 2
  });
  assert.equal(typeof scheduled, 'function');
  measurement = { volumeStatus: 'measured', volumeOz: 2.5 };
  scheduled();
  assert.equal(claims.length, 0);

  measurement = { volumeStatus: 'measured', volumeOz: 1.25 };
  client.evaluateKickCandidate(1);
  now += 30_000;
  scheduled();
  assert.equal(claims.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].trigger, 'automatic');
  assert.equal(events[0].remainingVolumeOz, 1.25);
});
