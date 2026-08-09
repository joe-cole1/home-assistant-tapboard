import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutosaveController } from '../public/autosave.js';

test('autosave serializes writes and coalesces a pending key to its newest value', async () => {
  const states = [];
  const completed = [];
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const autosave = createAutosaveController({ onStatus: (key, status) => states.push(`${key}:${status.state}`) });

  autosave.save('title', async () => {
    await first;
    completed.push('old title');
  });
  autosave.save('theme', async () => completed.push('theme'));
  autosave.save('theme', async () => completed.push('new theme'));
  releaseFirst();
  await autosave.flush();

  assert.deepEqual(completed, ['old title', 'new theme']);
  assert.ok(states.includes('title:saving'));
  assert.ok(states.includes('theme:saved'));
});

test('autosave reports failures but continues to later queued work', async () => {
  const states = [];
  const autosave = createAutosaveController({ onStatus: (key, status) => states.push(`${key}:${status.state}`) });
  autosave.save('bad', async () => {
    throw new Error('offline');
  });
  autosave.save('good', async () => {});
  await autosave.flush();
  assert.ok(states.includes('bad:error'));
  assert.ok(states.includes('good:saved'));
});
