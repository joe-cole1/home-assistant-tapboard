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

test('healthcheck is lightweight and public HTTP/SSE snapshots use only schema v2', async () => {
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
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(Object.keys(snapshot.tapStates), ['1', '2', '3', '4', '5', '6']);
    assert.equal(Object.hasOwn(snapshot, 'haStates'), false);
    assert.equal(stateText.includes('person.'), false);
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
    assert.match(eventText, /"tapStates":/);
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
