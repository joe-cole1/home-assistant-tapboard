/** Historical v1 scale readings, expressed as [relative milliseconds, tap number, US fl oz]. */
export type TelemetryPourTrace = readonly (readonly [number, number, number])[];

export const tap2Trace2035: TelemetryPourTrace = [
  [0, 1, 640],
  [0, 2, 620],
  [200, 1, 639.82],
  [200, 2, 619.8],
  [400, 1, 638.8],
  [400, 2, 613.68],
  [600, 1, 639.72],
  [600, 2, 613.55],
  [800, 1, 639.96],
  [800, 2, 613.42],
  [1000, 1, 640.02],
  [1000, 2, 613.3],
];

export const tap2Trace2046: TelemetryPourTrace = [
  [0, 1, 639.98],
  [0, 2, 613.3],
  [200, 1, 639.9],
  [200, 2, 613.26],
  [234, 1, 637.74],
  [573, 2, 612.16],
  [750, 1, 636.03],
  [750, 2, 609.64],
  [950, 1, 639.1],
  [950, 2, 609.48],
  [1150, 1, 639.86],
  [1150, 2, 609.36],
];

export const laterIdleFalsePositiveTrace: TelemetryPourTrace = [
  [0, 2, 609.4],
  [200, 2, 609.18],
  [400, 2, 608.82],
  [600, 2, 609.36],
  [800, 2, 609.12],
  [1000, 2, 609.38],
  [1200, 2, 608.96],
  [1400, 2, 609.4],
  [1600, 2, 609.32],
];

export const oscillatingPourTrace: TelemetryPourTrace = [
  [0, 1, 100],
  [200, 1, 99],
  [400, 1, 98.1],
  [600, 1, 98.7],
  [800, 1, 98],
  [1000, 1, 98.55],
  [1200, 1, 98.05],
  [1400, 1, 98.1],
];

export const slowPourTrace: TelemetryPourTrace = [
  [0, 1, 100],
  [700, 1, 99.7],
  [1400, 1, 99.2],
  [2100, 1, 98.7],
  [2800, 1, 98.2],
  [3500, 1, 98],
];
