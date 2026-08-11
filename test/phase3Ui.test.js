import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createCelebrationController, formatLifecycleLine, renderForecastDetails } from '../public/phase3Ui.js';

const forecast = {
  lifecycle: { tapId: 2, startedAt: '2026-08-01T00:00:00.000Z' },
  depletion: { earliestDaysRemaining: 2.1, latestDaysRemaining: 7.8 },
  evidence: { observationDays: 18, qualifyingPours: 5, totalOz: 48, method: 'fallback_24oz_per_4d' },
  confidence: { level: 'low', status: 'available', reason: 'insufficient_lifecycle_history' },
  isFallback: true
};

test('lifecycle line and dialog expose tapped age, uncertainty, and evidence', () => {
  const { document } = parseHTML('<h2 id="title"></h2><div id="body"></div>');
  globalThis.document = document;
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-08-10T12:00:00.000Z');
  try {
    const line = formatLifecycleLine({
      ...forecast,
      lifecycle: { ...forecast.lifecycle, startedAt: '2026-08-01T12:00:00.000Z' }
    });
    assert.equal(line, 'Tapped Aug 1 (9d ago)\n3-8 days left');
    assert.equal(
      formatLifecycleLine({
        ...forecast,
        lifecycle: { ...forecast.lifecycle, startedAt: '2026-08-01T12:00:00.000Z' },
        depletion: {},
        status: 'unavailable'
      }),
      'Tapped Aug 1 (9d ago)'
    );
    renderForecastDetails({
      title: document.getElementById('title'),
      body: document.getElementById('body'),
      forecast
    });
    assert.equal(document.getElementById('title').textContent, 'Tap 2 forecast');
    assert.match(document.getElementById('body').textContent, /Confidence/);
    assert.match(document.getElementById('body').textContent, /broad fallback/i);
    const facts = document.querySelector('.forecast-dialog-facts');
    assert.deepEqual(
      [...facts.children].slice(0, 4).map((node) => [node.localName, node.textContent]),
      [
        ['dt', 'Confidence'],
        ['dd', 'low'],
        ['dt', 'Data span'],
        ['dd', '18 days']
      ]
    );
  } finally {
    Date.now = originalNow;
  }
});

test('receipt UI deduplicates durable IDs and gates lifecycle ceremonies', () => {
  const { document } = parseHTML('<div id="layer"></div>');
  globalThis.document = document;
  const settings = { first_pour_effects: true, kick_effects: false, ceremony_sound: 'pub_bell' };
  const controller = createCelebrationController({
    layer: document.getElementById('layer'),
    getSettings: () => settings,
    soundEnabled: () => false
  });
  const receipt = {
    receiptId: 7,
    tapId: 2,
    lifecycleId: 9,
    beerName: 'Test IPA',
    volumePouredOz: 12,
    remaining: { remainingOz: 44, servings: 3.7 }
  };
  controller.receipt(receipt);
  controller.receipt(receipt);
  assert.equal(document.querySelectorAll('.pour-receipt-card').length, 1);
  controller.firstPour(receipt);
  assert.equal(document.querySelectorAll('.first-pour-banner').length, 1);
  controller.kegKicked({ ...receipt, kickedAt: '2026-08-11T00:00:00.000Z' });
  assert.equal(document.querySelectorAll('.keg-kick-ceremony').length, 0);
  settings.kick_effects = true;
  controller.kegKicked({ ...receipt, kickedAt: '2026-08-11T00:00:00.000Z' });
  assert.equal(document.querySelector('.keg-kick-ceremony').getAttribute('role'), 'status');
  document.querySelectorAll('.celebration-dismiss').forEach((button) => button.click());
});

test('Phase 3 animation selectors honor reduced-motion preferences', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.first-pour-banner/);
  assert.match(reduced, /\.keg-kick-ceremony/);
  assert.match(css, /\.lifecycle-forecast-btn:focus-visible/);
  assert.match(css, /\.forecast-dialog-facts\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.forecast-dialog-facts dt\s*\{[^}]*font-weight:\s*800;/s);
  assert.match(css, /\.forecast-dialog-facts dd\s*\{[^}]*color:\s*var\(--text-muted\);/s);
});
