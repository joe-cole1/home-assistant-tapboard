import { SENSORY_AXES } from './sensoryMappings.js';

const COVERAGE_STATES = new Set(['gained', 'lost', 'same']);
const REPORT_AXES = [...SENSORY_AXES].sort();

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return value === null ? null : Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function emptyAxis() {
  return {
    count: 0,
    coverage: { gained: 0, lost: 0, same: 0, unknown: 0 },
    source_changes: 0,
    mean_abs_delta: null,
    median_abs_delta: null,
    max_abs_delta: null,
    abs_delta_at_least_1: 0,
    abs_delta_at_least_2: 0
  };
}

export function compareSensoryProfiles(active, candidate) {
  const activeAxes = active?.axes && typeof active.axes === 'object' ? active.axes : {};
  const candidateAxes = candidate?.axes && typeof candidate.axes === 'object' ? candidate.axes : {};
  return Object.fromEntries(
    SENSORY_AXES.map((axis) => {
      const v1 = finiteNumber(activeAxes[axis]?.value);
      const v2 = finiteNumber(candidateAxes[axis]?.value);
      const bothKnown = v1 !== null && v2 !== null;
      return [
        axis,
        {
          v1,
          v2,
          delta: bothKnown ? v2 - v1 : null,
          coverage: bothKnown ? 'same' : v2 !== null ? 'gained' : v1 !== null ? 'lost' : 'unknown',
          source_v1: activeAxes[axis]?.source_layer ?? 'unsupported',
          source_v2: candidateAxes[axis]?.source_layer ?? 'unsupported'
        }
      ];
    })
  );
}

/**
 * Convert a collection of per-axis shadow comparisons into a privacy-safe,
 * population-level report. Values and source labels are consumed only to form
 * counts; neither the input records nor identifying metadata are retained.
 */
export function aggregateSensoryShadow(comparisons) {
  const aggregates = Object.fromEntries(REPORT_AXES.map((axis) => [axis, emptyAxis()]));
  const deltas = Object.fromEntries(REPORT_AXES.map((axis) => [axis, []]));

  if (!Array.isArray(comparisons)) return { axes: aggregates };

  for (const comparison of comparisons) {
    if (!comparison || typeof comparison !== 'object' || Array.isArray(comparison)) continue;

    for (const axis of REPORT_AXES) {
      const item = comparison[axis];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

      const aggregate = aggregates[axis];
      aggregate.count += 1;

      const coverage = typeof item.coverage === 'string' ? item.coverage.toLowerCase() : '';
      aggregate.coverage[COVERAGE_STATES.has(coverage) ? coverage : 'unknown'] += 1;

      if (
        typeof item.source_v1 === 'string' &&
        typeof item.source_v2 === 'string' &&
        item.source_v1 !== item.source_v2
      ) {
        aggregate.source_changes += 1;
      }

      const delta = finiteNumber(item.delta);
      if (delta === null) continue;
      const absoluteDelta = Math.abs(delta);
      deltas[axis].push(absoluteDelta);
      if (absoluteDelta >= 1) aggregate.abs_delta_at_least_1 += 1;
      if (absoluteDelta >= 2) aggregate.abs_delta_at_least_2 += 1;
    }
  }

  for (const axis of REPORT_AXES) {
    const values = deltas[axis];
    if (!values.length) continue;
    const aggregate = aggregates[axis];
    aggregate.mean_abs_delta = round(values.reduce((sum, value) => sum + value, 0) / values.length);
    aggregate.median_abs_delta = round(median(values));
    aggregate.max_abs_delta = round(Math.max(...values));
  }

  return { axes: aggregates };
}
