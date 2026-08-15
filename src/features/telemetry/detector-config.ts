/** The ordered, persisted detector configuration surface from schema v9. */
export const DETECTOR_CONFIG_FIELDS = [
  "candidateLossMl",
  "candidateSamples",
  "candidateSampleWindowMs",
  "candidateLookbackMs",
  "arbitrationMs",
  "arbitrationMinimumMl",
  "arbitrationDominanceRatio",
  "meaningfulFlowMl",
  "quietPeriodMs",
  "hardTimeoutMs",
  "minimumPourMl",
  "implausibleJumpMl",
  "jumpStableSamples",
  "jumpStableSpanMs",
  "jumpBandMl",
  "baselineSamples",
  "baselineSpanMs",
  "baselineBandMl",
  "settledSamples",
  "settledSpanMs",
  "settledBandMl",
  "cooldownMs",
  "historyMs",
] as const;

export interface DetectorConfig {
  readonly candidateLossMl: number;
  readonly candidateSamples: number;
  readonly candidateSampleWindowMs: number;
  readonly candidateLookbackMs: number;
  readonly arbitrationMs: number;
  readonly arbitrationMinimumMl: number;
  readonly arbitrationDominanceRatio: number;
  readonly meaningfulFlowMl: number;
  readonly quietPeriodMs: number;
  readonly hardTimeoutMs: number;
  readonly minimumPourMl: number;
  readonly implausibleJumpMl: number;
  readonly jumpStableSamples: number;
  readonly jumpStableSpanMs: number;
  readonly jumpBandMl: number;
  readonly baselineSamples: number;
  readonly baselineSpanMs: number;
  readonly baselineBandMl: number;
  readonly settledSamples: number;
  readonly settledSpanMs: number;
  readonly settledBandMl: number;
  readonly cooldownMs: number;
  readonly historyMs: number;
}

export type DetectorConfigOverride = {
  readonly [K in keyof DetectorConfig]?: DetectorConfig[K] | null;
};

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  candidateLossMl: 23.65882365,
  candidateSamples: 3,
  candidateSampleWindowMs: 400,
  candidateLookbackMs: 3000,
  arbitrationMs: 400,
  arbitrationMinimumMl: 14.78676478125,
  arbitrationDominanceRatio: 1.5,
  meaningfulFlowMl: 5.9147059125,
  quietPeriodMs: 5000,
  hardTimeoutMs: 15000,
  minimumPourMl: 29.5735295625,
  implausibleJumpMl: 887.205886875,
  jumpStableSamples: 5,
  jumpStableSpanMs: 3000,
  jumpBandMl: 14.78676478125,
  baselineSamples: 5,
  baselineSpanMs: 800,
  baselineBandMl: 8.87205886875,
  settledSamples: 5,
  settledSpanMs: 800,
  settledBandMl: 8.87205886875,
  cooldownMs: 5000,
  historyMs: 6000,
};

export function mergeDetectorConfig(
  base: DetectorConfig,
  override: DetectorConfigOverride | null | undefined,
): DetectorConfig {
  if (!override) return { ...base };
  const result = { ...base } as Record<keyof DetectorConfig, number>;
  for (const field of DETECTOR_CONFIG_FIELDS) {
    const value = override[field];
    if (value !== null && value !== undefined) result[field] = value;
  }
  return result;
}
export function detectorConfigsEqual(left: DetectorConfig, right: DetectorConfig): boolean {
  return DETECTOR_CONFIG_FIELDS.every((field) => left[field] === right[field]);
}
