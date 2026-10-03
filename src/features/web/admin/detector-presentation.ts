import type { HealthService } from "../../health/service.ts";
import {
  DETECTOR_CONFIG_FIELDS,
  type DetectorConfigOverride,
} from "../../telemetry/detector-config.ts";
import {
  HEALTH_CHECK_IDS,
  type HealthCheckId,
  type HealthConfigOverride,
} from "../../health/types.ts";
import {
  HEALTH_SECTION_PRESENTATION,
  type AdminConfigFieldPresentation,
} from "./health-presentation.ts";

export const DETECTOR_FIELD_PRESENTATION = {
  candidateLossMl: {
    label: "Candidate loss (mL)",
    help: "Volume loss that starts a possible pour candidate.",
    unit: "mL",
    group: "detection-start",
  },
  candidateSamples: {
    label: "Candidate samples (count)",
    help: "Samples that must support a candidate before arbitration begins.",
    unit: "samples",
    group: "detection-start",
  },
  candidateSampleWindowMs: {
    label: "Candidate sample window (ms)",
    help: "Time window used to collect candidate samples.",
    unit: "ms",
    group: "detection-start",
  },
  candidateLookbackMs: {
    label: "Candidate lookback (ms)",
    help: "How far back the detector checks for the start of a loss.",
    unit: "ms",
    group: "detection-start",
  },
  arbitrationMs: {
    label: "Arbitration window (ms)",
    help: "Time allowed to confirm that the candidate is a real pour.",
    unit: "ms",
    group: "tap-arbitration",
  },
  arbitrationMinimumMl: {
    label: "Arbitration minimum flow (mL)",
    help: "Minimum flow needed before a candidate can win arbitration.",
    unit: "mL",
    group: "tap-arbitration",
  },
  arbitrationDominanceRatio: {
    label: "Arbitration dominance ratio",
    help: "How much stronger the winning signal must be than competing movement.",
    unit: "ratio",
    group: "tap-arbitration",
  },
  meaningfulFlowMl: {
    label: "Meaningful flow (mL)",
    help: "Flow amount treated as meaningful activity during a pour.",
    unit: "mL",
    group: "pour-completion",
  },
  quietPeriodMs: {
    label: "Quiet period (ms)",
    help: "Quiet time required before the pour can be considered complete.",
    unit: "ms",
    group: "pour-completion",
  },
  hardTimeoutMs: {
    label: "Hard timeout (ms)",
    help: "Maximum time a single pour candidate may remain open.",
    unit: "ms",
    group: "pour-completion",
  },
  minimumPourMl: {
    label: "Minimum pour (mL)",
    help: "Smallest completed pour recorded as a pour event.",
    unit: "mL",
    group: "pour-completion",
  },
  implausibleJumpMl: {
    label: "Implausible jump (mL)",
    help: "Volume jump large enough to require stability checks before acceptance.",
    unit: "mL",
    group: "pour-completion",
  },
  jumpStableSamples: {
    label: "Jump stability samples (count)",
    help: "Samples that must agree before a large jump is accepted.",
    unit: "samples",
    group: "stability-recovery",
  },
  jumpStableSpanMs: {
    label: "Jump stability span (ms)",
    help: "Time span over which large-jump samples must remain stable.",
    unit: "ms",
    group: "stability-recovery",
  },
  jumpBandMl: {
    label: "Jump stability band (mL)",
    help: "Allowed variation while confirming a large jump.",
    unit: "mL",
    group: "stability-recovery",
  },
  baselineSamples: {
    label: "Baseline samples (count)",
    help: "Samples used to establish a stable baseline around the Tap.",
    unit: "samples",
    group: "stability-recovery",
  },
  baselineSpanMs: {
    label: "Baseline span (ms)",
    help: "Time span used to establish the baseline.",
    unit: "ms",
    group: "stability-recovery",
  },
  baselineBandMl: {
    label: "Baseline stability band (mL)",
    help: "Allowed variation while establishing the baseline.",
    unit: "mL",
    group: "stability-recovery",
  },
  settledSamples: {
    label: "Settled samples (count)",
    help: "Samples used to confirm that the reading has settled after a pour.",
    unit: "samples",
    group: "stability-recovery",
  },
  settledSpanMs: {
    label: "Settled span (ms)",
    help: "Time span over which the post-pour reading must stay settled.",
    unit: "ms",
    group: "stability-recovery",
  },
  settledBandMl: {
    label: "Settled stability band (mL)",
    help: "Allowed variation for a reading to count as settled.",
    unit: "mL",
    group: "stability-recovery",
  },
  cooldownMs: {
    label: "Cooldown (ms)",
    help: "Quiet time after a completed pour before another event may start.",
    unit: "ms",
    group: "stability-recovery",
  },
  historyMs: {
    label: "History window (ms)",
    help: "How long recent samples remain available for recovery decisions.",
    unit: "ms",
    group: "stability-recovery",
  },
} as const satisfies Record<
  (typeof DETECTOR_CONFIG_FIELDS)[number],
  AdminConfigFieldPresentation & { readonly group: string }
>;

export const DETECTOR_GROUPS = [
  {
    id: "detection-start",
    title: "Detection start",
    description: "These settings decide when measured volume loss becomes a pour candidate.",
  },
  {
    id: "tap-arbitration",
    title: "Tap arbitration",
    description: "These settings confirm that the candidate belongs to this Tap and is meaningful.",
  },
  {
    id: "pour-completion",
    title: "Pour completion",
    description: "These settings decide when a pour is recorded or safely timed out.",
  },
  {
    id: "stability-recovery",
    title: "Stability and recovery",
    description: "These settings keep baselines stable and recover cleanly after noisy readings.",
  },
] as const;

export function formatAdminConfigValue(value: unknown, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return typeof value === "boolean" ? (value ? "enabled" : "disabled") : "—";
  }
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  if (unit !== "ms") return unit === undefined ? formatted : `${formatted} ${unit}`;
  const seconds = value / 1000;
  const secondsLabel = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(seconds);
  return `${formatted} ms (${secondsLabel} s)`;
}

export function healthCheckPresentation(checkId: string): {
  readonly title: string;
  readonly description: string;
} {
  const presentation = HEALTH_SECTION_PRESENTATION[checkId as HealthCheckId];
  return presentation === undefined
    ? { title: "Health check", description: "Current health evaluation for this Tap." }
    : { title: presentation.title, description: presentation.description };
}

export function humanizeAdminIdentifier(value: unknown, fallback = "Unknown"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const words = value.replaceAll(/[_-]+/gu, " ").trim();
  return words.length === 0 ? fallback : words[0]!.toUpperCase() + words.slice(1);
}

export function detectorOverrideFromForm(
  form: Readonly<Record<string, string>>,
): DetectorConfigOverride {
  return Object.fromEntries(
    DETECTOR_CONFIG_FIELDS.flatMap((field) => {
      const value = form[`detector.${field}`];
      return value === undefined || value === "" ? [] : [[field, Number(value)]];
    }),
  );
}

export function healthOverrideFromForm(
  form: Readonly<Record<string, string>>,
  effective: ReturnType<HealthService["getEffectiveConfig"]>["effective"],
): HealthConfigOverride | null {
  const override: Record<string, Record<string, boolean | number>> = {};
  for (const checkId of HEALTH_CHECK_IDS) {
    for (const [field, inheritedValue] of Object.entries(effective[checkId])) {
      const raw = form[`health.${checkId}.${field}`];
      if (raw === undefined || raw === "") continue;
      const section = (override[checkId] ??= {});
      section[field] = typeof inheritedValue === "boolean" ? raw === "true" : Number(raw);
    }
  }
  return Object.keys(override).length === 0 ? null : override;
}
