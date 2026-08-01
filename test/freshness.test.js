import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_BADGE_WINDOW_MS, shouldShowNewBadge } from '../public/freshness.js';

const now = Date.parse('2026-08-01T12:00:00.000Z');

test('New badge is opt-in and limited to the first seven days on tap', () => {
  assert.equal(
    shouldShowNewBadge({ badge_fresh: 1, on_tap_at: new Date(now - NEW_BADGE_WINDOW_MS + 1).toISOString() }, now),
    true
  );
  assert.equal(
    shouldShowNewBadge({ badge_fresh: 1, on_tap_at: new Date(now - NEW_BADGE_WINDOW_MS).toISOString() }, now),
    false
  );
  assert.equal(shouldShowNewBadge({ badge_fresh: 0, on_tap_at: new Date(now).toISOString() }, now), false);
  assert.equal(shouldShowNewBadge({ badge_fresh: 1, on_tap_at: null }, now), false);
});
