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
    rules_version: 'sensory-v1',
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
        {}
      )
    );
    assert.ok(wrapper.textContent.includes(hostile));
    assert.equal(wrapper.querySelectorAll('script').length, 0);
    assert.equal(wrapper.querySelectorAll('img').length, 0);
    assert.ok(wrapper.querySelector('.brew-story-chart polyline'));
    assert.equal(wrapper.querySelectorAll('.brew-story-chart polyline').length, 2);
    assert.ok(wrapper.querySelector('.brew-story-radar-shape'));
    assert.equal(wrapper.querySelectorAll('.brew-story-radar-marker').length, 3);
    assert.ok(wrapper.textContent.includes('Style baseline'));
    assert.ok(wrapper.textContent.includes('Prediction'));
    assert.ok(wrapper.textContent.includes('Brewer tasting'));
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
    assert.deepEqual(headings.slice(0, 3), ['Tapboard chapter', 'Flavor guidance', 'Identity']);
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
        override: { hidden: false, description_override: null, axis_overrides: { hops: 4.5 } }
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
    assert.equal(body.querySelector('.brew-story-sensory-shadow'), null);
    form.querySelector('textarea').value = 'Manual description';
    form.querySelector('select[data-axis="roast"] option[value="3.5"]').selected = true;
    form.dispatchEvent(new document.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves[0].id, 'one');
    assert.equal(saves[0].payload.description_override, 'Manual description');
    assert.equal(saves[0].payload.axis_overrides.hops, 4.5);
    assert.equal(saves[0].payload.axis_overrides.roast, 3.5);
  }));

test('sensory v2 shadow comparison is rendered only for authenticated viewers', () =>
  withDocument(async (document) => {
    const shadowStory = {
      ...story,
      sensory: {
        ...story.sensory,
        shadow: {
          rules_version: 'sensory-v2',
          candidate: {
            known_axis_count: 2,
            prose: 'Brighter citrus with a softer finish.',
            axes: { hops: { evidence: 'Citra dry hop' }, roast: { evidence: 'No roast malt' } }
          },
          comparison: {
            hops: { v1: 5, v2: 4, delta: -1, coverage: 'same' },
            roast: { v1: null, v2: null, delta: null, coverage: 'unknown' }
          }
        }
      }
    };
    const adminDialog = document.createElement('dialog');
    adminDialog.showModal = () => {
      adminDialog.open = true;
    };
    const adminBody = document.createElement('div');
    const admin = createBrewStoryController({
      dialog: adminDialog,
      title: document.createElement('h2'),
      body: adminBody,
      status: document.createElement('p'),
      canEdit: () => true,
      fetchStory: async () => ({ ok: true, json: async () => shadowStory }),
      saveSensory: async () => ({ ok: true, json: async () => ({ success: true }) })
    });
    admin.open({ batchId: 'one', title: 'One', fallback: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shadow = adminBody.querySelector('.brew-story-sensory-shadow');
    assert.ok(shadow);
    assert.equal(shadow.querySelectorAll('.brew-story-radar').length, 0);
    assert.ok(shadow.textContent.includes('Hops'));
    assert.ok(shadow.textContent.includes('-1'));
    assert.ok(shadow.textContent.includes('Unavailable'));
    assert.ok(shadow.textContent.includes('Citra dry hop'));

    const publicDialog = document.createElement('dialog');
    publicDialog.showModal = () => {
      publicDialog.open = true;
    };
    const publicBody = document.createElement('div');
    const publicController = createBrewStoryController({
      dialog: publicDialog,
      title: document.createElement('h2'),
      body: publicBody,
      status: document.createElement('p'),
      canEdit: () => false,
      fetchStory: async () => ({ ok: true, json: async () => shadowStory })
    });
    publicController.open({ batchId: 'one', title: 'One', fallback: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(publicBody.querySelector('.brew-story-sensory-shadow'), null);
  }));
