import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import { assignKegLifecycle } from '../src/kegLifecycle.js';
import {
  getMysteryConfig,
  setMysteryConfig,
  revealMystery,
  isMysteryActive,
  redactTapProjection,
  redactBrewStory
} from '../src/mysteryTap.js';

function database() {
  const db = new Database(':memory:');
  migrateDatabase(db);
  for (let tapId = 1; tapId <= 6; tapId++) {
    db.prepare('INSERT INTO taps (tap_id, enabled) VALUES (?, 1)').run(tapId);
  }
  return db;
}

test('mystery tap configuration defaults, set, and reveal lifecycle', () => {
  const db = database();
  try {
    const lc = assignKegLifecycle(db, { tapId: 1, batchId: 'batch-101', startedAt: '2026-08-12T00:00:00.000Z' });

    // Default: no mystery
    let config = getMysteryConfig(db, lc.lifecycle_id);
    assert.equal(config, null);

    // Enable mystery with custom categories
    config = setMysteryConfig(db, {
      lifecycleId: lc.lifecycle_id,
      enabled: true,
      redactedCategories: ['name', 'style', 'description']
    });
    assert.equal(config.enabled, 1);
    assert.equal(config.revealed_at, null);
    assert.deepEqual(config.redacted_categories, ['name', 'style', 'description']);
    assert.equal(isMysteryActive(config), true);

    // Reveal mystery
    const revealed = revealMystery(db, { lifecycleId: lc.lifecycle_id });
    assert.notEqual(revealed.revealed_at, null);
    assert.equal(isMysteryActive(revealed), false);

    // Cannot re-hide once revealed
    assert.throws(() => {
      setMysteryConfig(db, { lifecycleId: lc.lifecycle_id, enabled: true });
    }, /cannot be placed back/i);
  } finally {
    db.close();
  }
});

test('redactTapProjection redacts beer identity while preserving safety telemetry', () => {
  const tapProjection = {
    batch: {
      recipeName: 'Super Hazy IPA',
      style: 'New England IPA',
      abv: 7.2,
      ibu: 65,
      og: 1.068,
      fg: 1.014,
      srm: 6,
      description: 'Juicy tropical hop explosion',
      status: 'Fermenting'
    },
    volumeStatus: 'measured',
    volumeOz: 500,
    fillPercent: 75,
    pintsRemaining: 31
  };

  const mysteryConfig = {
    enabled: 1,
    revealed_at: null,
    redacted_categories: ['name', 'style', 'description']
  };

  const redacted = redactTapProjection(tapProjection, mysteryConfig);

  // Redacted identity fields
  assert.equal(redacted.batch.recipeName, 'Mystery Beer');
  assert.equal(redacted.batch.style, 'Mystery Style');
  assert.equal(redacted.batch.description, 'Identity hidden in Mystery Tap mode.');

  // Preserved safety & telemetry fields
  assert.equal(redacted.batch.abv, 7.2);
  assert.equal(redacted.volumeStatus, 'measured');
  assert.equal(redacted.volumeOz, 500);
  assert.equal(redacted.fillPercent, 75);
  assert.equal(redacted.pintsRemaining, 31);
});

test('redactBrewStory redacts recipe, sensory radar, and image when mystery is active', () => {
  const story = {
    batchId: 'batch-101',
    name: 'Secret Stout',
    style: 'Imperial Stout',
    abv: 10.5,
    description: 'Dark, rich chocolate and espresso',
    image: { url: 'https://example.com/stout.jpg' },
    sensory: { hidden: false, axes: { roast: 5, sweetness: 4 } },
    recipe: { name: 'Secret Recipe', hops: ['Fuggle'], malts: ['Maris Otter'] }
  };

  const mysteryConfig = {
    enabled: 1,
    revealed_at: null,
    redacted_categories: ['name', 'style', 'description', 'sensory', 'image', 'brew_story']
  };

  const redacted = redactBrewStory(story, mysteryConfig);

  assert.equal(redacted.name, 'Mystery Beer');
  assert.equal(redacted.style, 'Mystery Style');
  assert.equal(redacted.description, 'Recipe and tasting profile redacted during Mystery Tap mode.');
  assert.equal(redacted.image, null);
  assert.equal(redacted.sensory, null);
  assert.equal(redacted.recipe, null);
});
