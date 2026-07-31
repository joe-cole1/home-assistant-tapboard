import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import db from './db.js';
import { HAClient } from './haClient.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Initialize HA Client
const haClient = new HAClient();
haClient.connect();

// SSE Connected Clients Set
const sseClients = new Set();

// Failed Auth Rate Limiter (IP -> { count, lockUntil })
const authAttempts = new Map();

// Helper: Check Admin Authorization Header
function isAuthorized(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  const session = db.prepare(`
    SELECT token FROM admin_sessions
    WHERE token = ? AND datetime(expires_at) > datetime('now')
  `).get(token);

  return !!session;
}

// Helper: Parse JSON Request Body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Helper: Calculate 14-Day Rolling Keg Kick Forecast with Multi-Sensor Lookup
function calculateKegKickForecast(tapId) {
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
  
  const stats = db.prepare(`
    SELECT 
      SUM(volume_poured_oz) as total_oz,
      COUNT(DISTINCT DATE(timestamp)) as active_days,
      MIN(timestamp) as first_pour_time
    FROM pour_logs
    WHERE tap_id = ? AND timestamp >= ?
  `).get(tapId, fourteenDaysAgo);

  const totalOz = stats?.total_oz || 0;

  let currentOz = 0;
  const ozState = haClient.statesMap.get(`sensor.tap_${tapId}_fl_oz`)?.state;
  const fillState = haClient.statesMap.get(`sensor.tap_${tapId}_fill`)?.state;
  const pintsState = haClient.statesMap.get(`sensor.tap_${tapId}_pints_remaining`)?.state;

  if (ozState && !isNaN(parseFloat(ozState)) && parseFloat(ozState) > 0) {
    currentOz = parseFloat(ozState);
  } else if (pintsState && !isNaN(parseFloat(pintsState)) && parseFloat(pintsState) > 0) {
    currentOz = parseFloat(pintsState) * 16.0;
  } else if (fillState && !isNaN(parseFloat(fillState)) && parseFloat(fillState) > 0) {
    currentOz = (parseFloat(fillState) / 100.0) * 640.0;
  }

  let avgDailyOz = 0;
  let isEstimatedBaseline = false;

  if (totalOz > 0 && stats?.first_pour_time) {
    const daysSpan = Math.max(1, (Date.now() - new Date(stats.first_pour_time).getTime()) / (86400 * 1000));
    avgDailyOz = totalOz / Math.min(14, daysSpan);
  } else {
    avgDailyOz = 16.0;
    isEstimatedBaseline = true;
  }

  if (currentOz <= 0) {
    return { 
      avgDailyOz: Math.round(avgDailyOz * 10) / 10,
      estimatedDaysRemaining: null,
      isEstimatedBaseline: true
    };
  }

  const daysRemaining = Math.round((currentOz / avgDailyOz) * 10) / 10;
  return { 
    avgDailyOz: Math.round(avgDailyOz * 10) / 10,
    estimatedDaysRemaining: daysRemaining,
    isEstimatedBaseline
  };
}

// Broadcast SSE Event
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// 15s Heartbeat Ping
setInterval(() => {
  for (const res of sseClients) {
    res.write(': ping\n\n');
  }
}, 15000);

// HA Event Listeners
haClient.on('connection_change', isConnected => {
  console.log(`[HAClient Connection Change] HA isConnected: ${isConnected}`);
  broadcastSSE('ha_connection_status', { isConnected });
});

haClient.on('state_changed', data => {
  broadcastSSE('state_changed', data);
});

haClient.on('pour_start', data => {
  console.log(`[SSE Broadcast] pour_start on Tap ${data.tapId}`);
  broadcastSSE('pour_start', data);
});

haClient.on('pour_complete', data => {
  console.log(`[SSE Broadcast] pour_complete on Tap ${data.tapId}: ${data.volumePouredOz} oz`);
  broadcastSSE('pour_complete', data);
  broadcastSSE('settings_updated', getFullStateSnapshot());
});

haClient.on('low_keg_alert', data => {
  broadcastSSE('low_keg_alert', data);
});

// Construct Full Application State Snapshot
function getFullStateSnapshot() {
  const settings = db.prepare('SELECT id, theme, volume_format, title, font_title, font_body, show_ondeck FROM settings WHERE id = 1').get();
  const taps = db.prepare('SELECT * FROM taps ORDER BY tap_id ASC').all();
  const batches = db.prepare('SELECT * FROM batches ORDER BY last_synced_at DESC').all();
  const catalog = db.prepare('SELECT * FROM beverage_catalog ORDER BY id DESC').all();
  const haStates = haClient.getFormattedState();

  const kegKickForecasts = {};
  for (let i = 1; i <= 6; i++) {
    kegKickForecasts[i] = calculateKegKickForecast(i);
  }

  return {
    settings,
    taps,
    batches,
    catalog,
    haStates,
    haConnected: haClient.isConnected,
    kegKickForecasts,
    timestamp: new Date().toISOString()
  };
}

// HTTP Server Logic
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const clientIp = req.socket.remoteAddress || 'unknown';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Real-Time Stream (/events)
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(': connected\n\n');
    sseClients.add(res);

    res.write(`event: snapshot\ndata: ${JSON.stringify(getFullStateSnapshot())}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Admin Auth Endpoint (/api/auth)
  if (url.pathname === '/api/auth' && req.method === 'POST') {
    try {
      const now = Date.now();
      const attempt = authAttempts.get(clientIp) || { count: 0, lockUntil: 0 };

      if (attempt.lockUntil > now) {
        const remainingMinutes = Math.ceil((attempt.lockUntil - now) / 60000);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Too many failed attempts. Locked out for ${remainingMinutes} minutes.` }));
        return;
      }

      const body = await parseJsonBody(req);
      const settings = db.prepare('SELECT admin_pin_hash FROM settings WHERE id = 1').get();

      if (!body.pin || !bcrypt.compareSync(body.pin, settings.admin_pin_hash)) {
        attempt.count += 1;
        if (attempt.count >= 5) {
          attempt.lockUntil = now + 15 * 60 * 1000;
        }
        authAttempts.set(clientIp, attempt);

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid PIN' }));
        return;
      }

      authAttempts.delete(clientIp);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      db.prepare(`
        INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)
      `).run(token, expiresAt);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, expiresAt }));

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. Get Public Snapshot (/api/state)
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFullStateSnapshot()));
    return;
  }

  // 4. Update Global Settings & Tap Visibilities (/api/settings)
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const { theme, volume_format, title, font_title, font_body, show_ondeck, tap_visibilities, new_pin } = body;

      db.prepare(`
        UPDATE settings SET
          theme = COALESCE(?, theme),
          volume_format = COALESCE(?, volume_format),
          title = COALESCE(?, title),
          font_title = COALESCE(?, font_title),
          font_body = COALESCE(?, font_body),
          show_ondeck = COALESCE(?, show_ondeck)
        WHERE id = 1
      `).run(theme, volume_format, title, font_title, font_body, show_ondeck !== undefined ? (show_ondeck ? 1 : 0) : null);

      if (tap_visibilities && typeof tap_visibilities === 'object') {
        const updateTapEnabled = db.prepare('UPDATE taps SET enabled = ? WHERE tap_id = ?');
        for (let i = 1; i <= 6; i++) {
          if (tap_visibilities[i] !== undefined) {
            const isEnabled = tap_visibilities[i] ? 1 : 0;
            updateTapEnabled.run(isEnabled, i);
            haClient.callHAService('input_boolean', isEnabled ? 'turn_on' : 'turn_off', {
              entity_id: `input_boolean.tap_${i}_enabled`
            }).catch(err => {});
          }
        }
      }

      if (new_pin && String(new_pin).trim().length === 4) {
        const pinHash = bcrypt.hashSync(String(new_pin).trim(), 10);
        db.prepare('UPDATE settings SET admin_pin_hash = ? WHERE id = 1').run(pinHash);
      }

      broadcastSSE('settings_updated', getFullStateSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 5. Update Tap Configuration & Overrides (/api/taps/:id)
  if (url.pathname.match(/^\/api\/taps\/\d+$/) && req.method === 'POST') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const tapId = parseInt(url.pathname.split('/')[3], 10);
    if (isNaN(tapId) || tapId < 1 || tapId > 6) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid tap ID' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);

      // Auto-enable tap if a batch is assigned
      let shouldEnable = body.enabled !== undefined ? (body.enabled ? 1 : 0) : null;
      let extractedBatchId = null;
      if (body.batch_option !== undefined) {
        if (body.batch_option !== '') {
          shouldEnable = 1;
          extractedBatchId = body.batch_option.split('|')[0].trim();
        } else {
          extractedBatchId = '';
        }
      }
      
      db.prepare(`
        UPDATE taps SET
          enabled = COALESCE(?, enabled),
          batch_id = COALESCE(?, batch_id),
          graphic = COALESCE(?, graphic),
          override_enabled = COALESCE(?, override_enabled),
          override_name = COALESCE(?, override_name),
          override_style = COALESCE(?, override_style),
          override_abv = COALESCE(?, override_abv),
          override_ibu = COALESCE(?, override_ibu),
          override_og = COALESCE(?, override_og),
          override_fg = COALESCE(?, override_fg),
          override_srm = COALESCE(?, override_srm),
          override_description = COALESCE(?, override_description),
          badge_low_keg = COALESCE(?, badge_low_keg),
          badge_fresh = COALESCE(?, badge_fresh),
          display_unit = COALESCE(?, display_unit),
          custom_pour_size = COALESCE(?, custom_pour_size)
        WHERE tap_id = ?
      `).run(
        shouldEnable,
        extractedBatchId,
        body.graphic,
        body.override_enabled !== undefined ? (body.override_enabled ? 1 : 0) : null,
        body.override_name !== undefined ? body.override_name : null,
        body.override_style !== undefined ? body.override_style : null,
        body.override_abv !== undefined ? (body.override_abv !== '' ? parseFloat(body.override_abv) : null) : null,
        body.override_ibu !== undefined ? (body.override_ibu !== '' ? parseInt(body.override_ibu) : null) : null,
        body.override_og !== undefined ? (body.override_og !== '' ? parseFloat(body.override_og) : null) : null,
        body.override_fg !== undefined ? (body.override_fg !== '' ? parseFloat(body.override_fg) : null) : null,
        body.override_srm !== undefined ? (body.override_srm !== '' ? parseInt(body.override_srm) : null) : null,
        body.override_description !== undefined ? body.override_description : null,
        body.badge_low_keg !== undefined ? parseFloat(body.badge_low_keg) : null,
        body.badge_fresh !== undefined ? (body.badge_fresh ? 1 : 0) : null,
        body.display_unit !== undefined ? body.display_unit : null,
        body.custom_pour_size !== undefined ? (body.custom_pour_size !== '' ? parseFloat(body.custom_pour_size) : null) : null,
        tapId
      );

      // Sync Home Assistant input_boolean.tap_N_enabled
      const haEnabledService = (shouldEnable === 1 || shouldEnable === null) ? 'turn_on' : 'turn_off';
      await haClient.callHAService('input_boolean', haEnabledService, {
        entity_id: `input_boolean.tap_${tapId}_enabled`
      }).catch(err => console.warn(`[HA Warning] Enable boolean call failed:`, err.message));

      if (body.batch_option !== undefined) {
        await haClient.callHAService('select', 'select_option', {
          entity_id: `select.tap_${tapId}_batch_select`,
          option: body.batch_option
        }).catch(err => console.warn(`[HA Warning] Select option failed:`, err.message));

        const batchId = body.batch_option.split('|')[0].trim();
        if (batchId) {
          await haClient.callHAService('input_text', 'set_value', {
            entity_id: `input_text.tap_${tapId}_batch`,
            value: batchId
          }).catch(err => console.warn(`[HA Warning] Batch text set failed:`, err.message));
        }
      }

      broadcastSSE('settings_updated', getFullStateSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 6. Action Endpoint: End Batch (/api/taps/:id/end-batch)
  if (url.pathname.match(/^\/api\/taps\/\d+\/end-batch$/) && req.method === 'POST') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const tapId = parseInt(url.pathname.split('/')[3], 10);
    try {
      await haClient.callHAService('script', 'end_tap_batch', { tap_number: tapId })
        .catch(err => console.warn(`[HA Call Warning] script.end_tap_batch failed:`, err.message));

      db.prepare(`
        UPDATE taps SET
          batch_id = NULL,
          override_enabled = 0,
          override_name = NULL,
          override_style = NULL,
          override_abv = NULL,
          override_ibu = NULL,
          override_og = NULL,
          override_fg = NULL,
          override_srm = NULL,
          override_description = NULL
        WHERE tap_id = ?
      `).run(tapId);

      broadcastSSE('settings_updated', getFullStateSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Batch completed and tap ${tapId} cleared.` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7. Action Endpoint: End Keg (/api/taps/:id/end-keg)
  if (url.pathname.match(/^\/api\/taps\/\d+\/end-keg$/) && req.method === 'POST') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const tapId = parseInt(url.pathname.split('/')[3], 10);
    try {
      db.prepare(`
        UPDATE taps SET
          batch_id = NULL,
          override_enabled = 0,
          override_name = NULL,
          override_style = NULL,
          override_abv = NULL,
          override_ibu = NULL,
          override_og = NULL,
          override_fg = NULL,
          override_srm = NULL,
          override_description = NULL
        WHERE tap_id = ?
      `).run(tapId);

      await haClient.callHAService('select', 'select_option', {
        entity_id: `select.tap_${tapId}_batch_select`,
        option: ''
      }).catch(err => console.warn(`[HA Call Warning] Clear tap batch select failed:`, err.message));

      broadcastSSE('settings_updated', getFullStateSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Tap ${tapId} unassigned / off-tap.` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7b. Action Endpoint: Simulate Pour (/api/taps/:id/simulate-pour)
  if (url.pathname.match(/^\/api\/taps\/\d+\/simulate-pour$/) && req.method === 'POST') {
    const tapId = parseInt(url.pathname.split('/')[3], 10);
    try {
      const tapInfo = db.prepare('SELECT override_name FROM taps WHERE tap_id = ?').get(tapId);
      const beerName = tapInfo?.override_name || `Tap ${tapId}`;

      console.log(`[Simulate Pour] Starting test pour on Tap ${tapId}...`);
      broadcastSSE('pour_start', { tapId, startVolume: 50 });

      setTimeout(() => {
        const simulatedPouredOz = parseFloat((Math.random() * 6 + 6).toFixed(1)); // 6.0 - 12.0 oz
        db.prepare(`
          INSERT INTO pour_logs (tap_id, volume_poured_oz) VALUES (?, ?)
        `).run(tapId, simulatedPouredOz);

        console.log(`[Simulate Pour] Finalized test pour on Tap ${tapId}: ${simulatedPouredOz} oz`);
        broadcastSSE('pour_complete', {
          tapId,
          volumePouredOz: simulatedPouredOz,
          beerName,
          timestamp: new Date().toISOString()
        });

        broadcastSSE('settings_updated', getFullStateSnapshot());
      }, 4000);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Simulated pour started on Tap ${tapId}` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 8. Manage Catalog & On-Deck (/api/catalog)
  if (url.pathname === '/api/catalog' && req.method === 'POST') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const stmt = db.prepare(`
        INSERT INTO beverage_catalog (name, style, abv, ibu, srm_color, description, on_deck, target_tap_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        body.name,
        body.style || '',
        body.abv || 0,
        body.ibu || 0,
        body.srm_color || 0,
        body.description || '',
        body.on_deck ? 1 : 0,
        body.target_tap_id || null
      );

      broadcastSSE('settings_updated', getFullStateSnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 9. Static Asset Serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=UTF-8',
      '.css': 'text/css; charset=UTF-8',
      '.js': 'application/javascript; charset=UTF-8',
      '.json': 'application/json; charset=UTF-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[Tapboard Server] Running on http://localhost:${PORT}`);
});
