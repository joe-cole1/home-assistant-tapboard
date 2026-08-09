import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildBrewStory, downsampleReadings, saveSensoryOverride, storyIsPublic } from '../src/brewStory.js';
import { migrateDatabase } from '../src/dbMigrations.js';

function database() {
  const db = new Database(':memory:');
  migrateDatabase(db);
  db.prepare(
    `INSERT INTO settings (id, admin_pin_hash, admin_pin_initialized, show_ondeck)
     VALUES (1, 'hash', 1, 1)`
  ).run();
  for (let tapId = 1; tapId <= 6; tapId++) db.prepare('INSERT INTO taps (tap_id) VALUES (?)').run(tapId);
  db.prepare(
    `INSERT INTO batches (
      batch_id, recipe_name, style, status, present, summary_fingerprint, detail_fingerprint,
      detail_fetched_at, last_success_at, estimated_ibu, estimated_abv
    ) VALUES ('batch-a', 'Story IPA', 'American IPA', 'Fermenting', 1, 'same', 'same',
      '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', 55, 6.5)`
  ).run();
  db.prepare(`INSERT INTO brewfather_ondeck_preferences (batch_id, visible) VALUES ('batch-a', 1)`).run();
  db.prepare(
    `INSERT INTO brewfather_batch_details (batch_id, payload_json, fingerprint, fetched_at)
     VALUES ('batch-a', ?, 'same', '2026-08-09T00:00:00.000Z')`
  ).run(
    JSON.stringify({
      image_url: 'https://images.example/private.png',
      batch: { taste_logs: [{ ratings: { bitterness: 4, alcohol: 3 } }] },
      recipe: {
        style: { name: 'American IPA' },
        ingredients: { hops: [{ name: 'Citra', use: 'Dry Hop' }], fermentables: [{ name: 'Pale Malt' }] }
      }
    })
  );
  return db;
}

test('public stories are restricted to assigned or visible On Deck batches', () => {
  const db = database();
  try {
    assert.equal(storyIsPublic(db, 'batch-a'), true);
    db.prepare("UPDATE brewfather_ondeck_preferences SET visible=0 WHERE batch_id='batch-a'").run();
    assert.equal(storyIsPublic(db, 'batch-a'), false);
    db.prepare("UPDATE taps SET batch_id='batch-a' WHERE tap_id=1").run();
    assert.equal(storyIsPublic(db, 'batch-a'), true);
    db.prepare('UPDATE batches SET present=0 WHERE batch_id=?').run('batch-a');
    assert.equal(storyIsPublic(db, 'batch-a'), false);
  } finally {
    db.close();
  }
});

test('story projection is bounded, stale-aware, lifecycle-scoped, and sensory-versioned', () => {
  const db = database();
  try {
    db.prepare("UPDATE taps SET batch_id='batch-a' WHERE tap_id=1").run();
    const lifecycle = db
      .prepare(
        `INSERT INTO keg_lifecycles (tap_id, batch_id, assignment_kind, started_at)
         VALUES (1, 'batch-a', 'brewfather', '2026-08-01T00:00:00.000Z')`
      )
      .run().lastInsertRowid;
    db.prepare(
      `INSERT INTO pour_logs (tap_id, batch_id, volume_poured_oz, timestamp, lifecycle_id, timestamp_epoch)
       VALUES (1, 'batch-a', 12, '2026-08-08T00:00:00.000Z', ?, 1786147200)`
    ).run(lifecycle);
    for (let index = 0; index < 800; index++) {
      const time = Date.parse('2026-08-01T00:00:00.000Z') + index * 60_000;
      db.prepare(
        `INSERT INTO brewfather_batch_readings
          (batch_id, reading_key, recorded_at, recorded_at_ms, sg, temp_c, ph, payload_json)
         VALUES ('batch-a', ?, ?, ?, ?, ?, ?, '{}')`
      ).run(`reading-${index}`, new Date(time).toISOString(), time, 1.06 - index / 100_000, 20 + (index % 4), 4.5);
    }
    saveSensoryOverride(db, 'batch-a', {
      hidden: false,
      description_override: 'Bright and bitter.',
      axis_overrides: { hops: 4.5 }
    });
    const story = buildBrewStory({
      db,
      batchId: 'batch-a',
      window: 'all',
      now: () => Date.parse('2026-08-10T00:00:00.000Z'),
      tapStates: { 1: { volumeOz: 400, fillPercent: 62.5, volumeStatus: 'measured' } },
      forecastForTap: () => ({ estimatedDaysRemaining: 10 })
    });
    assert.equal(story.schema_version, 1);
    assert.equal(story.telemetry.history.total_points, 800);
    assert.ok(story.telemetry.history.points.length <= 600);
    assert.equal(story.telemetry.history.downsampled, true);
    assert.equal(story.freshness.stale, true);
    assert.equal(story.tapboard.lifecycles[0].pours.total_oz, 12);
    assert.equal(story.tapboard.lifecycles[0].remaining.volume_oz, 400);
    assert.equal(story.sensory.rules_version, 'sensory-v1');
    assert.equal(story.sensory.axes.hops.value, 4.5);
    assert.equal(story.sensory.description, 'Bright and bitter.');
    assert.equal('image_url' in story.sections, false);
    assert.ok(Buffer.byteLength(JSON.stringify(story)) < 512 * 1024);
  } finally {
    db.close();
  }
});

test('downsampling retains endpoints and extrema without inventing missing axes', () => {
  const points = Array.from({ length: 1_200 }, (_, index) => ({
    reading_key: String(index),
    recorded_at_ms: index,
    sg: index === 500 ? 2 : 1,
    temp_c: index === 700 ? -10 : null,
    pressure: null,
    ph: null
  }));
  const sampled = downsampleReadings(points, 120);
  assert.equal(sampled[0].reading_key, '0');
  assert.equal(sampled.at(-1).reading_key, '1199');
  assert.ok(sampled.some((point) => point.reading_key === '500'));
  assert.ok(sampled.some((point) => point.reading_key === '700'));
  assert.ok(sampled.length <= 120);
});
