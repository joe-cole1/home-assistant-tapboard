const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_WRITABLE_BYTES = 64 * 1024;

export function formatSSEFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SSEHub {
  constructor({
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    blockedTimeoutMs = heartbeatMs,
    maxWritableBytes = DEFAULT_MAX_WRITABLE_BYTES,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now
  } = {}) {
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this.blockedTimeoutMs = blockedTimeoutMs;
    this.maxWritableBytes = maxWritableBytes;
    this.clearIntervalFn = clearIntervalFn;
    this.now = now;
    this.heartbeatTimer = setIntervalFn(() => this.heartbeat(), heartbeatMs);
    this.heartbeatTimer?.unref?.();
  }

  addClient(req, res, snapshot) {
    const client = {
      req,
      res,
      blocked: false,
      blockedAt: null,
      closed: false,
      listeners: []
    };

    const close = () => this.removeClient(client);
    this.addListener(client, req, 'close', close);
    this.addListener(client, req, 'aborted', close);
    this.addListener(client, res, 'close', close);
    this.addListener(client, res, 'error', close);

    this.clients.add(client);
    this.write(client, 'retry: 3000\n: connected\n\n');
    if (!client.closed) this.write(client, formatSSEFrame('snapshot', snapshot));
    return client;
  }

  addListener(client, emitter, event, listener) {
    if (!emitter?.on) return;
    emitter.on(event, listener);
    client.listeners.push({ emitter, event, listener });
  }

  publish(event, data) {
    const frame = formatSSEFrame(event, data);
    for (const client of [...this.clients]) this.write(client, frame);
  }

  publishImmediate(event, data) {
    this.publish(event, data);
  }

  write(client, frame) {
    if (client.closed || !this.clients.has(client)) return false;

    const { res } = client;
    if (res.destroyed || res.writableEnded) {
      this.removeClient(client);
      return false;
    }

    const writableLength = Number(res.writableLength) || 0;
    if (client.blocked || writableLength + Buffer.byteLength(frame) > this.maxWritableBytes) {
      this.removeClient(client, true);
      return false;
    }

    try {
      const accepted = res.write(frame);
      if (!accepted) {
        client.blocked = true;
        client.blockedAt = this.now();
        let drainRecord;
        const onDrain = () => {
          if (client.closed) return;
          client.listeners = client.listeners.filter(record => record !== drainRecord);
          client.blocked = false;
          client.blockedAt = null;
        };
        res.once?.('drain', onDrain);
        drainRecord = { emitter: res, event: 'drain', listener: onDrain };
        client.listeners.push(drainRecord);
      }
      return accepted;
    } catch {
      this.removeClient(client, true);
      return false;
    }
  }

  heartbeat() {
    const now = this.now();
    for (const client of [...this.clients]) {
      if (client.blocked) {
        if (client.blockedAt === null || now - client.blockedAt >= this.blockedTimeoutMs) {
          this.removeClient(client, true);
        }
        continue;
      }
      this.write(client, ': ping\n\n');
    }
  }

  removeClient(client, destroy = false) {
    if (!client || client.closed) return;
    client.closed = true;
    this.clients.delete(client);

    for (const { emitter, event, listener } of client.listeners) {
      emitter?.off?.(event, listener);
      emitter?.removeListener?.(event, listener);
    }
    client.listeners = [];

    if (destroy && !client.res.destroyed) {
      client.res.destroy?.();
    }
  }

  close() {
    if (this.heartbeatTimer) this.clearIntervalFn(this.heartbeatTimer);
    for (const client of [...this.clients]) this.removeClient(client, true);
  }
}
