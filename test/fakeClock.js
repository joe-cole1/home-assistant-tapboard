/** A deterministic clock suitable for detectors that inject timer functions. */
export class FakeClock {
  #now;
  #nextId = 1;
  #timers = new Map();

  constructor(start = 0) {
    this.#now = start;
  }

  now = () => this.#now;

  setTimeout = (callback, delay = 0) => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delay, callback });
    return id;
  };

  clearTimeout = (id) => this.#timers.delete(id);

  advanceBy(milliseconds) {
    return this.advanceTo(this.#now + milliseconds);
  }

  advanceTo(target) {
    if (target < this.#now) throw new RangeError('FakeClock cannot move backwards');
    while (true) {
      let nextId;
      let next;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && id < nextId))) {
          nextId = id;
          next = timer;
        }
      }
      if (!next) break;
      this.#timers.delete(nextId);
      this.#now = next.at;
      next.callback();
    }
    this.#now = target;
  }
}
