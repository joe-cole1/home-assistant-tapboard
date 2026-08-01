export class DisplayUpdateCoalescer {
  constructor({ delayMs = 250, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, onFlush } = {}) {
    this.delayMs = delayMs;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.onFlush = onFlush || (() => {});
    this.pendingByTap = new Map();
    this.timer = null;
    this.latestTimestamp = null;
  }

  enqueue({ tapId, changes, timestamp }) {
    if (!Number.isInteger(tapId) || !changes || Object.keys(changes).length === 0) return false;
    const pending = this.pendingByTap.get(tapId) || {};
    Object.assign(pending, changes);
    this.pendingByTap.set(tapId, pending);
    this.latestTimestamp = Math.max(this.latestTimestamp ?? -Infinity, Number.isFinite(timestamp) ? timestamp : this.now());
    if (this.timer === null) this.timer = this.setTimeoutFn(() => this.flush(), this.delayMs);
    return true;
  }

  flush() {
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    if (this.pendingByTap.size === 0) return null;
    const payload = {
      timestamp: new Date(this.latestTimestamp ?? this.now()).toISOString(),
      taps: [...this.pendingByTap.entries()]
        .sort(([left], [right]) => left - right)
        .map(([tapId, changes]) => ({ tapId, changes }))
    };
    this.pendingByTap.clear();
    this.latestTimestamp = null;
    this.onFlush(payload);
    return payload;
  }

  dispose() {
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.pendingByTap.clear();
    this.latestTimestamp = null;
  }
}
