import assert from 'node:assert/strict';
import test from 'node:test';
import { fitSingleLineText, formatVolumeReadout } from '../public/cardPresentation.js';

const measurement = (changes = {}) => ({
  available: true,
  volumeOz: 214.4,
  fillPercent: 33.5,
  pintsRemaining: 13.4,
  ...changes
});

test('volume readouts use whole-number Left labels with explicit sub-one values', () => {
  assert.equal(formatVolumeReadout({ display_unit: 'pints' }, measurement()), '13 Pints Left');
  assert.equal(formatVolumeReadout({ display_unit: 'pints' }, measurement({ pintsRemaining: 0.4 })), '< 1 Pint Left');
  assert.equal(formatVolumeReadout({ display_unit: 'oz' }, measurement()), '214 oz Left');
  assert.equal(formatVolumeReadout({ display_unit: 'percent' }, measurement()), '34% Left');
  assert.equal(formatVolumeReadout({ display_unit: 'percent' }, measurement({ fillPercent: 0.4 })), '< 1% Left');
  assert.equal(formatVolumeReadout({ display_unit: 'percent' }, measurement({ fillPercent: 0 })), '0% Left');
});

test('pour readouts round the count and retain a spaced serving-size label', () => {
  assert.equal(
    formatVolumeReadout({ display_unit: 'pours_12' }, measurement({ volumeOz: 45 })),
    '4 Pours Left (12 oz)'
  );
  assert.equal(
    formatVolumeReadout({ display_unit: 'pours_custom', custom_pour_size: 9.5 }, measurement({ volumeOz: 4 })),
    '< 1 Pour Left (9.5 oz)'
  );
});

test('pints derive from ounces when absent and malformed or unavailable values stay unavailable', () => {
  assert.equal(
    formatVolumeReadout({ display_unit: 'pints' }, measurement({ volumeOz: 32, pintsRemaining: null })),
    '2 Pints Left'
  );
  assert.equal(formatVolumeReadout({ display_unit: 'oz' }, measurement({ volumeOz: Number.NaN })), 'Unavailable');
  assert.equal(formatVolumeReadout({ display_unit: 'percent' }, { available: false }), 'Unavailable');
});

test('single-line title fitting shrinks no more than ten percent and retains the original line box', () => {
  const removed = [];
  const element = {
    clientWidth: 100,
    scrollWidth: 200,
    dataset: {},
    style: {
      removeProperty(name) {
        removed.push(name);
        if (name === 'font-size') delete this.fontSize;
        if (name === 'line-height') delete this.lineHeight;
      }
    }
  };
  const scale = fitSingleLineText(element, {
    getStyles: () => ({ fontSize: '20px', lineHeight: '24px' })
  });
  assert.equal(scale, 0.9);
  assert.equal(element.style.fontSize, '18px');
  assert.equal(element.style.lineHeight, '24px');
  assert.deepEqual(removed, ['font-size', 'line-height']);
});
