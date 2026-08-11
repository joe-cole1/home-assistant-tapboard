import assert from 'node:assert/strict';
import test from 'node:test';
import { FILL_GRAPHICS, SERVING_GLASS_OPTIONS, resolveServingGlass } from '../src/servingGlass.js';

test('serving glass catalogs include the established and expanded graphic IDs', () => {
  assert.equal(FILL_GRAPHICS.length, 17);
  assert.equal(SERVING_GLASS_OPTIONS.length, 17);
  assert.equal(SERVING_GLASS_OPTIONS[0], 'auto');
  assert.ok(FILL_GRAPHICS.includes('corny_keg'));
  assert.ok(FILL_GRAPHICS.includes('stemmed_lager'));
});

test('manual serving-glass selection overrides auto matching', () => {
  assert.deepEqual(resolveServingGlass({ selection: 'teku', style: 'American IPA' }), {
    id: 'teku',
    label: 'Teku',
    source: 'manual'
  });
});

test('auto serving-glass mapping follows the reviewed ordering', () => {
  for (const [style, id] of [
    ['Witbier', 'wheat_glass'],
    ['German Pilsner', 'pilsner_flute'],
    ['Kölsch', 'stange'],
    ['Belgian Saison', 'goblet'],
    ['American Pale Ale', 'ipa_glass'],
    ['Wild Ale', 'teku'],
    ['Robust Porter', 'stout_glass'],
    ['Wee Heavy', 'thistle'],
    ['American Barleywine', 'snifter'],
    ['English ESB', 'nonic_pint'],
    ['American Amber Ale', 'shaker_pint'],
    ['Doppelbock', 'stemmed_lager']
  ])
    assert.equal(resolveServingGlass({ selection: 'auto', style }).id, id, style);
});

test('custom, unknown, and unsafe selections require a manual choice', () => {
  for (const input of [
    { selection: 'auto', style: 'Mystery Beverage', isCustom: false },
    { selection: 'auto', style: 'IPA', isCustom: true },
    { selection: '<svg>', style: 'IPA', isCustom: false }
  ])
    assert.deepEqual(resolveServingGlass(input), { id: null, label: 'Choose manually', source: 'none' });
});
