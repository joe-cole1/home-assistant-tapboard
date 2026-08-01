import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DETECTOR_CONFIG, PourDetector, normalizeVolumeToOz } from '../src/pourDetector.js';
import { FakeClock } from './fakeClock.js';
import { laterIdleFalsePositiveTrace, oscillatingPourTrace, slowPourTrace, tap2Trace2035, tap2Trace2046 } from './fixtures/pourTraces.js';

function createDetector(config = {}) {
  const clock = new FakeClock();
  const events = [];
  const detector = new PourDetector({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onEvent: event => events.push(event),
    config
  });
  return { clock, detector, events };
}

function replay({ clock, detector }, trace) {
  for (const entry of trace) {
    clock.advanceTo(entry.at);
    const value = normalizeVolumeToOz(entry.value, entry.unit);
    detector.ingestSample(entry.tapId, value, entry.at);
  }
}

function eventsOf(events, type) {
  return events.filter(event => event.type === type);
}

function feedFlat({ clock, detector }, tapId, value, start, end, step = 200) {
  for (let at = start; at <= end; at += step) {
    clock.advanceTo(at);
    detector.ingestSample(tapId, value, at);
  }
}

test('declared units convert strictly, including a 640 fl oz keg', () => {
  assert.equal(normalizeVolumeToOz(640, 'fl oz'), 640);
  assert.equal(normalizeVolumeToOz(640, 'fl. oz.'), 640);
  assert.equal(normalizeVolumeToOz(640, 'oz'), 640);
  assert.ok(Math.abs(normalizeVolumeToOz(29.5735295625, 'mL') - 1) < 1e-10);
  assert.equal(normalizeVolumeToOz(640, 'percent'), null);
  assert.equal(normalizeVolumeToOz(640, undefined), null);
  assert.equal(normalizeVolumeToOz('unavailable', 'fl oz'), null);
  assert.equal(normalizeVolumeToOz('12 oz', 'fl oz'), null);
});

test('hydrates safely and rejects unavailable, unknown, spikes, and out-of-order telemetry', () => {
  const { clock, detector, events } = createDetector();
  detector.hydrate(1, 100, 0);
  assert.equal(detector.ingestSample(1, null, 100), false);
  assert.equal(detector.ingestSample(1, Number.NaN, 200), false);
  assert.equal(detector.ingestSample(1, 68, 300), false); // unconfirmed large change/spike
  assert.equal(detector.ingestSample(1, 100, 250), false); // stale timestamp
  assert.equal(eventsOf(events, 'start').length, 0);
  clock.advanceBy(DEFAULT_DETECTOR_CONFIG.quietPeriodMs);
  assert.equal(eventsOf(events, 'complete').length, 0);
});

test('20:35 synthetic trace starts only Tap 2 despite Tap 1 coupling and completes its net loss', () => {
  const harness = createDetector();
  replay(harness, tap2Trace2035);
  harness.clock.advanceBy(500); // settle arbitration window
  assert.deepEqual(eventsOf(harness.events, 'start').map(event => event.tapId), [2]);
  feedFlat(harness, 2, 613.30, 1_600, 5_800);
  harness.clock.advanceTo(6_600);
  const completes = eventsOf(harness.events, 'complete');
  assert.equal(completes.length, 1);
  assert.equal(completes[0].tapId, 2);
  assert.ok(completes[0].volumePouredOz > 6 && completes[0].volumePouredOz < 7);
  assert.equal(eventsOf(harness.events, 'start').some(event => event.tapId === 1), false);
});

test('20:46 synthetic trace arbitrates the dominant sustained Tap 2 loss over earlier Tap 1 impulse', () => {
  const harness = createDetector();
  replay(harness, tap2Trace2046);
  harness.clock.advanceBy(500);
  assert.deepEqual(eventsOf(harness.events, 'start').map(event => event.tapId), [2]);
  assert.equal(eventsOf(harness.events, 'start').some(event => event.tapId === 1), false);
  feedFlat(harness, 2, 609.36, 1_800, 6_200);
  harness.clock.advanceTo(6_400);
  assert.deepEqual(eventsOf(harness.events, 'complete').map(event => event.tapId), [2]);
});

test('later idle/startup false-positive trace never creates a physical pour', () => {
  const harness = createDetector();
  replay(harness, laterIdleFalsePositiveTrace);
  harness.clock.advanceBy(20_000);
  assert.equal(eventsOf(harness.events, 'start').length, 0);
  assert.equal(eventsOf(harness.events, 'complete').length, 0);
});

test('continuous flat 0.2-second samples do not postpone quiet completion', () => {
  const harness = createDetector({ candidateSamples: 2, candidateSampleWindowMs: 500 });
  replay(harness, [
    { at: 0, tapId: 1, value: 100, unit: 'fl oz' },
    { at: 200, tapId: 1, value: 99.0, unit: 'fl oz' },
    { at: 400, tapId: 1, value: 98.0, unit: 'fl oz' },
  ]);
  harness.clock.advanceBy(500);
  feedFlat(harness, 1, 98.0, 1_100, 5_900);
  harness.clock.advanceTo(6_100);
  assert.equal(eventsOf(harness.events, 'complete').length, 1);
  assert.ok(eventsOf(harness.events, 'complete')[0].timestamp <= 6_100);
});

test('jitter and positive rebound do not inflate volume, which is robust net loss rather than summed drops', () => {
  const harness = createDetector({ candidateSamples: 2, candidateSampleWindowMs: 500 });
  replay(harness, oscillatingPourTrace);
  harness.clock.advanceBy(500);
  feedFlat(harness, 1, 98.1, 2_000, 5_600);
  harness.clock.advanceTo(5_800);
  const complete = eventsOf(harness.events, 'complete')[0];
  assert.equal(complete.tapId, 1);
  assert.ok(complete.volumePouredOz >= 1.5 && complete.volumePouredOz <= 2.2);
});

test('slow meaningful flow remains active until the final quiet period, then completes', () => {
  const harness = createDetector({ candidateSamples: 2, candidateSampleWindowMs: 1_000 });
  replay(harness, slowPourTrace);
  harness.clock.advanceBy(500);
  assert.equal(eventsOf(harness.events, 'start').length, 1);
  feedFlat(harness, 1, 98.0, 4_200, 5_000);
  harness.clock.advanceTo(9_199);
  assert.equal(eventsOf(harness.events, 'complete').length, 0);
  harness.clock.advanceTo(9_200);
  assert.equal(eventsOf(harness.events, 'complete').length, 1);
});

test('persistent stable large plateau rebaselines without emitting a pour', () => {
  const harness = createDetector();
  harness.detector.hydrate(1, 100, 0);
  for (const [at, value] of [[200, 60], [1_000, 60.1], [1_800, 59.95], [2_600, 60.05], [3_200, 60]]) {
    harness.clock.advanceTo(at);
    harness.detector.ingestSample(1, value, at);
  }
  assert.equal(eventsOf(harness.events, 'start').length, 0);
  assert.equal(eventsOf(harness.events, 'complete').length, 0);
  assert.equal(eventsOf(harness.events, 'cancel').length, 0);
  assert.ok(Math.abs(harness.detector.stateFor(1).baseline - 60) < 0.1);
});

test('one-active arbitration suppresses ambiguous simultaneous candidates', () => {
  const harness = createDetector({ candidateSamples: 2, candidateSampleWindowMs: 500 });
  replay(harness, [
    { at: 0, tapId: 1, value: 100, unit: 'oz' }, { at: 0, tapId: 2, value: 100, unit: 'oz' },
    { at: 200, tapId: 1, value: 98.5, unit: 'oz' }, { at: 200, tapId: 2, value: 98.4, unit: 'oz' },
    { at: 400, tapId: 1, value: 98.3, unit: 'oz' }, { at: 400, tapId: 2, value: 98.2, unit: 'oz' },
  ]);
  harness.clock.advanceBy(500);
  assert.equal(eventsOf(harness.events, 'start').length, 0);
  assert.equal(eventsOf(harness.events, 'cancel').length, 0);
});

test('below-minimum sessions cancel and cooldown blocks immediate retrigger; safety timeout cancels long session', () => {
  const small = createDetector({ candidateSamples: 2, candidateSampleWindowMs: 500, minimumPourOz: 1.5 });
  replay(small, [
    { at: 0, tapId: 1, value: 100, unit: 'oz' }, { at: 200, tapId: 1, value: 99, unit: 'oz' }, { at: 400, tapId: 1, value: 99, unit: 'oz' },
  ]);
  feedFlat(small, 1, 99, 1_000, 1_800);
  small.clock.advanceTo(5_800);
  assert.equal(eventsOf(small.events, 'cancel').at(-1)?.reason, 'rebound');
  for (const [at, value] of [[5_900, 97], [6_100, 96], [6_300, 95]]) {
    small.clock.advanceTo(at);
    small.detector.ingestSample(1, value, at);
  }
  assert.equal(eventsOf(small.events, 'start').length, 1);

  for (const at of [10_900, 11_100, 11_300, 11_500, 11_700]) {
    small.clock.advanceTo(at);
    small.detector.ingestSample(1, 95, at);
  }
  for (const [at, value] of [[11_900, 94], [12_100, 93], [12_300, 92]]) {
    small.clock.advanceTo(at);
    small.detector.ingestSample(1, value, at);
  }
  small.clock.advanceTo(12_500);
  assert.equal(eventsOf(small.events, 'start').length, 2);

  const timeout = createDetector({ candidateSamples: 2, candidateSampleWindowMs: 500, quietPeriodMs: 20_000, hardSessionMs: 15_000 });
  replay(timeout, [
    { at: 0, tapId: 1, value: 100, unit: 'oz' }, { at: 200, tapId: 1, value: 99, unit: 'oz' }, { at: 400, tapId: 1, value: 98, unit: 'oz' },
  ]);
  timeout.clock.advanceBy(500);
  timeout.clock.advanceTo(15_800);
  assert.equal(eventsOf(timeout.events, 'cancel').at(-1)?.reason, 'timeout');
});
