import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveUpdateController, updateGraphicFill } from '../public/liveUpdates.js';

test('merges coherent measurement tuples and coalesces affected cards into one frame', () => {
  let state = {
    tapStates: {
      1: { volumeOz: 512, capacityOz: 640, fillPercent: 80, pintsRemaining: 32, volumeStatus: 'measured' }
    }
  };
  const frames = [];
  const dirtyCalls = [];
  const updates = createLiveUpdateController({
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    onDirty: (ids) => dirtyCalls.push([...ids].sort()),
    requestFrame: (callback) => frames.push(callback)
  });

  updates.applyStateChanged({
    taps: [
      {
        tapId: 1,
        changes: { volumeOz: 505, capacityOz: 640, fillPercent: 78.9, pintsRemaining: 31.6, volumeStatus: 'measured' }
      }
    ]
  });
  updates.applyStateChanged({
    taps: [
      {
        tapId: 2,
        changes: { volumeOz: 192, capacityOz: 640, fillPercent: 30, pintsRemaining: 12, volumeStatus: 'stale' }
      }
    ]
  });

  assert.deepEqual(state.tapStates, {
    1: { volumeOz: 505, capacityOz: 640, fillPercent: 78.9, pintsRemaining: 31.6, volumeStatus: 'measured' },
    2: { volumeOz: 192, capacityOz: 640, fillPercent: 30, pintsRemaining: 12, volumeStatus: 'stale' }
  });
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(dirtyCalls, [['1', '2']]);
});

test('snapshot replacement normalizes a missing tapStates map', () => {
  let state = {};
  const updates = createLiveUpdateController({
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    onDirty: () => {},
    requestFrame: () => {}
  });

  updates.replaceSnapshot({ settings: { title: 'Tapboard' } });
  assert.deepEqual(state, { settings: { title: 'Tapboard' }, tapStates: {} });
});

test('numeric fill updates mutate existing SVG nodes without replacing their identity', () => {
  const svg = {
    getAttribute(name) {
      return name === 'data-bottom-y' ? '200' : '100';
    }
  };
  const rects = [{ attributes: {} }, { attributes: {} }];
  rects.forEach((rect) => {
    rect.setAttribute = (name, value) => {
      rect.attributes[name] = value;
    };
  });
  const foam = {
    style: {},
    getAttribute() {
      return '200';
    }
  };
  const card = {
    classList: { contains: () => false },
    querySelector(selector) {
      if (selector === '.tap-graphic-svg') return svg;
      if (selector === '.beer-cloud-foam') return foam;
      return null;
    },
    querySelectorAll() {
      return rects;
    }
  };

  const originalSvg = card.querySelector('.tap-graphic-svg');
  updateGraphicFill(card, 25);

  assert.strictEqual(card.querySelector('.tap-graphic-svg'), originalSvg);
  assert.deepEqual(
    rects.map((rect) => rect.attributes),
    [
      { y: 175, height: 25 },
      { y: 175, height: 25 }
    ]
  );
  assert.equal(foam.style.transform, 'translateY(-25px)');
});
