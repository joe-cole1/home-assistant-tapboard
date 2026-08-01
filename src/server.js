import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import db from './db.js';
import { HAClient } from './haClient.js';
import { SSEHub } from './sseHub.js';
import {
  HttpError,
  applySecurityHeaders,
  enforceOrigin,
  isContainedPath,
  publicError as toPublicError,
  readEmptyJsonBody,
  readJsonBody,
  resolvePublicPath
} from './httpSecurity.js';
import { ValidationError, tapId as validateTapId, validateAuth, validateCatalog, validateSettings, validateTap } from './validation.js';

dotenv.config(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : undefined);

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const PUBLIC_REAL_DIR = fs.realpathSync(PUBLIC_DIR);

// Initialize HA Client
const haClient = new HAClient();
haClient.connect();

const sseHub = new SSEHub();

// Failed Auth Rate Limiter (IP -> { count, lockUntil })
const authAttempts = new Map();

// Helper: Check Admin Authorization Header
function sessionDigest(token) { return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`; }
function pruneSessions() { db.prepare("DELETE FROM admin_sessions WHERE datetime(expires_at) <= datetime('now')").run(); }
function adminPinInitialized() {
  return db.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get()?.admin_pin_initialized === 1;
}
function isAuthorized(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  pruneSessions();
  const session = db.prepare(`
    SELECT token FROM admin_sessions
    WHERE token = ? AND datetime(expires_at) > datetime('now')
  `).get(sessionDigest(token));

  return !!session;
}

function requireAdmin(req, res) {
  pruneSessions();
  if (!adminPinInitialized()) {
    sendError(res, 409, 'Admin PIN setup required');
    return false;
  }
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Unauthorized');
    return false;
  }
  return true;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function sendError(res, status, error) { sendJson(res, status, { error }); }
function handleError(res, error, context = 'request') {
  if (error instanceof ValidationError) {
    sendError(res, 400, error.message);
    return;
  }
  const result = toPublicError(error);
  if (result.status >= 500) console.error(`[HTTP ERROR] ${context}:`, error);
  sendError(res, result.status, result.message);
}

function allowedMethodsForApiPath(pathname) {
  if (pathname === '/api/state') return ['GET'];
  if (['/api/auth', '/api/settings', '/api/catalog'].includes(pathname)) return ['POST'];
  if (/^\/api\/taps\/[1-6](?:\/(?:end-batch|end-keg))?$/.test(pathname)) return ['POST'];
  return null;
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

// HA Event Listeners
haClient.on('connection_change', isConnected => {
  console.log(`[HAClient Connection Change] HA isConnected: ${isConnected}`);
  sseHub.publishImmediate('ha_connection_status', {
    isConnected,
    timestamp: new Date().toISOString()
  });
});

haClient.on('state_changed', data => {
  sseHub.publish('state_changed', data);
});

haClient.on('pour_start', data => {
  console.log(`[SSE Broadcast] pour_start on Tap ${data.tapId}`);
  sseHub.publishImmediate('pour_start', data);
});

haClient.on('pour_complete', data => {
  console.log(`[SSE Broadcast] pour_complete on Tap ${data.tapId}: ${data.volumePouredOz} oz`);
  sseHub.publishImmediate('pour_complete', {
    ...data,
    kegKickForecast: calculateKegKickForecast(data.tapId)
  });
});

haClient.on('pour_cancel', data => {
  console.log(`[SSE Broadcast] pour_cancel on Tap ${data.tapId}: ${data.reason}`);
  sseHub.publishImmediate('pour_cancel', data);
});

haClient.on('low_keg_alert', data => {
  sseHub.publishImmediate('low_keg_alert', data);
});

// Construct Full Application State Snapshot
function getFullStateSnapshot() {
  const settings = db.prepare('SELECT id, theme, volume_format, title, font_title, font_body, show_ondeck FROM settings WHERE id = 1').get();
  const taps = db.prepare(`
    SELECT tap_id, enabled, batch_id, graphic, override_enabled, override_name,
      override_style, override_abv, override_ibu, override_og, override_fg,
      override_srm, override_description, badge_low_keg, badge_fresh,
      on_tap_at, display_unit, custom_pour_size
    FROM taps ORDER BY tap_id ASC
  `).all();
  const batches = db.prepare(`
    SELECT batch_id, recipe_name, style, brew_date, og, fg, abv, ibu, srm,
      status, last_synced_at
    FROM batches ORDER BY last_synced_at DESC
  `).all();
  const catalog = db.prepare(`
    SELECT id, name, style, abv, ibu, srm_color, description, on_deck,
      target_tap_id
    FROM beverage_catalog ORDER BY id DESC
  `).all();
  const tapStates = haClient.getPublicTapStates();

  const kegKickForecasts = {};
  for (let i = 1; i <= 6; i++) {
    kegKickForecasts[i] = calculateKegKickForecast(i);
  }

  return {
    schemaVersion: 2,
    settings,
    taps,
    batches,
    catalog,
    tapStates,
    haConnected: haClient.isConnected,
    kegKickForecasts,
    timestamp: new Date().toISOString()
  };
}

// HTTP Server Logic
const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  applySecurityHeaders(res);
  res.setHeader('X-Request-ID', requestId);
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { sendError(res, 400, 'Invalid request URL'); return; }
  const clientIp = req.socket.remoteAddress || 'unknown';
  const requestContext = (operation, tapId = '-') =>
    `${operation} request_id=${requestId} method=${req.method} route=${url.pathname} tap_id=${tapId} client=${clientIp}`;
  try { enforceOrigin(req); } catch (error) { handleError(res, error, requestContext('origin check')); return; }

  if (req.method === 'OPTIONS') {
    const methods = allowedMethodsForApiPath(url.pathname);
    if (methods) {
      res.writeHead(204, { Allow: [...methods, 'OPTIONS'].join(', '), 'Cache-Control': 'no-store' });
      res.end();
    }
    else sendError(res, 404, 'Not found');
    return;
  }

  // 1. SSE Real-Time Stream (/events)
  if (url.pathname === '/events' && req.method === 'GET') {
    let snapshot;
    try { snapshot = getFullStateSnapshot(); }
    catch (error) { handleError(res, error, requestContext('create SSE snapshot')); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.flushHeaders?.();
    sseHub.addClient(req, res, snapshot);
    return;
  }

  if (url.pathname === '/healthz' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 2. Admin Auth Endpoint (/api/auth)
  if (url.pathname === '/api/auth' && req.method === 'POST') {
    try {
      const now = Date.now();
      const attempt = authAttempts.get(clientIp) || { count: 0, lockUntil: 0 };

      if (attempt.lockUntil > now) {
        const remainingMinutes = Math.ceil((attempt.lockUntil - now) / 60000);
        sendJson(res, 429, { error: `Too many failed attempts. Locked out for ${remainingMinutes} minutes.` });
        return;
      }

      const body = validateAuth(await readJsonBody(req));
      const settings = db.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();

      if (!settings.admin_pin_initialized) {
        sendError(res, 409, 'Admin PIN setup required');
        return;
      }

      if (!body.pin || !bcrypt.compareSync(body.pin, settings.admin_pin_hash)) {
        attempt.count += 1;
        if (attempt.count >= 5) {
          attempt.lockUntil = now + 15 * 60 * 1000;
          console.warn(`[AUTH SECURITY] Client locked out after failed PIN attempts request_id=${requestId} client=${clientIp}`);
        } else {
          console.warn(`[AUTH ACTION] Failed admin PIN attempt request_id=${requestId} client=${clientIp} attempt=${attempt.count}/5`);
        }
        authAttempts.set(clientIp, attempt);

        sendError(res, 401, 'Invalid PIN');
        return;
      }

      authAttempts.delete(clientIp);
      pruneSessions();

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      db.prepare(`
        INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)
      `).run(sessionDigest(token), expiresAt);

      console.log(`[AUTH ACTION] Successful admin PIN authentication request_id=${requestId} client=${clientIp}`);
      sendJson(res, 200, { token, expiresAt });

    } catch (err) {
      handleError(res, err, requestContext('admin authentication'));
    }
    return;
  }

  // 3. Get Public Snapshot (/api/state)
  if (url.pathname === '/api/state' && req.method === 'GET') {
    try { sendJson(res, 200, getFullStateSnapshot()); }
    catch (error) { handleError(res, error, requestContext('create state snapshot')); }
    return;
  }

  // 4. Update Global Settings & Tap Visibilities (/api/settings)
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = validateSettings(await readJsonBody(req));
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

      if (new_pin) {
        const pinHash = bcrypt.hashSync(new_pin, 10);
        db.transaction(() => {
          db.prepare('UPDATE settings SET admin_pin_hash = ?, admin_pin_initialized = 1 WHERE id = 1').run(pinHash);
          db.prepare('DELETE FROM admin_sessions').run();
        })();
        console.log(`[SETTINGS ACTION] Admin PIN updated request_id=${requestId} client=${clientIp}`);
      }

      console.log(`[SETTINGS ACTION] Global Studio Settings updated request_id=${requestId} client=${clientIp}`);

      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true, sessionsRevoked: Boolean(new_pin) });

    } catch (err) {
      handleError(res, err, requestContext('update global settings'));
    }
    return;
  }

  // 5. Update Tap Configuration & Overrides (/api/taps/:id)
  if (url.pathname.match(/^\/api\/taps\/\d+$/) && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    let tapId;
    try { tapId = validateTapId(url.pathname.split('/')[3]); } catch { sendError(res, 400, 'Invalid tap ID'); return; }

    try {
      const body = validateTap(await readJsonBody(req));

      if (body.batch_option !== undefined && body.batch_option !== '' && body.batch_option !== 'custom:topo_chico | Topo Chico 0%') {
        const options = haClient.getPublicTapStates()?.[String(tapId)]?.batchSelection?.options;
        if (!Array.isArray(options) || !options.includes(body.batch_option)) throw new ValidationError('Invalid batch option');
      }

      // Auto-enable tap if a batch is assigned
      let shouldEnable = body.enabled !== undefined ? (body.enabled ? 1 : 0) : null;
      let extractedBatchId = null;
      const currentTap = db.prepare('SELECT batch_id, on_tap_at FROM taps WHERE tap_id = ?').get(tapId);
      let onTapAt = currentTap.on_tap_at;
      if (body.batch_option !== undefined) {
        if (body.batch_option !== '') {
          shouldEnable = 1;
          extractedBatchId = body.batch_option.split('|')[0].trim();
          if (extractedBatchId !== currentTap.batch_id || !onTapAt) onTapAt = new Date().toISOString();
        } else {
          extractedBatchId = '';
          onTapAt = null;
        }
      }
      
      db.prepare(`
        UPDATE taps SET
          enabled = COALESCE(?, enabled),
          batch_id = COALESCE(?, batch_id),
          on_tap_at = ?,
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
        onTapAt,
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

      console.log(`[TAP ACTION] Tap settings updated request_id=${requestId} tap_id=${tapId} client=${clientIp}`);

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

      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true });

    } catch (err) {
      handleError(res, err, requestContext('update tap', tapId));
    }
    return;
  }

  // 6. Action Endpoint: End Batch (/api/taps/:id/end-batch)
  if (url.pathname.match(/^\/api\/taps\/\d+\/end-batch$/) && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    let tapId;
    try { tapId = validateTapId(url.pathname.split('/')[3]); await readEmptyJsonBody(req); } catch (err) { handleError(res, err, requestContext('end batch validation', tapId)); return; }
    try {
      try {
        await haClient.callHAService('script', 'end_tap_batch', { tap_number: tapId });
      } catch (error) {
        console.error(`[HA ERROR] End batch failed for Tap ${tapId}:`, error);
        throw new HttpError(502, 'Home Assistant request failed');
      }

      db.prepare(`
        UPDATE taps SET
          batch_id = NULL,
          on_tap_at = NULL,
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

      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true, message: `Batch completed and tap ${tapId} cleared.` });
    } catch (err) {
      handleError(res, err, requestContext('end batch', tapId));
    }
    return;
  }

  // 7. Action Endpoint: End Keg (/api/taps/:id/end-keg)
  if (url.pathname.match(/^\/api\/taps\/\d+\/end-keg$/) && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    let tapId;
    try { tapId = validateTapId(url.pathname.split('/')[3]); await readEmptyJsonBody(req); } catch (err) { handleError(res, err, requestContext('end keg validation', tapId)); return; }
    try {
      try {
        await haClient.callHAService('select', 'select_option', {
          entity_id: `select.tap_${tapId}_batch_select`,
          option: ''
        });
      } catch (error) {
        console.error(`[HA ERROR] End keg failed for Tap ${tapId}:`, error);
        throw new HttpError(502, 'Home Assistant request failed');
      }

      db.prepare(`
        UPDATE taps SET
          batch_id = NULL,
          on_tap_at = NULL,
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

      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true, message: `Tap ${tapId} unassigned / off-tap.` });
    } catch (err) {
      handleError(res, err, requestContext('end keg', tapId));
    }
    return;
  }

  // 8. Manage Catalog & On-Deck (/api/catalog)
  if (url.pathname === '/api/catalog' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = validateCatalog(await readJsonBody(req));
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

      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true });
    } catch (err) {
      handleError(res, err, requestContext('update catalog'));
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const methods = allowedMethodsForApiPath(url.pathname);
    if (methods) {
      res.setHeader('Allow', methods.join(', '));
      sendError(res, 405, 'Method not allowed');
    } else sendError(res, 404, 'Not found');
    return;
  }

  // 9. Static Asset Serving
  if (!['GET', 'HEAD'].includes(req.method)) { sendError(res, 405, 'Method not allowed'); return; }
  let candidate;
  try { candidate = resolvePublicPath(PUBLIC_DIR, url.pathname); }
  catch (error) { handleError(res, error, requestContext('static path validation')); return; }

  fs.realpath(candidate, (err, realPath) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      if (req.method !== 'HEAD') res.end('404 Not Found'); else res.end();
      return;
    }
    if (!isContainedPath(PUBLIC_REAL_DIR, realPath)) { sendError(res, 403, 'Forbidden'); return; }
    fs.stat(realPath, (statError, stats) => {
      if (statError || !stats.isFile()) { sendError(res, 404, 'Not found'); return; }

    const ext = path.extname(realPath).toLowerCase();
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

    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(realPath).on('error', () => { if (!res.headersSent) sendError(res, 500, 'Internal server error'); else res.destroy(); }).pipe(res);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Tapboard Server] Running on http://localhost:${PORT}`);
});
