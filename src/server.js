import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import db from './db.js';
import { HAClient } from './haClient.js';
import { SSEHub } from './sseHub.js';
import { calculateKegKickForecast as calculateForecast } from './kegForecast.js';
import { activeLifecycle, assignKegLifecycle, closeKegLifecycle } from './kegLifecycle.js';
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
import {
  ValidationError,
  tapId as validateTapId,
  validateAuth,
  validateCustomBeverage,
  validateOndeck,
  validateSettings,
  validateTap
} from './validation.js';

dotenv.config({
  quiet: true,
  ...(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {})
});

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
function sessionDigest(token) {
  return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}
function pruneSessions() {
  db.prepare("DELETE FROM admin_sessions WHERE datetime(expires_at) <= datetime('now')").run();
}
function adminPinInitialized() {
  return db.prepare('SELECT admin_pin_initialized FROM settings WHERE id = 1').get()?.admin_pin_initialized === 1;
}
function isAuthorized(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  pruneSessions();
  const session = db
    .prepare(
      `
    SELECT token FROM admin_sessions
    WHERE token = ? AND datetime(expires_at) > datetime('now')
  `
    )
    .get(sessionDigest(token));

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
function sendError(res, status, error) {
  sendJson(res, status, { error });
}
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
  if (pathname === '/api/ondeck') return ['GET', 'POST'];
  if (['/api/auth', '/api/settings', '/api/brewfather/refresh', '/api/custom-beverage'].includes(pathname))
    return ['POST'];
  if (/^\/api\/taps\/[1-6](?:\/(?:end-batch|end-keg))?$/.test(pathname)) return ['POST'];
  return null;
}

// Calculate a 14-day forecast from the current tap's lifecycle-scoped usage history.
function calculateKegKickForecast(tapId) {
  const measurement = haClient.getPublicTapStates()?.[String(tapId)];
  if (!measurement || !['measured', 'stale'].includes(measurement.volumeStatus)) {
    return { avgDailyOz: null, estimatedDaysRemaining: null, hasUsageData: false };
  }
  return calculateForecast({ db, tapId, currentOz: measurement.volumeOz });
}

function assignmentIdentity({ batchId, overrideEnabled, overrideName }) {
  const normalizedBatchId = typeof batchId === 'string' && batchId.trim() ? batchId.trim() : null;
  if (normalizedBatchId) {
    return {
      batchId: normalizedBatchId,
      assignmentKind: normalizedBatchId.startsWith('custom:') ? 'custom' : 'brewfather'
    };
  }
  if (overrideEnabled && typeof overrideName === 'string' && overrideName.trim()) {
    return { batchId: null, assignmentKind: 'override' };
  }
  return null;
}

function lifecycleMatchesAssignment(lifecycle, assignment) {
  return Boolean(
    lifecycle &&
    assignment &&
    (lifecycle.batch_id ?? null) === assignment.batchId &&
    lifecycle.assignment_kind === assignment.assignmentKind
  );
}

// HA Event Listeners
haClient.on('connection_change', (isConnected) => {
  console.log(`[HAClient Connection Change] HA isConnected: ${isConnected}`);
  sseHub.publishImmediate('ha_connection_status', {
    isConnected,
    timestamp: new Date().toISOString()
  });
});

haClient.on('state_changed', (data) => {
  sseHub.publish('state_changed', data);
});

haClient.on('pour_start', (data) => {
  console.log(`[SSE Broadcast] pour_start on Tap ${data.tapId}`);
  sseHub.publishImmediate('pour_start', data);
});

haClient.on('pour_complete', (data) => {
  console.log(`[SSE Broadcast] pour_complete on Tap ${data.tapId}: ${data.volumePouredOz} oz`);
  sseHub.publishImmediate('pour_complete', {
    ...data,
    kegKickForecast: calculateKegKickForecast(data.tapId)
  });
});

haClient.on('pour_cancel', (data) => {
  console.log(`[SSE Broadcast] pour_cancel on Tap ${data.tapId}: ${data.reason}`);
  sseHub.publishImmediate('pour_cancel', data);
});

haClient.on('low_keg_alert', (data) => {
  sseHub.publishImmediate('low_keg_alert', data);
});

haClient.on('hydrated', () => {
  observeBrewfatherBatches(haClient.getBrewfatherBatches());
  sseHub.publishImmediate('snapshot', getFullStateSnapshot());
});

haClient.on('brewfather_batches_changed', (batches) => {
  observeBrewfatherBatches(batches);
  sseHub.publishImmediate('brewfather_batches_changed', getFullStateSnapshot());
});

function observeBrewfatherBatches(batches) {
  const defaultVisible = db.prepare('SELECT ondeck_new_batch_default FROM settings WHERE id = 1').get()
    ?.ondeck_new_batch_default
    ? 1
    : 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO brewfather_ondeck_preferences (batch_id, visible) VALUES (?, ?)`);
  db.transaction(() => {
    for (const batch of batches) insert.run(batch.id, defaultVisible);
  })();
}

function eligibleOndeckBatches() {
  const batches = haClient.getBrewfatherBatches();
  const preferences = new Map(
    db
      .prepare('SELECT batch_id, visible FROM brewfather_ondeck_preferences')
      .all()
      .map((row) => [row.batch_id, row.visible === 1])
  );
  const defaultVisible = db
    .prepare('SELECT ondeck_new_batch_default FROM settings WHERE id = 1')
    .get()?.ondeck_new_batch_default;
  return batches.map((batch) => ({ ...batch, visible: preferences.get(batch.id) ?? Boolean(defaultVisible) }));
}

function isOndeckEnabled() {
  return db.prepare('SELECT show_ondeck FROM settings WHERE id = 1').get()?.show_ondeck === 1;
}

function customBeverage() {
  const beverage = db
    .prepare('SELECT id, name, style, abv, ibu, og, fg, srm, description FROM custom_beverage WHERE id = ?')
    .get('custom:topo_chico');
  return beverage ? { ...beverage, assignmentOption: 'custom:topo_chico | Tapboard Custom Beverage' } : null;
}

// Construct Full Application State Snapshot
function getFullStateSnapshot() {
  const settings = db
    .prepare(
      'SELECT id, theme, volume_format, title, font_title, font_body, show_ondeck, layout_mode, ondeck_new_batch_default FROM settings WHERE id = 1'
    )
    .get();
  const taps = db
    .prepare(
      `
    SELECT tap_id, enabled, batch_id, graphic, override_enabled, override_name,
      override_style, override_abv, override_ibu, override_og, override_fg,
      override_srm, override_description, badge_low_keg, badge_fresh,
      on_tap_at, display_unit, custom_pour_size
    FROM taps ORDER BY tap_id ASC
  `
    )
    .all();
  const batches = db
    .prepare(
      `
    SELECT batch_id, recipe_name, style, brew_date, og, fg, abv, ibu, srm,
      status, last_synced_at
    FROM batches ORDER BY last_synced_at DESC
  `
    )
    .all();
  const onDeckBatches = settings.show_ondeck ? eligibleOndeckBatches().filter((batch) => batch.visible) : [];
  const tapStates = haClient.getPublicTapStates();

  const kegKickForecasts = {};
  for (let i = 1; i <= 6; i++) {
    kegKickForecasts[i] = calculateKegKickForecast(i);
  }

  return {
    schemaVersion: 4,
    settings,
    taps,
    batches,
    onDeckBatches,
    customBeverage: customBeverage(),
    tapStates,
    haConnected: haClient.isConnected,
    kegKickForecasts,
    timestamp: new Date().toISOString()
  };
}

// HTTP Server Logic
let shuttingDown = false;
function ensureServing() {
  if (shuttingDown) throw new HttpError(503, 'Service is shutting down');
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  applySecurityHeaders(res);
  res.setHeader('X-Request-ID', requestId);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendError(res, 400, 'Invalid request URL');
    return;
  }
  const clientIp = req.socket.remoteAddress || 'unknown';
  const requestContext = (operation, tapId = '-') =>
    `${operation} request_id=${requestId} method=${req.method} route=${url.pathname} tap_id=${tapId} client=${clientIp}`;
  try {
    enforceOrigin(req);
  } catch (error) {
    handleError(res, error, requestContext('origin check'));
    return;
  }
  if (shuttingDown) {
    sendError(res, 503, 'Service is shutting down');
    return;
  }

  if (req.method === 'OPTIONS') {
    const methods = allowedMethodsForApiPath(url.pathname);
    if (methods) {
      res.writeHead(204, { Allow: [...methods, 'OPTIONS'].join(', '), 'Cache-Control': 'no-store' });
      res.end();
    } else sendError(res, 404, 'Not found');
    return;
  }

  // 1. SSE Real-Time Stream (/events)
  if (url.pathname === '/events' && req.method === 'GET') {
    let snapshot;
    try {
      snapshot = getFullStateSnapshot();
    } catch (error) {
      handleError(res, error, requestContext('create SSE snapshot'));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
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
      ensureServing();
      const settings = db.prepare('SELECT admin_pin_hash, admin_pin_initialized FROM settings WHERE id = 1').get();

      if (!settings.admin_pin_initialized) {
        sendError(res, 409, 'Admin PIN setup required');
        return;
      }

      if (!body.pin || !bcrypt.compareSync(body.pin, settings.admin_pin_hash)) {
        attempt.count += 1;
        if (attempt.count >= 5) {
          attempt.lockUntil = now + 15 * 60 * 1000;
          console.warn(
            `[AUTH SECURITY] Client locked out after failed PIN attempts request_id=${requestId} client=${clientIp}`
          );
        } else {
          console.warn(
            `[AUTH ACTION] Failed admin PIN attempt request_id=${requestId} client=${clientIp} attempt=${attempt.count}/5`
          );
        }
        authAttempts.set(clientIp, attempt);

        sendError(res, 401, 'Invalid PIN');
        return;
      }

      authAttempts.delete(clientIp);
      pruneSessions();

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      db.prepare(
        `
        INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)
      `
      ).run(sessionDigest(token), expiresAt);

      console.log(`[AUTH ACTION] Successful admin PIN authentication request_id=${requestId} client=${clientIp}`);
      sendJson(res, 200, { token, expiresAt });
    } catch (err) {
      handleError(res, err, requestContext('admin authentication'));
    }
    return;
  }

  // 3. Get Public Snapshot (/api/state)
  if (url.pathname === '/api/state' && req.method === 'GET') {
    try {
      sendJson(res, 200, getFullStateSnapshot());
    } catch (error) {
      handleError(res, error, requestContext('create state snapshot'));
    }
    return;
  }

  // 4. Update Global Settings & Tap Visibilities (/api/settings)
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = validateSettings(await readJsonBody(req));
      ensureServing();
      const {
        theme,
        volume_format,
        title,
        font_title,
        font_body,
        show_ondeck,
        layout_mode,
        ondeck_new_batch_default,
        tap_visibilities,
        new_pin
      } = body;

      db.prepare(
        `
        UPDATE settings SET
          theme = COALESCE(?, theme),
          volume_format = COALESCE(?, volume_format),
          title = COALESCE(?, title),
          font_title = COALESCE(?, font_title),
          font_body = COALESCE(?, font_body),
          show_ondeck = COALESCE(?, show_ondeck),
          layout_mode = COALESCE(?, layout_mode),
          ondeck_new_batch_default = COALESCE(?, ondeck_new_batch_default)
        WHERE id = 1
      `
      ).run(
        theme,
        volume_format,
        title,
        font_title,
        font_body,
        show_ondeck !== undefined ? (show_ondeck ? 1 : 0) : null,
        layout_mode,
        ondeck_new_batch_default !== undefined ? (ondeck_new_batch_default ? 1 : 0) : null
      );

      if (tap_visibilities && typeof tap_visibilities === 'object') {
        const updateTapEnabled = db.prepare('UPDATE taps SET enabled = ? WHERE tap_id = ?');
        for (let i = 1; i <= 6; i++) {
          if (tap_visibilities[i] !== undefined) {
            const isEnabled = tap_visibilities[i] ? 1 : 0;
            updateTapEnabled.run(isEnabled, i);
            haClient
              .callHAService('input_boolean', isEnabled ? 'turn_on' : 'turn_off', {
                entity_id: `input_boolean.tap_${i}_enabled`
              })
              .catch((_err) => {
                // HA synchronization is best-effort after the local change commits.
              });
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
    try {
      tapId = validateTapId(url.pathname.split('/')[3]);
    } catch {
      sendError(res, 400, 'Invalid tap ID');
      return;
    }

    try {
      const body = validateTap(await readJsonBody(req));
      ensureServing();

      if (
        body.batch_option !== undefined &&
        body.batch_option !== '' &&
        body.batch_option !== customBeverage()?.assignmentOption
      ) {
        const options = haClient.getPublicTapStates()?.[String(tapId)]?.batchSelection?.options;
        if (!Array.isArray(options) || !options.includes(body.batch_option))
          throw new ValidationError('Invalid batch option');
      }

      // Auto-enable tap if a batch is assigned
      let shouldEnable = body.enabled !== undefined ? (body.enabled ? 1 : 0) : null;
      let extractedBatchId = null;
      const currentTap = db
        .prepare(
          `SELECT batch_id, on_tap_at, override_enabled, override_name
        FROM taps WHERE tap_id = ?`
        )
        .get(tapId);
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

      const finalBatchId = body.batch_option === undefined ? currentTap.batch_id : extractedBatchId || null;
      const finalOverrideEnabled =
        body.override_enabled === undefined ? currentTap.override_enabled === 1 : body.override_enabled;
      const finalOverrideName = body.override_name === undefined ? currentTap.override_name : body.override_name;
      const desiredAssignment = assignmentIdentity({
        batchId: finalBatchId,
        overrideEnabled: finalOverrideEnabled,
        overrideName: finalOverrideName
      });
      const currentLifecycle = activeLifecycle(db, tapId);
      const lifecycleChanges = !lifecycleMatchesAssignment(currentLifecycle, desiredAssignment);
      if (!desiredAssignment) onTapAt = null;
      else if (lifecycleChanges || !onTapAt) onTapAt = new Date().toISOString();

      // Capacity is authoritative in Home Assistant. Complete request
      // validation first, but write HA before touching SQLite so a rejected
      // capacity can never leave the local tap settings partially saved.
      if (body.capacity_oz !== undefined) {
        try {
          await haClient.callHAService('input_number', 'set_value', {
            entity_id: `input_number.tap_${tapId}_keg_capacity_oz`,
            value: body.capacity_oz
          });
        } catch (error) {
          console.error(`[HA ERROR] Capacity update failed for Tap ${tapId}:`, error);
          throw new HttpError(502, 'Home Assistant capacity update failed');
        }
        ensureServing();
      }

      const updateTap = db.prepare(`
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
      `);
      const applyTapUpdate = () => {
        updateTap.run(
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
          body.custom_pour_size !== undefined
            ? body.custom_pour_size !== ''
              ? parseFloat(body.custom_pour_size)
              : null
            : null,
          tapId
        );
      };
      if (lifecycleChanges && desiredAssignment) {
        assignKegLifecycle(db, {
          tapId,
          ...desiredAssignment,
          startedAt: onTapAt,
          closeReason: currentLifecycle ? 'reassigned' : 'opened',
          updateTap: applyTapUpdate
        });
      } else if (lifecycleChanges && currentLifecycle) {
        closeKegLifecycle(db, {
          tapId,
          closedAt: new Date().toISOString(),
          closeReason: 'cleared',
          updateTap: applyTapUpdate
        });
      } else {
        db.transaction(applyTapUpdate)();
      }
      if (lifecycleChanges) haClient.clearTapMeasurement(tapId);

      console.log(`[TAP ACTION] Tap settings updated request_id=${requestId} tap_id=${tapId} client=${clientIp}`);

      // Sync Home Assistant input_boolean.tap_N_enabled
      const haEnabledService = shouldEnable === 1 || shouldEnable === null ? 'turn_on' : 'turn_off';
      await haClient
        .callHAService('input_boolean', haEnabledService, {
          entity_id: `input_boolean.tap_${tapId}_enabled`
        })
        .catch((err) => console.warn(`[HA Warning] Enable boolean call failed:`, err.message));

      if (body.batch_option !== undefined) {
        await haClient
          .callHAService('select', 'select_option', {
            entity_id: `select.tap_${tapId}_batch_select`,
            option: body.batch_option
          })
          .catch((err) => console.warn(`[HA Warning] Select option failed:`, err.message));

        const batchId = body.batch_option.split('|')[0].trim();
        if (batchId) {
          await haClient
            .callHAService('input_text', 'set_value', {
              entity_id: `input_text.tap_${tapId}_batch`,
              value: batchId
            })
            .catch((err) => console.warn(`[HA Warning] Batch text set failed:`, err.message));
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
    try {
      tapId = validateTapId(url.pathname.split('/')[3]);
      await readEmptyJsonBody(req);
      ensureServing();
    } catch (err) {
      handleError(res, err, requestContext('end batch validation', tapId));
      return;
    }
    try {
      try {
        await haClient.callHAService('script', 'end_tap_batch', { tap_number: tapId });
      } catch (error) {
        console.error(`[HA ERROR] End batch failed for Tap ${tapId}:`, error);
        throw new HttpError(502, 'Home Assistant request failed');
      }
      ensureServing();

      const clearBatch = db.prepare(`
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
      `);
      closeKegLifecycle(db, {
        tapId,
        closedAt: new Date().toISOString(),
        closeReason: 'end_batch',
        updateTap: () => clearBatch.run(tapId)
      });
      haClient.clearTapMeasurement(tapId);

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
    try {
      tapId = validateTapId(url.pathname.split('/')[3]);
      await readEmptyJsonBody(req);
      ensureServing();
    } catch (err) {
      handleError(res, err, requestContext('end keg validation', tapId));
      return;
    }
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
      ensureServing();

      const clearKeg = db.prepare(`
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
      `);
      closeKegLifecycle(db, {
        tapId,
        closedAt: new Date().toISOString(),
        closeReason: 'end_keg',
        updateTap: () => clearKeg.run(tapId)
      });
      haClient.clearTapMeasurement(tapId);

      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true, message: `Tap ${tapId} unassigned / off-tap.` });
    } catch (err) {
      handleError(res, err, requestContext('end keg', tapId));
    }
    return;
  }

  // 8. Manage Brewfather-powered On Deck preferences.
  if (url.pathname === '/api/ondeck' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      sendJson(res, 200, { batches: eligibleOndeckBatches(), show_ondeck: isOndeckEnabled() });
    } catch (err) {
      handleError(res, err, requestContext('read on deck'));
    }
    return;
  }

  if (url.pathname === '/api/ondeck' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = validateOndeck(await readJsonBody(req));
      ensureServing();
      const eligible = eligibleOndeckBatches();
      const known = new Set(eligible.map((batch) => batch.id));
      if (body.batches.some((batch) => !known.has(batch.batch_id)))
        throw new ValidationError('Invalid Brewfather batch');
      const update = db.prepare(
        `UPDATE brewfather_ondeck_preferences
         SET visible = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ?`
      );
      const updateEnabled = db.prepare('UPDATE settings SET show_ondeck = ? WHERE id = 1');
      db.transaction(() => {
        body.batches.forEach((batch) => update.run(batch.visible ? 1 : 0, batch.batch_id));
        if (body.show_ondeck !== undefined) updateEnabled.run(body.show_ondeck ? 1 : 0);
      })();
      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, {
        success: true,
        batches: eligibleOndeckBatches(),
        show_ondeck: isOndeckEnabled()
      });
    } catch (err) {
      handleError(res, err, requestContext('update on deck'));
    }
    return;
  }

  if (url.pathname === '/api/brewfather/refresh' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      await readEmptyJsonBody(req);
      ensureServing();
      try {
        await haClient.callHAService('input_button', 'press', { entity_id: 'input_button.brewery_brewfather_refresh' });
      } catch (error) {
        console.error('[HA ERROR] Brewfather refresh failed:', error);
        throw new HttpError(502, 'Home Assistant Brewfather refresh failed');
      }
      ensureServing();
      sendJson(res, 200, { success: true });
    } catch (err) {
      handleError(res, err, requestContext('refresh Brewfather'));
    }
    return;
  }

  if (url.pathname === '/api/custom-beverage' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = validateCustomBeverage(await readJsonBody(req));
      ensureServing();
      db.prepare(
        `UPDATE custom_beverage SET name = ?, style = ?, abv = ?, ibu = ?, og = ?, fg = ?, srm = ?, description = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'custom:topo_chico'`
      ).run(body.name, body.style, body.abv, body.ibu, body.og, body.fg, body.srm, body.description);
      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true, customBeverage: customBeverage() });
    } catch (err) {
      handleError(res, err, requestContext('update custom beverage'));
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
  if (!['GET', 'HEAD'].includes(req.method)) {
    sendError(res, 405, 'Method not allowed');
    return;
  }
  let candidate;
  try {
    candidate = resolvePublicPath(PUBLIC_DIR, url.pathname);
  } catch (error) {
    handleError(res, error, requestContext('static path validation'));
    return;
  }

  fs.realpath(candidate, (err, realPath) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      if (req.method !== 'HEAD') res.end('404 Not Found');
      else res.end();
      return;
    }
    if (!isContainedPath(PUBLIC_REAL_DIR, realPath)) {
      sendError(res, 403, 'Forbidden');
      return;
    }
    fs.stat(realPath, (statError, stats) => {
      if (statError || !stats.isFile()) {
        sendError(res, 404, 'Not found');
        return;
      }

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

      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(realPath)
        .on('error', () => {
          if (!res.headersSent) sendError(res, 500, 'Internal server error');
          else res.destroy();
        })
        .pipe(res);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[Tapboard Server] Running on http://localhost:${PORT}`);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Tapboard Server] ${signal} received; shutting down cleanly.`);
  haClient.stop();
  sseHub.close();
  const forceExit = setTimeout(() => {
    console.error('[Tapboard Server] Graceful shutdown timed out.');
    process.exit(1);
  }, 10_000);
  forceExit.unref?.();
  server.close(() => {
    clearTimeout(forceExit);
    try {
      db.close();
    } catch {
      // The process is already shutting down; closing an unavailable handle is harmless.
    }
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
