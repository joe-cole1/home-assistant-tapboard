import { BREWFATHER_STATUSES } from './brewfatherClient.js';
import {
  detailCandidates,
  latestReadingCandidates,
  markBatchError,
  upsertDetail,
  upsertReadings,
  upsertSummaries
} from './brewfatherCache.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const INITIAL_BACKOFF_MS = 5 * 60 * 1_000;
const MAX_BACKOFF_MS = 30 * 60 * 1_000;
const ERROR_CATEGORIES = new Set([
  'configuration',
  'auth',
  'forbidden',
  'rate_limited',
  'timeout',
  'network',
  'transient',
  'response_too_large',
  'invalid_response',
  'not_found',
  'unknown'
]);

function iso(now) {
  return new Date(now()).toISOString();
}

function category(error) {
  return ERROR_CATEGORIES.has(error?.category) ? error.category : 'unknown';
}

function requestCount(client) {
  return client?.getBudgetStatus?.().used ?? 0;
}

function retryAt(failures, now) {
  const delay = failures.reduce((maximum, failure) => Math.max(maximum, failure?.error?.retryAfter ?? 0), 0);
  return delay > 0 ? new Date(now() + delay).toISOString() : null;
}

function validateDetail(detail, batchId) {
  const remoteId = detail?._id ?? detail?.id;
  if (
    !detail ||
    typeof detail !== 'object' ||
    Array.isArray(detail) ||
    typeof remoteId !== 'string' ||
    remoteId !== batchId
  ) {
    throw Object.assign(new Error('Brewfather batch detail was invalid'), { category: 'invalid_response' });
  }
  return detail;
}

export class BrewfatherSyncCoordinator {
  constructor({
    db,
    client = null,
    now = () => Date.now(),
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
    intervalMs = SIX_HOURS_MS,
    detailLimit = 12,
    latestReadingLimit = 12,
    onUpdate = () => {},
    onFailure = () => {},
    logger = console
  } = {}) {
    if (!db) throw new TypeError('Brewfather sync requires a database');
    this.db = db;
    this.client = client;
    this.now = now;
    this.setTimeout = schedule;
    this.clearTimeout = cancel;
    this.intervalMs = Math.max(intervalMs, 60_000);
    this.detailLimit = Math.min(Math.max(detailLimit, 1), 12);
    this.latestReadingLimit = Math.min(Math.max(latestReadingLimit, 1), 12);
    this.onUpdate = onUpdate;
    this.onFailure = onFailure;
    this.logger = logger;
    this.inFlight = null;
    this.timer = null;
    this.started = false;
    this.stopped = false;
    this.backoffMs = INITIAL_BACKOFF_MS;
    const previous = this.db.prepare('SELECT status, error_category FROM brewfather_sync_state WHERE id = 1').get();
    this.failureCategory =
      ['failed', 'stale_cache'].includes(previous?.status) &&
      category({ category: previous.error_category }) !== 'configuration'
        ? category({ category: previous.error_category })
        : null;
  }

  start() {
    if (this.started || this.stopped) return false;
    this.started = true;
    const startup = this.refresh({ reason: 'startup' });
    this.#scheduleAfter(startup.promise);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
    return this.inFlight;
  }

  refresh({ reason = 'manual' } = {}) {
    if (this.stopped) {
      return {
        requestStatus: 'stopped',
        promise: Promise.resolve({ outcome: 'failed', errorCategory: 'configuration', reason })
      };
    }
    if (this.inFlight) return { requestStatus: 'coalesced', promise: this.inFlight };
    const before = requestCount(this.client);
    this.inFlight = this.#run(reason, before).finally(() => {
      this.inFlight = null;
    });
    return { requestStatus: 'started', promise: this.inFlight };
  }

  #scheduleAfter(promise) {
    promise.then((result) => {
      if (this.stopped) return;
      const failed = result.outcome !== 'succeeded';
      const delay =
        result.errorCategory === 'configuration' ? this.intervalMs : failed ? this.backoffMs : this.intervalMs;
      this.backoffMs = failed ? Math.min(this.backoffMs * 2, MAX_BACKOFF_MS) : INITIAL_BACKOFF_MS;
      this.timer = this.setTimeout(() => {
        this.timer = null;
        const scheduled = this.refresh({ reason: 'scheduled' });
        this.#scheduleAfter(scheduled.promise);
      }, delay);
      this.timer?.unref?.();
    });
  }

  #updateState(fields) {
    const allowed = [
      'last_attempt_at',
      'last_success_at',
      'status',
      'error_category',
      'retry_at',
      'freshness_at',
      'last_cycle_requests',
      'last_cycle_batches'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
    this.db
      .prepare(`UPDATE brewfather_sync_state SET ${assignments}, updated_at = ? WHERE id = 1`)
      .run(...entries.map(([, value]) => value), iso(this.now));
  }

  #hasCache() {
    return Boolean(this.db.prepare('SELECT 1 FROM batches LIMIT 1').get());
  }

  #notify(result) {
    try {
      this.onUpdate(result);
    } catch (error) {
      console.warn('[Brewfather sync] Update notification failed:', error?.message || 'unknown error');
    }
  }

  #notifyFailure(result) {
    if (result.outcome !== 'failed' && result.outcome !== 'stale_cache') return;
    if (result.errorCategory === 'configuration') {
      this.failureCategory = null;
      return;
    }
    if (this.failureCategory === result.errorCategory) return;
    this.failureCategory = result.errorCategory;
    try {
      const pending = this.onFailure(result);
      pending?.catch?.(() => {});
    } catch {
      // Failure notifications are best effort and must not affect sync outcomes.
    }
  }

  #logCycleFailure({ reason, outcome, errorCategory, summaries, requestCount, retryAt: retryTimestamp }) {
    const entry = {
      event: 'brewfather_sync_cycle_failed',
      reason: ['manual', 'startup', 'scheduled'].includes(reason) ? reason : 'manual',
      outcome: outcome === 'stale_cache' ? 'stale_cache' : 'failed',
      errorCategory: category({ category: errorCategory }),
      summaryCount: Number.isSafeInteger(summaries) && summaries >= 0 ? summaries : 0,
      requestCount: Number.isSafeInteger(requestCount) && requestCount >= 0 ? requestCount : 0
    };
    if (typeof retryTimestamp === 'string') entry.retryAt = retryTimestamp;

    try {
      const pending = this.logger?.error?.(JSON.stringify(entry));
      pending?.catch?.(() => {});
    } catch {
      // Logging must not change the outcome of a synchronization cycle.
    }
  }

  async #run(reason, requestsBefore) {
    const attemptedAt = iso(this.now);
    this.#updateState({
      status: this.client ? 'running' : 'not_configured',
      last_attempt_at: attemptedAt,
      error_category: this.client ? null : 'configuration',
      retry_at: null
    });
    if (!this.client) {
      this.failureCategory = null;
      const result = {
        outcome: this.#hasCache() ? 'stale_cache' : 'failed',
        errorCategory: 'configuration',
        reason,
        summaries: 0,
        requestCount: 0
      };
      this.#notify(result);
      return result;
    }

    try {
      const result = await this.client.listBatchesByStatuses(BREWFATHER_STATUSES);
      if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', reason };
      const batches = Array.isArray(result?.batches) ? result.batches : [];
      const failures = Array.isArray(result?.failures) ? result.failures : [];
      const summaryResult = upsertSummaries(this.db, batches, {
        now: this.now,
        complete: failures.length === 0
      });
      const secondaryFailures = [];

      for (const batchId of detailCandidates(this.db, summaryResult.changedIds, this.detailLimit)) {
        if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', reason };
        try {
          const detail = validateDetail(await this.client.getBatch(batchId), batchId);
          if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', reason };
          upsertDetail(this.db, batchId, detail, { now: this.now });
        } catch (error) {
          const errorCategory = category(error);
          markBatchError(this.db, batchId, errorCategory, iso(this.now));
          secondaryFailures.push({ error: { category: errorCategory, retryAfter: error?.retryAfter ?? null } });
        }
      }

      for (const batchId of latestReadingCandidates(this.db, this.latestReadingLimit)) {
        if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', reason };
        try {
          const reading = await this.client.getLatestReading(batchId);
          if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', reason };
          if (reading) upsertReadings(this.db, batchId, [reading], { maxPerWrite: 1 });
        } catch (error) {
          if (error?.category === 'not_found') continue;
          const errorCategory = category(error);
          markBatchError(this.db, batchId, errorCategory, iso(this.now));
          secondaryFailures.push({ error: { category: errorCategory, retryAfter: error?.retryAfter ?? null } });
        }
      }

      const allFailures = [...failures, ...secondaryFailures];
      const completedAt = iso(this.now);
      const requestsUsed = Math.max(0, requestCount(this.client) - requestsBefore);
      if (allFailures.length === 0) {
        this.#updateState({
          status: 'ok',
          last_success_at: completedAt,
          freshness_at: completedAt,
          error_category: null,
          retry_at: null,
          last_cycle_requests: requestsUsed,
          last_cycle_batches: summaryResult.rows.length
        });
        const success = {
          outcome: 'succeeded',
          errorCategory: null,
          reason,
          summaries: summaryResult.rows.length,
          requestCount: requestsUsed
        };
        this.failureCategory = null;
        this.#notify(success);
        return success;
      }

      const errorCategory = category(allFailures[0]?.error);
      const retryTimestamp = retryAt(allFailures, this.now);
      const stale = {
        outcome: this.#hasCache() ? 'stale_cache' : 'failed',
        errorCategory,
        reason,
        summaries: summaryResult.rows.length,
        requestCount: requestsUsed
      };
      this.#updateState({
        status: this.#hasCache() ? 'stale_cache' : 'failed',
        error_category: errorCategory,
        retry_at: retryTimestamp,
        last_cycle_requests: requestsUsed,
        last_cycle_batches: summaryResult.rows.length
      });
      this.#logCycleFailure({ ...stale, retryAt: retryTimestamp });
      this.#notifyFailure(retryTimestamp ? { ...stale, retryAt: retryTimestamp } : stale);
      this.#notify(stale);
      return stale;
    } catch (error) {
      if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', reason };
      const errorCategory = category(error);
      const requestsUsed = Math.max(0, requestCount(this.client) - requestsBefore);
      const retryTimestamp = error?.retryAfter ? new Date(this.now() + error.retryAfter).toISOString() : null;
      const failed = {
        outcome: this.#hasCache() ? 'stale_cache' : 'failed',
        errorCategory,
        reason,
        summaries: 0,
        requestCount: requestsUsed
      };
      this.#updateState({
        status: this.#hasCache() ? 'stale_cache' : 'failed',
        error_category: errorCategory,
        retry_at: retryTimestamp,
        last_cycle_requests: requestsUsed,
        last_cycle_batches: 0
      });
      this.#logCycleFailure({ ...failed, retryAt: retryTimestamp });
      this.#notifyFailure(retryTimestamp ? { ...failed, retryAt: retryTimestamp } : failed);
      this.#notify(failed);
      return failed;
    }
  }

  async loadHistory(batchId, { maxReadings = 1_000 } = {}) {
    if (!this.client || this.stopped) {
      return { outcome: 'failed', errorCategory: 'configuration', readings: 0 };
    }
    const rows = await this.client.getReadings(batchId);
    if (this.stopped) return { outcome: 'failed', errorCategory: 'configuration', readings: 0 };
    const cached = upsertReadings(this.db, batchId, rows, {
      maxPerWrite: Math.min(Math.max(Number(maxReadings) || 1, 1), 1_000)
    });
    return { outcome: 'succeeded', errorCategory: null, readings: cached.length };
  }
}

export { BrewfatherSyncCoordinator as BrewfatherSync };
