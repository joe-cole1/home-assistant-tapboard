import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'tapboard-ha-websocket-test-'));
process.env.HA_TOKEN = 'test-token';
const { HAClient } = await import('../src/haClient.js');

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  constructor() {
    super();
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.terminated = false;
    FakeWebSocket.instances.push(this);
  }
  send(payload, callback) {
    this.sent.push(JSON.parse(payload));
    callback?.();
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  message(payload) {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
}

function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, delay) {
      pending.set(++id, { fn, delay });
      return id;
    },
    clearTimeout(timer) {
      pending.delete(timer);
    },
    runNext() {
      const [timer, task] = pending.entries().next().value;
      pending.delete(timer);
      task.fn();
    }
  };
}

function clientWith(timers, detector = { onEvent: null, ingest() {}, hydrate() {}, reset() {} }) {
  return new HAClient({
    WebSocketImpl: FakeWebSocket,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    detector,
    displayUpdateCoalescer: { enqueue() {} }
  });
}

test('requests time out and settle only once', async () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  client.connect();
  const request = client.send({ type: 'get_states' });
  assert.equal(client.pendingRequests.size, 1);
  timers.runNext();
  await assert.rejects(request, /timed out/);
  assert.equal(client.pendingRequests.size, 0);

  // A late HA response cannot resettle an already timed-out request.
  FakeWebSocket.instances.at(-1).message({ id: 2, success: true, result: [] });
  assert.equal(client.pendingRequests.size, 0);
  client.stop();
});

test('close rejects outstanding work and owns one reconnect timer', async () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  const changes = [];
  client.on('connection_change', (value) => changes.push(value));
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: 'auth_ok' });
  const request = client.send({ type: 'get_states' });
  socket.emit('close', 1006);
  socket.emit('error', new Error('duplicate failure'));
  await assert.rejects(request, /closed/);
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(changes, []);
  client.stop();
});

test('fault cleanup terminates the old socket before a reconnect can start', () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit('error', new Error('connection failed'));
  assert.equal(socket.terminated, true);
  assert.equal(client.ws, null);
  assert.equal(timers.pending.size, 1);
  timers.runNext();
  assert.notEqual(FakeWebSocket.instances.at(-1), socket);
  client.stop();
});

test('send callback failures and shutdown reject and clean pending requests', async () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.send = (_payload, callback) => callback(new Error('send failed'));
  await assert.rejects(client.send({ type: 'get_states' }), /send failed/);
  assert.equal(client.pendingRequests.size, 0);
  assert.equal(client.ws, null);
  assert.equal(timers.pending.size, 1);
  client.stop();

  const secondTimers = fakeTimers();
  const second = clientWith(secondTimers);
  second.connect();
  const pending = second.send({ type: 'get_states' });
  second.stop();
  await assert.rejects(pending, /stopped/);
  assert.equal(second.pendingRequests.size, 0);
  assert.equal(secondTimers.pending.size, 0);
});

test('auth_invalid is terminal until explicit restart', () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: 'auth_invalid', message: 'bad token' });
  assert.equal(client.connectionState, 'auth_invalid');
  assert.equal(timers.pending.size, 0);
  assert.equal(client.connect(), false);
  assert.equal(client.restart(), true);
  client.stop();
});

test('an authentication handshake timeout closes the socket and backs off', () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit('open');
  assert.equal(timers.pending.size, 1);
  timers.runNext();
  assert.equal(client.ws, null);
  assert.equal(client.connectionState, 'disconnected');
  assert.equal(timers.pending.size, 1);
  client.stop();
});

test('hydration accepts only its subscription, applies queued state without detector replay', async () => {
  const timers = fakeTimers();
  const detector = {
    onEvent: null,
    ingests: 0,
    hydrates: 0,
    reset() {},
    ingest() {
      this.ingests += 1;
    },
    hydrate() {
      this.hydrates += 1;
    }
  };
  const client = clientWith(timers, detector);
  const changes = [];
  client.on('connection_change', (connected) => changes.push(connected));
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: 'auth_ok' });
  await new Promise((resolve) => setImmediate(resolve));
  const subscription = socket.sent.find((message) => message.type === 'subscribe_events');
  socket.message({ id: subscription.id, success: true, result: null });
  await new Promise((resolve) => setImmediate(resolve));
  const snapshot = socket.sent.find((message) => message.type === 'get_states');
  const entity = 'sensor.tap_1_fl_oz';
  socket.message({
    type: 'event',
    id: subscription.id + 99,
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: entity,
        new_state: {
          entity_id: entity,
          state: '1',
          attributes: { unit_of_measurement: 'fl oz' },
          last_updated: new Date(1000).toISOString()
        }
      }
    }
  });
  socket.message({
    type: 'event',
    id: subscription.id,
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: entity,
        new_state: {
          entity_id: entity,
          state: '2',
          attributes: { unit_of_measurement: 'fl oz' },
          last_updated: new Date(2000).toISOString()
        }
      }
    }
  });
  socket.message({
    id: snapshot.id,
    success: true,
    result: [
      {
        entity_id: entity,
        state: '0',
        attributes: { unit_of_measurement: 'fl oz' },
        last_updated: new Date(0).toISOString()
      }
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.isHydrated, true);
  assert.equal(client.statesMap.get(entity).state, '2');
  assert.equal(detector.ingests, 0);
  assert.ok(detector.hydrates >= 1);
  assert.deepEqual(changes, [true]);
  client.stop();
  assert.deepEqual(changes, [true, false]);
});

test('hydration overflow discards the generation and schedules a fresh connection', async () => {
  const timers = fakeTimers();
  const client = clientWith(timers);
  client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.message({ type: 'auth_ok' });
  await new Promise((resolve) => setImmediate(resolve));
  const subscription = socket.sent.find((message) => message.type === 'subscribe_events');
  socket.message({ id: subscription.id, success: true, result: null });
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 513; i++) {
    socket.message({
      type: 'event',
      id: subscription.id,
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: `sensor.x_${i}`,
          new_state: { entity_id: `sensor.x_${i}`, state: '1', attributes: {}, last_updated: new Date(i).toISOString() }
        }
      }
    });
  }
  assert.equal(client.isHydrated, false);
  assert.equal(client.eventQueue.length, 0);
  assert.equal(timers.pending.size, 1);
  client.stop();
});
