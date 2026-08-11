import assert from 'node:assert/strict';
import test from 'node:test';
import { FILL_GRAPHICS, fillGraphicForStyle } from '../src/fillGraphic.js';

test('fill graphic catalog includes the established and expanded graphic IDs', () => {
  assert.equal(FILL_GRAPHICS.length, 17);
  assert.ok(FILL_GRAPHICS.includes('corny_keg'));
  assert.ok(FILL_GRAPHICS.includes('stemmed_lager'));
});

test('style mapping follows the reviewed ordering', () => {
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
    assert.equal(fillGraphicForStyle(style), id, style);
});

test('unknown styles have no automatic fill graphic', () => {
  assert.equal(fillGraphicForStyle('Mystery Beverage'), null);
  assert.equal(fillGraphicForStyle(null), null);
});
