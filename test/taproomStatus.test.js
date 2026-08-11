import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderTaproomStatus, tapCardPlanningIndicatorText, taproomHeaderBadgeText } from '../public/taproomStatus.js';

function render(options = {}) {
  const { document } = parseHTML('<dialog id="dialog"></dialog>');
  globalThis.document = document;
  const dialog = document.getElementById('dialog');
  return { document, dialog, result: renderTaproomStatus({ dialog, ...options }) };
}

test('renders public projection text safely and excludes private implementation fields', () => {
  const { document, dialog } = render({
    draftHealth: {
      summary: '<img src=x onerror=alert(1)>',
      checks: [
        { label: 'Flow check', message: '<b>safe text</b>', entityId: 'sensor.secret', maintenanceNote: 'private' }
      ]
    },
    tapPlanning: { configured: true }
  });
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.match(dialog.textContent, /<img src=x/);
  assert.doesNotMatch(dialog.textContent, /sensor\.secret|private/);
});

test('unauthenticated dialog redacts administration and supports tab switching', () => {
  const { document, result } = render({
    draftHealth: { checks: [] },
    tapPlanning: { taps: [{ tapName: 'North tap', candidateName: 'Pale Ale', confidence: 'medium' }] }
  });
  assert.equal(document.querySelectorAll('.taproom-admin-controls').length, 0);
  document.getElementById('taproom-status-planning-tab').click();
  assert.match(document.querySelector('[role="tabpanel"]').textContent, /Pale Ale/);
  assert.equal(document.getElementById('taproom-status-planning-tab').getAttribute('aria-selected'), 'true');
  result.selectTab('health');
  assert.match(document.querySelector('[aria-live]').textContent, /Draft Health/);

  const keyboardEvent = new document.defaultView.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(keyboardEvent, 'key', { value: 'ArrowRight' });
  document.getElementById('taproom-status-health-tab').dispatchEvent(keyboardEvent);
  assert.equal(document.getElementById('taproom-status-planning-tab').getAttribute('aria-selected'), 'true');
});

test('authenticated controls call their callbacks, including acknowledgement', () => {
  let acknowledged = 0;
  let saved = 0;
  const { document } = render({
    authenticated: true,
    draftHealth: { checks: [{ label: 'CO₂ check' }] },
    callbacks: { acknowledge: () => acknowledged++, savePolicy: () => saved++ }
  });
  document.querySelector('.taproom-acknowledge').click();
  document.querySelector('.taproom-admin-action').click();
  assert.equal(acknowledged, 1);
  assert.equal(saved, 1);
});

test('empty configurations and probabilistic no-inventory planning have clear public wording', () => {
  const { document, dialog } = render({
    draftHealth: { configured: false },
    tapPlanning: { configured: false }
  });
  assert.match(dialog.textContent, /not configured/i);
  document.getElementById('taproom-status-planning-tab').click();
  assert.match(dialog.textContent, /not configured/i);
  const second = render({ tapPlanning: { taps: [{ tapName: 'South', noInventory: true }] } });
  second.document.getElementById('taproom-status-planning-tab').click();
  assert.match(second.dialog.textContent, /probabilistic planning result/i);
  assert.equal(taproomHeaderBadgeText({ attentionCount: 2 }), '2 draft health alerts');
  assert.equal(tapCardPlanningIndicatorText({ stale: true }), 'Planning data stale');
});
