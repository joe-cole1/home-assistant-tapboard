import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSensoryModel, buildSensoryProfile, RULES_VERSION } from '../src/sensoryEngine.js';

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} was not within ${epsilon} of ${expected}`);
}

function measurements(values) {
  return { batch: { measurements: values } };
}

test('v2 uses canonical measured fields and continuous amount-aware formulas', () => {
  const model = buildSensoryModel({
    detail: {
      ...measurements({
        measured_ibu: 50,
        target_ibu: 10,
        measured_og: 1.05,
        measured_fg: 1.01,
        measured_abv: 6,
        measured_batch_volume_l: 20
      }),
      recipe: {
        ingredients: {
          hops: [{ amount: 80, unit: 'g', use: 'Dry Hop' }],
          fermentables: [{ amount: 4_000, unit: 'g', name: 'Pale Malt' }]
        }
      }
    }
  });
  assert.equal(model.metrics.ibu, 50);
  assert.equal(model.metrics.abv, 6);
  close(model.values.bitterness, 3.7);
  close(model.values.perceived_strength, 1.5);
  close(model.values.hops, 10 / 3);
  close(model.values.malt, 2.325);
  assert.equal(model.axes.hops.source_layer, 'recipe_prediction');
  assert.match(model.axes.hops.evidence, /g\/L/);
});

test('v2 metric precedence is measured then target or estimated then compatibility aliases', () => {
  const model = buildSensoryModel({
    summary: { measured_og: 1.06, estimated_og: 1.05, og: 1.04, estimated_ibu: 25 },
    detail: measurements({ target_og: 1.07, measured_ibu: 40, target_ibu: 30 })
  });
  assert.equal(model.metrics.og, 1.06);
  assert.equal(model.metrics.ibu, 40);
});

test('v2 precedence is manual then newest valid per-axis tasting then recipe then composable style', () => {
  const profile = buildSensoryProfile({
    summary: { style: 'Sour IPA', ibu: 70 },
    detail: {
      batch: {
        taste_logs: [
          { recorded_at: '2026-01-01', ratings: { sweetness: 2, hops: 1 } },
          { recorded_at: '2026-02-01', ratings: { sweetness: 80, hops: 4 } }
        ]
      }
    },
    override: { axes: { bitterness: 5, hops: 8 } }
  });
  assert.equal(profile.rules_version, RULES_VERSION);
  assert.equal(profile.axes.bitterness.value, 5);
  assert.equal(profile.axes.bitterness.source_layer, 'manual');
  assert.equal(profile.axes.hops.value, 4);
  assert.equal(profile.axes.hops.source_layer, 'tasting');
  assert.equal(profile.axes.sweetness.value, 2);
  assert.equal(profile.axes.sweetness.source_layer, 'tasting');
  assert.equal(profile.axes.tartness.value, 5);
  assert.equal(profile.axes.tartness.source_layer, 'style_baseline');
});

test('v2 rejects ambiguous tasting scales and treats zero as real evidence', () => {
  const profile = buildSensoryProfile({
    summary: { style: 'IPA' },
    detail: {
      batch: {
        taste_logs: [{ ratings: { bitterness: 0 } }, { ratings: { bitterness: 80, sweetness: 7 } }]
      }
    }
  });
  assert.equal(profile.axes.bitterness.value, 0);
  assert.equal(profile.axes.bitterness.source_layer, 'tasting');
  assert.equal(profile.axes.sweetness.value, null);
});

test('v2 does not reuse ingredient counts or infer tartness from fruit, Brett, or water acid', () => {
  const profile = buildSensoryProfile({
    detail: {
      recipe: {
        water: { acid: 'lactic' },
        ingredients: {
          hops: [{ name: 'Citra' }, { name: 'Citra' }],
          miscs: [{ name: 'Fruit puree' }, { name: 'Citric acid' }],
          yeasts: [{ name: 'Brettanomyces' }]
        }
      }
    }
  });
  assert.equal(profile.axes.hops.value, null);
  assert.equal(profile.axes.tartness.value, null);
});

test('v2 hop intensity follows timing-weighted mass rather than entry count', () => {
  const oneLargeCharge = buildSensoryModel({
    detail: {
      ...measurements({ target_batch_volume_l: 20 }),
      recipe: { ingredients: { hops: [{ amount: 0.2, use: 'Dry Hop' }] } }
    }
  });
  const tokenCharges = buildSensoryModel({
    detail: {
      ...measurements({ target_batch_volume_l: 20 }),
      recipe: {
        ingredients: { hops: Array.from({ length: 5 }, () => ({ amount: 1, unit: 'g', use: 'Dry Hop' })) }
      }
    }
  });
  assert.equal(oneLargeCharge.values.hops, 5);
  assert.equal(tokenCharges.values.hops, 0.5);
});

test('v2 bitterness combines absolute IBU, BU:GU, and residual-extract masking', () => {
  const tiny = buildSensoryModel({
    detail: measurements({ measured_ibu: 5, measured_og: 1.005, measured_fg: 1.001 })
  });
  const westCoast = buildSensoryModel({
    detail: measurements({ measured_ibu: 65, measured_og: 1.065, measured_fg: 1.01 })
  });
  const largeSweetBeer = buildSensoryModel({
    detail: measurements({ measured_ibu: 30, measured_og: 1.1, measured_fg: 1.03 })
  });
  close(tiny.values.bitterness, 1);
  close(westCoast.values.bitterness, 4.45);
  assert.ok(largeSweetBeer.values.bitterness < 0.2);
});

test('v2 distinguishes equal FG values using apparent attenuation', () => {
  const session = buildSensoryModel({ detail: measurements({ measured_og: 1.04, measured_fg: 1.014 }) });
  const barleywine = buildSensoryModel({ detail: measurements({ measured_og: 1.1, measured_fg: 1.014 }) });
  assert.ok(session.values.sweetness > barleywine.values.sweetness);
});

test('v2 uses grist composition for roast and caps the SRM-only fallback', () => {
  const candi = buildSensoryModel({
    detail: { recipe: { ingredients: { fermentables: [{ name: 'Dark Candi Syrup', percentage: 100 }] } } }
  });
  const dehusked = buildSensoryModel({
    detail: {
      recipe: {
        ingredients: {
          fermentables: [
            { name: 'Pale Malt', percentage: 95 },
            { name: 'Carafa Special III dehusked', percentage: 5 }
          ]
        }
      }
    }
  });
  const fallback = buildSensoryModel({ summary: { estimated_srm: 80 } });
  assert.equal(candi.values.roast, 0);
  close(dehusked.values.roast, 1);
  assert.equal(fallback.values.roast, 1.5);
});

test('v2 tartness prefers measured pH and otherwise accepts only recognized souring evidence', () => {
  const measured = buildSensoryModel({ detail: measurements({ measured_ph: 3.3 }) });
  const culture = buildSensoryModel({
    detail: { recipe: { ingredients: { yeasts: [{ name: 'Lallemand Philly Sour' }] } } }
  });
  const brett = buildSensoryModel({
    detail: { recipe: { ingredients: { yeasts: [{ name: 'Brettanomyces Bruxellensis' }] } } }
  });
  const explicit = buildSensoryModel({ detail: { recipe: { souring: 'Kettle sour' } } });
  close(measured.values.tartness, 4.5);
  assert.equal(culture.values.tartness, 4);
  assert.equal(explicit.values.tartness, 4);
  assert.equal(brett.values.tartness, undefined);
});

test('cached souring evidence contributes to the active v2 profile', () => {
  const detail = {
    batch: { sensory_v2_souring: 'Kettle sour' },
    recipe: { sensory_v2_souring: true }
  };
  assert.equal(buildSensoryProfile({ detail }).axes.tartness.value, 4);
});

test('v2 body combines gravity and adjunct percentage with diminishing returns', () => {
  const plain = buildSensoryModel({
    detail: {
      ...measurements({ measured_og: 1.06, measured_fg: 1.016 }),
      recipe: { ingredients: { fermentables: [{ name: 'Pale Malt', percentage: 100 }] } }
    }
  });
  const oats = buildSensoryModel({
    detail: {
      ...measurements({ measured_og: 1.06, measured_fg: 1.016 }),
      recipe: {
        ingredients: {
          fermentables: [
            { name: 'Pale Malt', percentage: 80 },
            { name: 'Flaked Oats', percentage: 20 }
          ]
        }
      }
    }
  });
  assert.ok(oats.values.body > plain.values.body);
  assert.ok(oats.values.body < plain.values.body + 2);
  const attenuationOnly = buildSensoryModel({
    detail: measurements({ measured_attenuation: 70 })
  });
  assert.equal(attenuationOnly.values.body, 2.5);
});

test('v2 style matching composes compound families and separates Tripel', () => {
  const sourIpa = buildSensoryProfile({ summary: { style: 'Sour IPA' } });
  const tripel = buildSensoryProfile({ summary: { style: 'Belgian Tripel' } });
  assert.equal(sourIpa.axes.tartness.value, 5);
  assert.equal(sourIpa.axes.hops.value, 4.5);
  assert.equal(sourIpa.axes.body.value, 2);
  assert.equal(tripel.axes.sweetness.value, 1.5);
  assert.equal(tripel.axes.body.value, 2);
  const sparseStout = buildSensoryProfile({ summary: { style: 'Imperial Stout', estimated_srm: 20 } });
  assert.equal(sparseStout.axes.roast.value, 5);
  assert.equal(sparseStout.axes.roast.source_layer, 'style_baseline');
});

test('v2 model excludes human layers and null-safe profiles invent nothing', () => {
  const model = buildSensoryModel({
    summary: { style: 'IPA' },
    detail: { tasting: { hops: 1 } },
    override: { axes: { hops: 0 } }
  });
  assert.equal(model.axes.hops.source_layer, 'style_baseline');
  const empty = buildSensoryProfile({ summary: null, detail: null, override: null });
  assert.ok(Object.values(empty.axes).every((axis) => axis.value === null));
  assert.equal(empty.prose, '');
});
