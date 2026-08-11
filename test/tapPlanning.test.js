import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTapPlanningProjection,
  compareReadinessRanges,
  estimateCandidateReadiness,
  evaluateCapabilityCompatibility,
  rankCandidates
} from '../src/tapPlanning.js';
import { validateReadinessOverride } from '../src/validation.js';

const now = Date.parse('2026-08-11T12:00:00Z');

test('planning lifecycle ranges and manual dates remain potential', () => {
  assert.deepEqual(
    estimateCandidateReadiness({ status: 'Planning', brew_date: '2026-08-01' }, { now }).earliest,
    '2026-08-19'
  );
  assert.deepEqual(
    estimateCandidateReadiness({ status: 'Planning', brew_date: '2026-08-01' }, { now }).latest,
    '2026-09-15'
  );
  assert.deepEqual(
    estimateCandidateReadiness({ status: 'Fermenting', fermentation_start_date: '2026-08-01' }, { now }).latest,
    '2026-09-08'
  );
  assert.deepEqual(
    estimateCandidateReadiness({ status: 'Conditioning', packaging_date: '2026-08-01' }, { now }).earliest,
    '2026-08-08'
  );
  const manual = estimateCandidateReadiness(
    { status: 'Planning', override: { earliest: '2026-08-12', latest: '2026-08-20' } },
    { now }
  );
  assert.equal(manual.source, 'manual');
  assert.equal(manual.status, 'potential');
  const confirmed = estimateCandidateReadiness(
    { status: 'Planning', override: { earliest: '2026-08-12', latest: '2026-08-20', confirmed: true }, detail: {} },
    { now }
  );
  assert.equal(confirmed.confidence, 'high');
});

test('readiness confirmation requires an operator-provided date range', () => {
  assert.throws(
    () =>
      validateReadinessOverride({
        earliest_date: null,
        latest_date: null,
        confirmed: true,
        required_capabilities: []
      }),
    /date range/i
  );
});

test('invalid and missing anchors fail closed while scheduled future dates remain valid; gravity does not complete a batch', () => {
  for (const brew_date of ['nope', '2026-08-32'])
    assert.equal(estimateCandidateReadiness({ status: 'Planning', brew_date }, { now }).status, 'unknown');
  assert.equal(
    estimateCandidateReadiness({ status: 'Planning', brew_date: '2027-01-01' }, { now }).status,
    'potential'
  );
  assert.equal(estimateCandidateReadiness({ status: 'Completed' }, { now }).status, 'unknown');
  const completed = estimateCandidateReadiness(
    { status: 'Completed', completed_date: '2026-08-01', readings: [{ sg: 1.01 }] },
    { now }
  );
  assert.equal(completed.status, 'potential');
  assert.equal(completed.confidence, 'low');
  assert.equal(completed.gravityUsed, false);
  assert.equal(completed.earliest, '2026-08-01');
  assert.equal(completed.latest, '2026-08-01');
});

test('capabilities distinguish potential, subset compatibility, and mismatch', () => {
  assert.equal(evaluateCapabilityCompatibility({}, {}).status, 'potential');
  assert.equal(
    evaluateCapabilityCompatibility({ capabilityTags: ['standard'] }, { capabilityTags: ['standard', 'nitro'] }).status,
    'compatible'
  );
  assert.equal(
    evaluateCapabilityCompatibility({ capabilityTags: ['nitro'] }, { capabilityTags: ['standard'] }).status,
    'incompatible'
  );
});

test('range boundaries, stale data, ranking, changed forecasts, and same batch caveat are projected', () => {
  assert.equal(
    compareReadinessRanges(
      { earliest: '2026-08-10', latest: '2026-08-12' },
      { earliest: '2026-08-12', latest: '2026-08-14' }
    ).classification,
    'covered'
  );
  assert.equal(
    compareReadinessRanges(
      { earliest: '2026-08-15', latest: '2026-08-18' },
      { earliest: '2026-08-10', latest: '2026-08-14' }
    ).classification,
    'forecast_gap'
  );
  assert.equal(
    compareReadinessRanges(
      { earliest: '2026-08-12', latest: '2026-08-16' },
      { earliest: '2026-08-10', latest: '2026-08-14' }
    ).classification,
    'possible_gap'
  );
  assert.equal(compareReadinessRanges({}, {}).classification, 'unknown');
  const ranked = rankCandidates(
    [
      { batchId: 'late', status: 'Planning', brew_date: '2026-08-01', capabilityTags: ['nitro'] },
      { batchId: 'soon', status: 'Conditioning', packaging_date: '2026-08-01', capabilityTags: ['standard'] }
    ],
    { now, tap: { capabilityTags: ['standard'] } }
  );
  assert.equal(ranked[0].batchId, 'soon');
  const [projection] = buildTapPlanningProjection({
    now,
    taps: [
      {
        tapId: 1,
        batchId: 'soon',
        capabilityTags: ['standard'],
        forecast: { earliest: '2026-08-10', latest: '2026-08-12' }
      }
    ],
    candidates: ranked
  });
  assert.equal(projection.candidates[0].gap.sameBatch, true);
  assert.match(projection.candidates[0].gap.caveat, /does not indicate a spare keg/i);
});
