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
import { fillGraphicForStyle } from './fillGraphic.js';
import { createBrewfatherClientFromEnv } from './brewfatherClient.js';
import {
  assignmentOptions,
  batchSummary,
  onDeckBatches,
  syncStatus as getBrewfatherSyncStatus
} from './brewfatherCache.js';
import { BrewfatherSyncCoordinator } from './brewfatherSync.js';
import {
  BREW_STORY_WINDOWS,
  buildBrewStory,
  saveSensoryOverride,
  sensoryOverride,
  storyIsPublic,
  validBrewfatherBatchId
} from './brewStory.js';
import { fetchCachedImage } from './imageProxy.js';
import { buildBrewfatherSyncFailureEvent, buildTapboardEvent } from './tapboardEvents.js';
import { TapMutationCoordinator } from './tapActions.js';
import { DraftHealthEngine, mergeDraftHealthConfig } from './draftHealth.js';
import { DEFAULT_TAP_PLANNING_POLICY, buildTapPlanningProjection } from './tapPlanning.js';
import {
  HttpError,
  applySecurityHeaders,
  enforceOrigin,
  isContainedPath,
  publicError as toPublicError,
  readEmptyJsonBody,
  readJsonBody,
  readOptionalJsonBody,
  resolvePublicPath
} from './httpSecurity.js';
import {
  ValidationError,
  tapId as validateTapId,
  validateAuth,
  validateCustomBeverage,
  validateEndKeg,
  validateEffectiveHealthConfig,
  validateHealthAcknowledgement,
  validateHealthConfig,
  validateMaintenance,
  validateOndeck,
  validatePinChange,
  validateSettings,
  validateSensoryOverride,
  validateTap,
  validateReadinessOverride,
  validateReadinessPolicy
} from './validation.js';

dotenv.config({
  quiet: true,
  ...(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {})
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const PUBLIC_REAL_DIR = fs.realpathSync(PUBLIC_DIR);

// Home Assistant owns serving telemetry. Brewfather credentials remain
// server-side and are optional so last-known-good cache display can start
// during an outage or before native credentials are configured.
const haClient = new HAClient();
const sseHub = new SSEHub();
const brewfatherClient = createBrewfatherClientFromEnv();
const brewfatherSync = new BrewfatherSyncCoordinator({
  db,
  client: brewfatherClient,
  onUpdate: () => {
    evaluatePlanning();
    sseHub.publishImmediate('brewfather_batches_changed', getFullStateSnapshot());
  },
  onFailure: (result) => publishBrewfatherSyncFailure(result)
});

function brewfatherCompletion(batchId) {
  if (!brewfatherClient) throw new HttpError(503, 'Brewfather credentials are not configured');
  return brewfatherClient.completeBatch(batchId).catch((error) => {
    const messages = {
      auth: 'Brewfather authentication failed',
      forbidden: 'Brewfather batch-edit permission is required',
      rate_limited: 'Brewfather request budget is temporarily exhausted',
      timeout: 'Brewfather completion request timed out',
      network: 'Brewfather is unavailable'
    };
    const status = error?.category === 'rate_limited' ? 429 : error?.category === 'configuration' ? 503 : 502;
    throw new HttpError(status, messages[error?.category] || 'Brewfather completion request failed');
  });
}

const tapMutations = new TapMutationCoordinator({ db, completeBatch: brewfatherCompletion });
haClient.connect();

// Failed Auth Rate Limiter (IP -> { count, lockUntil })
const authAttempts = new Map();
// PIN changes have their own limiter so a valid administrator session cannot
// be used to repeatedly guess the current credential.
const pinChangeAttempts = new Map();

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
function sendBoundedJson(res, status, payload, maxBytes = 512 * 1024) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxBytes) throw new HttpError(500, 'Brew story response exceeds size limit');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
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
  if (['/api/state', '/api/brewfather/status'].includes(pathname)) return ['GET'];
  if (pathname === '/api/draft-health/config') return ['GET', 'POST'];
  if (pathname === '/api/planning/config') return ['GET'];
  if (['/api/draft-health/acknowledge', '/api/maintenance', '/api/planning/policy'].includes(pathname)) return ['POST'];
  if (pathname === '/api/ondeck') return ['GET', 'POST'];
  if (
    ['/api/auth', '/api/settings', '/api/admin/pin', '/api/brewfather/refresh', '/api/custom-beverage'].includes(
      pathname
    )
  )
    return ['POST'];
  if (/^\/api\/taps\/[1-6](?:\/(?:end-batch|end-keg))?$/.test(pathname)) return ['POST'];
  if (/^\/api\/batches\/[A-Za-z0-9_-]{1,256}\/story$/.test(pathname)) return ['GET'];
  if (/^\/api\/batches\/[A-Za-z0-9_-]{1,256}\/sensory$/.test(pathname)) return ['POST'];
  if (/^\/api\/batches\/[A-Za-z0-9_-]{1,256}\/readiness$/.test(pathname)) return ['POST'];
  if (/^\/api\/batches\/[A-Za-z0-9_-]{1,256}\/image$/.test(pathname)) return ['GET'];
  return null;
}

function calculateKegKickForecast(tapId) {
  const measurement = haClient.getPublicTapStates()?.[String(tapId)] || {};
  return calculateForecast({
    db,
    tapId,
    currentOz: measurement.volumeOz,
    capacityOz: measurement.capacityOz,
    volumeStatus: measurement.volumeStatus
  });
}

const healthEngines = new Map();
let draftHealthProjection = {
  schemaVersion: 1,
  configured: true,
  summary: 'Draft health is initializing.',
  checks: []
};
let tapPlanningProjection = { schemaVersion: 1, configured: true, stale: true, taps: [] };
let healthEvaluationTimer = null;
let phase4DebounceTimer = null;

function schedulePhase4Evaluation({ health = true, planning = false } = {}) {
  if (phase4DebounceTimer !== null) clearTimeout(phase4DebounceTimer);
  phase4DebounceTimer = setTimeout(() => {
    phase4DebounceTimer = null;
    if (health) evaluateDraftHealth();
    if (planning) evaluatePlanning();
  }, 250);
  phase4DebounceTimer.unref?.();
}

function parseBoundedJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function healthRowsForTap(tapId) {
  const rows = db
    .prepare(
      `SELECT check_id, tap_id, enabled, config_json FROM health_check_config
       WHERE tap_id IN (0, ?) ORDER BY tap_id`
    )
    .all(tapId);
  const merged = new Map();
  for (const row of rows) {
    const previous = merged.get(row.check_id) || { enabled: false, config: {} };
    merged.set(row.check_id, {
      enabled: Boolean(row.enabled),
      config: { ...previous.config, ...parseBoundedJson(row.config_json) }
    });
  }
  return merged;
}

function healthConfigAtScope(checkId, tapId) {
  const row = db
    .prepare('SELECT config_json FROM health_check_config WHERE check_id=? AND tap_id=?')
    .get(checkId, tapId);
  return parseBoundedJson(row?.config_json);
}

function proposedHealthConfig(body) {
  const currentGlobal = healthConfigAtScope(body.check_id, 0);
  const proposedGlobal = body.tap_id === 0 ? { ...currentGlobal, ...body.config } : currentGlobal;
  const affectedTaps = body.tap_id === 0 ? [1, 2, 3, 4, 5, 6] : [body.tap_id];
  for (const tapId of affectedTaps) {
    const currentTap = healthConfigAtScope(body.check_id, tapId);
    const proposedTap = body.tap_id === tapId ? { ...currentTap, ...body.config } : currentTap;
    validateEffectiveHealthConfig(body.check_id, { ...proposedGlobal, ...proposedTap });
  }
  return {
    ...healthConfigAtScope(body.check_id, body.tap_id),
    ...body.config
  };
}

function draftHealthEngineConfig(tapId) {
  const rows = healthRowsForTap(tapId);
  const get = (id) => rows.get(id) || { enabled: false, config: {} };
  const low = get('low_keg');
  const scale = get('scale_availability');
  const leak = get('suspected_leak');
  const temperature = get('serving_temperature');
  const cleaning = get('line_cleaning_due');
  const cToF = (value) => (Number(value) * 9) / 5 + 32;
  return mergeDraftHealthConfig({
    low_keg: {
      enabled: low.enabled,
      thresholdOz: 0,
      thresholdPercent: Number(low.config.warning_percent ?? 20),
      criticalPercent: Number(low.config.critical_percent ?? 5)
    },
    scale_availability: {
      enabled: scale.enabled,
      staleAfterMs: Number(scale.config.stale_minutes ?? 30) * 60_000,
      unavailableAfterMs: Number(scale.config.unavailable_minutes ?? 5) * 60_000
    },
    suspected_leak: {
      enabled: leak.enabled,
      lossOz: Number(leak.config.loss_oz ?? 8),
      windowMs: Number(leak.config.window_minutes ?? 15) * 60_000,
      pourGraceMs: Number(leak.config.pour_grace_minutes ?? 2) * 60_000,
      settlingMs: Number(leak.config.settling_minutes ?? 10) * 60_000,
      resetMovementOz: 32,
      maxSamples: 64
    },
    serving_temperature: {
      enabled: temperature.enabled,
      minimumF: cToF(temperature.config.warning_min_c ?? 1.1),
      maximumF: cToF(temperature.config.warning_max_c ?? 5.6),
      criticalMinimumF: cToF(temperature.config.critical_min_c ?? -1.1),
      criticalMaximumF: cToF(temperature.config.critical_max_c ?? 10),
      durationMs: Number(temperature.config.duration_minutes ?? 15) * 60_000
    },
    line_cleaning_due: {
      enabled: cleaning.enabled,
      intervalDays: Number(cleaning.config.warning_days ?? 14),
      criticalAfterDays: Math.max(
        0,
        Number(cleaning.config.critical_days ?? 21) - Number(cleaning.config.warning_days ?? 14)
      )
    }
  });
}

function healthEngineForTap(tapId) {
  const config = draftHealthEngineConfig(tapId);
  const fingerprint = JSON.stringify(config);
  const existing = healthEngines.get(tapId);
  if (existing?.fingerprint === fingerprint) return existing.engine;
  const engine = new DraftHealthEngine({ config });
  healthEngines.set(tapId, { fingerprint, engine });
  return engine;
}

function latestCleaningAt(tapId) {
  return (
    db
      .prepare(
        `SELECT m.completed_at FROM maintenance_records m
         JOIN maintenance_record_taps mt ON mt.maintenance_id=m.maintenance_id
         WHERE mt.tap_id=? ORDER BY m.completed_at DESC, m.maintenance_id DESC LIMIT 1`
      )
      .get(tapId)?.completed_at ?? null
  );
}

function healthEventContext(tapId) {
  const lifecycle = activeLifecycle(db, tapId);
  const tap = db
    .prepare(
      `SELECT t.batch_id, t.override_name, t.override_style, b.recipe_name, b.style
       FROM taps t LEFT JOIN batches b ON b.batch_id=t.batch_id WHERE t.tap_id=?`
    )
    .get(tapId);
  return lifecycleEventContext({
    tapId,
    lifecycle,
    batchId: lifecycle?.batch_id ?? tap?.batch_id ?? null,
    displayName: tap?.override_name || tap?.recipe_name || null,
    displayStyle: tap?.override_style || tap?.style || null
  });
}

function healthTransition(previous, next) {
  const previousActionable = previous && previous.state !== 'healthy' && previous.state !== 'not_configured';
  const nextActionable = next.state !== 'healthy' && next.state !== 'not_configured';
  if (!previousActionable && nextActionable) return 'opened';
  if (nextActionable && !previous?.last_event_at) return 'opened';
  if (previousActionable && !nextActionable) return 'resolved';
  if (previousActionable && nextActionable && previous.severity !== next.severity) return 'escalated';
  return null;
}

function persistHealthEvaluation(tapId, evaluation, { publish = true } = {}) {
  const now = new Date(evaluation.evaluatedAt).toISOString();
  const previousRows = new Map(
    db
      .prepare('SELECT * FROM health_check_state WHERE tap_id=?')
      .all(tapId)
      .map((row) => [row.check_id, row])
  );
  const upsert = db.prepare(
    `INSERT INTO health_check_state
      (check_id, tap_id, lifecycle_id, state, severity, code, evidence_json, incident_id,
       transitioned_at, acknowledged_at, cooldown_until, last_event_at)
     VALUES (@check_id, @tap_id, @lifecycle_id, @state, @severity, @code, @evidence_json, @incident_id,
       @transitioned_at, @acknowledged_at, @cooldown_until, @last_event_at)
     ON CONFLICT(check_id, tap_id) DO UPDATE SET
       lifecycle_id=excluded.lifecycle_id, state=excluded.state, severity=excluded.severity,
       code=excluded.code, evidence_json=excluded.evidence_json, incident_id=excluded.incident_id,
       transitioned_at=excluded.transitioned_at, acknowledged_at=excluded.acknowledged_at,
       cooldown_until=excluded.cooldown_until, last_event_at=excluded.last_event_at`
  );
  const lifecycle = activeLifecycle(db, tapId);
  const projected = [];
  const pendingEvents = [];
  db.transaction(() => {
    for (const check of evaluation.checks) {
      const previous = previousRows.get(check.id) || null;
      const transition = healthTransition(previous, check);
      const actionable = check.state !== 'healthy' && check.state !== 'not_configured';
      const sameIncident =
        actionable &&
        previous &&
        previous.lifecycle_id === (lifecycle?.lifecycle_id ?? null) &&
        previous.state !== 'healthy' &&
        previous.state !== 'not_configured' &&
        transition !== 'escalated';
      const incidentId = actionable ? (sameIncident ? previous.incident_id : crypto.randomUUID()) : null;
      const config = healthRowsForTap(tapId).get(check.id)?.config || {};
      const cooldownMs = Number(config.cooldown_minutes ?? 360) * 60_000;
      const mayPublish =
        publish &&
        transition &&
        (check.state !== 'not_configured' || transition === 'resolved') &&
        (transition !== 'resolved' || Boolean(previous?.last_event_at));
      const row = {
        check_id: check.id,
        tap_id: tapId,
        lifecycle_id: lifecycle?.lifecycle_id ?? null,
        state: check.state,
        severity: check.severity,
        code: check.evidence?.reason || check.evidence?.label || null,
        evidence_json: JSON.stringify(check.evidence || {}).slice(0, 4096),
        incident_id: incidentId,
        transitioned_at: transition ? now : previous?.transitioned_at || now,
        acknowledged_at: sameIncident && transition !== 'escalated' ? (previous?.acknowledged_at ?? null) : null,
        cooldown_until: mayPublish
          ? new Date(evaluation.evaluatedAt + cooldownMs).toISOString()
          : (previous?.cooldown_until ?? null),
        last_event_at: mayPublish ? now : (previous?.last_event_at ?? null)
      };
      if (publish) upsert.run(row);
      if (mayPublish) {
        pendingEvents.push({
          eventType: 'health_transition',
          data: {
            check_id: check.id,
            transition,
            state: transition === 'resolved' || check.state === 'healthy' ? 'healthy' : check.state,
            severity: check.severity,
            code: row.code
          }
        });
        if (check.id === 'low_keg' && transition === 'opened') {
          const threshold = Number(config.warning_percent ?? 20);
          const current = Number(check.evidence?.volumeOz);
          const capacity = Number(haClient.getPublicTapStates()?.[String(tapId)]?.capacityOz);
          const currentPercent = capacity > 0 ? Math.max(0, Math.min(100, (current / capacity) * 100)) : 0;
          pendingEvents.push({
            eventType: 'low_keg',
            data: {
              current_percent: currentPercent,
              threshold_percent: threshold
            }
          });
        }
      }
      projected.push({
        id: check.id,
        tapId,
        state: check.state,
        severity: check.severity,
        code: row.code,
        evidence: check.evidence || {},
        incidentId,
        transitionedAt: row.transitioned_at,
        acknowledged: Boolean(row.acknowledged_at),
        acknowledgeable: actionable
      });
    }
  })();
  for (const event of pendingEvents) publishTapboardEvent(event.eventType, healthEventContext(tapId), event.data);
  return projected;
}

function evaluateDraftHealth({ publish = true } = {}) {
  const checks = [];
  for (let tapId = 1; tapId <= 6; tapId++) {
    const lifecycle = activeLifecycle(db, tapId);
    const rows = healthRowsForTap(tapId);
    const temperatureEntityId = rows.get('serving_temperature')?.config?.entity_id || null;
    const evaluation = healthEngineForTap(tapId).evaluate({
      tapId,
      lifecycle,
      connected: haClient.isConnected,
      ...haClient.getTapHealthInput(tapId),
      temperature: temperatureEntityId ? haClient.getEntityState(temperatureEntityId) : null,
      lineCleanedAt: latestCleaningAt(tapId)
    });
    checks.push(...persistHealthEvaluation(tapId, evaluation, { publish }));
  }
  const active = checks.filter((check) => check.state === 'active' || check.state === 'degraded');
  const severityRank = { none: 0, info: 1, warning: 2, critical: 3 };
  const highestSeverity = active.reduce(
    (highest, check) => (severityRank[check.severity] > severityRank[highest] ? check.severity : highest),
    'none'
  );
  draftHealthProjection = {
    schemaVersion: 1,
    configured: true,
    summary: active.length
      ? `${active.length} draft health item${active.length === 1 ? '' : 's'} need attention.`
      : 'Draft health is clear.',
    attentionCount: active.length,
    highestSeverity,
    checks,
    evaluatedAt: new Date().toISOString()
  };
  if (publish) sseHub.publishImmediate('health_updated', draftHealthProjection);
  return draftHealthProjection;
}

function readinessPolicy() {
  return db.prepare('SELECT * FROM readiness_policy WHERE id=1').get();
}

function planningCandidates(policy = readinessPolicy()) {
  const rows = db
    .prepare(
      `SELECT b.*, p.visible, d.payload_json AS detail_json, o.earliest_date, o.latest_date, o.confirmed
       FROM batches b
       JOIN brewfather_ondeck_preferences p ON p.batch_id=b.batch_id
       LEFT JOIN brewfather_batch_details d ON d.batch_id=b.batch_id
       LEFT JOIN batch_readiness_overrides o ON o.batch_id=b.batch_id
       JOIN settings s ON s.id=1
       WHERE b.present=1 AND p.visible=1 AND s.show_ondeck=1
       ORDER BY b.brew_date DESC, b.batch_id LIMIT 50`
    )
    .all();
  const requirements = db.prepare('SELECT capability FROM batch_capability_requirements WHERE batch_id=?');
  return rows.map((row) => {
    const detail = parseBoundedJson(row.detail_json, {});
    const fermentation = detail?.recipe?.profiles?.fermentation;
    const minutes = Array.isArray(fermentation?.steps)
      ? fermentation.steps.reduce(
          (sum, step) =>
            sum + Math.max(0, Number(step?.time_minutes) || 0) + Math.max(0, Number(step?.ramp_minutes) || 0),
          0
        )
      : 0;
    const fermentationDays = minutes > 0 ? [Math.ceil(minutes / 1_440), Math.ceil(minutes / 1_440)] : null;
    return {
      batchId: row.batch_id,
      name: row.recipe_name || row.batch_name || 'On Deck batch',
      style: row.style || '',
      status: row.status,
      brew_date: row.brew_date?.slice(0, 10) || null,
      start_date: row.start_date?.slice(0, 10) || null,
      fermentation_start_date: row.fermentation_start_date?.slice(0, 10) || null,
      conditioning_date: row.conditioning_date?.slice(0, 10) || null,
      packaging_date: row.packaging_date?.slice(0, 10) || null,
      completed_date: row.completed_date?.slice(0, 10) || null,
      fermentationDays,
      detail: detail && Object.keys(detail).length ? { fermentation_profile: fermentation } : null,
      override: {
        earliest_date: row.earliest_date,
        latest_date: row.latest_date,
        confirmed: row.confirmed === 1
      },
      requiredCapabilities: requirements.all(row.batch_id).map((item) => item.capability),
      syncFreshness: {
        stale:
          !row.last_success_at ||
          Date.now() - Date.parse(row.last_success_at) > Number(policy.stale_after_hours ?? 12) * 60 * 60_000
      }
    };
  });
}

function evaluatePlanning({ publish = true } = {}) {
  const policyRow = readinessPolicy();
  const policy = {
    ...DEFAULT_TAP_PLANNING_POLICY,
    fermentationDays: [policyRow.fallback_fermentation_min_days, policyRow.fallback_fermentation_max_days],
    packagingDays: [policyRow.packaging_min_days, policyRow.packaging_max_days],
    conditioningDays: [policyRow.conditioning_min_days, policyRow.conditioning_max_days],
    planningLatestUncertaintyDays: policyRow.planning_uncertainty_days
  };
  const capabilityQuery = db.prepare('SELECT capability FROM tap_capabilities WHERE tap_id=? ORDER BY capability');
  const taps = db
    .prepare('SELECT tap_id, batch_id FROM taps WHERE enabled=1 ORDER BY tap_id')
    .all()
    .map((tap) => ({
      tapId: tap.tap_id,
      batchId: tap.batch_id,
      capabilityTags: capabilityQuery.all(tap.tap_id).map((row) => row.capability),
      forecast: calculateKegKickForecast(tap.tap_id)
    }));
  const raw = buildTapPlanningProjection({ taps, candidates: planningCandidates(policyRow), policy });
  const plans = raw.map((plan) => {
    const candidates = plan.candidates.slice(0, 3).map((candidate) => ({
      batchId: candidate.batchId,
      name: candidate.name,
      style: candidate.style,
      readiness: {
        earliest: candidate.readiness.earliest,
        latest: candidate.readiness.latest,
        confidence: candidate.readiness.confidence,
        source: candidate.readiness.source,
        confirmed: candidate.override?.confirmed === true,
        status: candidate.status === 'Completed' ? 'potential_completed' : 'potential'
      },
      compatibility: candidate.compatibility,
      gap: candidate.gap
    }));
    const selected = candidates.find((candidate) => candidate.compatibility.status !== 'incompatible') || null;
    return {
      tapId: plan.tapId,
      tapName: `Tap ${plan.tapId}`,
      forecastAvailable: plan.forecastAvailable,
      classification: selected?.gap?.classification || 'unknown',
      candidateName: selected?.name || null,
      confidence: selected?.readiness?.confidence || 'low',
      compatibility: selected?.compatibility?.status || 'potential',
      rangeText:
        selected?.readiness?.earliest && selected?.readiness?.latest
          ? `${selected.readiness.earliest} to ${selected.readiness.latest}`
          : null,
      assumptions: [
        'Recommendations are timing estimates, not physical keg inventory.',
        'Fermentation data is read-only and never declares completion.'
      ],
      noInventory: true,
      candidates
    };
  });
  const sync = getBrewfatherSyncStatus(db);
  tapPlanningProjection = {
    schemaVersion: 1,
    configured: true,
    stale: !['ok', 'running'].includes(sync.status),
    taps: plans,
    evaluatedAt: new Date().toISOString()
  };
  persistPlanningTransitions(plans, policyRow, { publish });
  if (publish) sseHub.publishImmediate('planning_updated', tapPlanningProjection);
  return tapPlanningProjection;
}

function persistPlanningTransitions(plans, policy, { publish = true } = {}) {
  if (!publish) return;
  const select = db.prepare('SELECT * FROM forecast_gap_state WHERE tap_id=?');
  const upsert = db.prepare(
    `INSERT INTO forecast_gap_state
      (tap_id, lifecycle_id, state, candidate_batch_id, gap_min_days, gap_max_days, signature, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tap_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id, state=excluded.state,
       candidate_batch_id=excluded.candidate_batch_id, gap_min_days=excluded.gap_min_days,
       gap_max_days=excluded.gap_max_days, signature=excluded.signature, last_event_at=excluded.last_event_at,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  );
  const now = Date.now();
  for (const plan of plans) {
    const lifecycle = activeLifecycle(db, plan.tapId);
    const candidate = plan.candidates.find((item) => item.compatibility.status !== 'incompatible') || null;
    const classification = candidate?.gap?.classification || 'unknown';
    const minGap = candidate?.gap?.earliestGapDays ?? null;
    const maxGap = candidate?.gap?.latestGapDays ?? null;
    const signature = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([lifecycle?.lifecycle_id ?? null, classification, candidate?.batchId ?? null, minGap, maxGap])
      )
      .digest('hex');
    const previous = select.get(plan.tapId);
    const opened = classification === 'forecast_gap' && previous?.state !== 'forecast_gap';
    const resolved = previous?.state === 'forecast_gap' && classification !== 'forecast_gap';
    const materiallyChanged =
      classification === 'forecast_gap' &&
      previous?.state === 'forecast_gap' &&
      (previous.candidate_batch_id !== candidate?.batchId ||
        Math.abs(Number(previous.gap_min_days) - Number(minGap)) >= 1 ||
        Math.abs(Number(previous.gap_max_days) - Number(maxGap)) >= 1);
    const cooldownElapsed =
      !previous?.last_event_at || now - Date.parse(previous.last_event_at) >= policy.cooldown_hours * 60 * 60_000;
    const transition = opened
      ? 'opened'
      : resolved
        ? 'resolved'
        : materiallyChanged && cooldownElapsed
          ? 'updated'
          : null;
    const lastEventAt = publish && transition ? new Date(now).toISOString() : (previous?.last_event_at ?? null);
    upsert.run(
      plan.tapId,
      lifecycle?.lifecycle_id ?? null,
      classification,
      candidate?.batchId ?? null,
      minGap,
      maxGap,
      signature,
      lastEventAt
    );
    if (publish && transition) {
      publishTapboardEvent('forecast_gap', healthEventContext(plan.tapId), {
        transition,
        classification,
        candidate_batch_id: candidate?.batchId ?? null,
        gap_min_days: minGap,
        gap_max_days: maxGap,
        confidence: candidate?.readiness?.confidence || 'low',
        compatibility: candidate?.compatibility?.status || 'potential'
      });
    }
  }
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
  schedulePhase4Evaluation({ health: true });
});

haClient.on('source_state_changed', () => schedulePhase4Evaluation({ health: true }));

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
  schedulePhase4Evaluation({ health: true, planning: true });
});

haClient.on('pour_receipt', (data) => {
  sseHub.publishImmediate('pour_receipt', data);
});

haClient.on('pour_receipt_updated', (data) => {
  sseHub.publishImmediate('pour_receipt_updated', data);
});

haClient.on('first_pour', (data) => {
  sseHub.publishImmediate('first_pour', data);
});

haClient.on('keg_kicked', (data) => {
  sseHub.publishImmediate('keg_kicked', data);
  sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
});

haClient.on('pour_cancel', (data) => {
  console.log(`[SSE Broadcast] pour_cancel on Tap ${data.tapId}: ${data.reason}`);
  sseHub.publishImmediate('pour_cancel', data);
});

haClient.on('low_keg_alert', (data) => {
  sseHub.publishImmediate('low_keg_alert', data);
});

haClient.on('hydrated', () => {
  evaluateDraftHealth();
  sseHub.publishImmediate('snapshot', getFullStateSnapshot());
});

function eligibleOndeckBatches() {
  return onDeckBatches(db);
}

function onDeckBatchesForPublic() {
  return onDeckBatches(db, { limit: 50 });
}

function isOndeckEnabled() {
  return db.prepare('SELECT show_ondeck FROM settings WHERE id = 1').get()?.show_ondeck === 1;
}

function brewfatherStatus() {
  const budget = brewfatherClient?.getBudgetStatus?.() || null;
  const sync = getBrewfatherSyncStatus(db);
  const hasCache = Boolean(db.prepare('SELECT 1 FROM batches LIMIT 1').get());
  const cacheStatus =
    sync.status === 'running' ? 'refreshing' : sync.status === 'ok' ? 'current' : hasCache ? 'stale' : 'empty';
  return {
    configured: Boolean(brewfatherClient),
    ...sync,
    has_cache: hasCache,
    cache_status: cacheStatus,
    budget: budget
      ? { limit: budget.limit, used: budget.used, remaining: budget.remaining, blockedUntil: budget.blockedUntil }
      : null
  };
}

function customBeverage() {
  const beverage = db
    .prepare('SELECT id, name, style, abv, ibu, og, fg, srm, description FROM custom_beverage WHERE id = ?')
    .get('custom:topo_chico');
  return beverage ? { ...beverage, assignmentOption: 'custom:topo_chico | Tapboard Custom Beverage' } : null;
}

function optionForBatch(batch) {
  return batch ? `${batch.batch_id} | ${batch.recipe_name} (${batch.status || 'Cached'})` : null;
}

function batchOptionsForTap(tap) {
  const options = assignmentOptions(db).map((batch) => batch.assignmentOption);
  const custom = customBeverage();
  if (custom) options.push(custom.assignmentOption);
  if (tap?.batch_id && !tap.batch_id.startsWith('custom:')) {
    const current = batchSummary(db, tap.batch_id);
    const option = optionForBatch(current) || `${tap.batch_id} | Current assignment`;
    if (!options.includes(option)) options.push(option);
  }
  return options.slice(0, 152);
}

function resolveBatchOption(tap, option) {
  if (option === '') return null;
  const custom = customBeverage();
  if (custom && option === custom.assignmentOption) return custom.id;
  const match = assignmentOptions(db).find((batch) => batch.assignmentOption === option);
  if (match) return match.batch_id;
  if (tap?.batch_id && !tap.batch_id.startsWith('custom:')) {
    const current = batchSummary(db, tap.batch_id);
    if (option === (optionForBatch(current) || `${tap.batch_id} | Current assignment`)) return tap.batch_id;
  }
  throw new ValidationError('Invalid batch option');
}

function batchProjection(batch) {
  if (!batch) return null;
  return {
    batchId: batch.batch_id,
    recipeName: batch.recipe_name,
    style: batch.style,
    brewDate: batch.brew_date,
    og: batch.og,
    fg: batch.fg,
    abv: batch.abv,
    ibu: batch.ibu,
    srm: batch.srm,
    description: batch.description,
    status: batch.status
  };
}

function tapStatesFromNativeCache(taps) {
  const states = haClient.getPublicTapStates();
  const custom = customBeverage();
  for (const tap of taps) {
    const tapId = String(tap.tap_id);
    const batch = tap.batch_id?.startsWith('custom:')
      ? custom && {
          batch_id: custom.id,
          recipe_name: custom.name,
          style: custom.style,
          brew_date: null,
          og: custom.og,
          fg: custom.fg,
          abv: custom.abv,
          ibu: custom.ibu,
          srm: custom.srm,
          description: custom.description,
          status: 'Custom'
        }
      : batchSummary(db, tap.batch_id);
    const options = batchOptionsForTap(tap);
    states[tapId] = {
      ...states[tapId],
      batch: batchProjection(batch),
      batchSelection: {
        value: tap.batch_id
          ? options.find((option) => option === custom?.assignmentOption || option.startsWith(`${tap.batch_id} |`)) ||
            ''
          : '',
        options
      }
    };
  }
  return states;
}

function publishTapboardEvent(eventType, context, data) {
  let event;
  try {
    event = buildTapboardEvent(eventType, context, data);
  } catch (error) {
    console.warn(`[Tapboard event] Could not build ${eventType}: ${error.message}`);
    return;
  }
  haClient.fireEvent('tapboard_event', event).catch((error) => {
    console.warn(`[Tapboard event] Could not publish ${eventType}: ${error.message}`);
  });
}

function publishBrewfatherSyncFailure(result) {
  let event;
  try {
    event = buildBrewfatherSyncFailureEvent(result);
  } catch {
    console.warn('[Tapboard event] Could not build brewfather_sync_failed');
    return;
  }
  haClient.fireEvent('tapboard_event', event).catch(() => {
    console.warn('[Tapboard event] Could not publish brewfather_sync_failed');
  });
}

function lifecycleEventContext({ tapId, lifecycle, batchId, displayName, displayStyle }) {
  return {
    tap_id: tapId,
    lifecycle_id: lifecycle?.lifecycle_id ?? null,
    batch_id: batchId ?? lifecycle?.batch_id ?? null,
    metadata: {
      ...(displayName ? { display_name: displayName } : {}),
      ...(displayStyle ? { display_style: displayStyle } : {})
    }
  };
}

function activeLifecycleMilestones() {
  return Object.fromEntries(
    db
      .prepare(
        `SELECT l.tap_id, l.lifecycle_id, m.first_pour_at, m.kicked_at, m.kick_trigger
         FROM keg_lifecycles l
         LEFT JOIN lifecycle_milestones m ON m.lifecycle_id = l.lifecycle_id
         WHERE l.closed_at IS NULL`
      )
      .all()
      .map((row) => [
        row.tap_id,
        {
          lifecycleId: row.lifecycle_id,
          firstPourAt: row.first_pour_at ?? null,
          kickedAt: row.kicked_at ?? null,
          kickTrigger: row.kick_trigger ?? null
        }
      ])
  );
}

// Construct Full Application State Snapshot
function getFullStateSnapshot() {
  const settings = db
    .prepare(
      `SELECT id, theme, volume_format, title, font_title, font_body, show_ondeck,
        layout_mode, ondeck_new_batch_default, primary_color, secondary_color,
        first_pour_effects, kick_effects, ceremony_sound
       FROM settings WHERE id = 1`
    )
    .get();
  const taps = db
    .prepare(
      `
    SELECT tap_id, enabled, batch_id, graphic, kick_threshold_oz,
      override_enabled, override_name,
      override_style, override_abv, override_ibu, override_og, override_fg,
      override_srm, override_description, badge_low_keg, badge_fresh,
      on_tap_at, display_unit, custom_pour_size
    FROM taps ORDER BY tap_id ASC
  `
    )
    .all();
  const tapCapabilityQuery = db.prepare('SELECT capability FROM tap_capabilities WHERE tap_id=? ORDER BY capability');
  for (const tap of taps) tap.capabilities = tapCapabilityQuery.all(tap.tap_id).map((row) => row.capability);
  const assignedIds = [...new Set(taps.map((tap) => tap.batch_id).filter((id) => id && !id.startsWith('custom:')))];
  const batches = assignedIds.map((batchId) => batchSummary(db, batchId)).filter(Boolean);
  const onDeckBatches = settings.show_ondeck ? onDeckBatchesForPublic().filter((batch) => batch.visible) : [];
  const tapStates = tapStatesFromNativeCache(taps);

  const kegKickForecasts = {};
  for (let i = 1; i <= 6; i++) {
    kegKickForecasts[i] = calculateKegKickForecast(i);
  }

  return {
    schemaVersion: 9,
    settings,
    taps,
    batches,
    onDeckBatches,
    customBeverage: customBeverage(),
    tapStates,
    haConnected: haClient.isConnected,
    kegKickForecasts,
    lifecycleMilestones: activeLifecycleMilestones(),
    draftHealth: draftHealthProjection,
    tapPlanning: tapPlanningProjection,
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
        res.setHeader('Retry-After', String(Math.ceil((attempt.lockUntil - now) / 1000)));
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

  const storyMatch = url.pathname.match(/^\/api\/batches\/([A-Za-z0-9_-]{1,256})\/story$/);
  if (storyMatch && req.method === 'GET') {
    const batchId = storyMatch[1];
    try {
      if (!validBrewfatherBatchId(batchId)) throw new ValidationError('Invalid Brewfather batch');
      const queryKeys = [...new Set(url.searchParams.keys())];
      if (
        queryKeys.some((key) => !['window', 'tap_id'].includes(key)) ||
        url.searchParams.getAll('window').length > 1 ||
        url.searchParams.getAll('tap_id').length > 1
      ) {
        throw new ValidationError('Invalid story query');
      }
      const window = url.searchParams.get('window') || '7d';
      if (!BREW_STORY_WINDOWS.includes(window)) throw new ValidationError('Invalid story window');
      const storyTapId = url.searchParams.has('tap_id') ? validateTapId(url.searchParams.get('tap_id')) : null;
      const authorized = isAuthorized(req);
      if (!authorized && !storyIsPublic(db, batchId)) {
        sendError(res, 404, 'Brew story not found');
        return;
      }
      const storyTap =
        storyTapId === null
          ? null
          : db.prepare('SELECT tap_id, batch_id FROM taps WHERE tap_id=? AND batch_id=?').get(storyTapId, batchId);
      if (storyTapId !== null && !storyTap) throw new ValidationError('Tap does not have this batch assigned');
      const story = buildBrewStory({
        db,
        batchId,
        window,
        tapStates: haClient.getPublicTapStates(),
        forecastForTap: calculateKegKickForecast,
        includeHiddenSensory: authorized
      });
      if (!story) sendError(res, 404, 'Brew story not found');
      else sendBoundedJson(res, 200, story);
    } catch (error) {
      handleError(res, error, requestContext('read Brew Story'));
    }
    return;
  }

  const sensoryMatch = url.pathname.match(/^\/api\/batches\/([A-Za-z0-9_-]{1,256})\/sensory$/);
  if (sensoryMatch && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const batchId = sensoryMatch[1];
    try {
      if (!db.prepare('SELECT 1 FROM batches WHERE batch_id=? AND present=1').get(batchId)) {
        sendError(res, 404, 'Brew story not found');
        return;
      }
      const body = validateSensoryOverride(await readJsonBody(req));
      const current = sensoryOverride(db, batchId);
      const merged = {
        hidden: body.hidden ?? current.hidden,
        description_override:
          body.description_override === undefined ? current.description_override : body.description_override,
        axis_overrides: {
          ...current.axes,
          ...(body.axis_overrides || {})
        }
      };
      sendJson(res, 200, { success: true, sensory: saveSensoryOverride(db, batchId, merged) });
    } catch (error) {
      handleError(res, error, requestContext('update sensory override'));
    }
    return;
  }

  const imageMatch = url.pathname.match(/^\/api\/batches\/([A-Za-z0-9_-]{1,256})\/image$/);
  if (imageMatch && req.method === 'GET') {
    const batchId = imageMatch[1];
    try {
      if (!isAuthorized(req) && !storyIsPublic(db, batchId)) {
        sendError(res, 404, 'Brew image not found');
        return;
      }
      const imageUrl = db
        .prepare('SELECT image_url FROM batches WHERE batch_id=? AND present=1')
        .get(batchId)?.image_url;
      if (!imageUrl) {
        sendError(res, 404, 'Brew image not found');
        return;
      }
      const image = await fetchCachedImage(imageUrl);
      res.writeHead(200, {
        'Content-Type': image.contentType,
        'Content-Length': image.body.length,
        'Cache-Control': 'no-store'
      });
      res.end(image.body);
    } catch (error) {
      if (!res.headersSent) sendError(res, 502, 'Brew image unavailable');
      else res.destroy();
    }
    return;
  }

  // 4. Read Brewfather configuration and cache-sync status for General Settings.
  if (url.pathname === '/api/brewfather/status' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      sendJson(res, 200, { brewfather: brewfatherStatus() });
    } catch (error) {
      handleError(res, error, requestContext('read Brewfather status'));
    }
    return;
  }

  // 5. Change the administrator PIN. This is deliberately separate from
  // general settings so ordinary autosaves can never include credentials.
  if (url.pathname === '/api/admin/pin' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const now = Date.now();
      const attempt = pinChangeAttempts.get(clientIp) || { count: 0, lockUntil: 0 };
      if (attempt.lockUntil > now) {
        const remainingMinutes = Math.ceil((attempt.lockUntil - now) / 60000);
        res.setHeader('Retry-After', String(Math.ceil((attempt.lockUntil - now) / 1000)));
        sendJson(res, 429, { error: `Too many failed attempts. Locked out for ${remainingMinutes} minutes.` });
        return;
      }
      const body = validatePinChange(await readJsonBody(req));
      ensureServing();
      const settings = db.prepare('SELECT admin_pin_hash FROM settings WHERE id = 1').get();
      if (!bcrypt.compareSync(body.current_pin, settings.admin_pin_hash)) {
        attempt.count += 1;
        if (attempt.count >= 5) attempt.lockUntil = now + 15 * 60 * 1000;
        pinChangeAttempts.set(clientIp, attempt);
        console.warn(`[PIN SECURITY] Failed current PIN verification request_id=${requestId} client=${clientIp}`);
        sendError(res, 403, 'Current PIN is incorrect');
        return;
      }
      pinChangeAttempts.delete(clientIp);
      const pinHash = bcrypt.hashSync(body.new_pin, 10);
      db.transaction(() => {
        db.prepare('UPDATE settings SET admin_pin_hash = ?, admin_pin_initialized = 1 WHERE id = 1').run(pinHash);
        db.prepare('DELETE FROM admin_sessions').run();
      })();
      console.log(`[PIN ACTION] Admin PIN updated request_id=${requestId} client=${clientIp}`);
      sendJson(res, 200, { success: true, sessionsRevoked: true });
    } catch (err) {
      handleError(res, err, requestContext('change admin PIN'));
    }
    return;
  }

  // 5. Update Global Settings & Tap Visibilities (/api/settings)
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
        primary_color,
        secondary_color,
        first_pour_effects,
        kick_effects,
        ceremony_sound
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
          ondeck_new_batch_default = COALESCE(?, ondeck_new_batch_default),
          primary_color = CASE WHEN ? THEN ? ELSE primary_color END,
          secondary_color = CASE WHEN ? THEN ? ELSE secondary_color END,
          first_pour_effects = COALESCE(?, first_pour_effects),
          kick_effects = COALESCE(?, kick_effects),
          ceremony_sound = COALESCE(?, ceremony_sound)
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
        ondeck_new_batch_default !== undefined ? (ondeck_new_batch_default ? 1 : 0) : null,
        primary_color !== undefined ? 1 : 0,
        primary_color,
        secondary_color !== undefined ? 1 : 0,
        secondary_color,
        first_pour_effects !== undefined ? (first_pour_effects ? 1 : 0) : null,
        kick_effects !== undefined ? (kick_effects ? 1 : 0) : null,
        ceremony_sound
      );

      if (tap_visibilities && typeof tap_visibilities === 'object') {
        const updateTapEnabled = db.prepare('UPDATE taps SET enabled = ? WHERE tap_id = ? AND enabled IS NOT ?');
        for (let i = 1; i <= 6; i++) {
          if (tap_visibilities[i] !== undefined) {
            const isEnabled = tap_visibilities[i] ? 1 : 0;
            const changed = updateTapEnabled.run(isEnabled, i, isEnabled).changes > 0;
            if (changed) {
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
      }

      console.log(`[SETTINGS ACTION] Global Studio Settings updated request_id=${requestId} client=${clientIp}`);

      evaluatePlanning();
      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, { success: true, settings: getFullStateSnapshot().settings });
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
      await tapMutations.runExclusive(tapId, async () => {
        // Auto-enable tap if a batch is assigned
        let shouldEnable = body.enabled !== undefined ? (body.enabled ? 1 : 0) : null;
        let extractedBatchId = null;
        const currentTap = db
          .prepare(
            `SELECT enabled, batch_id, on_tap_at, override_enabled, override_name, override_style
        FROM taps WHERE tap_id = ?`
          )
          .get(tapId);
        let onTapAt = currentTap.on_tap_at;
        if (body.batch_option !== undefined) {
          if (body.batch_option !== '') {
            shouldEnable = 1;
            extractedBatchId = resolveBatchOption(currentTap, body.batch_option);
            if (extractedBatchId !== currentTap.batch_id || !onTapAt) onTapAt = new Date().toISOString();
          } else {
            extractedBatchId = null;
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
        const currentBatch = currentTap.batch_id?.startsWith('custom:')
          ? customBeverage()
          : batchSummary(db, currentTap.batch_id);
        const currentDisplayName = currentTap.override_name || currentBatch?.name || currentBatch?.recipe_name || null;
        const currentDisplayStyle = currentTap.override_style || currentBatch?.style || null;
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

        // Build a partial update rather than using COALESCE: empty override
        // fields are an intentional request to clear the stored nullable value.
        const tapUpdates = [];
        const tapValues = [];
        const addTapUpdate = (column, value) => {
          tapUpdates.push(`${column} = ?`);
          tapValues.push(value);
        };
        if (shouldEnable !== null) addTapUpdate('enabled', shouldEnable);
        if (body.batch_option !== undefined) addTapUpdate('batch_id', extractedBatchId);
        if (body.batch_option !== undefined || lifecycleChanges) addTapUpdate('on_tap_at', onTapAt);
        const assignedBatchGraphic =
          body.batch_option !== undefined && extractedBatchId && !extractedBatchId.startsWith('custom:')
            ? fillGraphicForStyle(batchSummary(db, extractedBatchId)?.style)
            : null;
        const directColumns = {
          graphic: body.graphic === undefined ? (assignedBatchGraphic ?? undefined) : body.graphic,
          kick_threshold_oz: body.kick_threshold_oz,
          override_enabled: body.override_enabled === undefined ? undefined : body.override_enabled ? 1 : 0,
          override_name: body.override_name,
          override_style: body.override_style,
          override_description: body.override_description,
          badge_low_keg: body.badge_low_keg,
          badge_fresh: body.badge_fresh === undefined ? undefined : body.badge_fresh ? 1 : 0,
          display_unit: body.display_unit
        };
        for (const [column, value] of Object.entries(directColumns))
          if (value !== undefined) addTapUpdate(column, value);
        for (const column of [
          'override_abv',
          'override_ibu',
          'override_og',
          'override_fg',
          'override_srm',
          'custom_pour_size'
        ]) {
          if (body[column] !== undefined) addTapUpdate(column, body[column] === '' ? null : body[column]);
        }
        const updateTap = tapUpdates.length
          ? db.prepare(`UPDATE taps SET ${tapUpdates.join(', ')} WHERE tap_id = ?`)
          : null;
        const applyTapUpdate = () => {
          if (updateTap) updateTap.run(...tapValues, tapId);
        };
        let committedLifecycle = currentLifecycle;
        if (lifecycleChanges && desiredAssignment) {
          committedLifecycle = assignKegLifecycle(db, {
            tapId,
            ...desiredAssignment,
            startedAt: onTapAt,
            closeReason: currentLifecycle ? 'reassigned' : 'opened',
            updateTap: applyTapUpdate
          });
        } else if (lifecycleChanges && currentLifecycle) {
          committedLifecycle = closeKegLifecycle(db, {
            tapId,
            closedAt: new Date().toISOString(),
            closeReason: 'cleared',
            updateTap: applyTapUpdate
          });
        } else {
          db.transaction(applyTapUpdate)();
        }
        if (body.capabilities !== undefined) {
          db.transaction(() => {
            db.prepare('DELETE FROM tap_capabilities WHERE tap_id=?').run(tapId);
            const insertCapability = db.prepare('INSERT INTO tap_capabilities (tap_id, capability) VALUES (?, ?)');
            for (const capability of body.capabilities) insertCapability.run(tapId, capability);
          })();
        }
        if (body.badge_low_keg !== undefined) {
          db.prepare(
            `INSERT INTO health_check_config (check_id, tap_id, enabled, config_json)
             VALUES ('low_keg', ?, ?, ?)
             ON CONFLICT(check_id, tap_id) DO UPDATE SET enabled=excluded.enabled,
               config_json=json_patch(health_check_config.config_json, excluded.config_json),
               updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
          ).run(
            tapId,
            body.badge_low_keg > 0 ? 1 : 0,
            JSON.stringify({ warning_percent: body.badge_low_keg > 0 ? body.badge_low_keg : 20 })
          );
          healthEngines.delete(tapId);
        }
        if (lifecycleChanges) haClient.clearTapMeasurement(tapId);

        if (lifecycleChanges && currentLifecycle) {
          publishTapboardEvent(
            'keg_ended',
            lifecycleEventContext({
              tapId,
              lifecycle: currentLifecycle,
              batchId: currentLifecycle.batch_id,
              displayName: currentDisplayName,
              displayStyle: currentDisplayStyle
            }),
            { reason: desiredAssignment ? 'reassigned' : 'cleared' }
          );
        }
        if (lifecycleChanges && desiredAssignment) {
          const updatedTap = db
            .prepare('SELECT override_name, override_style, batch_id FROM taps WHERE tap_id = ?')
            .get(tapId);
          const updatedBatch = updatedTap.batch_id?.startsWith('custom:')
            ? customBeverage()
            : batchSummary(db, updatedTap.batch_id);
          publishTapboardEvent(
            'keg_assigned',
            lifecycleEventContext({
              tapId,
              lifecycle: committedLifecycle,
              batchId: desiredAssignment.batchId,
              displayName: updatedTap.override_name || updatedBatch?.name || updatedBatch?.recipe_name || null,
              displayStyle: updatedTap.override_style || updatedBatch?.style || null
            }),
            { assignment_kind: desiredAssignment.assignmentKind }
          );
        }

        console.log(`[TAP ACTION] Tap settings updated request_id=${requestId} tap_id=${tapId} client=${clientIp}`);

        // Sync Home Assistant input_boolean.tap_N_enabled
        const finalEnabled = shouldEnable === null ? currentTap.enabled : shouldEnable;
        if (finalEnabled !== currentTap.enabled) {
          const haEnabledService = finalEnabled === 1 ? 'turn_on' : 'turn_off';
          await haClient
            .callHAService('input_boolean', haEnabledService, {
              entity_id: `input_boolean.tap_${tapId}_enabled`
            })
            .catch((err) => console.warn(`[HA Warning] Enable boolean call failed:`, err.message));
        }

        evaluateDraftHealth();
        evaluatePlanning();
        sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
        sendJson(res, 200, {
          success: true,
          tap: {
            ...db.prepare('SELECT * FROM taps WHERE tap_id = ?').get(tapId),
            capabilities: db
              .prepare('SELECT capability FROM tap_capabilities WHERE tap_id=? ORDER BY capability')
              .all(tapId)
              .map((row) => row.capability)
          }
        });
      });
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
      const result = await tapMutations.endBatch(tapId);
      ensureServing();
      haClient.clearTapMeasurement(tapId);

      publishTapboardEvent(
        'keg_ended',
        lifecycleEventContext({
          tapId,
          lifecycle: result.lifecycle,
          batchId: result.batchId,
          displayName: result.displayName,
          displayStyle: result.displayStyle
        }),
        { reason: 'end_batch' }
      );

      evaluateDraftHealth();
      evaluatePlanning();
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
    let endKegReason;
    try {
      tapId = validateTapId(url.pathname.split('/')[3]);
      endKegReason = validateEndKeg(await readOptionalJsonBody(req)).reason;
      ensureServing();
    } catch (err) {
      handleError(res, err, requestContext('end keg validation', tapId));
      return;
    }
    try {
      const result = await tapMutations.endKeg(tapId, { reason: endKegReason });
      ensureServing();
      haClient.clearTapMeasurement(tapId);

      publishTapboardEvent(
        'keg_ended',
        lifecycleEventContext({
          tapId,
          lifecycle: result.lifecycle,
          batchId: result.batchId,
          displayName: result.displayName,
          displayStyle: result.displayStyle
        }),
        { reason: result.closeReason }
      );

      if (result.kickClaimed) {
        publishTapboardEvent(
          'keg_kicked',
          lifecycleEventContext({
            tapId,
            lifecycle: result.lifecycle,
            batchId: result.batchId,
            displayName: result.displayName,
            displayStyle: result.displayStyle
          }),
          { trigger: 'manual', receipt_id: null, remaining_volume_oz: null, threshold_oz: null }
        );
        sseHub.publishImmediate('keg_kicked', {
          tapId,
          lifecycleId: result.lifecycle?.lifecycle_id ?? null,
          beerName: result.displayName || `Tap ${tapId}`,
          trigger: 'manual',
          kickedAt: result.kickMilestone?.kicked_at ?? new Date().toISOString()
        });
      }

      evaluateDraftHealth();
      evaluatePlanning();
      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, {
        success: true,
        message:
          result.closeReason === 'kicked'
            ? `Keg on tap ${tapId} marked kicked and removed.`
            : `Tap ${tapId} unassigned / off-tap.`
      });
    } catch (err) {
      handleError(res, err, requestContext('end keg', tapId));
    }
    return;
  }

  // 8. Manage Brewfather-powered On Deck preferences.
  if (url.pathname === '/api/ondeck' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      sendJson(res, 200, {
        batches: eligibleOndeckBatches(),
        show_ondeck: isOndeckEnabled(),
        brewfather: brewfatherStatus(),
        haConnected: haClient.isConnected
      });
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
      const known = new Set(eligible.map((batch) => batch.batch_id));
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
      evaluatePlanning();
      sseHub.publishImmediate('settings_updated', getFullStateSnapshot());
      sendJson(res, 200, {
        success: true,
        batches: eligibleOndeckBatches(),
        show_ondeck: isOndeckEnabled(),
        brewfather: brewfatherStatus(),
        haConnected: haClient.isConnected
      });
    } catch (err) {
      handleError(res, err, requestContext('update on deck'));
    }
    return;
  }

  if (url.pathname === '/api/draft-health/config' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      const configs = db
        .prepare(
          'SELECT check_id, tap_id, enabled, config_json, updated_at FROM health_check_config ORDER BY check_id, tap_id'
        )
        .all()
        .map((row) => ({
          check_id: row.check_id,
          tap_id: row.tap_id,
          enabled: row.enabled === 1,
          config: parseBoundedJson(row.config_json),
          updated_at: row.updated_at
        }));
      const maintenance = db
        .prepare(
          `SELECT m.maintenance_id, m.completed_at, m.method, m.notes, m.next_due_at,
             group_concat(mt.tap_id) AS tap_ids
           FROM maintenance_records m
           JOIN maintenance_record_taps mt ON mt.maintenance_id=m.maintenance_id
           GROUP BY m.maintenance_id ORDER BY m.completed_at DESC, m.maintenance_id DESC LIMIT 50`
        )
        .all()
        .map((row) => ({ ...row, tap_ids: String(row.tap_ids).split(',').map(Number) }));
      sendJson(res, 200, { schemaVersion: 1, configs, maintenance });
    } catch (err) {
      handleError(res, err, requestContext('read draft health configuration'));
    }
    return;
  }

  if (url.pathname === '/api/draft-health/config' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = validateHealthConfig(await readJsonBody(req));
      ensureServing();
      const proposedConfig = proposedHealthConfig(body);
      db.prepare(
        `INSERT INTO health_check_config (check_id, tap_id, enabled, config_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(check_id, tap_id) DO UPDATE SET enabled=excluded.enabled,
           config_json=excluded.config_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(body.check_id, body.tap_id, body.enabled ? 1 : 0, JSON.stringify(proposedConfig));
      if (body.check_id === 'low_keg' && body.tap_id > 0 && proposedConfig.warning_percent !== undefined) {
        db.prepare('UPDATE taps SET badge_low_keg=? WHERE tap_id=?').run(
          body.enabled ? proposedConfig.warning_percent : 0,
          body.tap_id
        );
      }
      healthEngines.delete(body.tap_id || 1);
      if (body.tap_id === 0) healthEngines.clear();
      evaluateDraftHealth();
      sendJson(res, 200, { success: true, draftHealth: draftHealthProjection });
    } catch (err) {
      handleError(res, err, requestContext('update draft health configuration'));
    }
    return;
  }

  if (url.pathname === '/api/draft-health/acknowledge' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = validateHealthAcknowledgement(await readJsonBody(req));
      ensureServing();
      const current = db
        .prepare('SELECT incident_id, state FROM health_check_state WHERE check_id=? AND tap_id=?')
        .get(body.check_id, body.tap_id);
      if (
        !current ||
        current.incident_id !== body.incident_id ||
        ['healthy', 'not_configured'].includes(current.state)
      ) {
        throw new HttpError(409, 'Health incident is no longer current');
      }
      const acknowledgedAt = new Date().toISOString();
      db.prepare('UPDATE health_check_state SET acknowledged_at=? WHERE check_id=? AND tap_id=?').run(
        acknowledgedAt,
        body.check_id,
        body.tap_id
      );
      const check = draftHealthProjection.checks.find(
        (item) => item.id === body.check_id && item.tapId === body.tap_id && item.incidentId === body.incident_id
      );
      if (check) {
        check.acknowledged = true;
        sseHub.publishImmediate('health_updated', draftHealthProjection);
      }
      sendJson(res, 200, { success: true, acknowledged_at: acknowledgedAt });
    } catch (err) {
      handleError(res, err, requestContext('acknowledge draft health incident'));
    }
    return;
  }

  if (url.pathname === '/api/maintenance' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = validateMaintenance(await readJsonBody(req));
      ensureServing();
      const maintenanceId = db.transaction(() => {
        const result = db
          .prepare(
            `INSERT INTO maintenance_records (completed_at, method, notes, next_due_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(body.completed_at, body.method, body.notes, body.next_due_at);
        const insertTap = db.prepare('INSERT INTO maintenance_record_taps (maintenance_id, tap_id) VALUES (?, ?)');
        for (const tap of body.tap_ids) insertTap.run(result.lastInsertRowid, tap);
        return Number(result.lastInsertRowid);
      })();
      evaluateDraftHealth();
      sendJson(res, 201, { success: true, maintenance_id: maintenanceId });
    } catch (err) {
      handleError(res, err, requestContext('record line maintenance'));
    }
    return;
  }

  if (url.pathname === '/api/planning/config' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      const overrides = db
        .prepare(
          `SELECT o.batch_id, o.earliest_date, o.latest_date, o.confirmed, o.updated_at,
             b.recipe_name, b.status
           FROM batch_readiness_overrides o JOIN batches b ON b.batch_id=o.batch_id
           ORDER BY b.recipe_name, o.batch_id`
        )
        .all()
        .map((row) => ({ ...row, confirmed: row.confirmed === 1 }));
      const requirements = db
        .prepare('SELECT batch_id, capability FROM batch_capability_requirements ORDER BY batch_id, capability')
        .all();
      const tapCapabilities = db
        .prepare('SELECT tap_id, capability FROM tap_capabilities ORDER BY tap_id, capability')
        .all();
      sendJson(res, 200, { schemaVersion: 1, policy: readinessPolicy(), overrides, requirements, tapCapabilities });
    } catch (err) {
      handleError(res, err, requestContext('read tap planning configuration'));
    }
    return;
  }

  if (url.pathname === '/api/planning/policy' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const body = validateReadinessPolicy(await readJsonBody(req));
      ensureServing();
      const current = readinessPolicy();
      const merged = { ...current, ...body };
      for (const [minimum, maximum] of [
        ['fallback_fermentation_min_days', 'fallback_fermentation_max_days'],
        ['packaging_min_days', 'packaging_max_days'],
        ['conditioning_min_days', 'conditioning_max_days']
      ]) {
        if (merged[minimum] > merged[maximum]) throw new ValidationError('Invalid readiness range');
      }
      const entries = Object.entries(body);
      db.prepare(
        `UPDATE readiness_policy SET ${entries.map(([key]) => `${key}=?`).join(', ')},
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=1`
      ).run(...entries.map(([, value]) => value));
      evaluatePlanning();
      sendJson(res, 200, { success: true, policy: readinessPolicy(), tapPlanning: tapPlanningProjection });
    } catch (err) {
      handleError(res, err, requestContext('update tap planning policy'));
    }
    return;
  }

  const readinessMatch = url.pathname.match(/^\/api\/batches\/([A-Za-z0-9_-]{1,256})\/readiness$/);
  if (readinessMatch && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const batchId = readinessMatch[1];
      const body = validateReadinessOverride(await readJsonBody(req));
      ensureServing();
      if (!db.prepare('SELECT 1 FROM batches WHERE batch_id=? AND present=1').get(batchId))
        throw new HttpError(404, 'Brewfather batch is not available');
      db.transaction(() => {
        db.prepare(
          `INSERT INTO batch_readiness_overrides (batch_id, earliest_date, latest_date, confirmed)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(batch_id) DO UPDATE SET earliest_date=excluded.earliest_date,
             latest_date=excluded.latest_date, confirmed=excluded.confirmed,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        ).run(batchId, body.earliest_date, body.latest_date, body.confirmed ? 1 : 0);
        db.prepare('DELETE FROM batch_capability_requirements WHERE batch_id=?').run(batchId);
        const insert = db.prepare('INSERT INTO batch_capability_requirements (batch_id, capability) VALUES (?, ?)');
        for (const capability of body.required_capabilities) insert.run(batchId, capability);
      })();
      evaluatePlanning();
      sendJson(res, 200, { success: true, tapPlanning: tapPlanningProjection });
    } catch (err) {
      handleError(res, err, requestContext('update batch readiness'));
    }
    return;
  }

  if (url.pathname === '/api/brewfather/refresh' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      await readEmptyJsonBody(req);
      ensureServing();
      const refresh = brewfatherSync.refresh({ reason: 'manual' });
      const result = await refresh.promise;
      ensureServing();
      const payload = {
        success: result.outcome === 'succeeded',
        requestStatus: refresh.requestStatus,
        outcome: result.outcome,
        errorCategory: result.errorCategory,
        summaries: result.summaries,
        requestCount: result.requestCount,
        brewfather: brewfatherStatus()
      };
      sendJson(res, result.outcome === 'failed' ? 503 : 200, payload);
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

evaluateDraftHealth({ publish: false });
evaluatePlanning({ publish: false });
healthEvaluationTimer = setInterval(() => {
  evaluateDraftHealth();
  evaluatePlanning();
}, 60_000);
healthEvaluationTimer.unref?.();

server.listen(PORT, () => {
  console.log(`[Tapboard Server] Running on http://localhost:${PORT}`);
});
brewfatherSync.start();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Tapboard Server] ${signal} received; shutting down cleanly.`);
  brewfatherSync.stop();
  if (phase4DebounceTimer !== null) clearTimeout(phase4DebounceTimer);
  if (healthEvaluationTimer !== null) clearInterval(healthEvaluationTimer);
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
