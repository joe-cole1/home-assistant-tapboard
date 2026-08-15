import type { DetectorConfig } from "./detector-config.ts";
export type DetectorPhase =
  "waiting_for_measurement" | "ready" | "candidate" | "pouring" | "cooldown" | "warning" | "closed";
export interface DetectorSample {
  readonly volumeMl: number;
  readonly atMs: number;
}
export interface DetectorRuntimeState {
  readonly phase: DetectorPhase;
  readonly tapId?: string;
  readonly baselineVolumeMl: number | null;
  readonly baselineAtMs: number | null;
  readonly lastMeasuredAtMs: number | null;
  readonly lastInterpretedVolumeMl: number | null;
  readonly lastStabilizedVolumeMl: number | null;
  readonly candidateSessionId: string | null;
  readonly candidateStartedAtMs: number | null;
  readonly candidateBaselineVolumeMl: number | null;
  readonly candidateLossMl: number | null;
  readonly arbitrationDeadlineMs: number | null;
  readonly lowestFlowVolumeMl: number | null;
  readonly lastMeaningfulFlowAtMs: number | null;
  readonly quietSinceMs: number | null;
  readonly timeoutAtMs: number | null;
  readonly cooldownUntilMs: number | null;
  readonly warningCode: "implausible_jump" | null;
  readonly warningActivityFlag: boolean;
  readonly warningStartedAtMs: number | null;
  readonly warningReferenceVolumeMl: number | null;
  readonly lastCancellationReason: "rebound" | "timeout" | "jump" | "arbitration" | null;
}
export type DetectorEffect =
  | { readonly type: "baseline_established"; readonly volumeMl: number }
  | { readonly type: "warning_opened"; readonly code: "implausible_jump" }
  | { readonly type: "warning_cleared"; readonly volumeMl: number }
  | { readonly type: "candidate_started"; readonly sessionId: string; readonly lossMl: number }
  | { readonly type: "candidate_updated"; readonly sessionId: string; readonly lossMl: number }
  | { readonly type: "candidate_activated"; readonly sessionId: string }
  | {
      readonly type: "candidate_cancelled";
      readonly sessionId: string;
      readonly reason: "rebound" | "timeout" | "jump" | "arbitration";
    }
  | {
      readonly type: "pour_completed";
      readonly sessionId: string;
      readonly volumeMl: number;
      readonly startedAtMs: number;
      readonly completedAtMs: number;
    };
export interface DetectorTransition {
  readonly state: DetectorRuntimeState;
  readonly effects: readonly DetectorEffect[];
}
export const waitingDetectorState = (): DetectorRuntimeState => ({
  phase: "waiting_for_measurement",
  baselineVolumeMl: null,
  baselineAtMs: null,
  lastMeasuredAtMs: null,
  lastInterpretedVolumeMl: null,
  lastStabilizedVolumeMl: null,
  candidateSessionId: null,
  candidateStartedAtMs: null,
  candidateBaselineVolumeMl: null,
  candidateLossMl: null,
  arbitrationDeadlineMs: null,
  lowestFlowVolumeMl: null,
  lastMeaningfulFlowAtMs: null,
  quietSinceMs: null,
  timeoutAtMs: null,
  cooldownUntilMs: null,
  warningCode: null,
  warningActivityFlag: false,
  warningStartedAtMs: null,
  warningReferenceVolumeMl: null,
  lastCancellationReason: null,
});
function med(v: readonly number[]) {
  const x = [...v].sort((a, b) => a - b),
    m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m]! : (x[m - 1]! + x[m]!) / 2;
}
function last(h: readonly DetectorSample[], n: number) {
  return [...h].sort((a, b) => a.atMs - b.atMs).slice(-n);
}
function flat(h: readonly DetectorSample[], n: number, span: number, band: number) {
  const x = last(h, n);
  if (x.length !== n || x[n - 1]!.atMs - x[0]!.atMs < span) return null;
  const v = x.map((s) => s.volumeMl);
  return Math.max(...v) - Math.min(...v) <= band ? med(v) : null;
}
function cooldown(
  s: DetectorRuntimeState,
  c: DetectorConfig,
  at: number,
  r: DetectorRuntimeState["lastCancellationReason"],
): DetectorRuntimeState {
  return {
    ...s,
    phase: "cooldown",
    candidateSessionId: null,
    candidateStartedAtMs: null,
    candidateBaselineVolumeMl: null,
    candidateLossMl: null,
    arbitrationDeadlineMs: null,
    lowestFlowVolumeMl: null,
    lastMeaningfulFlowAtMs: null,
    quietSinceMs: null,
    timeoutAtMs: null,
    cooldownUntilMs: at + c.cooldownMs,
    lastCancellationReason: r,
  };
}
export function suppressCandidate(
  s: DetectorRuntimeState,
  c: DetectorConfig,
  at: number,
  reason: "rebound" | "timeout" | "jump" | "arbitration",
): DetectorTransition {
  const id = s.candidateSessionId;
  return {
    state: cooldown(s, c, at, reason),
    effects: id ? [{ type: "candidate_cancelled", sessionId: id, reason }] : [],
  };
}
export function reduceDetector(
  p: DetectorRuntimeState,
  cur: DetectorSample,
  history: readonly DetectorSample[],
  c: DetectorConfig,
  id: string,
): DetectorTransition {
  const h = history.filter((x) => x.atMs <= cur.atMs).sort((a, b) => a.atMs - b.atMs);
  let s: DetectorRuntimeState = {
    ...p,
    lastMeasuredAtMs: cur.atMs,
    lastInterpretedVolumeMl: cur.volumeMl,
  };
  const effects: DetectorEffect[] = [];
  if (s.phase === "closed") return { state: s, effects };
  if (s.phase === "waiting_for_measurement") {
    const v = flat(h, c.baselineSamples, c.baselineSpanMs, c.baselineBandMl);
    return v === null
      ? { state: s, effects }
      : {
          state: {
            ...s,
            phase: "ready",
            baselineVolumeMl: v,
            baselineAtMs: cur.atMs,
            lastStabilizedVolumeMl: v,
          },
          effects: [{ type: "baseline_established", volumeMl: v }],
        };
  }
  if (
    s.phase !== "warning" &&
    p.lastInterpretedVolumeMl !== null &&
    Math.abs(cur.volumeMl - p.lastInterpretedVolumeMl) > c.implausibleJumpMl
  ) {
    if (s.candidateSessionId)
      effects.push({
        type: "candidate_cancelled",
        sessionId: s.candidateSessionId,
        reason: "jump",
      });
    return {
      state: {
        ...cooldown(s, c, cur.atMs, "jump"),
        phase: "warning",
        cooldownUntilMs: null,
        warningCode: "implausible_jump",
        warningActivityFlag: true,
        warningStartedAtMs: cur.atMs,
        warningReferenceVolumeMl: p.lastInterpretedVolumeMl,
      },
      effects: [...effects, { type: "warning_opened", code: "implausible_jump" }],
    };
  }
  if (s.phase === "warning") {
    const reference = s.warningReferenceVolumeMl ?? s.baselineVolumeMl;
    if (reference !== null && Math.abs(cur.volumeMl - reference) <= c.jumpBandMl)
      return {
        state: {
          ...s,
          phase: "ready",
          cooldownUntilMs: null,
          lastCancellationReason: null,
          warningCode: null,
          warningActivityFlag: false,
          warningStartedAtMs: null,
          warningReferenceVolumeMl: null,
        },
        effects: [{ type: "warning_cleared", volumeMl: s.baselineVolumeMl ?? reference }],
      };
    const v = flat(
      h.filter((x) => x.atMs >= (s.warningStartedAtMs ?? cur.atMs)),
      c.jumpStableSamples,
      c.jumpStableSpanMs,
      c.jumpBandMl,
    );
    return v === null
      ? { state: s, effects }
      : {
          state: {
            ...s,
            phase: "ready",
            baselineVolumeMl: v,
            baselineAtMs: cur.atMs,
            lastStabilizedVolumeMl: v,
            cooldownUntilMs: null,
            lastCancellationReason: null,
            warningCode: null,
            warningActivityFlag: false,
            warningStartedAtMs: null,
            warningReferenceVolumeMl: null,
          },
          effects: [
            { type: "baseline_established", volumeMl: v },
            { type: "warning_cleared", volumeMl: v },
          ],
        };
  }
  if (s.phase === "cooldown") {
    const cooldownUntilMs = s.cooldownUntilMs;
    if (cooldownUntilMs === null || cur.atMs < cooldownUntilMs) return { state: s, effects };
    const fresh = h.filter((x) => x.atMs >= cooldownUntilMs),
      v = flat(fresh, c.baselineSamples, c.baselineSpanMs, c.baselineBandMl);
    return v === null
      ? { state: s, effects }
      : {
          state: {
            ...s,
            phase: "ready",
            cooldownUntilMs: null,
            baselineVolumeMl: v,
            baselineAtMs: cur.atMs,
            lastStabilizedVolumeMl: v,
            lastCancellationReason: null,
          },
          effects: [{ type: "baseline_established", volumeMl: v }],
        };
  }
  const base = flat(h, c.baselineSamples, c.baselineSpanMs, c.baselineBandMl);
  if (s.phase === "ready") {
    if (base !== null)
      s = { ...s, baselineVolumeMl: base, baselineAtMs: cur.atMs, lastStabilizedVolumeMl: base };
    const samples = h.filter((x) => x.atMs >= cur.atMs - c.candidateSampleWindowMs),
      v = samples.length >= c.candidateSamples ? med(samples.map((x) => x.volumeMl)) : null,
      loss =
        v === null ||
        s.baselineVolumeMl === null ||
        s.baselineAtMs === null ||
        cur.atMs - s.baselineAtMs > c.candidateLookbackMs
          ? 0
          : s.baselineVolumeMl - v;
    if (loss < c.candidateLossMl) return { state: s, effects };
    return {
      state: {
        ...s,
        phase: "candidate",
        candidateSessionId: id,
        candidateStartedAtMs: cur.atMs,
        candidateBaselineVolumeMl: s.baselineVolumeMl,
        candidateLossMl: loss,
        arbitrationDeadlineMs: cur.atMs + c.arbitrationMs,
        lowestFlowVolumeMl: cur.volumeMl,
        lastMeaningfulFlowAtMs: null,
        timeoutAtMs: null,
      },
      effects: [{ type: "candidate_started", sessionId: id, lossMl: loss }],
    };
  }
  const robust = med(last(h, 3).map((x) => x.volumeMl)),
    loss = s.candidateBaselineVolumeMl! - robust;
  const flow = (s.lowestFlowVolumeMl ?? robust) - robust;
  s = {
    ...s,
    candidateLossMl: loss,
    lowestFlowVolumeMl: Math.min(s.lowestFlowVolumeMl ?? robust, robust),
    lastStabilizedVolumeMl: robust,
    ...(flow >= c.meaningfulFlowMl ? { lastMeaningfulFlowAtMs: cur.atMs } : {}),
  };
  if (s.phase === "candidate")
    effects.push({ type: "candidate_updated", sessionId: s.candidateSessionId!, lossMl: loss });
  return { state: s, effects };
}
export function activateCandidate(
  s: DetectorRuntimeState,
  at = s.arbitrationDeadlineMs ?? s.candidateStartedAtMs ?? 0,
  c?: DetectorConfig,
): DetectorTransition {
  return s.phase !== "candidate" || !s.candidateSessionId
    ? { state: s, effects: [] }
    : {
        state: {
          ...s,
          phase: "pouring",
          lastMeaningfulFlowAtMs: at,
          timeoutAtMs: at + (c?.hardTimeoutMs ?? 0),
        },
        effects: [{ type: "candidate_activated", sessionId: s.candidateSessionId }],
      };
}
type DetectorDueDecision =
  | { readonly type: "activate"; readonly atMs: number }
  | { readonly type: "complete"; readonly atMs: number; readonly endVolumeMl: number }
  | { readonly type: "timeout"; readonly atMs: number };

function detectorDueDecision(
  s: DetectorRuntimeState,
  h: readonly DetectorSample[],
  c: DetectorConfig,
  now: number,
): DetectorDueDecision | null {
  if (s.phase === "candidate") {
    return s.arbitrationDeadlineMs !== null && s.arbitrationDeadlineMs <= now
      ? { type: "activate", atMs: s.arbitrationDeadlineMs }
      : null;
  }
  if (s.phase !== "pouring") return null;
  const quietDeadline =
      s.lastMeaningfulFlowAtMs === null ? null : s.lastMeaningfulFlowAtMs + c.quietPeriodMs,
    timeout = s.timeoutAtMs;
  if (
    quietDeadline !== null &&
    quietDeadline <= now &&
    (timeout === null || quietDeadline <= timeout)
  ) {
    const checkpoints = [
      quietDeadline,
      ...h
        .filter((sample) => sample.atMs > quietDeadline && sample.atMs <= now)
        .map((sample) => sample.atMs),
    ]
      .filter((atMs, index, values) => values.indexOf(atMs) === index)
      .sort((a, b) => a - b);
    for (const checkpoint of checkpoints) {
      if (timeout !== null && checkpoint > timeout) break;
      const eligible = h.filter((sample) => sample.atMs <= checkpoint),
        endVolumeMl = flat(eligible, c.settledSamples, c.settledSpanMs, c.settledBandMl);
      if (endVolumeMl === null) continue;
      const atMs = Math.max(
        quietDeadline,
        last(eligible, c.settledSamples).at(-1)?.atMs ?? quietDeadline,
      );
      if (timeout === null || atMs <= timeout) return { type: "complete", atMs, endVolumeMl };
    }
  }
  return timeout !== null && timeout <= now ? { type: "timeout", atMs: timeout } : null;
}

export function advanceDetector(
  s: DetectorRuntimeState,
  h: readonly DetectorSample[],
  c: DetectorConfig,
  now: number,
): DetectorTransition {
  const decision = detectorDueDecision(s, h, c, now);
  if (decision?.type === "activate") return activateCandidate(s, decision.atMs, c);
  if (decision?.type === "timeout") return suppressCandidate(s, c, decision.atMs, "timeout");
  if (decision?.type === "complete") {
    const raw = Math.max(0, s.candidateBaselineVolumeMl! - decision.endVolumeMl),
      volumeMl = (Math.round((raw / 29.5735295625) * 10) / 10) * 29.5735295625;
    if (volumeMl < c.minimumPourMl) return suppressCandidate(s, c, decision.atMs, "rebound");
    const startedAtMs = s.candidateStartedAtMs ?? decision.atMs;
    return {
      state: cooldown(s, c, decision.atMs, null),
      effects: [
        {
          type: "pour_completed",
          sessionId: s.candidateSessionId!,
          volumeMl,
          startedAtMs,
          completedAtMs: decision.atMs,
        },
      ],
    };
  }
  return { state: s, effects: [] };
}

/** Returns the logical timestamp of the transition that advanceDetector would perform by now. */
export function nextDetectorDueAt(
  s: DetectorRuntimeState,
  h: readonly DetectorSample[],
  c: DetectorConfig,
  now: number,
): number | null {
  return detectorDueDecision(s, h, c, now)?.atMs ?? null;
}
export interface ArbitrationDecision {
  readonly winnerTapId: string | null;
  readonly suppressedTapIds: readonly string[];
}
export function arbitrateCandidates(
  candidates: readonly DetectorRuntimeState[],
  c: DetectorConfig,
): ArbitrationDecision {
  const x = candidates
      .filter(
        (s) =>
          s.phase === "candidate" &&
          s.candidateLossMl !== null &&
          s.candidateStartedAtMs !== null &&
          s.tapId !== undefined,
      )
      .sort(
        (a, b) =>
          b.candidateLossMl! - a.candidateLossMl! ||
          a.candidateStartedAtMs! - b.candidateStartedAtMs! ||
          (a.tapId! < b.tapId! ? -1 : a.tapId! > b.tapId! ? 1 : 0),
      ),
    w = x[0];
  if (!w) return { winnerTapId: null, suppressedTapIds: [] };
  const r = x[1],
    ok =
      w.candidateLossMl! >= c.arbitrationMinimumMl &&
      (!r ||
        (w.candidateLossMl! - r.candidateLossMl! >= c.arbitrationMinimumMl &&
          w.candidateLossMl! / r.candidateLossMl! >= c.arbitrationDominanceRatio));
  return ok
    ? { winnerTapId: w.tapId!, suppressedTapIds: x.slice(1).map((s) => s.tapId!) }
    : { winnerTapId: null, suppressedTapIds: x.map((s) => s.tapId!) };
}
