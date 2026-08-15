import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBattleDraft, validateMysteryConfig, validateVote } from '../src/validation.js';

test('validation enforces Tap Wars body schema and invariants', () => {
  // Valid draft
  const draft = validateBattleDraft({
    contestant_a_tap_id: 1,
    contestant_b_tap_id: 2,
    title: 'Hazy vs West Coast',
    description_copy: 'Great IPA Battle',
    theme: 'ipa_showdown'
  });
  assert.equal(draft.contestant_a_tap_id, 1);
  assert.equal(draft.contestant_b_tap_id, 2);

  // Reject same tap A and B
  assert.throws(() => {
    validateBattleDraft({
      contestant_a_tap_id: 1,
      contestant_b_tap_id: 1,
      title: 'Same Tap Battle'
    });
  }, /two different taps/i);

  // Reject invalid tap numbers
  assert.throws(() => {
    validateBattleDraft({ contestant_a_tap_id: 0, contestant_b_tap_id: 2, title: 'Bad Tap' });
  }, /Invalid tap/i);

  // Valid vote
  const vote = validateVote({ battle_id: 12, contestant_side: 'A' });
  assert.equal(vote.battle_id, 12);
  assert.equal(vote.contestant_side, 'A');

  // Reject invalid contestant side
  assert.throws(() => {
    validateVote({ battle_id: 12, contestant_side: 'C' });
  }, /Invalid/i);
});

test('validation enforces Mystery Tap config schema', () => {
  const valid = validateMysteryConfig({
    enabled: true,
    redacted_categories: ['name', 'style', 'description']
  });
  assert.equal(valid.enabled, true);
  assert.deepEqual(valid.redacted_categories, ['name', 'style', 'description']);

  assert.throws(() => {
    validateMysteryConfig({ enabled: true, redacted_categories: ['invalid_category'] });
  }, /Invalid redacted category/i);
});
