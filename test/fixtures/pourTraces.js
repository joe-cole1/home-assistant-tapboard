const sample = (at, tapId, value, unit = 'fl oz') => ({ at, tapId, value, unit });

// Synthetic, recorder-derived reproductions. Values are already in their declared unit.
export const tap2Trace2035 = [
  sample(0, 1, 640.00), sample(0, 2, 620.00),
  sample(200, 1, 639.82), sample(200, 2, 619.80),
  sample(400, 1, 638.80), sample(400, 2, 613.68), // ~1.20 / ~6.32 oz coupling
  sample(600, 1, 639.72), sample(600, 2, 613.55),
  sample(800, 1, 639.96), sample(800, 2, 613.42),
  sample(1000, 1, 640.02), sample(1000, 2, 613.30),
];

export const tap2Trace2046 = [
  sample(0, 1, 639.98), sample(0, 2, 613.30),
  sample(200, 1, 639.90), sample(200, 2, 613.26),
  sample(234, 1, 637.74), // recorder: Tap 1 crossed first
  sample(573, 2, 612.16), // recorder: Tap 2 crossed 339 ms later
  sample(750, 1, 636.03), sample(750, 2, 609.64),
  sample(950, 1, 639.10), sample(950, 2, 609.48),
  sample(1150, 1, 639.86), sample(1150, 2, 609.36),
];

// Post-20:46 idle/startup disturbances: no physical pour should be completed.
export const laterIdleFalsePositiveTrace = [
  sample(0, 2, 609.40), sample(200, 2, 609.18), sample(400, 2, 608.82),
  sample(600, 2, 609.36), sample(800, 2, 609.12), sample(1000, 2, 609.38),
  sample(1200, 2, 608.96), sample(1400, 2, 609.40), sample(1600, 2, 609.32),
];

export const oscillatingPourTrace = [
  sample(0, 1, 100), sample(200, 1, 99.0), sample(400, 1, 98.1),
  sample(600, 1, 98.7), sample(800, 1, 98.0), sample(1000, 1, 98.55),
  sample(1200, 1, 98.05), sample(1400, 1, 98.10),
];

export const slowPourTrace = [
  sample(0, 1, 100), sample(700, 1, 99.7), sample(1400, 1, 99.2),
  sample(2100, 1, 98.7), sample(2800, 1, 98.2), sample(3500, 1, 98.0),
];
