import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  buildOnDeckItems,
  buildRecipeModalContent,
  buildTapCardContent,
  createSelectOption,
  createToast
} from '../public/domBuilders.js';
import { renderTapGraphic } from '../public/graphics.js';
import { storedXssPayloads, xssPayloads } from './fixtures/xssPayloads.js';

function withDocument(run) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const previousDocument = globalThis.document;
  globalThis.document = document;
  try {
    return run(document);
  } finally {
    globalThis.document = previousDocument;
  }
}

function assertInertText(node, payload) {
  assert.equal(node.querySelectorAll('img, script, svg, a').length, 0);
  node.querySelectorAll('*').forEach((child) => {
    [...child.attributes].forEach((attribute) => assert.doesNotMatch(attribute.name, /^on/i));
  });
  assert.ok(node.textContent.includes(payload), `payload was not preserved as text: ${payload}`);
}

test('stored-XSS values stay inert text in cards, recipe, catalog, options, and toasts', () =>
  withDocument((document) => {
    storedXssPayloads.forEach((payload) => {
      const card = document.createElement('div');
      card.replaceChildren(
        buildTapCardContent({
          tapId: 1,
          fillPercent: 50,
          fresh: false,
          lowThreshold: 20,
          beerName: payload,
          style: payload,
          description: payload,
          abv: payload,
          ibu: payload,
          og: payload,
          fg: payload,
          volumeReadoutText: payload,
          forecastText: payload
        })
      );
      const modal = document.createElement('div');
      modal.replaceChildren(
        buildRecipeModalContent({
          style: payload,
          abv: payload,
          ibu: payload,
          srm: payload,
          og: payload,
          fg: payload,
          brewDate: payload,
          description: payload
        })
      );
      const ticker = document.createElement('div');
      ticker.replaceChildren(buildOnDeckItems([{ name: payload, style: payload, abv: payload }]));
      const toast = createToast(payload);
      const option = createSelectOption(payload, payload, true);

      [card, modal, ticker, toast, option].forEach((node) => assertInertText(node, payload));
      assert.equal(card.querySelector('.beer-title')?.title, payload);
      assert.equal(option.value, payload);
      assert.equal(option.textContent, payload);
    });
  }));

test('hostile graphic style, color, and instance id cannot enter SVG markup', () => {
  const svg = renderTapGraphic(xssPayloads.style, 50, xssPayloads.color, false, xssPayloads.id);
  assert.match(svg, /<svg\b/);
  assert.doesNotMatch(svg, /<script|onload=|globalThis\.__xss|corny_keg"/i);
  assert.match(svg, /#E8A317/); // invalid colors use the renderer's safe fallback
  assert.match(svg, /(?:id|url\(#)[a-zA-Z0-9_-]+/);
});

test('opted-in fresh badge is rendered with its new label', () =>
  withDocument((document) => {
    const card = document.createElement('div');
    card.replaceChildren(
      buildTapCardContent({
        tapId: 1,
        fillPercent: 50,
        fresh: true,
        lowThreshold: 20,
        beerName: 'Test Beer',
        style: 'Test Style',
        description: '',
        abv: '5%',
        ibu: 20,
        og: 1.05,
        fg: 1.01,
        volumeReadoutText: '50% Remaining',
        forecastText: 'Calculating'
      })
    );
    assert.equal(card.querySelector('.badge-fresh')?.textContent, 'NEW');
    assert.equal(card.textContent.includes('FRESH!'), false);
  }));

test('compact-card semantics keep the header, graphic badges, and right-side details distinct', () =>
  withDocument((document) => {
    const directChild = (parent, selector) =>
      [...(parent?.children || [])].find((child) => child.matches(selector)) || null;
    const card = document.createElement('article');
    card.replaceChildren(
      buildTapCardContent({
        tapId: 4,
        fillPercent: 10,
        volumeStatus: 'measured',
        fresh: true,
        lowThreshold: 20,
        beerName: 'Compact Header Beer',
        style: 'Right-side Style',
        description: 'Right-side details remain inert.',
        abv: '6.2%',
        ibu: 42,
        og: 1.06,
        fg: 1.012,
        volumeReadoutText: '10% Remaining',
        forecastText: '2 days remaining'
      })
    );

    const header = card.querySelector('.tap-card-header');
    const graphicColumn = card.querySelector('.tap-card-graphic-column');
    const graphic = directChild(graphicColumn, '.graphic-container');
    const details = card.querySelector('.tap-card-content');
    const badges = directChild(graphicColumn, '.tap-card-badges');

    assert.ok(header);
    assert.equal(directChild(header, '.tap-number-badge')?.textContent, '4');
    assert.equal(directChild(header, '.beer-title')?.textContent, 'Compact Header Beer');
    assert.equal(directChild(header, '.beer-title')?.localName, 'button');
    assert.equal(header.querySelector('.beer-title .tap-cog-btn'), null);
    assert.equal(card.querySelectorAll('.beer-title').length, 1);

    assert.ok(graphicColumn);
    assert.equal(directChild(card, '.tap-card-graphic-column'), graphicColumn);
    assert.ok(graphic);
    assert.ok(badges);
    assert.equal(badges.querySelector('.badge-low')?.textContent, 'LOW KEG!');
    assert.equal(badges.querySelector('.badge-fresh')?.textContent, 'NEW');
    assert.equal(header.querySelector('.badge'), null);
    assert.ok(directChild(graphic, '.tap-graphic-wrapper'));

    assert.ok(details);
    assert.equal(directChild(card, '.tap-card-content'), details);
    assert.equal(directChild(details, '.beer-style')?.textContent, 'Right-side Style');
    assert.equal(directChild(details, '.beer-description')?.textContent, 'Right-side details remain inert.');
    assert.ok(directChild(details, '.metrics-row'));
    const volumeReadout = directChild(graphic, '.volume-readout');
    const forecastReadout = directChild(graphic, '.forecast-readout');
    assert.equal(volumeReadout?.textContent, '10% Remaining');
    assert.equal(forecastReadout?.textContent, '2 days remaining');
    assert.equal(volumeReadout?.nextElementSibling, forecastReadout);
    assert.equal(directChild(details, '.forecast-readout'), null);
    assert.equal(details.querySelector('.graphic-container'), null);
    assert.equal(details.querySelector('.serving-glass-readout'), null);

    // Existing app live-update selectors remain meaningful after the restructuring.
    assert.ok(card.querySelector('.tap-card-actions .tap-cog-btn'));
    assert.ok(card.querySelector('.metrics-row .metric-value'));
    assert.equal(card.querySelector('.forecast-readout')?.hidden, false);
  }));

test('forecast block is hidden when no usage forecast is available', () =>
  withDocument((document) => {
    const card = document.createElement('div');
    card.replaceChildren(
      buildTapCardContent({
        tapId: 3,
        fillPercent: 100,
        fresh: false,
        lowThreshold: 20,
        beerName: 'Topo Chico',
        style: 'Sparkling Water',
        description: '',
        abv: '0%',
        ibu: '-',
        og: '-',
        fg: '-',
        volumeReadoutText: '100% Remaining',
        forecastText: ''
      })
    );
    assert.equal(card.querySelector('.forecast-readout')?.hidden, true);
  }));

test('unavailable and assumed-full states are explicit, and low-keg is fresh-measured only', () =>
  withDocument((document) => {
    const unavailable = document.createElement('div');
    unavailable.replaceChildren(
      buildTapCardContent({
        tapId: 1,
        fillPercent: 0,
        volumeStatus: 'unavailable',
        fresh: false,
        lowThreshold: null,
        beerName: 'Test Beer',
        style: 'Style',
        description: '',
        abv: '5%',
        ibu: 20,
        og: 1.05,
        fg: 1.01,
        volumeReadoutText: 'Unavailable',
        forecastText: ''
      })
    );
    assert.equal(unavailable.querySelector('.volume-status')?.textContent, 'Unavailable');
    assert.equal(unavailable.querySelector('.badge-low'), null);

    const assumed = document.createElement('div');
    assumed.replaceChildren(
      buildTapCardContent({
        tapId: 3,
        fillPercent: 100,
        volumeStatus: 'assumed_full',
        fresh: false,
        lowThreshold: null,
        beerName: 'Water',
        style: 'Water',
        description: '',
        abv: '0%',
        ibu: '-',
        og: '-',
        fg: '-',
        volumeReadoutText: '100.0% Remaining',
        forecastText: ''
      })
    );
    assert.equal(assumed.querySelector('.volume-status')?.textContent, 'Assumed full — not measured');
    assert.equal(assumed.querySelector('.badge-low'), null);
  }));

test('app only parses trusted renderTapGraphic output', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  );
  const assignments = [...source.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((match) => match[1]);
  assert.equal(assignments.length, 2);
  assignments.forEach((value) => assert.match(value, /^renderTapGraphic\(/));
  assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML/);
});
