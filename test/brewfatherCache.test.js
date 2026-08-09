import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';
import {
  batchSummary,
  onDeckBatches,
  sanitizeDetail,
  sanitizeReading,
  sanitizeSummary,
  upsertDetail,
  upsertReadings,
  upsertSummaries
} from '../src/brewfatherCache.js';

function database() {
  const db = new Database(':memory:');
  migrateDatabase(db);
  db.prepare(
    `INSERT INTO settings (id, admin_pin_hash, admin_pin_initialized, ondeck_new_batch_default)
     VALUES (1, 'hash', 1, 1)`
  ).run();
  for (let tapId = 1; tapId <= 6; tapId++) db.prepare('INSERT INTO taps (tap_id) VALUES (?)').run(tapId);
  return db;
}

function summary(id = 'batch-a', status = 'Planning') {
  return {
    _id: id,
    name: 'Batch A',
    status,
    recipe: {
      _id: 'recipe-a',
      name: 'Privacy IPA',
      description: 'Citrus and pine',
      style: { name: 'American IPA' },
      ibu: 52,
      color: 7
    },
    measuredOg: 1.061,
    measuredFg: 1.012,
    measuredAbv: 6.4,
    brewDate: '2026-07-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z'
  };
}

test('summary cache is sanitized, idempotent, and tolerates missing optional fields', () => {
  const db = database();
  try {
    const sanitized = sanitizeSummary({ id: 'minimal', status: 'Brewing' });
    assert.equal(sanitized.recipe_name, 'Unknown Brew');
    assert.equal(sanitized.description, null);

    const first = upsertSummaries(db, [summary()], { now: () => 1_700_000_000_000 });
    const second = upsertSummaries(db, [summary()], { now: () => 1_700_000_001_000 });
    assert.deepEqual(first.changedIds, ['batch-a']);
    assert.deepEqual(second.changedIds, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM batches').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_ondeck_preferences').get().count, 1);
    assert.deepEqual(batchSummary(db, 'batch-a'), {
      batch_id: 'batch-a',
      batch_name: 'Batch A',
      batch_number: null,
      recipe_name: 'Privacy IPA',
      style: 'American IPA',
      description: 'Citrus and pine',
      brew_date: '2026-07-01T00:00:00.000Z',
      og: 1.061,
      fg: 1.012,
      abv: 6.4,
      ibu: 52,
      srm: 7,
      status: 'Planning',
      image_url: null,
      last_synced_at: '2023-11-14T22:13:21.000Z',
      present: 1
    });
  } finally {
    db.close();
  }
});

test('partial failures preserve last-known-good rows and complete refreshes only mark absence', () => {
  const db = database();
  try {
    upsertSummaries(db, [summary('present'), summary('missing')], { now: () => 1_000 });
    db.prepare('UPDATE brewfather_ondeck_preferences SET visible=0 WHERE batch_id=?').run('missing');

    upsertSummaries(db, [summary('present', 'Fermenting')], { now: () => 2_000, complete: false });
    assert.equal(db.prepare('SELECT present FROM batches WHERE batch_id=?').get('missing').present, 1);

    upsertSummaries(db, [summary('present', 'Conditioning')], { now: () => 3_000, complete: true });
    assert.equal(db.prepare('SELECT present FROM batches WHERE batch_id=?').get('missing').present, 0);
    assert.equal(
      db.prepare('SELECT visible FROM brewfather_ondeck_preferences WHERE batch_id=?').get('missing').visible,
      0
    );
    assert.deepEqual(
      onDeckBatches(db).map((row) => row.batch_id),
      ['present']
    );
  } finally {
    db.close();
  }
});

test('details are allowlisted and bounded without leaking arbitrary keys', () => {
  const db = database();
  try {
    upsertSummaries(db, [summary()], { now: () => 1_000 });
    const detail = {
      name: 'Batch A',
      status: 'Planning',
      notes: 'future story context',
      accessToken: 'must-not-survive',
      events: [{ id: 'event-1', name: 'Dry hop', description: 'Added hops', secret: 'no' }],
      tags: ['competition', '<script>text only</script>'],
      measuredPh: 4.4,
      recipe: {
        _id: 'recipe-a',
        name: 'Privacy IPA',
        notes: 'recipe note',
        fermentables: Array.from({ length: 150 }, (_, index) => ({
          name: `Malt ${index}`,
          amount: 1,
          percentage: index === 0 ? 80 : 0
        }))
      }
    };
    const sanitized = sanitizeDetail(detail);
    assert.ok(Buffer.byteLength(sanitized.payload_json) <= 262_144);
    assert.equal(sanitized.payload_json.includes('must-not-survive'), false);
    assert.equal(sanitized.payload_json.includes('"secret"'), false);
    assert.equal(JSON.parse(sanitized.payload_json).recipe.ingredients.fermentables.length, 100);
    assert.equal(JSON.parse(sanitized.payload_json).batch.measurements.measured_ph, 4.4);
    upsertDetail(db, 'batch-a', detail, { now: () => 2_000 });
    upsertDetail(db, 'batch-a', detail, { now: () => 3_000 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_batch_details').get().count, 1);
  } finally {
    db.close();
  }
});

test('readings use deterministic identities and deduplicate idempotently', () => {
  const db = database();
  try {
    upsertSummaries(db, [summary()], { now: () => 1_000 });
    const reading = { timestamp: '2026-01-01T00:00:00Z', gravity: 1.01, temp: 20, ph: 4.2, id: 'device-color' };
    const first = sanitizeReading(reading);
    const second = sanitizeReading(reading);
    assert.equal(first.reading_key, second.reading_key);
    assert.equal(first.ph, 4.2);
    assert.equal(sanitizeReading({ timestamp: 'not-a-date' }), null);
    upsertReadings(db, 'batch-a', [reading]);
    upsertReadings(db, 'batch-a', [reading]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM brewfather_batch_readings').get().count, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.throws(() => upsertReadings(db, 'absent-batch', [reading]), /FOREIGN KEY constraint failed/);
  } finally {
    db.close();
  }
});
