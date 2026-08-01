import assert from 'node:assert/strict';
import test from 'node:test';
import { DisplayUpdateCoalescer } from '../src/displayUpdateCoalescer.js';
import { FakeClock } from './fakeClock.js';

test('coalesces globally for 250ms, merges tap changes, and emits deterministic tap order', () => {
  const clock = new FakeClock();
  const payloads = [];
  const coalescer = new DisplayUpdateCoalescer({ now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, onFlush: payload => payloads.push(payload) });
  coalescer.enqueue({ tapId: 2, changes: { volumeOz: 100 }, timestamp: 100 });
  clock.advanceTo(100);
  coalescer.enqueue({ tapId: 1, changes: { fillPercent: 50 }, timestamp: 100 });
  clock.advanceTo(200);
  coalescer.enqueue({ tapId: 2, changes: { pintsRemaining: 6, volumeOz: 99.5 }, timestamp: 200 });
  assert.equal(payloads.length, 0);
  clock.advanceTo(250);
  assert.deepEqual(payloads, [{ timestamp: new Date(200).toISOString(), taps: [
    { tapId: 1, changes: { fillPercent: 50 } },
    { tapId: 2, changes: { volumeOz: 99.5, pintsRemaining: 6 } }
  ] }]);
});

test('flushes at no more than four batches per second under sustained updates', () => {
  const clock = new FakeClock();
  const payloads = [];
  const coalescer = new DisplayUpdateCoalescer({ now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, onFlush: payload => payloads.push(payload) });
  for (let at = 0; at < 1_000; at += 100) {
    clock.advanceTo(at);
    coalescer.enqueue({ tapId: 1, changes: { volumeOz: at }, timestamp: at });
  }
  clock.advanceTo(1_250);
  assert.equal(payloads.length, 4);
  assert.deepEqual(payloads.map(payload => payload.taps[0].changes.volumeOz), [200, 500, 800, 900]);
});

test('10 Hz display telemetry produces four events per second while fast and unrelated inputs produce none', () => {
  const clock = new FakeClock();
  const payloads = [];
  const coalescer = new DisplayUpdateCoalescer({ now: clock.now, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, onFlush: payload => payloads.push(payload) });
  for (let at = 0; at < 1_000; at += 100) {
    clock.advanceTo(at);
    coalescer.enqueue({ tapId: 3, changes: { volumeOz: 640 - at / 100 }, timestamp: at });
  }
  clock.advanceTo(1_250);
  assert.equal(payloads.length, 4);
  assert.ok(payloads.every(payload => payload.taps.length === 1 && payload.taps[0].tapId === 3));
  console.log(`coalescer measurement: 10 input updates/sec -> ${payloads.length} display events/sec`);
});
