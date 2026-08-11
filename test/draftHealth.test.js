import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftHealthEngine, temperatureF } from '../src/draftHealth.js';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const base = (tapId = 1) => ({
  tapId,
  connected: true,
  lifecycleId: `life-${tapId}`,
  volumeOz: 100,
  capacityOz: 160,
  volumeStatus: 'measured',
  freshAt: NOW
});
const byId = (answer, id) => answer.checks.find((check) => check.id === id);

test('all five registered checks evaluate for each supported tap', () => {
  for (let tapId = 1; tapId <= 6; tapId++) {
    const answer = new DraftHealthEngine({ now: () => NOW }).evaluate(base(tapId));
    assert.equal(answer.checks.length, 5);
    assert.equal(byId(answer, 'low_keg').state, 'healthy');
  }
});

test('low keg uses fresh canonical measurement; scale handles stale, unavailable and disconnect', () => {
  let now = NOW;
  const engine = new DraftHealthEngine({ now: () => now });
  assert.equal(byId(engine.evaluate({ ...base(), volumeOz: 10 }), 'low_keg').state, 'active');
  assert.equal(byId(engine.evaluate({ ...base(), freshAt: NOW - 31 * 60_000 }), 'low_keg').state, 'degraded');
  assert.equal(
    byId(engine.evaluate({ ...base(), volumeStatus: 'unavailable', volumeOz: null }), 'scale_availability').state,
    'degraded'
  );
  now += 5 * 60_000;
  assert.equal(
    byId(engine.evaluate({ ...base(), volumeStatus: 'unavailable', volumeOz: null }), 'scale_availability').state,
    'active'
  );
  assert.equal(byId(engine.evaluate({ ...base(), connected: false }), 'scale_availability').state, 'degraded');
});

test('temperature accepts Fahrenheit and Celsius and is only configured with an entity', () => {
  let now = NOW;
  const engine = new DraftHealthEngine({
    now: () => now,
    config: { serving_temperature: { enabled: true } }
  });
  assert.equal(temperatureF(4, 'C'), 39.2);
  assert.equal(
    byId(engine.evaluate({ ...base(), temperature: { state: '4', unit: 'C' } }), 'serving_temperature').state,
    'healthy'
  );
  assert.equal(
    byId(engine.evaluate({ ...base(), temperature: { state: '50', unit: 'F' } }), 'serving_temperature').state,
    'degraded'
  );
  now += 15 * 60_000;
  assert.equal(
    byId(engine.evaluate({ ...base(), temperature: { state: '50', unit: 'F' } }), 'serving_temperature').state,
    'active'
  );
  assert.equal(byId(engine.evaluate(base()), 'serving_temperature').state, 'not_configured');
});

test('temperature duration requires continuous valid evidence', () => {
  let now = NOW;
  const engine = new DraftHealthEngine({
    now: () => now,
    config: { serving_temperature: { enabled: true } }
  });
  engine.evaluate({ ...base(), temperature: { state: '50', unit: 'F' } });
  now += 10 * 60_000;
  engine.evaluate({ ...base(), temperature: { state: 'unavailable', unit: 'F' } });
  now += 10 * 60_000;
  assert.equal(
    byId(engine.evaluate({ ...base(), temperature: { state: '50', unit: 'F' } }), 'serving_temperature').state,
    'degraded'
  );
});

test('maintenance requires policy and baseline then becomes due', () => {
  const engine = new DraftHealthEngine({
    now: () => NOW,
    config: { line_cleaning_due: { enabled: true, intervalDays: 14, criticalAfterDays: 7 } }
  });
  assert.equal(byId(engine.evaluate(base()), 'line_cleaning_due').state, 'not_configured');
  assert.equal(
    byId(engine.evaluate({ ...base(), lineCleanedAt: NOW - 15 * 86_400_000 }), 'line_cleaning_due').severity,
    'warning'
  );
  assert.equal(
    byId(engine.evaluate({ ...base(), lineCleanedAt: NOW - 22 * 86_400_000 }), 'line_cleaning_due').severity,
    'critical'
  );
});

test('leak is conservative, suppressed for pours, resets for movements and lifecycle reassignment', () => {
  let now = NOW;
  const engine = new DraftHealthEngine({ now: () => now, config: { suspected_leak: { enabled: true } } });
  engine.evaluate(base());
  now += 15 * 60_000;
  assert.equal(byId(engine.evaluate({ ...base(), volumeOz: 91 }), 'suspected_leak').state, 'active');
  now += 1;
  assert.equal(byId(engine.evaluate({ ...base(), volumeOz: 90, pourActive: true }), 'suspected_leak').state, 'healthy');
  now += 13 * 60_000;
  engine.evaluate({ ...base(), volumeOz: 82 });
  assert.equal(
    byId(engine.evaluate({ ...base(), volumeOz: 120 }), 'suspected_leak').evidence.reason,
    'movement_or_refill'
  );
  assert.equal(byId(engine.evaluate({ ...base(), lifecycleId: 'new-life' }), 'suspected_leak').state, 'degraded');
});

test('pour and settling samples cannot become leak evidence afterward', () => {
  let now = NOW;
  const engine = new DraftHealthEngine({ now: () => now, config: { suspected_leak: { enabled: true } } });
  engine.evaluate(base());
  now += 15 * 60_000;
  engine.evaluate({ ...base(), volumeOz: 90, pourActive: true });
  now += 12 * 60_000;
  assert.equal(byId(engine.evaluate({ ...base(), volumeOz: 90 }), 'suspected_leak').state, 'healthy');
});

test('transitions, acknowledgement, recovery and disabled checks produce caller-owned record projections', () => {
  const engine = new DraftHealthEngine({ now: () => NOW });
  const first = engine.evaluate({ ...base(), volumeOz: 10 });
  assert.ok(first.transitions.some((change) => change.id === 'low_keg' && change.to === 'active'));
  engine.acknowledge(1, 'low_keg', { until: NOW + 1_000 });
  assert.equal(byId(engine.evaluate({ ...base(), volumeOz: 10 }), 'low_keg').acknowledged, true);
  engine.cooldown(1, 'low_keg', NOW + 2_000);
  assert.equal(byId(engine.evaluate({ ...base(), volumeOz: 10 }), 'low_keg').coolingDown, true);
  assert.equal(byId(engine.evaluate(base()), 'low_keg').state, 'healthy');
  assert.equal(byId(engine.evaluate(base()), 'suspected_leak').state, 'not_configured');
});
