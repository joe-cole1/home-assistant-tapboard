import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import {
  activateCandidate,
  advanceDetector,
  arbitrateCandidates,
  reduceDetector,
  waitingDetectorState,
  type DetectorRuntimeState,
} from "../src/features/telemetry/detector.ts";
import { interpretTelemetry } from "../src/features/telemetry/interpretation.ts";

const config = {
  ...DEFAULT_DETECTOR_CONFIG,
  candidateLossMl: 20,
  candidateSamples: 3,
  candidateSampleWindowMs: 500,
  minimumPourMl: 25,
  quietPeriodMs: 1000,
  hardTimeoutMs: 3000,
  settledSamples: 3,
  settledSpanMs: 100,
  baselineSamples: 3,
  baselineSpanMs: 100,
  cooldownMs: 500,
};
function sample(volumeMl: number, atMs: number) {
  return { volumeMl, atMs };
}

void test("interpretation preserves actual impossible volumes while exposing a clamped public value", () => {
  const result = interpretTelemetry(
    { capacityMl: 1000, tareG: 100, densityGPerMl: 1 },
    { kind: "total_weight", value: 50 },
  );
  assert.equal(result.interpretedVolumeMl, -50);
  assert.equal(result.publicVolumeMl, 0);
  assert.equal(result.diagnosticCode, "below_tare");
});
void test("interpretation uses epoch density and capacity while remaining volume stays canonical", () => {
  const snapshot = { capacityMl: 2000, tareG: 100, densityGPerMl: 1.25 };
  assert.equal(
    interpretTelemetry(snapshot, { kind: "total_weight", value: 1100 }).interpretedVolumeMl,
    800,
  );
  assert.equal(
    interpretTelemetry(snapshot, { kind: "remaining_volume", value: 875 }).interpretedVolumeMl,
    875,
  );
  assert.equal(
    interpretTelemetry(snapshot, { kind: "fill_percentage", value: 25 }).interpretedVolumeMl,
    500,
  );
});
void test("a fresh epoch waits for a settled baseline plateau", () => {
  let state = waitingDetectorState();
  const history = [sample(1000, 0), sample(1001, 50), sample(999, 100)];
  ({ state } = reduceDetector(state, history[0]!, history.slice(0, 1), config, "baseline"));
  assert.equal(state.phase, "waiting_for_measurement");
  ({ state } = reduceDetector(state, history[1]!, history.slice(0, 2), config, "baseline"));
  assert.equal(state.phase, "waiting_for_measurement");
  const transition = reduceDetector(state, history[2]!, history, config, "baseline");
  assert.equal(transition.state.phase, "ready");
  assert.equal(transition.state.baselineVolumeMl, 1000);
  assert.equal(transition.effects[0]?.type, "baseline_established");
});
void test("noise stays in ready state and sustained median loss creates one candidate session", () => {
  let state = waitingDetectorState();
  let history = [sample(1000, 0)];
  ({ state } = reduceDetector(state, history[0]!, history, config, "one"));
  for (const item of [sample(996, 100), sample(1002, 200), sample(997, 300)]) {
    history = [...history, item];
    ({ state } = reduceDetector(state, item, history, config, "one"));
  }
  assert.equal(state.phase, "ready");
  for (const item of [sample(970, 400), sample(965, 500), sample(960, 600)]) {
    history = [...history, item];
    ({ state } = reduceDetector(state, item, history, config, "one"));
  }
  assert.equal(state.phase, "candidate");
  assert.equal(state.candidateSessionId, "one");
});
void test("arbitration is deterministic, and only an explicit group is subject to it", () => {
  const a = {
    ...waitingDetectorState(),
    phase: "candidate" as const,
    tapId: "b",
    candidateLossMl: 50,
    candidateStartedAtMs: 10,
  };
  const b = {
    ...waitingDetectorState(),
    phase: "candidate" as const,
    tapId: "a",
    candidateLossMl: 50,
    candidateStartedAtMs: 10,
  };
  assert.deepEqual(arbitrateCandidates([a, b], config), {
    winnerTapId: null,
    suppressedTapIds: ["a", "b"],
  });
  const c = { ...b, candidateLossMl: 80 };
  assert.equal(arbitrateCandidates([a, c], config).winnerTapId, "a");
});
void test("arbitration requires both a lead and dominance ratio", () => {
  const a = {
    ...waitingDetectorState(),
    phase: "candidate" as const,
    tapId: "a",
    candidateLossMl: 50,
    candidateStartedAtMs: 0,
  };
  const b = {
    ...waitingDetectorState(),
    phase: "candidate" as const,
    tapId: "b",
    candidateLossMl: 40,
    candidateStartedAtMs: 1,
  };
  assert.equal(arbitrateCandidates([a, b], config).winnerTapId, null);
});
void test("candidate median averages an even sample count", () => {
  const c = { ...config, candidateLossMl: 40, candidateSamples: 2, candidateSampleWindowMs: 100 };
  let state: DetectorRuntimeState = {
    ...waitingDetectorState(),
    phase: "ready",
    baselineVolumeMl: 1000,
    baselineAtMs: 0,
  };
  let history = [sample(1000, 0)];
  for (const item of [sample(960, 100), sample(940, 200)]) {
    history = [...history, item];
    ({ state } = reduceDetector(state, item, history, c, "s"));
  }
  assert.equal(state.candidateLossMl, 50);
});
void test("quiet plateau completes an activated pour with canonical tenth-ounce semantics", () => {
  let state: DetectorRuntimeState = {
    ...waitingDetectorState(),
    phase: "ready",
    baselineVolumeMl: 1000,
    baselineAtMs: 0,
  };
  let history = [sample(1000, 0)];
  for (const item of [sample(970, 100), sample(965, 200), sample(960, 300)]) {
    history = [...history, item];
    ({ state } = reduceDetector(state, item, history, config, "s"));
  }
  ({ state } = activateCandidate(state, 300, config));
  for (const item of [sample(940, 400), sample(940, 500), sample(940, 600)]) {
    history = [...history, item];
    ({ state } = reduceDetector(state, item, history, config, "s"));
  }
  const result = advanceDetector(state, history, config, 1700);
  assert.equal(result.effects[0]?.type, "pour_completed");
  assert.equal(result.state.phase, "cooldown");
});
void test("settled plateaus require the configured span", () => {
  const s = { ...waitingDetectorState(), phase: "cooldown" as const, cooldownUntilMs: 0 };
  assert.equal(
    advanceDetector(s, [sample(10, 0), sample(10, 50), sample(10, 99)], config, 100).state.phase,
    "cooldown",
  );
  assert.equal(
    advanceDetector(s, [sample(10, 0), sample(10, 50), sample(10, 100)], config, 100).state.phase,
    "ready",
  );
});
void test("stale baseline cannot start a candidate", () => {
  const c = { ...config, candidateLookbackMs: 10 };
  const s = {
    ...waitingDetectorState(),
    phase: "ready" as const,
    baselineVolumeMl: 1000,
    baselineAtMs: 0,
  };
  assert.equal(
    reduceDetector(s, sample(900, 100), [sample(900, 0), sample(900, 50), sample(900, 100)], c, "s")
      .state.phase,
    "ready",
  );
});
void test("flat samples do not postpone quiet completion", () => {
  const s = {
    ...waitingDetectorState(),
    phase: "pouring" as const,
    candidateSessionId: "s",
    candidateBaselineVolumeMl: 1000,
    lastMeaningfulFlowAtMs: 0,
    timeoutAtMs: 5000,
  };
  assert.equal(
    advanceDetector(s, [sample(950, 0), sample(950, 50), sample(950, 100)], config, 1000).effects[0]
      ?.type,
    "pour_completed",
  );
});
void test("sub-threshold terminal loss cancels as rebound and enters cooldown", () => {
  const s = {
    ...waitingDetectorState(),
    phase: "pouring" as const,
    candidateSessionId: "s",
    candidateBaselineVolumeMl: 1000,
    lastMeaningfulFlowAtMs: 0,
    timeoutAtMs: 5000,
  };
  const r = advanceDetector(s, [sample(990, 0), sample(990, 50), sample(990, 100)], config, 1000);
  assert.equal(r.state.phase, "cooldown");
  assert.equal(r.effects[0]?.type, "candidate_cancelled");
});
void test("hard timeout cancels and enters cooldown", () => {
  const s = {
    ...waitingDetectorState(),
    phase: "pouring" as const,
    candidateSessionId: "s",
    candidateBaselineVolumeMl: 1000,
    timeoutAtMs: 100,
  };
  const r = advanceDetector(s, [], config, 100);
  assert.equal(r.state.phase, "cooldown");
  assert.equal(r.effects[0]?.type, "candidate_cancelled");
});
void test("quiet completion wins when quiet and timeout share a deadline", () => {
  const s = {
    ...waitingDetectorState(),
    phase: "pouring" as const,
    candidateSessionId: "s",
    candidateBaselineVolumeMl: 1000,
    lastMeaningfulFlowAtMs: 0,
    timeoutAtMs: 1000,
  };
  assert.equal(
    advanceDetector(s, [sample(950, 0), sample(950, 50), sample(950, 100)], config, 1000).effects[0]
      ?.type,
    "pour_completed",
  );
});
void test("implausible jump return clears warning without changing baseline", () => {
  const c = { ...config, implausibleJumpMl: 100 };
  let s: DetectorRuntimeState = {
    ...waitingDetectorState(),
    phase: "ready",
    baselineVolumeMl: 1000,
    baselineAtMs: 0,
    lastInterpretedVolumeMl: 1000,
  };
  ({ state: s } = reduceDetector(s, sample(1200, 10), [sample(1000, 0), sample(1200, 10)], c, "s"));
  const r = reduceDetector(
    s,
    sample(1000, 20),
    [sample(1000, 0), sample(1200, 10), sample(1000, 20)],
    c,
    "s",
  );
  assert.equal(r.state.phase, "ready");
  assert.equal(r.state.baselineVolumeMl, 1000);
});
void test("stable implausible plateau rebaselines without a pour", () => {
  const c = { ...config, implausibleJumpMl: 100, jumpStableSamples: 3, jumpStableSpanMs: 100 };
  let s: DetectorRuntimeState = {
    ...waitingDetectorState(),
    phase: "ready",
    baselineVolumeMl: 1000,
    baselineAtMs: 0,
    lastInterpretedVolumeMl: 1000,
  };
  ({ state: s } = reduceDetector(s, sample(1200, 0), [sample(1000, -1), sample(1200, 0)], c, "s"));
  ({ state: s } = reduceDetector(s, sample(1200, 50), [sample(1200, 0), sample(1200, 50)], c, "s"));
  const r = reduceDetector(
    s,
    sample(1200, 100),
    [sample(1200, 0), sample(1200, 50), sample(1200, 100)],
    c,
    "s",
  );
  assert.equal(r.state.baselineVolumeMl, 1200);
  assert.equal(
    r.effects.some((x) => x.type === "pour_completed"),
    false,
  );
});
void test("cooldown requires settled rebaseline", () => {
  const s = { ...waitingDetectorState(), phase: "cooldown" as const, cooldownUntilMs: 0 };
  assert.equal(
    advanceDetector(s, [sample(1, 0), sample(50, 50), sample(1, 100)], config, 100).state.phase,
    "cooldown",
  );
});
void test("two ungrouped detector states activate and complete independently", () => {
  const a = {
    ...waitingDetectorState(),
    phase: "candidate" as const,
    candidateSessionId: "a",
    candidateBaselineVolumeMl: 1000,
    arbitrationDeadlineMs: 0,
  };
  const b = { ...a, candidateSessionId: "b" };
  assert.equal(advanceDetector(a, [], config, 0).effects[0]?.type, "candidate_activated");
  assert.equal(advanceDetector(b, [], config, 0).effects[0]?.type, "candidate_activated");
});
void test("timestamp replay yields identical state/effects", () => {
  const p = {
    ...waitingDetectorState(),
    phase: "ready" as const,
    baselineVolumeMl: 1000,
    baselineAtMs: 0,
  };
  const h = [sample(970, 0), sample(960, 50), sample(950, 100)];
  assert.deepEqual(
    reduceDetector(p, h[2]!, h, config, "s"),
    reduceDetector(p, h[2]!, h, config, "s"),
  );
});
void test("explicit-group recorder-style 20:35/20:46 dominance selects the materially larger loss", () => {
  const a = {
    ...waitingDetectorState(),
    phase: "candidate" as const,
    tapId: "20:35",
    candidateLossMl: 90,
    candidateStartedAtMs: 0,
  };
  const b = { ...a, tapId: "20:46", candidateLossMl: 40 };
  assert.equal(arbitrateCandidates([a, b], config).winnerTapId, "20:35");
});
