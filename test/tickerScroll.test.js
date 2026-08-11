import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createTickerAutoScroller, TICKER_INTERACTION_PAUSE_MS } from '../public/tickerScroll.js';

function harness({ reduced = false, hidden = false, scrollWidth = 300 } = {}) {
  const { document } = parseHTML('<div id="ticker"></div>');
  const element = document.getElementById('ticker');
  Object.defineProperties(element, {
    clientWidth: { value: 100 },
    scrollWidth: { value: scrollWidth }
  });
  element.scrollLeft = 0;
  let clock = 0;
  let nextId = 1;
  const frames = new Map();
  const controller = createTickerAutoScroller({
    element,
    now: () => clock,
    reducedMotion: () => reduced,
    visibilityTarget: document,
    isHidden: () => hidden,
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id)
  });
  const frame = (at) => {
    clock = at;
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback(at);
  };
  return {
    controller,
    element,
    Event: document.defaultView.Event,
    frame,
    frames,
    setClock: (value) => (clock = value),
    setHidden(value) {
      hidden = value;
      document.dispatchEvent(new document.defaultView.Event('visibilitychange'));
    }
  };
}

test('ticker scrolls automatically, pauses after user scrolling, and resumes after the pause window', () => {
  const { controller, element, Event, frame, setClock } = harness();
  frame(0);
  frame(1_000);
  assert.ok(Math.abs(element.scrollLeft - 2.304) < Number.EPSILON * 4);

  setClock(1_000);
  element.dispatchEvent(new Event('wheel'));
  frame(2_000);
  assert.ok(Math.abs(element.scrollLeft - 2.304) < Number.EPSILON * 4);
  frame(1_000 + TICKER_INTERACTION_PAUSE_MS + 1);
  assert.ok(element.scrollLeft > 2.304);
  controller.destroy();
});

test('ticker slows down for reduced motion and refresh does not create duplicate animation loops', () => {
  const { controller, element, frame, frames } = harness({ reduced: true });
  controller.refresh();
  assert.equal(frames.size, 1);
  frame(0);
  frame(1_000);
  assert.equal(element.scrollLeft, 0.768);
  assert.equal(frames.size, 1);
  controller.destroy();
  assert.equal(frames.size, 0);
});

test('ticker sleeps without overflow or while hidden and resumes when visibility returns', () => {
  const noOverflow = harness({ scrollWidth: 100 });
  noOverflow.frame(0);
  assert.equal(noOverflow.frames.size, 0);
  noOverflow.controller.destroy();

  const hidden = harness({ hidden: true });
  hidden.frame(0);
  assert.equal(hidden.frames.size, 0);
  hidden.setHidden(false);
  assert.equal(hidden.frames.size, 1);
  hidden.frame(16);
  hidden.frame(32);
  assert.ok(hidden.element.scrollLeft > 0);
  hidden.controller.destroy();
});
