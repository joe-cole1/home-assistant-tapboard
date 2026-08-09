import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSensoryProfile } from '../src/sensoryEngine.js';

function values(profile) {
  return Object.fromEntries(Object.entries(profile.axes).map(([axis, item]) => [axis, item.value]));
}

test('golden pale fixture is style-grounded and leaves unsupported traits null', () => {
  const profile = buildSensoryProfile({ summary: { style: 'American Pale Ale' } });
  assert.deepEqual(values(profile), {
    malt: 2,
    hops: 2,
    bitterness: 2,
    sweetness: null,
    roast: null,
    tartness: null,
    body: 2,
    perceived_strength: null
  });
  assert.equal(profile.rules_version, 'sensory-v1');
  assert.equal(profile.axes.malt.source_layer, 'style_baseline');
});

test('golden hoppy fixture uses recipe prediction over style baseline', () => {
  const profile = buildSensoryProfile({
    summary: { style: 'Hazy IPA', ibu: 70 },
    detail: { recipe: { ingredients: { hops: [{ use: 'Dry Hop' }, { use: 'Whirlpool' }, { use: 'Boil' }] } } }
  });
  assert.deepEqual(values(profile), {
    malt: 2,
    hops: 4.5,
    bitterness: 3,
    sweetness: null,
    roast: null,
    tartness: null,
    body: 4,
    perceived_strength: null
  });
  assert.equal(profile.axes.bitterness.source_layer, 'recipe_prediction');
});

test('golden dark fixture derives roast and strength from recipe data', () => {
  const profile = buildSensoryProfile({ summary: { style: 'Imperial Stout', srm: 42, abv: 10.5 } });
  assert.equal(profile.axes.roast.value, 4);
  assert.equal(profile.axes.perceived_strength.value, 4);
  assert.equal(profile.axes.malt.value, 4);
});

test('golden sour fixture does not treat water acid treatment as tartness evidence', () => {
  const waterOnly = buildSensoryProfile({ detail: { recipe: { water: { acid: 'lactic' } } } });
  assert.equal(waterOnly.axes.tartness.value, null);
  const sour = buildSensoryProfile({ summary: { style: 'Gose' } });
  assert.equal(sour.axes.tartness.value, 5);
});

test('golden strong fixture honors tasting then manual per-axis overlays', () => {
  const profile = buildSensoryProfile({
    summary: { style: 'Barleywine', ibu: 80, abv: 12 },
    detail: { tasting: { bitterness: 1, sweetness: 3, perceived_strength: 3 } },
    override: { axes: { bitterness: 5 } }
  });
  assert.equal(profile.axes.bitterness.value, 5);
  assert.equal(profile.axes.bitterness.source_layer, 'manual');
  assert.equal(profile.axes.sweetness.source_layer, 'tasting');
  assert.equal(profile.axes.perceived_strength.source_layer, 'tasting');
});

test('brewer tasting precedence selects the newest timestamp regardless of array order', () => {
  const profile = buildSensoryProfile({
    detail: {
      batch: {
        taste_logs: [
          { recorded_at: '2026-08-09T00:00:00.000Z', ratings: { bitterness: 4 } },
          { recorded_at: '2026-08-01T00:00:00.000Z', ratings: { bitterness: 1 } }
        ]
      }
    }
  });
  assert.equal(profile.axes.bitterness.value, 4);
  assert.equal(profile.axes.bitterness.source_layer, 'tasting');
});

test('golden data-poor fixture fabricates neither values nor prose', () => {
  const profile = buildSensoryProfile();
  assert.deepEqual(values(profile), {
    malt: null,
    hops: null,
    bitterness: null,
    sweetness: null,
    roast: null,
    tartness: null,
    body: null,
    perceived_strength: null
  });
  assert.equal(profile.prose, '');
  assert.equal(profile.axes.body.confidence, null);
});
