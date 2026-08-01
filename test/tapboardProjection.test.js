import assert from 'node:assert/strict';
import test from 'node:test';
import { createTapStatesProjection, projectTapStateChange } from '../src/tapboardProjection.js';

function entity(state, attributes = {}) { return { state, attributes }; }

test('projection uses only fixed tap entity IDs and strips non-allowlisted HA attributes', () => {
  const states = new Map([
    ['sensor.tap_1_fill', entity('55.5', { unit_of_measurement: '%', secret: 'nope' })],
    ['sensor.tap_1_fl_oz', entity('355.2', { latitude: 40 })],
    ['sensor.tap_1_pints_remaining', entity('22.2')],
    ['sensor.tap_1_batch_info', entity('active', { batch_id: 'batch-1', recipe_name: 'Privacy IPA', style: 'IPA', abv: '6.5', srm: '8', secret_token: 'never-public' })],
    ['select.tap_1_batch_select', entity('batch-1 | Privacy IPA', { options: ['batch-1 | Privacy IPA', 42], device_id: 'private' })],
    ['person.joe', entity('home', { latitude: 40.1, longitude: -73.9, password: 'secret' })],
    ['sensor.tap_7_fill', entity('99')]
  ]);
  const projection = createTapStatesProjection(states);
  assert.deepEqual(Object.keys(projection), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(projection['1'], {
    fillPercent: 55.5, volumeOz: 355.2, pintsRemaining: 22.2,
    batch: { batchId: 'batch-1', recipeName: 'Privacy IPA', style: 'IPA', brewDate: null, og: null, fg: null, abv: 6.5, ibu: null, srm: 8, description: null, status: null },
    batchSelection: { value: 'batch-1 | Privacy IPA', options: ['batch-1 | Privacy IPA'] }
  });
  assert.equal(JSON.stringify(projection).includes('secret'), false);
  assert.equal(JSON.stringify(projection).includes('person.joe'), false);
});

test('incremental projections are semantic deltas and unrelated entities produce no public output', () => {
  assert.deepEqual(projectTapStateChange('sensor.tap_2_fill', entity('unavailable')), { tapId: 2, changes: { fillPercent: null } });
  assert.deepEqual(projectTapStateChange('sensor.tap_2_batch_info', entity('active', { name: 'Pils', color: 4, internal: 'hidden' })), {
    tapId: 2,
    changes: { batch: { batchId: null, recipeName: 'Pils', style: null, brewDate: null, og: null, fg: null, abv: null, ibu: null, srm: 4, description: null, status: null } }
  });
  assert.equal(projectTapStateChange('binary_sensor.front_door', entity('on', { sensitive: true })), null);
  assert.equal(projectTapStateChange('sensor.tap_2_fast', entity('100')), null);
  assert.deepEqual(projectTapStateChange('sensor.tap_2_fl_oz', entity('12 oz')), { tapId: 2, changes: { volumeOz: null } });
  assert.equal(
    projectTapStateChange('sensor.tap_2_batch_info', entity('active', { batch_id: { token: 'nested-secret' } })).changes.batch.batchId,
    null
  );
});

test('batch options survive unusable selector states without exposing other attributes', () => {
  const options = ['batch-1 | Privacy IPA', 42, { secret: 'nested' }, 'custom:topo_chico | Topo Chico 0%'];
  const states = new Map([
    ['select.tap_1_batch_select', entity('unknown', { options, device_id: 'private' })],
    ['select.tap_2_batch_select', entity('unavailable', { options, access_token: 'never-public' })],
    ['select.tap_3_batch_select', entity('unknown', { options: 'malformed' })]
  ]);

  const projection = createTapStatesProjection(states);
  for (const tapId of ['1', '2']) {
    assert.deepEqual(projection[tapId].batchSelection, {
      value: '',
      options: ['batch-1 | Privacy IPA', 'custom:topo_chico | Topo Chico 0%']
    });
  }
  assert.deepEqual(projection['3'].batchSelection, { value: '', options: [] });
  assert.equal(JSON.stringify(projection).includes('private'), false);
  assert.equal(JSON.stringify(projection).includes('never-public'), false);
  assert.equal(JSON.stringify(projection).includes('nested'), false);

  assert.deepEqual(
    projectTapStateChange('select.tap_1_batch_select', entity('unknown', { options })),
    {
      tapId: 1,
      changes: {
        batchSelection: {
          value: '',
          options: ['batch-1 | Privacy IPA', 'custom:topo_chico | Topo Chico 0%']
        }
      }
    }
  );
});

test('a 1,273-entity legacy-style map is substantially larger than the fixed public tap projection', () => {
  const states = new Map();
  for (let index = 0; index < 1_273; index++) {
    states.set(`sensor.private_${index}`, entity('home', {
      friendly_name: `Private household entity ${index}`,
      latitude: 40.7128,
      longitude: -74.006,
      sensitive_payload: 'x'.repeat(150)
    }));
  }
  for (let tapId = 1; tapId <= 6; tapId++) {
    states.set(`sensor.tap_${tapId}_fill`, entity('50'));
    states.set(`sensor.tap_${tapId}_fl_oz`, entity('320'));
    states.set(`sensor.tap_${tapId}_pints_remaining`, entity('20'));
  }
  const legacy = Object.fromEntries(states);
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
  const publicBytes = Buffer.byteLength(JSON.stringify(createTapStatesProjection(states)));
  assert.ok(legacyBytes > 265_257, `legacy fixture should exceed audit baseline, got ${legacyBytes}`);
  assert.ok(publicBytes < legacyBytes / 100, `${publicBytes} must be under 1% of ${legacyBytes}`);
  assert.equal(JSON.stringify(createTapStatesProjection(states)).includes('sensitive_payload'), false);
  console.log(`projection measurement: legacy ${legacyBytes} bytes -> public ${publicBytes} bytes (${(100 * publicBytes / legacyBytes).toFixed(2)}%)`);
});
