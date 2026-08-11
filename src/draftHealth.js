// Phase 4 draft-health evaluation.  This module is deliberately side-effect free:
// callers own persistence, HA reads, and notification delivery.

export const DRAFT_HEALTH_CHECKS = Object.freeze([
  'low_keg',
  'scale_availability',
  'suspected_leak',
  'serving_temperature',
  'serving_pressure',
  'line_cleaning_due',
  'tap_gap_predicted'
]);

export const DEFAULT_DRAFT_HEALTH_CONFIG = Object.freeze({
  low_keg: { enabled: true, thresholdOz: 0, thresholdPercent: 20, criticalPercent: 5, settlingMs: 30_000 },
  scale_availability: { enabled: true, staleAfterMs: 30 * 60_000, unavailableAfterMs: 5 * 60_000 },
  suspected_leak: {
    enabled: false,
    lossOz: 8,
    windowMs: 15 * 60_000,
    pourGraceMs: 2 * 60_000,
    settlingMs: 10 * 60_000,
    resetMovementOz: 32,
    maxSamples: 64
  },
  serving_temperature: {
    enabled: false,
    minimumF: 34,
    maximumF: 42,
    criticalMinimumF: 30,
    criticalMaximumF: 50,
    durationMs: 15 * 60_000
  },
  serving_pressure: {
    enabled: false,
    minimumPsi: 10,
    maximumPsi: 14,
    criticalMinimumPsi: 5,
    criticalMaximumPsi: 20,
    durationMs: 15 * 60_000
  },
  line_cleaning_due: { enabled: false, intervalDays: 14, intervalKegs: 3, criticalAfterDays: 7, criticalAfterKegs: 1 },
  tap_gap_predicted: { enabled: true }
});

const STATES = new Set(['not_configured', 'healthy', 'degraded', 'active']);
const SEVERITIES = new Set(['none', 'info', 'warning', 'critical']);
const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const timestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export function mergeDraftHealthConfig(overrides = {}) {
  const result = {};
  for (const id of DRAFT_HEALTH_CHECKS)
    result[id] = Object.freeze({ ...DEFAULT_DRAFT_HEALTH_CONFIG[id], ...object(overrides[id]) });
  return Object.freeze(result);
}

export function validateDraftHealthConfig(config = {}) {
  const merged = mergeDraftHealthConfig(config);
  for (const [id, values] of Object.entries(merged)) {
    if (typeof values.enabled !== 'boolean') throw new TypeError(`${id}.enabled must be boolean`);
    for (const [key, value] of Object.entries(values))
      if (key !== 'enabled' && typeof value === 'number' && (!Number.isFinite(value) || value < 0))
        throw new TypeError(`${id}.${key} must be a non-negative finite number`);
  }
  if (merged.serving_temperature.minimumF >= merged.serving_temperature.maximumF)
    throw new RangeError('serving_temperature bounds are invalid');
  return merged;
}

export function temperatureF(value, unit = 'F') {
  const number = finite(value);
  if (number === null) return null;
  const normalized = String(unit || 'F')
    .trim()
    .toUpperCase()
    .replace('°', '');
  if (normalized === 'F' || normalized === 'FAHRENHEIT') return number;
  if (normalized === 'C' || normalized === 'CELSIUS') return number * (9 / 5) + 32;
  return null;
}

function result(id, state, severity, evidence = {}, incidentKey = null) {
  const boundedEvidence = Object.fromEntries(Object.entries(evidence).slice(0, 12));
  return { id, state, severity, evidence: boundedEvidence, incidentKey };
}
function entityValue(entity) {
  const source = object(entity);
  if (source.state === 'unknown' || source.state === 'unavailable') return null;
  return finite(source.state ?? source.value ?? entity);
}
function measurement(input) {
  const source = object(input.measurement || input);
  const volumeOz = finite(source.volumeOz ?? source.volume_oz ?? source.measuredVolumeOz);
  const capacityOz = finite(source.capacityOz ?? source.capacity_oz);
  const freshnessAt = timestamp(source.freshAt ?? source.freshnessAt ?? source.updatedAt ?? source.lastUpdated);
  const status = source.volumeStatus ?? source.status ?? (volumeOz === null ? 'unavailable' : 'measured');
  return { volumeOz, capacityOz, freshnessAt, status };
}
function lifecycleId(input) {
  const lifecycle = input.lifecycle ?? input.lifecycleIdentity ?? input.lifecycleId;
  if (lifecycle && typeof lifecycle === 'object')
    return lifecycle.lifecycle_id ?? lifecycle.lifecycleId ?? lifecycle.id ?? null;
  return lifecycle ?? null;
}
function incidentKey(id, input) {
  return `${id}:${input.tapId ?? input.tap_id ?? 'unknown'}:${lifecycleId(input) ?? 'none'}`;
}

export class DraftHealthEngine {
  constructor({ config = {}, now = () => Date.now(), records = {} } = {}) {
    this.config = validateDraftHealthConfig(config);
    this.now = now;
    this.records = new Map(Object.entries(records));
  }

  evaluate(input = {}) {
    const now = finite(input.now) ?? this.now();
    const tapId = input.tapId ?? input.tap_id ?? 'unknown';
    const key = String(tapId);
    const previous = object(this.records.get(key));
    const next = { ...previous, samples: Array.isArray(previous.samples) ? previous.samples : [] };
    const output = DRAFT_HEALTH_CHECKS.map((id) => this.#check(id, input, next, now));
    const changes = [];
    for (const item of output) {
      const old = previous.results?.[item.id];
      if (!old || old.state !== item.state || old.severity !== item.severity || old.incidentKey !== item.incidentKey)
        changes.push({ id: item.id, from: old?.state ?? null, to: item.state, incidentKey: item.incidentKey });
    }
    next.results = Object.fromEntries(output.map((item) => [item.id, item]));
    next.updatedAt = now;
    this.records.set(key, next);
    return Object.freeze({
      tapId,
      evaluatedAt: now,
      checks: output,
      transitions: changes,
      record: this.snapshot(tapId)
    });
  }

  acknowledge(tapId, id, { until = null, now = this.now() } = {}) {
    if (!DRAFT_HEALTH_CHECKS.includes(id)) throw new RangeError('Unknown draft health check');
    const record = object(this.records.get(String(tapId)));
    const acknowledgements = { ...object(record.acknowledgements) };
    acknowledgements[id] = { at: now, until: timestamp(until) };
    this.records.set(String(tapId), { ...record, acknowledgements });
    return this.snapshot(tapId);
  }

  cooldown(tapId, id, until) {
    if (!DRAFT_HEALTH_CHECKS.includes(id)) throw new RangeError('Unknown draft health check');
    const untilMs = timestamp(until);
    if (untilMs === null) throw new TypeError('Cooldown timestamp is invalid');
    const record = object(this.records.get(String(tapId)));
    this.records.set(String(tapId), { ...record, cooldowns: { ...object(record.cooldowns), [id]: untilMs } });
    return this.snapshot(tapId);
  }

  snapshot(tapId) {
    const value = this.records.get(String(tapId));
    return value ? structuredClone(value) : null;
  }

  #check(id, input, record, now) {
    const config = this.config[id];
    if (!config.enabled) return result(id, 'not_configured', 'none');
    const connected = input.connected ?? input.haConnected ?? input.ha?.connected ?? true;
    const measured = measurement(input);
    const life = lifecycleId(input);
    let check;
    if (id === 'low_keg') {
      if (!life || measured.volumeOz === null || measured.capacityOz === null || measured.status !== 'measured')
        check = result(id, 'not_configured', 'none');
      else if (
        measured.freshnessAt === null ||
        now - measured.freshnessAt > this.config.scale_availability.staleAfterMs
      )
        check = result(id, 'degraded', 'info', { reason: 'stale_measurement' });
      else {
        const threshold = Math.max(config.thresholdOz, (measured.capacityOz * config.thresholdPercent) / 100);
        const currentPercent = (measured.volumeOz / measured.capacityOz) * 100;
        check =
          measured.volumeOz <= threshold
            ? result(
                id,
                'active',
                currentPercent <= config.criticalPercent ? 'critical' : 'warning',
                { volumeOz: measured.volumeOz, currentPercent, thresholdOz: threshold },
                incidentKey(id, input)
              )
            : result(id, 'healthy', 'none', { volumeOz: measured.volumeOz, currentPercent });
      }
    } else if (id === 'scale_availability') {
      if (!life) check = result(id, 'not_configured', 'none');
      else if (!connected) check = result(id, 'degraded', 'warning', { reason: 'ha_disconnected' });
      else if (measured.status === 'assumed_full') check = result(id, 'not_configured', 'none');
      else if (measured.status === 'unavailable' || measured.volumeOz === null) {
        record.scaleUnavailableSince ??= now;
        const unavailableMs = Math.max(0, now - record.scaleUnavailableSince);
        check =
          unavailableMs >= config.unavailableAfterMs
            ? result(
                id,
                'active',
                'critical',
                { reason: 'scale_unavailable', unavailableMinutes: unavailableMs / 60_000 },
                incidentKey(id, input)
              )
            : result(id, 'degraded', 'info', { reason: 'scale_unavailable_settling' });
      } else if (measured.freshnessAt === null || now - measured.freshnessAt > config.staleAfterMs)
        check = result(id, 'degraded', 'info', { reason: 'scale_stale' });
      else {
        record.scaleUnavailableSince = null;
        check = result(id, 'healthy', 'none');
      }
    } else if (id === 'serving_temperature') {
      const entity = input.temperature ?? input.temperatureEntity;
      if (!entity) {
        record.temperatureOutsideSince = null;
        check = result(id, 'not_configured', 'none');
      } else if (!connected || entity?.state === 'unavailable' || entity?.state === 'unknown') {
        record.temperatureOutsideSince = null;
        check = result(id, 'degraded', 'warning', {
          reason: !connected ? 'ha_disconnected' : 'temperature_unavailable'
        });
      } else {
        const value = temperatureF(
          entityValue(entity),
          entity?.unit ??
            entity?.unit_of_measurement ??
            entity?.attributes?.unit_of_measurement ??
            input.temperatureUnit
        );
        if (value === null) {
          record.temperatureOutsideSince = null;
          check = result(id, 'degraded', 'info', { reason: 'temperature_invalid' });
        } else if (value < config.minimumF || value > config.maximumF) {
          record.temperatureOutsideSince ??= now;
          const durationMs = now - record.temperatureOutsideSince;
          const severity = value < config.criticalMinimumF || value > config.criticalMaximumF ? 'critical' : 'warning';
          check =
            durationMs >= config.durationMs
              ? result(
                  id,
                  'active',
                  severity,
                  {
                    temperatureF: value,
                    minimumF: config.minimumF,
                    maximumF: config.maximumF,
                    durationMinutes: durationMs / 60_000
                  },
                  incidentKey(id, input)
                )
              : result(id, 'degraded', 'info', { reason: 'temperature_excursion_settling', temperatureF: value });
        } else {
          record.temperatureOutsideSince = null;
          check = result(id, 'healthy', 'none', { temperatureF: value });
        }
      }
    } else if (id === 'serving_pressure') {
      const entity = input.pressure ?? input.pressureEntity;
      if (!entity) check = result(id, 'not_configured', 'none');
      else if (!connected || entity?.state === 'unavailable' || entity?.state === 'unknown') {
        check = result(id, 'degraded', 'warning', { reason: !connected ? 'ha_disconnected' : 'pressure_unavailable' });
      } else {
        const value = finite(entityValue(entity));
        if (value === null) check = result(id, 'degraded', 'info', { reason: 'pressure_invalid' });
        else if (value < config.minimumPsi || value > config.maximumPsi) {
          record.pressureOutsideSince ??= now;
          const durationMs = now - record.pressureOutsideSince;
          const severity =
            value < config.criticalMinimumPsi || value > config.criticalMaximumPsi ? 'critical' : 'warning';
          check =
            durationMs >= config.durationMs
              ? result(
                  id,
                  'active',
                  severity,
                  {
                    pressurePsi: value,
                    minimumPsi: config.minimumPsi,
                    maximumPsi: config.maximumPsi,
                    durationMinutes: durationMs / 60_000
                  },
                  incidentKey(id, input)
                )
              : result(id, 'degraded', 'info', { reason: 'pressure_excursion_settling', pressurePsi: value });
        } else {
          record.pressureOutsideSince = null;
          check = result(id, 'healthy', 'none', { pressurePsi: value });
        }
      }
    } else if (id === 'line_cleaning_due') {
      const baseline = timestamp(
        input.lineCleanedAt ?? input.maintenance?.lineCleanedAt ?? input.maintenance?.baselineAt
      );
      const kegsServed = finite(input.kegsServed ?? input.maintenance?.kegsServed) ?? 0;
      if (!life || baseline === null) check = result(id, 'not_configured', 'none');
      else {
        const ageDays = Math.max(0, (now - baseline) / 86_400_000);
        const daysOver = ageDays >= config.intervalDays;
        const kegsOver = config.intervalKegs > 0 && kegsServed >= config.intervalKegs;
        const isCritical =
          ageDays >= config.intervalDays + config.criticalAfterDays ||
          (config.intervalKegs > 0 && kegsServed >= config.intervalKegs + (config.criticalAfterKegs || 1));
        if (daysOver || kegsOver)
          check = result(
            id,
            'active',
            isCritical ? 'critical' : 'warning',
            { ageDays: Math.floor(ageDays), dueDays: config.intervalDays, kegsServed, dueKegs: config.intervalKegs },
            incidentKey(id, input)
          );
        else check = result(id, 'healthy', 'none', { ageDays: Math.floor(ageDays), kegsServed });
      }
    } else check = this.#leak(input, record, now, measured, life);
    return this.#effectiveAcknowledgement(check, record, now);
  }

  #leak(input, record, now, measured, life) {
    const config = this.config.suspected_leak;
    const reset =
      !life ||
      input.connected === false ||
      measured.status !== 'measured' ||
      measured.volumeOz === null ||
      measured.freshnessAt === null ||
      now - measured.freshnessAt > this.config.scale_availability.staleAfterMs;
    if (reset || record.lifecycleId !== life) {
      record.samples = reset ? [] : [{ at: now, volumeOz: measured.volumeOz }];
      record.lifecycleId = life;
      return result('suspected_leak', !life ? 'not_configured' : 'degraded', !life ? 'none' : 'info', {
        reason: reset ? 'measurement_unavailable' : 'lifecycle_changed'
      });
    }
    const samples = record.samples.filter((sample) => sample.at >= now - config.windowMs);
    const previous = samples.at(-1);
    if (
      previous &&
      (measured.volumeOz > previous.volumeOz ||
        Math.abs(measured.volumeOz - previous.volumeOz) >= config.resetMovementOz)
    ) {
      record.samples = [];
      return result('suspected_leak', 'healthy', 'none', { reason: 'movement_or_refill' });
    }
    samples.push({ at: now, volumeOz: measured.volumeOz });
    record.samples = samples.slice(-config.maxSamples);
    const pourAt = timestamp(input.lastPourAt ?? input.recentPourAt);
    const suppressed =
      input.pourActive || (pourAt !== null && now - pourAt <= config.pourGraceMs) || (record.settlingUntil ?? 0) > now;
    if (input.pourActive || (pourAt !== null && now - pourAt <= config.pourGraceMs))
      record.settlingUntil = now + config.settlingMs;
    if (suppressed) {
      record.samples = [{ at: now, volumeOz: measured.volumeOz }];
      return result('suspected_leak', 'healthy', 'none', { reason: 'pour_or_settling' });
    }
    const oldest = record.samples[0];
    const loss = oldest ? oldest.volumeOz - measured.volumeOz : 0;
    return loss >= config.lossOz
      ? result(
          'suspected_leak',
          'active',
          'warning',
          { label: 'suspected', lossOz: loss, windowMinutes: config.windowMs / 60_000 },
          incidentKey('suspected_leak', input)
        )
      : result('suspected_leak', 'healthy', 'none');
  }

  #effectiveAcknowledgement(check, record, now) {
    const ack = object(record.acknowledgements)?.[check.id];
    const cooldownUntil = timestamp(object(record.cooldowns)?.[check.id]);
    const acknowledged = ack && (ack.until === null || ack.until > now);
    const coolingDown = cooldownUntil !== null && cooldownUntil > now;
    if (check.state !== 'active' || (!acknowledged && !coolingDown)) return check;
    return { ...check, acknowledged: Boolean(acknowledged), coolingDown, notificationSeverity: 'none' };
  }
}

export const createDraftHealthEngine = (options) => new DraftHealthEngine(options);
export const HEALTH_STATES = Object.freeze([...STATES]);
export const HEALTH_SEVERITIES = Object.freeze([...SEVERITIES]);
