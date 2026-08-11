import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSensoryShadow, compareSensoryProfiles } from '../src/sensoryShadowReport.js';

test('compares bounded profiles without carrying unrelated profile data', () => {
  const comparison = compareSensoryProfiles(
    { private_name: 'Never include', axes: { hops: { value: 4, source_layer: 'recipe_prediction' } } },
    { axes: { hops: { value: 2.5, source_layer: 'style_baseline' }, roast: { value: 1 } } }
  );
  assert.deepEqual(comparison.hops, {
    v1: 4,
    v2: 2.5,
    delta: -1.5,
    coverage: 'same',
    source_v1: 'recipe_prediction',
    source_v2: 'style_baseline'
  });
  assert.equal(comparison.roast.coverage, 'gained');
  assert.equal(JSON.stringify(comparison).includes('Never include'), false);
});

test('aggregates per-axis shadow comparisons without returning input identifiers', () => {
  const report = aggregateSensoryShadow([
    {
      batch_id: 'private-batch-id',
      beer_name: 'Private beer name',
      bitterness: { v1: 1, v2: 2, delta: 1, coverage: 'gained', source_v1: 'style', source_v2: 'recipe' },
      malt: { v1: 4, v2: 2, delta: -2, coverage: 'same', source_v1: 'manual', source_v2: 'manual' }
    },
    {
      bitterness: { v1: 3, v2: 0.5, delta: -2.5, coverage: 'lost', source_v1: 'recipe', source_v2: 'manual' },
      malt: { v1: null, v2: null, delta: null, coverage: 'unrecognized' }
    }
  ]);

  assert.deepEqual(report.axes.bitterness, {
    count: 2,
    coverage: { gained: 1, lost: 1, same: 0, unknown: 0 },
    source_changes: 2,
    mean_abs_delta: 1.75,
    median_abs_delta: 1.75,
    max_abs_delta: 2.5,
    abs_delta_at_least_1: 2,
    abs_delta_at_least_2: 1
  });
  assert.deepEqual(report.axes.malt, {
    count: 2,
    coverage: { gained: 0, lost: 0, same: 1, unknown: 1 },
    source_changes: 0,
    mean_abs_delta: 2,
    median_abs_delta: 2,
    max_abs_delta: 2,
    abs_delta_at_least_1: 1,
    abs_delta_at_least_2: 1
  });
  assert.deepEqual(Object.keys(report.axes), [...Object.keys(report.axes)].sort());
  assert.equal(JSON.stringify(report).includes('private-batch-id'), false);
  assert.equal(JSON.stringify(report).includes('Private beer name'), false);
  assert.equal(JSON.stringify(report).includes('style'), false);
});

test('is null-safe, ignores unknown axes, and keeps empty metrics deterministic', () => {
  const report = aggregateSensoryShadow([
    null,
    { unknown_axis: { delta: 999, coverage: 'gained' }, body: null },
    { body: { delta: 'not-a-number', coverage: null, source_v1: 'manual', source_v2: null } }
  ]);

  assert.deepEqual(report.axes.body, {
    count: 1,
    coverage: { gained: 0, lost: 0, same: 0, unknown: 1 },
    source_changes: 0,
    mean_abs_delta: null,
    median_abs_delta: null,
    max_abs_delta: null,
    abs_delta_at_least_1: 0,
    abs_delta_at_least_2: 0
  });
  assert.deepEqual(aggregateSensoryShadow(null), aggregateSensoryShadow([]));
});

test('rounds aggregate deltas deterministically', () => {
  const report = aggregateSensoryShadow([
    { hops: { delta: 1 / 3, coverage: 'same' } },
    { hops: { delta: -2 / 3, coverage: 'same' } },
    { hops: { delta: 1, coverage: 'same' } }
  ]);

  assert.equal(report.axes.hops.mean_abs_delta, 0.667);
  assert.equal(report.axes.hops.median_abs_delta, 0.667);
  assert.equal(report.axes.hops.max_abs_delta, 1);
  assert.equal(report.axes.hops.abs_delta_at_least_1, 1);
});
