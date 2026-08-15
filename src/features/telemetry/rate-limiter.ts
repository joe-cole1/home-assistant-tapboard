import type { TelemetryRateLimiter } from "./types.ts";

interface BucketState {
  tokens: number;
  lastRefillTimeMs: number;
}

export class InMemoryTelemetryRateLimiter implements TelemetryRateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  consume(
    sourceId: string,
    count: number,
    nowMs: number,
    settings: {
      readonly rateLimitSamplesPerMinute: number;
      readonly rateLimitBurstSamples: number;
    },
  ): boolean {
    if (count <= 0) {
      return true;
    }

    const burstCapacity = settings.rateLimitBurstSamples;
    const refillRatePerMs = settings.rateLimitSamplesPerMinute / 60_000;

    let state = this.buckets.get(sourceId);
    if (!state) {
      state = {
        tokens: burstCapacity,
        lastRefillTimeMs: nowMs,
      };
      this.buckets.set(sourceId, state);
    } else {
      // Wall-clock time can move backwards (for example after NTP correction).
      // Keep the bucket's effective clock monotonic so a later forward jump
      // cannot refill the interval that was already accounted for.
      const effectiveNowMs = Math.max(nowMs, state.lastRefillTimeMs);
      const elapsedMs = effectiveNowMs - state.lastRefillTimeMs;
      state.tokens = Math.min(burstCapacity, state.tokens + elapsedMs * refillRatePerMs);
      state.lastRefillTimeMs = effectiveNowMs;
    }

    if (state.tokens >= count) {
      state.tokens -= count;
      return true;
    }

    return false;
  }

  reset(sourceId?: string): void {
    if (sourceId !== undefined) {
      this.buckets.delete(sourceId);
    } else {
      this.buckets.clear();
    }
  }
}
