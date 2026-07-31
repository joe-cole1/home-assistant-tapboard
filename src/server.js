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

// Helper: Calculate Keg Kick Forecast (Avg Daily Oz vs Remaining Oz)
function calculateKegKickForecast(tapId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const totalOzRow = db.prepare(`
    SELECT SUM(volume_poured_oz) as total_oz
    FROM pour_logs
    WHERE tap_id = ? AND timestamp >= ?
  `).get(tapId, sevenDaysAgo);

  const avgDailyOz = (totalOzRow?.total_oz || 0) / 7;
  const haState = haClient.statesMap.get(`sensor.tap_${tapId}_fl_oz`) || haClient.statesMap.get(`sensor.tap_${tapId}_fill`);
  const currentOz = parseFloat(haState?.state || '0');

  if (isNaN(currentOz) || currentOz <= 0 || avgDailyOz <= 0) {
    return { avgDailyOz: Math.round(avgDailyOz * 10) / 10, estimatedDaysRemaining: null };
  }

  const daysRemaining = Math.round((currentOz / avgDailyOz) * 10) / 10;
  return { avgDailyOz: Math.round(avgDailyOz * 10) / 10, estimatedDaysRemaining: daysRemaining };
}

// Broadcast SSE Event to all connected browser clients
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// 15s Heartbeat Ping to prevent proxy timeouts
setInterval(() => {
  for (const res of sseClients) {
    res.write(': ping\n\n');
  }
}, 15000);

// HA Event Listeners
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
    kegKickForecasts,
    timestamp: new Date().toISOString()
  };
}

// HTTP Server Logic
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const clientIp = req.socket.remoteAddress || 'unknown';

  // Enable CORS headers
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
      'X-Accel-Buffering': 'no' // Pangolin/Traefik proxy bypass header
    });

    res.write(': connected\n\n');
    sseClients.add(res);

    // Send initial snapshot on join
    res.write(`event: snapshot\ndata: ${JSON.stringify(getFullStateSnapshot())}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Admin Auth Endpoint (/api/auth)
  if (url.pathname === '/api/auth' && req.method === 'POST') {
    try {
      // Check Rate Limit (5 attempts / 15 mins)
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

      // Reset rate limit counter on success
      authAttempts.delete(clientIp);

      // Create session token (valid for 24h)
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

  // 4. Update Settings (/api/settings)
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const { theme, volume_format, title, font_title, font_body, show_ondeck, new_pin } = body;

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

  // 5. Update Tap Configuration (/api/taps/:id)
  if (url.pathname.startsWith('/api/taps/') && req.method === 'POST') {
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
      db.prepare(`
        UPDATE taps SET
          enabled = COALESCE(?, enabled),
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
          badge_fresh = COALESCE(?, badge_fresh)
        WHERE tap_id = ?
      `).run(
        body.enabled !== undefined ? (body.enabled ? 1 : 0) : null,
        body.graphic,
        body.override_enabled !== undefined ? (body.override_enabled ? 1 : 0) : null,
        body.override_name,
        body.override_style,
        body.override_abv,
        body.override_ibu,
        body.override_og,
        body.override_fg,
        body.override_srm,
        body.override_description,
        body.badge_low_keg,
        body.badge_fresh !== undefined ? (body.badge_fresh ? 1 : 0) : null,
        tapId
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

  // 6. Manage Catalog & On-Deck (/api/catalog)
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

  // 7. Static Asset Serving
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
