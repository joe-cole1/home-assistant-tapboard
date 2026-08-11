#!/usr/bin/env node
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildSensoryModelV1 } from '../src/sensoryEngine.js';
import { buildSensoryModelV2 } from '../src/sensoryEngineV2.js';
import { aggregateSensoryShadow, compareSensoryProfiles } from '../src/sensoryShadowReport.js';

const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const databaseFile = path.join(dataDirectory, 'tapboard.db');

function parseDetail(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let database;
try {
  database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  const rows = database
    .prepare(
      `SELECT b.*, d.payload_json
       FROM batches b
       LEFT JOIN brewfather_batch_details d ON d.batch_id=b.batch_id
       WHERE b.present=1
       ORDER BY b.batch_id`
    )
    .all();
  const comparisons = rows.map((row) => {
    const { payload_json: payloadJson, ...summary } = row;
    const detail = parseDetail(payloadJson);
    return compareSensoryProfiles(buildSensoryModelV1({ summary, detail }), buildSensoryModelV2({ summary, detail }));
  });
  console.log(
    JSON.stringify(
      {
        rules: { active: 'sensory-v1', candidate: 'sensory-v2' },
        batch_count: comparisons.length,
        ...aggregateSensoryShadow(comparisons)
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(`[Sensory shadow report] ${error.message}`);
  process.exitCode = 1;
} finally {
  database?.close();
}
