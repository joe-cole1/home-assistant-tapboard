import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { buildBrewStoryContent, createBrewStoryController } from '../public/brewStory.js';

function withDocument(run) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const previous = globalThis.document;
  globalThis.document = document;
  return Promise.resolve()
    .then(() => run(document))
    .finally(() => {
      globalThis.document = previous;
    });
}

const story = {
  batch: { batch_id: 'one', recipe_name: 'Safe IPA', style: 'IPA', status: 'Fermenting' },
  freshness: { stale: false, latest_reading_at: '2026-08-09T00:00:00.000Z', stale_after_hours: 12 },
  sections: {
    batch: { tags: ['fresh'], events: [{ name: 'Dry hop', description: 'Citra' }], taste_logs: [] },
    recipe: {
      style: { name: 'American IPA', aroma: 'Citrus' },
      ingredients: { hops: [{ name: 'Citra', amount: 0.1, unit: 'kg', use: 'Dry Hop' }] },
      profiles: {}
    }
  },
  telemetry: {
    latest: { recorded_at: '2026-08-09T00:00:00.000Z', sg: 1.01, temp_c: 20 },
    history: {
      points: [
        { recorded_at_ms: 1, sg: 1.05, temp_c: 21, pressure: null, ph: null },
        { recorded_at_ms: 2, sg: 1.01, temp_c: 20, pressure: null, ph: null }
      ]
    }
  },
  tapboard: { lifecycles: [] },
  sensory: {
    hidden: false,
    rules_version: 'sensory-v2',
    description: 'Hoppy and firm.',
    axes: {
      malt: { value: 2, source_layer: 'style_baseline', confidence: 'low', evidence: 'Style' },
      hops: { value: 5, source_layer: 'recipe_prediction', confidence: 'medium', evidence: 'Dry hop' },
      bitterness: { value: 4, source_layer: 'tasting', confidence: 'high', evidence: 'Tasting' },
      roast: { value: null, source_layer: 'unsupported', confidence: null, evidence: 'No evidence' }
    }
  }
};

test('Brew Story renders telemetry and partial radar without interpreting remote markup', () =>
  withDocument((document) => {
    const hostile = '<img src=x onerror=globalThis.bad=true>';
    const wrapper = document.createElement('div');
    wrapper.appendChild(
      buildBrewStoryContent(
        {
          ...story,
          batch: { ...story.batch, recipe_name: hostile },
          sections: { ...story.sections, recipe: { ...story.sections.recipe, notes: hostile } }
        },
        {},
        { isAdmin: true }
      )
    );
    assert.ok(wrapper.textContent.includes(hostile));
    assert.equal(wrapper.querySelectorAll('script').length, 0);
    assert.equal(wrapper.querySelectorAll('img').length, 0);
    assert.ok(wrapper.querySelector('.brew-story-chart polyline'));
    assert.equal(wrapper.querySelectorAll('.brew-story-chart polyline').length, 2);
    assert.ok(wrapper.querySelector('.brew-story-radar-shape'));
    assert.equal(wrapper.querySelectorAll('.brew-story-radar-marker').length, 3);
    assert.equal(wrapper.querySelectorAll('.brew-story-sensory-table tbody tr').length, 8);
    assert.ok(wrapper.textContent.includes('Med'));
    assert.ok(wrapper.textContent.includes('High'));
    assert.equal(wrapper.textContent.includes('Hoppy and firm.'), false);
    assert.equal(wrapper.textContent.includes('Prediction'), false);
    assert.equal(wrapper.textContent.includes('Brewer tasting'), false);
    assert.equal(wrapper.textContent.includes('Score'), false);
    assert.equal(wrapper.textContent.includes('Calculation'), false);
  }));

test('Tap Details starts with the Tapboard chapter and Flavor guidance', () =>
  withDocument((document) => {
    const wrapper = document.createElement('div');
    wrapper.appendChild(
      buildBrewStoryContent(
        {
          ...story,
          tapboard: {
            lifecycles: [
              {
                tap_id: 2,
                active: true,
                tapped_at: '2026-08-10T00:00:00.000Z',
                pours: { count: 3, total_oz: 36 },
                remaining: { volume_oz: 604 }
              }
            ]
          }
        },
        {}
      )
    );
    const headings = Array.from(wrapper.querySelectorAll('.brew-story-section-heading h3'), (heading) =>
      heading.textContent.trim()
    );
    assert.deepEqual(headings.slice(0, 2), ['Tap Details', 'Flavor guidance']);
  }));

test('public sensory rankings use the five simple bands without exposing numeric detail', () =>
  withDocument((document) => {
    const wrapper = document.createElement('div');
    wrapper.appendChild(
      buildBrewStoryContent(
        {
          ...story,
          sensory: {
            ...story.sensory,
            axes: {
              malt: { value: 0.94 },
              hops: { value: 0.95 },
              bitterness: { value: 1.94 },
              sweetness: { value: 1.95 },
              roast: { value: 2.94 },
              tartness: { value: 2.95 },
              body: { value: 3.94 },
              perceived_strength: { value: 3.95 }
            }
          }
        },
        {}
      )
    );
    const rankings = Array.from(wrapper.querySelectorAll('.brew-story-sensory-rank'), (cell) => cell.textContent);
    assert.deepEqual(rankings, ['Low', 'Med-Low', 'Med-Low', 'Med', 'Med', 'Med-High', 'Med-High', 'High']);
    assert.equal(wrapper.textContent.includes('0.94'), false);
    assert.equal(wrapper.textContent.includes('3.95'), false);
  }));

test('hidden sensory guidance stays absent publicly', () =>
  withDocument((document) => {
    const wrapper = document.createElement('div');
    wrapper.appendChild(buildBrewStoryContent({ ...story, sensory: { ...story.sensory, hidden: true } }, {}));
    assert.equal(wrapper.querySelector('.brew-story-sensory-table'), null);
    assert.equal(wrapper.textContent.includes('Flavor guidance'), false);
  }));

test('controller loads on demand, switches windows, and suppresses stale responses', () =>
  withDocument(async (document) => {
    const dialog = document.createElement('dialog');
    dialog.open = false;
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
    const title = document.createElement('h2');
    const body = document.createElement('div');
    const status = document.createElement('p');
    const calls = [];
    const pending = [];
    const controller = createBrewStoryController({
      dialog,
      title,
      body,
      status,
      canEdit: () => true,
      fetchStory(id, windowName, signal) {
        calls.push({ id, windowName, signal });
        return new Promise((resolve) => pending.push(resolve));
      }
    });
    controller.open({ batchId: 'one', title: 'One', fallback: {} });
    controller.load('24h');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    pending[0]({ ok: true, json: async () => ({ ...story, batch: { recipe_name: 'Stale response' } }) });
    pending[1]({ ok: true, json: async () => story });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(title.textContent, 'Safe IPA');
    assert.ok(body.querySelector('.brew-story-chart'));
    controller.close();
    assert.equal(dialog.open, false);
  }));

test('authenticated controller renders and submits complete sensory overrides', () =>
  withDocument(async (document) => {
    const dialog = document.createElement('dialog');
    dialog.showModal = () => {
      dialog.open = true;
    };
    const title = document.createElement('h2');
    const body = document.createElement('div');
    const status = document.createElement('p');
    const saves = [];
    const adminStory = {
      ...story,
      sensory: {
        ...story.sensory,
        hidden: true,
        axes: { ...story.sensory.axes, hops: { ...story.sensory.axes.hops, value: 1.96 } },
        override: { hidden: true, description_override: null, axis_overrides: { hops: 4.5 } }
      }
    };
    const controller = createBrewStoryController({
      dialog,
      title,
      body,
      status,
      canEdit: () => true,
      fetchStory: async () => ({ ok: true, json: async () => adminStory }),
      saveSensory: async (id, payload) => {
        saves.push({ id, payload });
        return { ok: true, json: async () => ({ success: true }) };
      }
    });
    controller.open({ batchId: 'one', title: 'One', fallback: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const form = body.querySelector('.brew-story-override-form');
    assert.ok(form, `${status.textContent}\n${body.innerHTML}`);
    const sensoryTable = body.querySelector('.brew-story-sensory-table');
    assert.ok(sensoryTable);
    assert.ok(sensoryTable.textContent.includes('Score'));
    assert.ok(sensoryTable.textContent.includes('Calculation'));
    const hopsRow = Array.from(sensoryTable.querySelectorAll('tbody tr')).find((row) =>
      row.textContent.includes('Hops')
    );
    assert.ok(hopsRow.textContent.includes('Med'));
    assert.ok(hopsRow.textContent.includes('2.0'));
    assert.ok(sensoryTable.textContent.includes('Prediction · medium · Dry hop'));
    assert.equal(form.querySelector('textarea'), null);
    form.querySelector('select[data-axis="roast"] option[value="3.5"]').selected = true;
    form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves[0].id, 'one');
    assert.equal('description_override' in saves[0].payload, false);
    assert.equal(saves[0].payload.hidden, true);
    assert.equal(saves[0].payload.axis_overrides.hops, 4.5);
    assert.equal(saves[0].payload.axis_overrides.roast, 3.5);
  }));
