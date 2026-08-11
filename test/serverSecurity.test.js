import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MAX_JSON_BYTES, SECURITY_HEADERS } from '../src/httpSecurity.js';

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

async function waitForServer(baseUrl, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${stderr.value}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The server may not be listening yet; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not start: ${stderr.value}`);
}

async function startServer({ initialPin = '2468', publicOrigin = '' } = {}) {
  const port = await reservePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tapboard-server-security-'));
  const stderr = { value: '' };
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HA_TOKEN: '',
      TAPBOARD_INITIAL_ADMIN_PIN: initialPin,
      TAPBOARD_PUBLIC_ORIGIN: publicOrigin,
      DOTENV_CONFIG_PATH: path.join(dataDir, '.env-unused')
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (chunk) => {
    stderr.value += chunk;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, stderr);
  return { baseUrl, child, dataDir, stderr };
}

async function stopServer(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 2_000).unref();
  });
}

async function authenticate(baseUrl, pin = '2468') {
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  assert.equal(response.status, 200);
  return await response.json();
}

test('server applies exact headers, strict origin checks, and OPTIONS behavior', async () => {
  const instance = await startServer();
  try {
    for (const pathname of ['/', '/healthz', '/api/state']) {
      const response = await fetch(`${instance.baseUrl}${pathname}`);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('strict-transport-security'), null);
    }

    const controller = new AbortController();
    const events = await fetch(`${instance.baseUrl}/events`, { signal: controller.signal });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(events.headers.get(name), value);
    controller.abort();

    const foreign = await fetch(`${instance.baseUrl}/api/state`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);

    const options = await fetch(`${instance.baseUrl}/api/settings`, {
      method: 'OPTIONS',
      headers: { Origin: instance.baseUrl }
    });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('allow'), 'POST, OPTIONS');
    assert.equal(options.headers.get('access-control-allow-origin'), null);

    const noOriginOptions = await fetch(`${instance.baseUrl}/api/state`, { method: 'OPTIONS' });
    assert.equal(noOriginOptions.status, 204);
    assert.equal(noOriginOptions.headers.get('allow'), 'GET, OPTIONS');

    const wrongApiMethod = await fetch(`${instance.baseUrl}/api/auth`);
    assert.equal(wrongApiMethod.status, 405);
    assert.equal(wrongApiMethod.headers.get('allow'), 'POST');
    assert.deepEqual(await wrongApiMethod.json(), { error: 'Method not allowed' });

    const wrongStaticMethod = await fetch(`${instance.baseUrl}/`, { method: 'POST' });
    assert.equal(wrongStaticMethod.status, 405);
  } finally {
    await stopServer(instance.child);
  }
});

test('Brew Story routes enforce public visibility and authenticated sensory overrides', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    database
      .prepare(
        `INSERT INTO batches
        (batch_id, recipe_name, style, status, present, summary_fingerprint, detail_fingerprint, detail_fetched_at)
       VALUES ('story-a', 'Private Story', 'IPA', 'Planning', 1, 'v1', 'v1', '2026-08-09T00:00:00.000Z')`
      )
      .run();
    database.prepare(`INSERT INTO brewfather_ondeck_preferences (batch_id, visible) VALUES ('story-a', 0)`).run();
    database
      .prepare(
        `INSERT INTO brewfather_batch_details (batch_id, payload_json, fingerprint, fetched_at)
       VALUES ('story-a', '{"batch":{"sensory_v2_souring":"Kettle sour"},"recipe":{"sensory_v2_souring":true}}', 'v1', '2026-08-09T00:00:00.000Z')`
      )
      .run();

    assert.equal((await fetch(`${instance.baseUrl}/api/batches/story-a/story`)).status, 404);
    assert.equal((await fetch(`${instance.baseUrl}/api/batches/story-a/story?tap_id=1`)).status, 404);
    assert.equal((await fetch(`${instance.baseUrl}/api/batches/story-a/story?tap_id=2`)).status, 404);
    const { token } = await authenticate(instance.baseUrl);
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${instance.baseUrl}/api/batches/story-a/story`, { headers: auth })).status, 200);

    database.prepare("UPDATE brewfather_ondeck_preferences SET visible=1 WHERE batch_id='story-a'").run();
    const publicStory = await fetch(`${instance.baseUrl}/api/batches/story-a/story?window=7d`);
    assert.equal(publicStory.status, 200);
    const storyText = await publicStory.text();
    assert.ok(Buffer.byteLength(storyText) < 512 * 1024);
    const publicPayload = JSON.parse(storyText);
    assert.equal(publicPayload.schema_version, 6);
    assert.equal(publicPayload.sensory.rules_version, 'sensory-v2');
    assert.equal('override' in publicPayload.sensory, false);
    assert.equal('shadow' in publicPayload.sensory, false);
    assert.equal('sensory_v2_souring' in (publicPayload.sections?.batch || {}), false);
    assert.equal('sensory_v2_souring' in (publicPayload.sections?.recipe || {}), false);

    const sensory = await fetch(`${instance.baseUrl}/api/batches/story-a/sensory`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description_override: 'Manual public description', axis_overrides: { hops: 4.5 } })
    });
    assert.equal(sensory.status, 200);
    assert.equal((await sensory.json()).sensory.axes.hops, 4.5);
    const adminPayload = await (await fetch(`${instance.baseUrl}/api/batches/story-a/story`, { headers: auth })).json();
    assert.deepEqual(adminPayload.sensory.override, {
      hidden: false,
      description_override: 'Manual public description',
      axis_overrides: { hops: 4.5 }
    });
    assert.equal(adminPayload.sensory.rules_version, 'sensory-v2');
    assert.equal(adminPayload.sensory.axes.hops.value, 4.5);
    assert.equal('shadow' in adminPayload.sensory, false);
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/batches/story-a/sensory`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ axis_overrides: { hops: 4.3 } })
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/batches/story-a/sensory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
      ).status,
      401
    );
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('configured reverse-proxy origin is exact for normal and OPTIONS requests', async () => {
  const publicOrigin = 'https://tapboard.example';
  const instance = await startServer({ publicOrigin });
  try {
    assert.equal((await fetch(`${instance.baseUrl}/api/state`, { headers: { Origin: publicOrigin } })).status, 200);
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/state`, { method: 'OPTIONS', headers: { Origin: publicOrigin } })).status,
      204
    );
    assert.equal((await fetch(`${instance.baseUrl}/api/state`, { headers: { Origin: instance.baseUrl } })).status, 403);
  } finally {
    await stopServer(instance.child);
  }
});

test('JSON body policy returns 400, 413, and 415 before settings mutation', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const { token } = await authenticate(instance.baseUrl);
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/settings`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'text/plain' },
          body: '{}'
        })
      ).status,
      415
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/settings`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{'
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/settings`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: ''
        })
      ).status,
      400
    );
    const oversized = JSON.stringify({ title: 'x'.repeat(MAX_JSON_BYTES) });
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/settings`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: oversized
        })
      ).status,
      413
    );
    assert.equal(database.prepare('SELECT title FROM settings WHERE id = 1').get().title, 'Hazardous Brews');
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('route validation rejects invalid IDs, fields, ranges, and bodyless action data without mutation', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const before = database.prepare('SELECT graphic, batch_id FROM taps WHERE tap_id = 1').get();
    assert.equal((await fetch(`${instance.baseUrl}/api/taps/01`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/taps/1`, {
          method: 'POST',
          headers,
          body: '{"graphic":"script","unknown":true}'
        })
      ).status,
      400
    );
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/1`, { method: 'POST', headers, body: '{"custom_pour_size":129}' }))
        .status,
      400
    );
    for (const capacity of [15, 2049, 640.5, '640.5']) {
      assert.equal(
        (
          await fetch(`${instance.baseUrl}/api/taps/1`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ capacity_oz: capacity })
          })
        ).status,
        400
      );
    }
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/taps/1`, {
          method: 'POST',
          headers,
          body: '{"batch_option":"not a current option"}'
        })
      ).status,
      400
    );
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/1/end-keg`, { method: 'POST', headers, body: '{"unexpected":true}' }))
        .status,
      400
    );
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/settings`, { method: 'POST', headers, body: '{"unknown":true}' })).status,
      400
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/catalog`, {
          method: 'POST',
          headers,
          body: '{"name":"IPA","unknown":true}'
        })
      ).status,
      404
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM beverage_catalog').get().count, 0);
    assert.deepEqual(database.prepare('SELECT graphic, batch_id FROM taps WHERE tap_id = 1').get(), before);

    // An empty JSON object is a valid body shape. With no assignment the local
    // End Keg action rejects without involving Home Assistant.
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/1/end-keg`, { method: 'POST', headers, body: '{}' })).status,
      409
    );
    assert.deepEqual(database.prepare('SELECT graphic, batch_id FROM taps WHERE tap_id = 1').get(), before);
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('capacity writes require authorization and fail without a local tap mutation when HA rejects them', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const headers = { 'Content-Type': 'application/json' };
    const payload = JSON.stringify({ capacity_oz: 768, graphic: 'mug' });
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/1`, { method: 'POST', headers, body: payload })).status,
      401
    );

    const { token } = await authenticate(instance.baseUrl);
    const authorized = { ...headers, Authorization: `Bearer ${token}` };
    const before = database.prepare('SELECT graphic FROM taps WHERE tap_id = 1').get();
    const response = await fetch(`${instance.baseUrl}/api/taps/1`, {
      method: 'POST',
      headers: authorized,
      body: payload
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Home Assistant capacity update failed' });
    assert.deepEqual(database.prepare('SELECT graphic FROM taps WHERE tap_id = 1').get(), before);
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('tokens are stored as digests, expired sessions are pruned, and PIN change revokes every session', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const first = await authenticate(instance.baseUrl);
    const second = await authenticate(instance.baseUrl);
    const stored = database
      .prepare('SELECT token FROM admin_sessions ORDER BY token')
      .all()
      .map((row) => row.token);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((token) => /^sha256:[a-f0-9]{64}$/.test(token)));
    assert.ok(stored.every((token) => token !== first.token && token !== second.token));

    database
      .prepare("INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', '-1 second'))")
      .run(`sha256:${'f'.repeat(64)}`);
    const update = await fetch(`${instance.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${first.token}` },
      body: '{"title":"Secured"}'
    });
    assert.equal(update.status, 200);
    assert.equal(
      database.prepare("SELECT COUNT(*) count FROM admin_sessions WHERE datetime(expires_at) <= datetime('now')").get()
        .count,
      0
    );

    const pinChange = await fetch(`${instance.baseUrl}/api/admin/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${first.token}` },
      body: '{"current_pin":"2468","new_pin":"1357","confirm_new_pin":"1357"}'
    });
    assert.equal(pinChange.status, 200);
    assert.deepEqual(await pinChange.json(), { success: true, sessionsRevoked: true });
    assert.equal(database.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count, 0);
    for (const token of [first.token, second.token]) {
      assert.equal(
        (
          await fetch(`${instance.baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: '{}'
          })
        ).status,
        401
      );
    }
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('PIN change verifies the current PIN, validates replacement values, limits guesses, and revokes sessions', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const first = await authenticate(instance.baseUrl);
    await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${first.token}` };
    const beforeHash = database.prepare('SELECT admin_pin_hash FROM settings WHERE id = 1').get().admin_pin_hash;
    for (const body of [
      { current_pin: '9999', new_pin: '1357', confirm_new_pin: '1357' },
      { current_pin: '2468', new_pin: '1357', confirm_new_pin: '2468' },
      { current_pin: '2468', new_pin: '2468', confirm_new_pin: '2468' },
      { current_pin: '2468', new_pin: '0000', confirm_new_pin: '0000' }
    ]) {
      const response = await fetch(`${instance.baseUrl}/api/admin/pin`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      assert.equal(response.status, body.current_pin === '9999' ? 403 : 400);
      assert.equal(
        database.prepare('SELECT admin_pin_hash FROM settings WHERE id = 1').get().admin_pin_hash,
        beforeHash
      );
      assert.equal(database.prepare('SELECT COUNT(*) count FROM admin_sessions').get().count, 2);
    }

    // Four further failures plus the first one above exhaust this endpoint's
    // independent limit without invalidating the already authenticated token.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${instance.baseUrl}/api/admin/pin`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ current_pin: '9999', new_pin: '1357', confirm_new_pin: '1357' })
      });
      assert.equal(response.status, 403);
    }
    const limited = await fetch(`${instance.baseUrl}/api/admin/pin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ current_pin: '9999', new_pin: '1357', confirm_new_pin: '1357' })
    });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after') || '', /^\d+$/);
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('PIN change accepts the new credential and settings color overrides persist and reset', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const colors = await fetch(`${instance.baseUrl}/api/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ primary_color: '#abc123', secondary_color: '#0dEeF0' })
    });
    assert.equal(colors.status, 200);
    assert.deepEqual((await colors.json()).settings, {
      id: 1,
      theme: 'modern_dark',
      volume_format: 'oz',
      title: 'Hazardous Brews',
      font_title: 'Outfit',
      font_body: 'Inter',
      show_ondeck: 1,
      layout_mode: 'cozy',
      ondeck_new_batch_default: 1,
      primary_color: '#ABC123',
      secondary_color: '#0DEEF0',
      first_pour_effects: 1,
      kick_effects: 1,
      ceremony_sound: 'pub_bell'
    });
    assert.equal((await (await fetch(`${instance.baseUrl}/api/state`)).json()).settings.primary_color, '#ABC123');
    const reset = await fetch(`${instance.baseUrl}/api/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ primary_color: null, secondary_color: null })
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(database.prepare('SELECT primary_color, secondary_color FROM settings WHERE id = 1').get(), {
      primary_color: null,
      secondary_color: null
    });
    const invalid = await fetch(`${instance.baseUrl}/api/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ primary_color: '#abc' })
    });
    assert.equal(invalid.status, 400);

    const changed = await fetch(`${instance.baseUrl}/api/admin/pin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ current_pin: '2468', new_pin: '1357', confirm_new_pin: '1357' })
    });
    assert.equal(changed.status, 200);
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '2468' })
        })
      ).status,
      401
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '1357' })
        })
      ).status,
      200
    );
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('global settings can hide and show taps', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    for (const visible of [false, true]) {
      const response = await fetch(`${instance.baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tap_visibilities: { 1: visible } })
      });
      assert.equal(response.status, 200);
      assert.equal(database.prepare('SELECT enabled FROM taps WHERE tap_id = 1').get().enabled, visible ? 1 : 0);
    }
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('assignment lifecycles preserve pour history and rotate after a clear', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const body = JSON.stringify({ batch_option: 'custom:topo_chico | Tapboard Custom Beverage' });

    database.prepare('INSERT INTO pour_logs (tap_id, volume_poured_oz) VALUES (1, 12)').run();
    assert.equal((await fetch(`${instance.baseUrl}/api/taps/1`, { method: 'POST', headers, body })).status, 200);
    const assigned = database.prepare('SELECT batch_id, on_tap_at FROM taps WHERE tap_id = 1').get();
    assert.equal(assigned.batch_id, 'custom:topo_chico');
    assert.ok(Number.isFinite(Date.parse(assigned.on_tap_at)));
    const firstLifecycle = database
      .prepare('SELECT lifecycle_id FROM keg_lifecycles WHERE tap_id = 1 AND closed_at IS NULL')
      .get().lifecycle_id;
    assert.equal(database.prepare('SELECT COUNT(*) count FROM pour_logs WHERE tap_id = 1').get().count, 1);

    database.prepare('INSERT INTO pour_logs (tap_id, volume_poured_oz) VALUES (1, 8)').run();
    database.prepare("UPDATE taps SET on_tap_at = '2026-01-02T03:04:05.000Z' WHERE tap_id = 1").run();
    assert.equal((await fetch(`${instance.baseUrl}/api/taps/1`, { method: 'POST', headers, body })).status, 200);
    assert.equal(
      database.prepare('SELECT on_tap_at FROM taps WHERE tap_id = 1').get().on_tap_at,
      '2026-01-02T03:04:05.000Z'
    );
    assert.equal(database.prepare('SELECT COUNT(*) count FROM pour_logs WHERE tap_id = 1').get().count, 2);

    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/taps/1`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ batch_option: '' })
        })
      ).status,
      200
    );
    assert.deepEqual(database.prepare('SELECT batch_id, on_tap_at FROM taps WHERE tap_id = 1').get(), {
      batch_id: null,
      on_tap_at: null
    });
    assert.equal(database.prepare('SELECT COUNT(*) count FROM pour_logs WHERE tap_id = 1').get().count, 2);
    assert.equal(
      database
        .prepare('SELECT closed_at IS NOT NULL closed FROM keg_lifecycles WHERE lifecycle_id = ?')
        .get(firstLifecycle).closed,
      1
    );

    assert.equal((await fetch(`${instance.baseUrl}/api/taps/1`, { method: 'POST', headers, body })).status, 200);
    const secondLifecycle = database
      .prepare('SELECT lifecycle_id FROM keg_lifecycles WHERE tap_id = 1 AND closed_at IS NULL')
      .get().lifecycle_id;
    assert.notEqual(secondLifecycle, firstLifecycle);
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/1/end-keg`, { method: 'POST', headers, body: '{}' })).status,
      200
    );
    assert.equal(database.prepare('SELECT batch_id FROM taps WHERE tap_id=1').get().batch_id, null);
    assert.equal(
      database.prepare('SELECT close_reason FROM keg_lifecycles WHERE lifecycle_id=?').get(secondLifecycle)
        .close_reason,
      'end_keg'
    );
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('native cached batches assign without HA projections and failed End Batch preserves local state', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    database
      .prepare(
        `INSERT INTO batches(batch_id, recipe_name, style, description, status, present, last_success_at)
         VALUES('native-1', 'Native IPA', 'American IPA', 'Native description', 'Conditioning', 1,
           '2026-08-09T00:00:00.000Z')`
      )
      .run();
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const assigned = await fetch(`${instance.baseUrl}/api/taps/3`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ batch_option: 'native-1 | Native IPA (Conditioning)' })
    });
    assert.equal(assigned.status, 200);
    const snapshot = await (await fetch(`${instance.baseUrl}/api/state`)).json();
    assert.equal(snapshot.tapStates['3'].batch.batchId, 'native-1');
    assert.equal(snapshot.tapStates['3'].batch.description, 'Native description');
    assert.equal(snapshot.haConnected, false);

    const lifecycle = database
      .prepare('SELECT lifecycle_id FROM keg_lifecycles WHERE tap_id=3 AND closed_at IS NULL')
      .get();
    assert.ok(lifecycle.lifecycle_id);
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/3/end-batch`, { method: 'POST', headers, body: '{}' })).status,
      503
    );
    assert.equal(database.prepare('SELECT batch_id FROM taps WHERE tap_id=3').get().batch_id, 'native-1');
    assert.equal(
      database.prepare('SELECT closed_at FROM keg_lifecycles WHERE lifecycle_id=?').get(lifecycle.lifecycle_id)
        .closed_at,
      null
    );
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/taps/3/end-keg`, { method: 'POST', headers, body: '{}' })).status,
      200
    );
    assert.equal(database.prepare('SELECT batch_id FROM taps WHERE tap_id=3').get().batch_id, null);
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('Brewfather assignments choose matching fill graphics while custom, unknown, and explicit values preserve intent', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    database
      .prepare(
        `INSERT INTO batches(batch_id, recipe_name, style, status, present)
         VALUES
          ('fill-ipa', 'Fill IPA', 'American IPA', 'Conditioning', 1),
          ('fill-unknown', 'Fill Unknown', 'Mystery Beverage', 'Conditioning', 1)`
      )
      .run();
    database.prepare("UPDATE taps SET graphic='mug' WHERE tap_id IN (1, 2, 3)").run();
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const updateTap = async (tapId, body) => {
      const response = await fetch(`${instance.baseUrl}/api/taps/${tapId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
    };

    await updateTap(1, { batch_option: 'fill-ipa | Fill IPA (Conditioning)' });
    assert.equal(database.prepare('SELECT graphic FROM taps WHERE tap_id=1').get().graphic, 'ipa_glass');

    await updateTap(1, { batch_option: 'fill-ipa | Fill IPA (Conditioning)', graphic: 'teku' });
    assert.equal(database.prepare('SELECT graphic FROM taps WHERE tap_id=1').get().graphic, 'teku');

    await updateTap(2, { batch_option: 'fill-unknown | Fill Unknown (Conditioning)' });
    assert.equal(database.prepare('SELECT graphic FROM taps WHERE tap_id=2').get().graphic, 'mug');

    await updateTap(3, { batch_option: 'custom:topo_chico | Tapboard Custom Beverage' });
    assert.equal(database.prepare('SELECT graphic FROM taps WHERE tap_id=3').get().graphic, 'mug');
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('override-only beverages own one lifecycle until explicitly cleared', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const { token } = await authenticate(instance.baseUrl);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/taps/2`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ override_enabled: true, override_name: 'House Soda' })
        })
      ).status,
      200
    );
    const first = database
      .prepare(
        `SELECT lifecycle_id, assignment_kind, batch_id
      FROM keg_lifecycles WHERE tap_id = 2 AND closed_at IS NULL`
      )
      .get();
    assert.deepEqual(
      { assignment_kind: first.assignment_kind, batch_id: first.batch_id },
      { assignment_kind: 'override', batch_id: null }
    );

    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/taps/2`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ override_name: 'House Soda Corrected' })
        })
      ).status,
      200
    );
    assert.equal(
      database.prepare('SELECT lifecycle_id FROM keg_lifecycles WHERE tap_id = 2 AND closed_at IS NULL').get()
        .lifecycle_id,
      first.lifecycle_id
    );

    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/taps/2`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ override_enabled: false })
        })
      ).status,
      200
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) count FROM keg_lifecycles WHERE tap_id = 2 AND closed_at IS NULL').get().count,
      0
    );
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('On Deck and custom beverage APIs require authentication, validate strictly, and persist one canonical value', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${instance.baseUrl}/api/ondeck`)).status, 401);
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/custom-beverage`, { method: 'POST', headers: json, body: '{}' })).status,
      401
    );

    const { token } = await authenticate(instance.baseUrl);
    const headers = { ...json, Authorization: `Bearer ${token}` };
    const listed = await fetch(`${instance.baseUrl}/api/ondeck`, { headers });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(listedBody.batches, []);
    assert.equal(listedBody.show_ondeck, true);
    assert.equal(listedBody.haConnected, false);
    assert.equal(listedBody.brewfather.configured, false);
    assert.equal(listedBody.brewfather.status, 'not_configured');

    const hideOnDeck = await fetch(`${instance.baseUrl}/api/ondeck`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ batches: [], show_ondeck: false })
    });
    assert.equal(hideOnDeck.status, 200);
    const hiddenBody = await hideOnDeck.json();
    assert.equal(hiddenBody.success, true);
    assert.deepEqual(hiddenBody.batches, []);
    assert.equal(hiddenBody.show_ondeck, false);
    assert.equal(hiddenBody.brewfather.configured, false);
    assert.equal(database.prepare('SELECT show_ondeck FROM settings WHERE id = 1').get().show_ondeck, 0);
    const hiddenSnapshot = await (await fetch(`${instance.baseUrl}/api/state`)).json();
    assert.equal(hiddenSnapshot.settings.show_ondeck, 0);
    assert.deepEqual(hiddenSnapshot.onDeckBatches, []);
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/ondeck`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ batches: [{ batch_id: 'bf-planned-1', visible: 'yes' }] })
        })
      ).status,
      400
    );
    assert.equal(
      (await fetch(`${instance.baseUrl}/api/brewfather/refresh`, { method: 'POST', headers, body: '{}' })).status,
      503
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/brewfather/refresh`, {
          method: 'POST',
          headers,
          body: '{"unexpected":true}'
        })
      ).status,
      400
    );

    const custom = {
      name: 'Lime Soda',
      style: 'Sparkling Water',
      abv: 0,
      ibu: 0,
      og: 1,
      fg: 1,
      srm: 0,
      description: 'House-made lime soda'
    };
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/custom-beverage`, {
          method: 'POST',
          headers,
          body: JSON.stringify(custom)
        })
      ).status,
      200
    );
    assert.deepEqual(
      database
        .prepare('SELECT name, style, abv, ibu, og, fg, srm, description FROM custom_beverage WHERE id = ?')
        .get('custom:topo_chico'),
      custom
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/custom-beverage`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...custom, abv: 101 })
        })
      ).status,
      400
    );
    const withoutAbv = { ...custom };
    delete withoutAbv.abv;
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/custom-beverage`, {
          method: 'POST',
          headers,
          body: JSON.stringify(withoutAbv)
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${instance.baseUrl}/api/custom-beverage`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...custom, unexpected: true })
        })
      ).status,
      400
    );
    const snapshot = await (await fetch(`${instance.baseUrl}/api/state`)).json();
    assert.equal(snapshot.schemaVersion, 8);
    assert.deepEqual(snapshot.customBeverage, {
      id: 'custom:topo_chico',
      ...custom,
      assignmentOption: 'custom:topo_chico | Tapboard Custom Beverage'
    });
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('Brewfather status requires authentication and exposes only safe unconfigured status', async () => {
  const instance = await startServer();
  try {
    const unauthorized = await fetch(`${instance.baseUrl}/api/brewfather/status`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'Unauthorized' });

    const { token } = await authenticate(instance.baseUrl);
    const authorized = await fetch(`${instance.baseUrl}/api/brewfather/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(authorized.status, 200);
    const { brewfather } = await authorized.json();
    assert.equal(brewfather.configured, false);
    assert.equal(brewfather.status, 'not_configured');
    assert.equal(brewfather.error_category, 'configuration');
    assert.equal(brewfather.stale, true);
    assert.equal(brewfather.has_cache, false);
    assert.equal(brewfather.cache_status, 'empty');
    assert.equal(brewfather.budget, null);

    const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
    database
      .prepare("INSERT INTO batches(batch_id, recipe_name, status) VALUES('retained', 'Retained', 'Completed')")
      .run();
    const cached = await (
      await fetch(`${instance.baseUrl}/api/brewfather/status`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json();
    assert.equal(cached.brewfather.has_cache, true);
    assert.equal(cached.brewfather.cache_status, 'stale');

    database.prepare("UPDATE brewfather_sync_state SET status = 'running' WHERE id = 1").run();
    const running = await (
      await fetch(`${instance.baseUrl}/api/brewfather/status`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ).json();
    assert.equal(running.brewfather.has_cache, true);
    assert.equal(running.brewfather.cache_status, 'refreshing');
    database.close();

    const wrongMethod = await fetch(`${instance.baseUrl}/api/brewfather/status`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
  } finally {
    await stopServer(instance.child);
  }
});

test('simulation is absent and traversal variants cannot escape public', async () => {
  const instance = await startServer();
  const database = new Database(path.join(instance.dataDir, 'tapboard.db'));
  try {
    const before = database.prepare('SELECT COUNT(*) count FROM pour_logs').get().count;
    assert.equal((await fetch(`${instance.baseUrl}/api/taps/1/simulate-pour`, { method: 'POST' })).status, 404);
    assert.equal(database.prepare('SELECT COUNT(*) count FROM pour_logs').get().count, before);
    const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.equal(source.includes('simulate-pour'), false);

    assert.equal((await fetch(`${instance.baseUrl}/..%2farchitecture.md`)).status, 403);
    assert.equal((await fetch(`${instance.baseUrl}/..%5carchitecture.md`)).status, 400);
    assert.equal((await fetch(`${instance.baseUrl}/bad%00name`)).status, 400);
    assert.equal((await fetch(`${instance.baseUrl}/%E0%A4%A`)).status, 400);
    assert.equal((await fetch(`${instance.baseUrl}/%252e%252e%252farchitecture.md`)).status, 404);
    assert.equal((await fetch(`${instance.baseUrl}/../architecture.md`)).status, 404);
    assert.equal((await fetch(`${instance.baseUrl}/app.js`, { method: 'HEAD' })).status, 200);
  } finally {
    database.close();
    await stopServer(instance.child);
  }
});

test('uninitialized installations keep the dashboard public but reject auth and mutations with 409', async () => {
  const instance = await startServer({ initialPin: '' });
  try {
    assert.equal((await fetch(`${instance.baseUrl}/`)).status, 200);
    const auth = await fetch(`${instance.baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"pin":"0000"}'
    });
    assert.equal(auth.status, 409);
    assert.deepEqual(await auth.json(), { error: 'Admin PIN setup required' });
    const mutation = await fetch(`${instance.baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(mutation.status, 409);
  } finally {
    await stopServer(instance.child);
  }
});
