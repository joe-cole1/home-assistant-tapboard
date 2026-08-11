import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTapGraphic } from '../public/graphics.js';

for (const [style, foamClip, expectedBaseY] of [
  ['wheat_glass', 'wheatFoamClip', '30'],
  ['tulip_glass', 'tulipFoamClip', '40'],
  ['stout_glass', 'stoutFoamClip', '45'],
  ['snifter', 'snifterFoamClip', '55']
]) {
  test(`${style} clips foam to its body contour at the liquid level`, () => {
    const id = `${style}_top`;
    const svg = renderTapGraphic(style, 100, '#E8A317', false, id);

    assert.match(svg, new RegExp(`<clipPath id="${foamClip}_${id}">`));
    assert.match(
      svg,
      new RegExp(
        `<g class="beer-foam-contour" clip-path="url\\(#${foamClip}_${id}\\)">\\s*<g class="beer-cloud-foam" data-base-y="${expectedBaseY}">`
      )
    );
  });
}
