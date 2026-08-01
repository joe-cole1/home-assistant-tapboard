import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { DisplayUpdateCoalescer } from '../src/displayUpdateCoalescer.js';
import { formatSSEFrame, SSEHub } from '../src/sseHub.js';
import { FakeClock } from './fakeClock.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.writableLength = 0;
    this.writes = [];
    this.acceptWrites = true;
  }

  write(frame) {
    this.writes.push(frame);
    return this.acceptWrites;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

function createHub(options = {}) {
  return new SSEHub({
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    ...options
  });
}

test('formats one compact SSE frame per event', () => {
  const frame = formatSSEFrame('state_changed', { taps: [{ tapId: 1, changes: { volumeOz: 12.3 } }] });
  assert.equal(
    frame,
    'event: state_changed\ndata: {"taps":[{"tapId":1,"changes":{"volumeOz":12.3}}]}\n\n'
  );
  assert.ok(Buffer.byteLength(frame) < 2_048);
  console.log(`typical incremental SSE frame measurement: ${Buffer.byteLength(frame)} bytes`);
});

test('priority pour events are written before a pending display flush', () => {
  const clock = new FakeClock();
  const hub = createHub();
  const res = new FakeResponse();
  hub.addClient(new EventEmitter(), res, { schemaVersion: 2 });
  const coalescer = new DisplayUpdateCoalescer({
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    onFlush: payload => hub.publish('state_changed', payload)
  });

  coalescer.enqueue({ tapId: 1, changes: { volumeOz: 99 }, timestamp: 0 });
  hub.publishImmediate('pour_start', { tapId: 1, startVolume: 100 });
  clock.advanceTo(250);

  const liveFrames = res.writes.slice(2);
  assert.match(liveFrames[0], /^event: pour_start\n/);
  assert.match(liveFrames[1], /^event: state_changed\n/);
});

test('new clients receive retry guidance and a snapshot, then clean up on close', () => {
  const hub = createHub();
  const req = new EventEmitter();
  const res = new FakeResponse();

  hub.addClient(req, res, { schemaVersion: 2 });
  assert.equal(hub.clients.size, 1);
  assert.equal(res.writes[0], 'retry: 3000\n: connected\n\n');
  assert.match(res.writes[1], /^event: snapshot\n/);

  req.emit('close');
  assert.equal(hub.clients.size, 0);
});

test('a real HTTP SSE client remains registered for live events and is removed on disconnect', async () => {
  const hub = createHub();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    hub.addClient(req, res, { schemaVersion: 2 });
    setTimeout(() => hub.publishImmediate('probe', { ok: true }), 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}`);
    const reader = response.body.getReader();
    let received = '';
    while (!received.includes('event: probe')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    assert.match(received, /event: probe\ndata: {"ok":true}/);
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(hub.clients.size, 0);
  } finally {
    hub.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a blocked consumer is bounded and removed without affecting healthy clients', () => {
  let now = 0;
  const hub = createHub({ now: () => now });
  const slow = new FakeResponse();
  const healthy = new FakeResponse();
  hub.addClient(new EventEmitter(), slow, { schemaVersion: 2 });
  hub.addClient(new EventEmitter(), healthy, { schemaVersion: 2 });

  slow.acceptWrites = false;
  hub.publish('state_changed', { taps: [{ tapId: 1, changes: { fillPercent: 50 } }] });
  assert.equal(slow.destroyed, false);
  assert.equal(hub.clients.size, 2);

  now = 1;
  hub.publishImmediate('pour_start', { tapId: 1, startVolume: 100 });
  assert.equal(slow.destroyed, true);
  assert.equal(hub.clients.size, 1);
  assert.match(healthy.writes.at(-1), /^event: pour_start\n/);
});

test('blocked clients that never drain are removed by heartbeat timeout', () => {
  let now = 0;
  const hub = createHub({ now: () => now, heartbeatMs: 100, blockedTimeoutMs: 100 });
  const res = new FakeResponse();
  hub.addClient(new EventEmitter(), res, { schemaVersion: 2 });

  res.acceptWrites = false;
  hub.publish('state_changed', { taps: [] });
  now = 100;
  hub.heartbeat();

  assert.equal(res.destroyed, true);
  assert.equal(hub.clients.size, 0);
});

test('recovered backpressure cycles do not accumulate drain listener metadata', () => {
  const hub = createHub();
  const res = new FakeResponse();
  const client = hub.addClient(new EventEmitter(), res, { schemaVersion: 2 });
  const lifecycleListenerCount = client.listeners.length;

  for (let cycle = 0; cycle < 100; cycle++) {
    res.acceptWrites = false;
    hub.publish('state_changed', { taps: [{ tapId: 1, changes: { volumeOz: cycle } }] });
    assert.equal(client.listeners.length, lifecycleListenerCount + 1);
    res.acceptWrites = true;
    res.emit('drain');
    assert.equal(client.listeners.length, lifecycleListenerCount);
  }

  assert.equal(hub.clients.size, 1);
});

test('writable byte ceiling rejects a client before another frame is buffered', () => {
  const hub = createHub({ maxWritableBytes: 64 });
  const res = new FakeResponse();
  hub.addClient(new EventEmitter(), res, { schemaVersion: 2 });
  res.writableLength = 60;

  hub.publish('state_changed', { taps: [{ tapId: 1, changes: { volumeOz: 1 } }] });

  assert.equal(res.destroyed, true);
  assert.equal(hub.clients.size, 0);
});
