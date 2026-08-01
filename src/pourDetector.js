// Pure, timestamp-driven pour detector.  It deliberately has no HA or DB
// dependencies so recorded traces can be replayed with a fake clock.

export const DEFAULT_DETECTOR_CONFIG = Object.freeze({
  candidateLossOz: 0.8,
  candidateSamples: 3,
  candidateSampleWindowMs: 400,
  candidateLookbackMs: 3000,
  arbitrationMs: 400,
  arbitrationMinimumOz: 0.5,
  arbitrationDominanceRatio: 1.5,
  meaningfulFlowOz: 0.2,
  quietPeriodMs: 5000,
  hardSessionMs: 15000,
  minimumPourOz: 1.0,
  spikeOz: 30,
  largeChangeStableSamples: 5,
  largeChangeStableSpanMs: 3000,
  largeChangeBandOz: 0.5,
  baselineSamples: 5,
  baselineSpanMs: 800,
  baselineBandOz: 0.3,
  settledSamples: 5,
  settledSpanMs: 800,
  settledBandOz: 0.3,
  cooldownMs: 5000,
  historyMs: 6000
});

const UNIT_TO_OZ = new Map([
  ['oz', 1],
  ['fl oz', 1],
  ['fl. oz', 1],
  ['fl. oz.', 1],
  ['fl oz.', 1],
  ['fl_oz', 1],
  ['floz', 1],
  ['fluid ounce', 1],
  ['fluid ounces', 1],
  ['ml', 1 / 29.5735295625],
  ['milliliter', 1 / 29.5735295625],
  ['milliliters', 1 / 29.5735295625],
  ['millilitre', 1 / 29.5735295625],
  ['millilitres', 1 / 29.5735295625]
]);

export function normalizeVolumeToOz(value, unit) {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number) || typeof unit !== 'string') return null;
  const factor = UNIT_TO_OZ.get(unit.trim().toLowerCase());
  return factor === undefined ? null : number * factor;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Events are { type: 'start'|'complete'|'cancel', tapId, ... }.  `now`,
 * `setTimeout`, and `clearTimeout` are injectable; explicit timestamps make
 * normal trace replay independent of wall-clock time.
 */
export class PourDetector {
  constructor({
    now = () => Date.now(),
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
    onEvent = () => {},
    config = {}
  } = {}) {
    this.now = now;
    this.setTimeout = schedule;
    this.clearTimeout = cancel;
    this.onEvent = onEvent;
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
    this.taps = new Map();
    this.activeTapId = null;
    this.arbitrationTimer = null;
    this.arbitrationDeadline = null;
  }

  stateFor(tapId) {
    if (!this.taps.has(tapId)) {
      this.taps.set(tapId, {
        samples: [],
        baseline: null,
        baselineAt: 0,
        candidate: null,
        active: null,
        cooldownUntil: 0,
        needsRebaseline: false,
        largeChange: null
      });
    }
    return this.taps.get(tapId);
  }

  hydrate(tapId, volumeOz, timestamp = this.now()) {
    if (!Number.isFinite(volumeOz)) return false;
    const state = this.stateFor(tapId);
    if (state.samples.length && timestamp <= state.samples[state.samples.length - 1].timestamp) return false;
    if (state.active) this.clearActive(state);
    state.samples = [{ volumeOz, timestamp }];
    state.baseline = volumeOz;
    state.baselineAt = timestamp;
    state.candidate = null;
    state.active = null;
    state.cooldownUntil = 0;
    state.needsRebaseline = false;
    state.largeChange = null;
    return true;
  }

  ingest(tapId, volumeOz, timestamp = this.now()) {
    if (!Number.isFinite(volumeOz)) return false;
    const state = this.stateFor(tapId);
    const last = state.samples.at(-1);
    if (last && timestamp <= last.timestamp) return false; // stale and duplicate telemetry fail closed
    if (!last) return this.hydrate(tapId, volumeOz, timestamp);

    const delta = volumeOz - last.volumeOz;
    this.advance(timestamp);
    state.samples.push({ volumeOz, timestamp });
    state.samples = state.samples.filter((sample) => sample.timestamp >= timestamp - this.config.historyMs);

    if (Math.abs(delta) > this.config.spikeOz) {
      this.trackLargeChange(tapId, volumeOz, timestamp);
      return false;
    }
    if (state.largeChange) {
      this.trackLargeChange(tapId, volumeOz, timestamp);
      return false;
    }

    if (state.active) {
      const robustVolume = median(state.samples.slice(-3).map((sample) => sample.volumeOz));
      if (robustVolume <= state.active.lowestFlowVolume - this.config.meaningfulFlowOz) {
        state.active.lowestFlowVolume = robustVolume;
        state.active.lastMeaningfulFlowAt = timestamp;
        this.scheduleActiveTimers(tapId, state.active);
      }
      return true;
    }

    if (timestamp < state.cooldownUntil || this.activeTapId !== null) return true;
    if (state.needsRebaseline) {
      this.rebaselineIfSettled(state, timestamp);
      return true;
    }
    this.refreshBaseline(state, volumeOz, timestamp);
    this.considerCandidate(tapId, timestamp);
    return true;
  }

  // Aliases keep callers/tests readable without coupling them to HA naming.
  addSample(tapId, volumeOz, timestamp) {
    return this.ingest(tapId, volumeOz, timestamp);
  }
  ingestSample(tapId, volumeOz, timestamp) {
    return this.ingest(tapId, volumeOz, timestamp);
  }

  advance(timestamp = this.now()) {
    for (const [tapId, state] of this.taps) {
      if (state.active) {
        // A quiet completed pour wins over hard cancellation at a shared deadline.
        if (timestamp >= state.active.lastMeaningfulFlowAt + this.config.quietPeriodMs)
          this.finishActive(tapId, timestamp);
        if (state.active && timestamp >= state.active.startedAt + this.config.hardSessionMs)
          this.cancelActive(tapId, 'timeout', timestamp);
      }
    }
    this.resolveArbitration(timestamp);
  }

  reset(reason = 'reset') {
    if (this.arbitrationTimer) this.clearTimeout(this.arbitrationTimer);
    this.arbitrationTimer = null;
    this.arbitrationDeadline = null;
    const at = this.now();
    for (const [tapId, state] of this.taps) {
      if (state.active) this.cancelActive(tapId, reason, at);
      state.candidate = null;
      state.largeChange = null;
    }
    this.activeTapId = null;
  }

  refreshBaseline(state, volumeOz, timestamp) {
    // Only a settled plateau can move an idle baseline. A steady decline
    // therefore remains measured against the last quiet level.
    const quiet = state.samples.slice(-this.config.baselineSamples);
    if (quiet.length !== this.config.baselineSamples) return;
    if (quiet.at(-1).timestamp - quiet[0].timestamp < this.config.baselineSpanMs) return;
    const values = quiet.map((sample) => sample.volumeOz);
    if (Math.max(...values) - Math.min(...values) > this.config.baselineBandOz) return;
    state.baseline = median(values);
    state.baselineAt = timestamp;
  }

  considerCandidate(tapId, timestamp) {
    const state = this.stateFor(tapId);
    const recent = state.samples.filter(
      (sample) => sample.timestamp >= timestamp - this.config.candidateSampleWindowMs
    );
    if (
      recent.length < this.config.candidateSamples ||
      state.baseline === null ||
      timestamp - state.baselineAt > this.config.candidateLookbackMs
    )
      return;
    const sustained = median(recent.map((sample) => sample.volumeOz));
    const loss = state.baseline - sustained;
    if (loss < this.config.candidateLossOz) return;
    state.candidate = { baseline: state.baseline, loss, at: timestamp };
    if (!this.arbitrationTimer) {
      this.arbitrationDeadline = timestamp + this.config.arbitrationMs;
      this.arbitrationTimer = this.setTimeout(() => this.resolveArbitration(this.now()), this.config.arbitrationMs);
    }
  }

  resolveArbitration(timestamp = this.now()) {
    if (this.arbitrationDeadline !== null && timestamp < this.arbitrationDeadline) return;
    const candidates = [];
    for (const [tapId, state] of this.taps) {
      if (
        state.candidate &&
        timestamp - state.candidate.at <= this.config.arbitrationMs + this.config.candidateSampleWindowMs
      ) {
        candidates.push({ tapId, ...state.candidate });
      } else if (
        state.candidate &&
        timestamp - state.candidate.at > this.config.arbitrationMs + this.config.candidateSampleWindowMs
      ) {
        state.candidate = null;
      }
    }
    if (!candidates.length || this.activeTapId !== null) {
      if (!candidates.length) {
        this.arbitrationTimer = null;
        this.arbitrationDeadline = null;
      }
      return;
    }
    candidates.sort((a, b) => b.loss - a.loss);
    const winner = candidates[0];
    const runner = candidates[1];
    if (
      winner.loss < this.config.arbitrationMinimumOz ||
      (runner &&
        (winner.loss - runner.loss < this.config.arbitrationMinimumOz ||
          winner.loss < runner.loss * this.config.arbitrationDominanceRatio))
    ) {
      for (const candidate of candidates) this.suppressCandidate(candidate.tapId, timestamp);
      this.arbitrationTimer = null;
      this.arbitrationDeadline = null;
      return;
    }
    this.startActive(winner.tapId, winner, timestamp);
    for (const candidate of candidates.slice(1)) this.suppressCandidate(candidate.tapId, timestamp);
    this.arbitrationTimer = null;
    this.arbitrationDeadline = null;
  }

  suppressCandidate(tapId, timestamp) {
    const state = this.stateFor(tapId);
    state.candidate = null;
    state.cooldownUntil = timestamp + this.config.cooldownMs;
    state.needsRebaseline = true;
  }

  startActive(tapId, candidate, timestamp) {
    const state = this.stateFor(tapId);
    state.candidate = null;
    state.active = {
      startedAt: timestamp,
      lastMeaningfulFlowAt: timestamp,
      startBaseline: candidate.baseline,
      lowestFlowVolume: median(state.samples.slice(-3).map((sample) => sample.volumeOz)),
      quietTimer: null,
      hardTimer: null
    };
    this.activeTapId = tapId;
    this.emit({ type: 'start', tapId, startVolume: candidate.baseline, timestamp });
    this.scheduleActiveTimers(tapId, state.active);
  }

  scheduleActiveTimers(tapId, active) {
    if (active.quietTimer) this.clearTimeout(active.quietTimer);
    if (active.hardTimer) this.clearTimeout(active.hardTimer);
    const now = this.now();
    active.quietTimer = this.setTimeout(
      () => this.advance(this.now()),
      Math.max(0, active.lastMeaningfulFlowAt + this.config.quietPeriodMs - now)
    );
    active.hardTimer = this.setTimeout(
      () => this.advance(this.now()),
      Math.max(0, active.startedAt + this.config.hardSessionMs - now)
    );
  }

  finishActive(tapId, timestamp) {
    const state = this.stateFor(tapId);
    const active = state.active;
    if (!active) return;
    const endSamples = state.samples.slice(-this.config.settledSamples);
    const settledEnough =
      endSamples.length === this.config.settledSamples &&
      endSamples.at(-1).timestamp - endSamples[0].timestamp >= this.config.settledSpanMs &&
      Math.max(...endSamples.map((sample) => sample.volumeOz)) -
        Math.min(...endSamples.map((sample) => sample.volumeOz)) <=
        this.config.settledBandOz;
    if (!settledEnough) {
      active.quietTimer = this.setTimeout(() => this.advance(this.now()), 200);
      return;
    }
    const settled = median(endSamples.map((sample) => sample.volumeOz));
    const volumePouredOz = Math.max(0, Math.round((active.startBaseline - settled) * 10) / 10);
    this.clearActive(state);
    if (volumePouredOz < this.config.minimumPourOz) {
      this.requireRebaselineForAll(timestamp);
      this.emit({ type: 'cancel', tapId, reason: 'rebound', volumePouredOz, timestamp });
      return;
    }
    this.requireRebaselineForAll(timestamp);
    this.emit({
      type: 'complete',
      tapId,
      startVolume: active.startBaseline,
      endVolume: settled,
      volumePouredOz,
      timestamp
    });
  }

  cancelActive(tapId, reason, timestamp = this.now()) {
    const state = this.stateFor(tapId);
    if (!state.active) return;
    this.clearActive(state);
    this.requireRebaselineForAll(timestamp);
    this.emit({ type: 'cancel', tapId, reason, timestamp });
  }

  clearActive(state) {
    if (state.active?.quietTimer) this.clearTimeout(state.active.quietTimer);
    if (state.active?.hardTimer) this.clearTimeout(state.active.hardTimer);
    state.active = null;
    this.activeTapId = null;
  }

  trackLargeChange(tapId, volumeOz, timestamp) {
    const state = this.stateFor(tapId);
    if (state.baseline !== null && Math.abs(volumeOz - state.baseline) <= this.config.spikeOz) {
      // The reading returned to the prior plateau: the large value was a spike.
      state.samples = [{ volumeOz, timestamp }];
      state.largeChange = null;
      return;
    }

    let change = state.largeChange || { samples: [] };
    const priorValues = change.samples.map((sample) => sample.volumeOz);
    if (priorValues.length && Math.abs(volumeOz - median(priorValues)) > this.config.largeChangeBandOz) {
      change = { samples: [] };
    }
    change.samples.push({ volumeOz, timestamp });
    state.largeChange = change;
    const values = change.samples.map((sample) => sample.volumeOz);
    const stableSpan = timestamp - change.samples[0].timestamp;
    if (
      change.samples.length >= this.config.largeChangeStableSamples &&
      stableSpan >= this.config.largeChangeStableSpanMs &&
      Math.max(...values) - Math.min(...values) <= this.config.largeChangeBandOz
    ) {
      // `ingest` has already recorded this sample, so do the silent hydration
      // inline rather than rejecting it as an out-of-order duplicate.
      const baseline = median(values);
      if (state.active) this.cancelActive(tapId, 'large_change', timestamp);
      state.samples = [{ volumeOz: baseline, timestamp }];
      state.baseline = baseline;
      state.baselineAt = timestamp;
      state.candidate = null;
      state.largeChange = null;
      state.needsRebaseline = false;
    }
  }

  requireRebaselineForAll(timestamp) {
    for (const state of this.taps.values()) {
      state.cooldownUntil = timestamp + this.config.cooldownMs;
      state.needsRebaseline = true;
      state.candidate = null;
    }
  }

  rebaselineIfSettled(state, timestamp) {
    const samples = state.samples.slice(-this.config.baselineSamples);
    if (samples.length !== this.config.baselineSamples) return false;
    if (samples.at(-1).timestamp - samples[0].timestamp < this.config.baselineSpanMs) return false;
    const values = samples.map((sample) => sample.volumeOz);
    if (Math.max(...values) - Math.min(...values) > this.config.baselineBandOz) return false;
    state.baseline = median(values);
    state.baselineAt = timestamp;
    state.needsRebaseline = false;
    return true;
  }

  emit(event) {
    this.onEvent(event);
  }
}
