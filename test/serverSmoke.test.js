import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The server may not be listening yet; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

test('healthcheck is lightweight and public HTTP/SSE snapshots use schema v9 health and planning state', async () => {
  const port = await reservePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-server-smoke-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HA_TOKEN: '',
      DOTENV_CONFIG_PATH: path.join(dataDir, '.env-unused')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForServer(`${baseUrl}/healthz`, child);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(health.headers.get('cache-control'), 'no-store');

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    const stateText = await stateResponse.text();
    const snapshot = JSON.parse(stateText);
    assert.equal(snapshot.schemaVersion, 9);
    assert.deepEqual(snapshot.settings, {
      id: 1,
      theme: 'modern_dark',
      volume_format: 'oz',
      title: 'Hazardous Brews',
      font_title: 'Outfit',
      font_body: 'Inter',
      show_ondeck: 1,
      layout_mode: 'cozy',
      ondeck_new_batch_default: 1,
      primary_color: null,
      secondary_color: null,
      first_pour_effects: 1,
      kick_effects: 1,
      ceremony_sound: 'pub_bell'
    });
    assert.deepEqual(snapshot.onDeckBatches, []);
    assert.deepEqual(snapshot.customBeverage, {
      id: 'custom:topo_chico',
      name: 'Topo Chico',
      style: 'Sparkling Water',
      abv: 0,
      ibu: 0,
      og: 1,
      fg: 1,
      srm: 0,
      description: 'Sparkling mineral water',
      assignmentOption: 'custom:topo_chico | Tapboard Custom Beverage'
    });
    assert.deepEqual(Object.keys(snapshot.tapStates), ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(snapshot.lifecycleMilestones, {});
    assert.equal(snapshot.draftHealth.schemaVersion, 1);
    assert.equal(snapshot.draftHealth.checks.length, 30);
    assert.equal(snapshot.tapPlanning.schemaVersion, 1);
    assert.equal(snapshot.tapPlanning.taps.length, snapshot.taps.filter((tap) => tap.enabled === 1).length);
    assert.equal(Object.hasOwn(snapshot, 'haStates'), false);
    assert.equal(stateText.includes('person.'), false);
    assert.equal(stateText.includes('entity_id'), false);
    assert.equal(stateText.includes('maintenance_note'), false);
    assert.ok(Buffer.byteLength(stateText) < 32 * 1024);

    const controller = new AbortController();
    const eventsResponse = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    const reader = eventsResponse.body.getReader();
    let eventText = '';
    while (
      !eventText.includes('event: snapshot') ||
      !eventText.includes('\n\n', eventText.indexOf('event: snapshot'))
    ) {
      const { value, done } = await reader.read();
      if (done) break;
      eventText += new TextDecoder().decode(value);
    }
    controller.abort();
    assert.match(eventText, /event: snapshot\n/);
    assert.match(eventText, /"schemaVersion":9/);
    assert.match(eventText, /"tapStates":/);
    assert.match(eventText, /"draftHealth":/);
    assert.match(eventText, /"tapPlanning":/);
    assert.doesNotMatch(eventText, /"haStates":/);

    console.log(`seeded public snapshot measurement: ${Buffer.byteLength(stateText)} bytes`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2_000).unref();
    });
    assert.equal(stderr.includes('SyntaxError'), false, stderr);
  }
});
