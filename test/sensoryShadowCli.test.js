import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/dbMigrations.js';

test('shadow report reads current cache data and emits aggregates without beer identifiers', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tapboard-sensory-shadow-'));
  const databaseFile = path.join(directory, 'tapboard.db');
  const db = new Database(databaseFile);
  try {
    migrateDatabase(db);
    db.prepare(
      `INSERT INTO batches (batch_id, recipe_name, style, status, present, estimated_ibu)
       VALUES ('private-batch-id', 'Private beer name', 'American IPA', 'Planning', 1, 60)`
    ).run();
    db.prepare(
      `INSERT INTO brewfather_batch_details (batch_id, payload_json, fingerprint, fetched_at)
       VALUES ('private-batch-id', ?, 'fingerprint', '2026-08-11T00:00:00.000Z')`
    ).run(
      JSON.stringify({
        batch: { measurements: { target_og: 1.06, target_fg: 1.01, target_batch_volume_l: 20 } },
        recipe: { ingredients: { hops: [{ amount: 0.1, use: 'Dry Hop' }] } }
      })
    );
  } finally {
    db.close();
  }

  try {
    const result = spawnSync(process.execPath, ['scripts/sensory-shadow-report.js'], {
      cwd: path.resolve('.'),
      env: { ...process.env, DATA_DIR: directory },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.batch_count, 1);
    assert.equal(report.rules.active, 'sensory-v1');
    assert.equal(report.rules.candidate, 'sensory-v2');
    assert.equal(report.axes.hops.count, 1);
    assert.equal(result.stdout.includes('private-batch-id'), false);
    assert.equal(result.stdout.includes('Private beer name'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
