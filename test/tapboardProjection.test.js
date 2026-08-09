import assert from 'node:assert/strict';
import test from 'node:test';
import { createTapStatesProjection, projectTapStateChange } from '../src/tapboardProjection.js';

function entity(state, attributes = {}) {
  return { state, attributes };
}

function measurementStates(volume, capacity = 640) {
  return new Map([
    ['sensor.tap_1_fl_oz', entity(volume)],
    ['input_number.tap_1_keg_capacity_oz', entity(capacity)]
  ]);
}

const assignedTapOne = { isAssigned: (tapId) => tapId === 1, lastValidMeasurements: new Map() };

test('canonical projection derives every public measurement from only ounces and capacity', () => {
  const states = measurementStates('355.2');
  states.set('sensor.tap_1_fill', entity('99.9', { secret: 'obsolete' }));
  states.set('sensor.tap_1_pints_remaining', entity('999'));
  states.set(
    'sensor.tap_1_batch_info',
    entity('active', { batch_id: 'batch-1', recipe_name: 'Privacy IPA', style: 'IPA', secret_token: 'never-public' })
  );
  states.set('select.tap_1_batch_select', entity('batch-1 | Privacy IPA', { options: ['batch-1 | Privacy IPA', 42] }));
  const projection = createTapStatesProjection(states, assignedTapOne);

  assert.deepEqual(Object.keys(projection), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(projection['1'], {
    volumeOz: 355.2,
    capacityOz: 640,
    fillPercent: 55.5,
    pintsRemaining: 22.2,
    volumeStatus: 'measured'
  });
  assert.equal(JSON.stringify(projection).includes('obsolete'), false);
  assert.equal(JSON.stringify(projection).includes('999'), false);
  assert.equal(JSON.stringify(projection).includes('secret'), false);
});

test('measurement clamps negative and over-capacity readings, and reacts to capacity changes', () => {
  const options = { isAssigned: () => true, lastValidMeasurements: new Map() };
  assert.deepEqual(createTapStatesProjection(measurementStates(-3), options)['1'], {
    volumeOz: 0,
    capacityOz: 640,
    fillPercent: 0,
    pintsRemaining: 0,
    volumeStatus: 'measured'
  });
  assert.deepEqual(createTapStatesProjection(measurementStates(800), options)['1'], {
    volumeOz: 640,
    capacityOz: 640,
    fillPercent: 100,
    pintsRemaining: 40,
    volumeStatus: 'measured'
  });
  const changedCapacity = createTapStatesProjection(measurementStates(400, 320), options)['1'];
  assert.deepEqual(
    {
      volumeOz: changedCapacity.volumeOz,
      capacityOz: changedCapacity.capacityOz,
      fillPercent: changedCapacity.fillPercent,
      pintsRemaining: changedCapacity.pintsRemaining,
      volumeStatus: changedCapacity.volumeStatus
    },
    { volumeOz: 320, capacityOz: 320, fillPercent: 100, pintsRemaining: 20, volumeStatus: 'measured' }
  );
});

test('sensorless assigned taps are assumed full while sensorless or measured unassigned taps are unavailable', () => {
  const capacityOnly = new Map([['input_number.tap_1_keg_capacity_oz', entity(640)]]);
  assert.equal(createTapStatesProjection(capacityOnly, { isAssigned: () => true })['1'].volumeStatus, 'assumed_full');
  const sensorlessUnassigned = createTapStatesProjection(capacityOnly, { isAssigned: () => false })['1'];
  assert.equal(sensorlessUnassigned.volumeStatus, 'unavailable');
  assert.equal(sensorlessUnassigned.capacityOz, 640);
  assert.equal(
    createTapStatesProjection(measurementStates(320), { isAssigned: () => false })['1'].volumeStatus,
    'unavailable'
  );
});

test('placeholder telemetry for taps 4 through 6 remains unavailable instead of fabricating volume', () => {
  const states = new Map();
  for (let tapId = 4; tapId <= 6; tapId++) {
    states.set(`sensor.tap_${tapId}_fl_oz`, entity('unavailable', { unit_of_measurement: 'fl oz' }));
    states.set(`input_number.tap_${tapId}_keg_capacity_oz`, entity(640));
  }
  const projection = createTapStatesProjection(states, { isAssigned: () => true });
  for (let tapId = 4; tapId <= 6; tapId++) {
    assert.deepEqual(
      {
        volumeOz: projection[String(tapId)].volumeOz,
        fillPercent: projection[String(tapId)].fillPercent,
        pintsRemaining: projection[String(tapId)].pintsRemaining,
        volumeStatus: projection[String(tapId)].volumeStatus
      },
      { volumeOz: null, fillPercent: null, pintsRemaining: null, volumeStatus: 'unavailable' }
    );
  }
});

test('unavailable existing scale is stale only after a valid in-process measurement, then recovers', () => {
  const options = { isAssigned: () => true, lastValidMeasurements: new Map() };
  const states = measurementStates(216.63);
  assert.equal(createTapStatesProjection(states, options)['1'].volumeStatus, 'measured');
  states.set('sensor.tap_1_fl_oz', entity('unavailable'));
  const stale = createTapStatesProjection(states, options)['1'];
  assert.deepEqual(
    {
      volumeOz: stale.volumeOz,
      capacityOz: stale.capacityOz,
      fillPercent: stale.fillPercent,
      pintsRemaining: stale.pintsRemaining,
      volumeStatus: stale.volumeStatus
    },
    { volumeOz: 216.63, capacityOz: 640, fillPercent: 33.8, pintsRemaining: 13.539375, volumeStatus: 'stale' }
  );
  states.set('sensor.tap_1_fl_oz', entity(200));
  assert.equal(createTapStatesProjection(states, options)['1'].volumeStatus, 'measured');
  assert.equal(createTapStatesProjection(states, options)['1'].fillPercent, 31.3);

  assert.equal(
    createTapStatesProjection(measurementStates('unavailable'), {
      isAssigned: () => true,
      lastValidMeasurements: new Map()
    })['1'].volumeStatus,
    'unavailable'
  );
});

test('incremental volume and capacity events emit coherent tuples; obsolete events are ignored', () => {
  const options = { isAssigned: () => true, lastValidMeasurements: new Map() };
  const states = measurementStates(320, 640);
  assert.deepEqual(
    projectTapStateChange('sensor.tap_1_fl_oz', states.get('sensor.tap_1_fl_oz'), { statesMap: states, ...options }),
    {
      tapId: 1,
      changes: { volumeOz: 320, capacityOz: 640, fillPercent: 50, pintsRemaining: 20, volumeStatus: 'measured' }
    }
  );
  states.set('input_number.tap_1_keg_capacity_oz', entity(500));
  assert.deepEqual(
    projectTapStateChange('input_number.tap_1_keg_capacity_oz', states.get('input_number.tap_1_keg_capacity_oz'), {
      statesMap: states,
      ...options
    }),
    {
      tapId: 1,
      changes: { volumeOz: 320, capacityOz: 500, fillPercent: 64, pintsRemaining: 20, volumeStatus: 'measured' }
    }
  );
  assert.equal(projectTapStateChange('sensor.tap_1_fill', entity('50'), { statesMap: states, ...options }), null);
  assert.equal(
    projectTapStateChange('sensor.tap_1_pints_remaining', entity('20'), { statesMap: states, ...options }),
    null
  );
});

test('HA-projected Brewfather entities are ignored by the serving telemetry projection', () => {
  const states = measurementStates(320);
  states.set(
    'sensor.tap_1_batch_info',
    entity('active', { batch_id: 'private-batch', tasting_notes: 'private notes', gravity: 1.01 })
  );
  states.set('select.tap_1_batch_select', entity('private-batch', { options: ['private-batch'] }));
  states.set('sensor.brewfather_active_batches', entity('ready', { batches: [{ id: 'private-batch' }] }));

  const projection = createTapStatesProjection(states, assignedTapOne);
  assert.deepEqual(projection['1'], {
    volumeOz: 320,
    capacityOz: 640,
    fillPercent: 50,
    pintsRemaining: 20,
    volumeStatus: 'measured'
  });
  assert.equal(projectTapStateChange('sensor.tap_1_batch_info', states.get('sensor.tap_1_batch_info')), null);
  assert.equal(projectTapStateChange('select.tap_1_batch_select', states.get('select.tap_1_batch_select')), null);
  assert.equal(
    projectTapStateChange('sensor.brewfather_active_batches', states.get('sensor.brewfather_active_batches')),
    null
  );
});
