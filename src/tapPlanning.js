/** Pure, deliberately conservative replacement planning.  It never infers inventory. */
const DAY = 86_400_000;
const TAGS = new Set(['standard', 'nitro', 'high_carbonation', 'custom_non_beer']);

export const DEFAULT_TAP_PLANNING_POLICY = Object.freeze({
  fermentationDays: Object.freeze([10, 21]),
  packagingDays: Object.freeze([1, 3]),
  conditioningDays: Object.freeze([7, 14]),
  planningLatestUncertaintyDays: 7
});
export const DEFAULT_PLANNING_POLICY = DEFAULT_TAP_PLANNING_POLICY;

const ownObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const day = (value) => Math.floor(value / DAY);
const date = (value) => new Date(value * DAY).toISOString().slice(0, 10);
const add = (value, days) => date(day(Date.parse(`${value}T00:00:00.000Z`)) + days);

export function parsePlanningDate(value, { now = Date.now(), allowFuture = true } = {}) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || date(day(ms)) !== value || (!allowFuture && day(ms) > day(Number(now)))) return null;
  return value;
}

function sourceValue(candidate, names) {
  const source = ownObject(candidate);
  const summary = ownObject(source.summary ?? source.batchSummary ?? source.batch);
  const detail = ownObject(source.detail ?? source.batchDetail);
  for (const name of names) {
    const value = source[name] ?? detail[name] ?? summary[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}
function sourceDate(candidate, names, options) {
  const raw = sourceValue(candidate, names);
  if (typeof raw !== 'string') return null;
  const direct = parsePlanningDate(raw.slice(0, 10), options);
  return direct;
}
function pair(value, fallback) {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const values = value.map(Number);
  return values.every((item) => Number.isFinite(item) && item >= 0) && values[0] <= values[1] ? values : fallback;
}
function profileFermentation(candidate, policy) {
  const profile = ownObject(sourceValue(candidate, ['fermentation_profile', 'fermentationProfile', 'profile']));
  const direct =
    profile.days ?? profile.duration_days ?? sourceValue(candidate, ['fermentation_days', 'fermentationDays']);
  return pair(direct, policy.fermentationDays);
}
function manualRange(candidate, options) {
  const override = ownObject(candidate?.override ?? candidate?.readinessOverride);
  const earliest = parsePlanningDate(override.earliest ?? override.earliest_date ?? candidate?.earliest, options);
  const latest = parsePlanningDate(override.latest ?? override.latest_date ?? candidate?.latest, options);
  return earliest && latest && earliest <= latest
    ? { earliest, latest, source: 'manual', confirmed: override.confirmed === true || override.confirmed === 1 }
    : null;
}
function confidence(candidate, base, freshness) {
  const stale = candidate?.syncFreshness?.stale ?? candidate?.freshness?.stale ?? freshness?.stale;
  const missingDetail = !candidate?.detail && !candidate?.batchDetail;
  return stale || missingDetail ? 'low' : base;
}

/** Estimate only a potential readiness interval; gravity readings cannot move it. */
export function estimateCandidateReadiness(
  candidate = {},
  { policy = DEFAULT_TAP_PLANNING_POLICY, now = Date.now(), syncFreshness } = {}
) {
  const effectivePolicy = { ...DEFAULT_TAP_PLANNING_POLICY, ...ownObject(candidate.policy), ...ownObject(policy) };
  const options = { now };
  const manual = manualRange(candidate, options);
  const status = String(sourceValue(candidate, ['status']) ?? 'Unknown');
  if (manual)
    return {
      status: 'potential',
      confidence: confidence(candidate, manual.confirmed ? 'high' : 'medium', syncFreshness),
      ...manual,
      inferredStatus: status,
      gravityUsed: false
    };
  let range = null;
  if (status === 'Planning' || status === 'Brewing') {
    const anchor = sourceDate(candidate, ['brew_date', 'brewDate', 'start_date', 'startDate'], options);
    if (anchor) {
      const fermentation = profileFermentation(candidate, effectivePolicy);
      const packaging = pair(effectivePolicy.packagingDays, DEFAULT_TAP_PLANNING_POLICY.packagingDays);
      const conditioning = pair(effectivePolicy.conditioningDays, DEFAULT_TAP_PLANNING_POLICY.conditioningDays);
      range = {
        earliest: add(anchor, fermentation[0] + packaging[0] + conditioning[0]),
        latest: add(
          anchor,
          fermentation[1] + packaging[1] + conditioning[1] + Number(effectivePolicy.planningLatestUncertaintyDays || 0)
        ),
        source: 'inferred'
      };
    }
  } else if (status === 'Fermenting') {
    const anchor = sourceDate(
      candidate,
      ['fermentation_start_date', 'fermentationStartDate', 'start_date', 'startDate'],
      options
    );
    if (anchor) {
      const fermentation = profileFermentation(candidate, effectivePolicy);
      const packaging = pair(effectivePolicy.packagingDays, DEFAULT_TAP_PLANNING_POLICY.packagingDays);
      const conditioning = pair(effectivePolicy.conditioningDays, DEFAULT_TAP_PLANNING_POLICY.conditioningDays);
      range = {
        earliest: add(anchor, fermentation[0] + packaging[0] + conditioning[0]),
        latest: add(anchor, fermentation[1] + packaging[1] + conditioning[1]),
        source: 'inferred'
      };
    }
  } else if (status === 'Conditioning') {
    const anchor = sourceDate(
      candidate,
      ['conditioning_date', 'conditioningDate', 'packaging_date', 'packagingDate', 'bottlingDate'],
      options
    );
    if (anchor) {
      const conditioning = pair(effectivePolicy.conditioningDays, DEFAULT_TAP_PLANNING_POLICY.conditioningDays);
      range = { earliest: add(anchor, conditioning[0]), latest: add(anchor, conditioning[1]), source: 'inferred' };
    }
  } else if (status === 'Completed') {
    const anchor = sourceDate(
      candidate,
      ['completed_date', 'completedDate', 'packaging_date', 'packagingDate'],
      options
    );
    if (anchor) range = { earliest: anchor, latest: anchor, source: 'inferred' };
  }
  if (!range)
    return {
      status: 'unknown',
      confidence: 'low',
      earliest: null,
      latest: null,
      source: null,
      inferredStatus: status,
      gravityUsed: false
    };
  return {
    status: 'potential',
    confidence: confidence(candidate, status === 'Completed' ? 'low' : 'medium', syncFreshness),
    ...range,
    inferredStatus: status,
    gravityUsed: false
  };
}

function tags(value) {
  if (!Array.isArray(value)) return null;
  const output = value.filter((tag) => typeof tag === 'string' && TAGS.has(tag));
  return output.length ? new Set(output) : null;
}
/** Required candidate tags must be a subset of available tap tags. */
export function evaluateCapabilityCompatibility(candidate = {}, tap = {}) {
  const required = tags(candidate.capabilityTags ?? candidate.capabilities ?? candidate.requiredCapabilities);
  const available = tags(tap.capabilityTags ?? tap.capabilities ?? tap.supportedCapabilities);
  if (!required || !available) return { status: 'potential', compatible: null, reason: 'missing_capability_metadata' };
  const compatible = [...required].every((tag) => available.has(tag));
  return {
    status: compatible ? 'compatible' : 'incompatible',
    compatible,
    reason: compatible ? 'required_tags_supported' : 'required_tags_missing',
    required: [...required],
    available: [...available]
  };
}

export function compareReadinessRanges(readiness, forecast) {
  const readyEarliest = parsePlanningDate(readiness?.earliest, { allowFuture: true });
  const readyLatest = parsePlanningDate(readiness?.latest, { allowFuture: true });
  const kickEarliest = parsePlanningDate(
    forecast?.earliestDate ?? forecast?.earliest ?? forecast?.depletion?.earliestDate,
    { allowFuture: true }
  );
  const kickLatest = parsePlanningDate(forecast?.latestDate ?? forecast?.latest ?? forecast?.depletion?.latestDate, {
    allowFuture: true
  });
  if (!readyEarliest || !readyLatest || !kickEarliest || !kickLatest)
    return { classification: 'unknown', earliestGapDays: null, latestGapDays: null };
  const earliestGapDays = day(Date.parse(`${readyEarliest}T00:00:00Z`)) - day(Date.parse(`${kickLatest}T00:00:00Z`));
  const latestGapDays = day(Date.parse(`${readyLatest}T00:00:00Z`)) - day(Date.parse(`${kickEarliest}T00:00:00Z`));
  const classification = latestGapDays <= 0 ? 'covered' : earliestGapDays > 0 ? 'forecast_gap' : 'possible_gap';
  return { classification, earliestGapDays, latestGapDays, readyEarliest, readyLatest, kickEarliest, kickLatest };
}
export const compareRanges = compareReadinessRanges;

export function rankCandidates(candidates = [], options = {}) {
  return [...candidates]
    .map((candidate) => {
      const readiness = candidate.readiness ?? estimateCandidateReadiness(candidate, options);
      const compatibility = candidate.compatibility ?? evaluateCapabilityCompatibility(candidate, options.tap ?? {});
      const rank =
        (compatibility.status === 'compatible' ? 0 : compatibility.status === 'potential' ? 1 : 2) * 10 +
        (readiness.status === 'potential' ? 0 : 5) +
        (readiness.confidence === 'low' ? 1 : 0);
      return { ...candidate, readiness, compatibility, rank };
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        String(left.readiness.earliest ?? '').localeCompare(String(right.readiness.earliest ?? ''))
    );
}

/** Build display-safe projections.  A covered interval is timing only, never a claim that a keg is spare. */
export function buildTapPlanningProjection({
  taps = [],
  candidates = [],
  policy,
  now = Date.now(),
  syncFreshness
} = {}) {
  return taps.map((tap) => {
    const forecast = tap.kickForecast ?? tap.forecast;
    const planned = rankCandidates(candidates, { policy, now, syncFreshness, tap }).map((candidate) => {
      const gap = compareReadinessRanges(candidate.readiness, forecast);
      const sameBatch = Boolean(
        tap.batchId && (candidate.batchId ?? candidate.batch_id ?? candidate.id) === tap.batchId
      );
      return {
        ...candidate,
        gap: {
          ...gap,
          sameBatch,
          caveat: sameBatch ? 'This is the active batch; timing does not indicate a spare keg.' : null
        }
      };
    });
    return {
      tapId: tap.tapId ?? tap.id,
      candidates: planned,
      forecastAvailable: Boolean(forecast?.depletion ?? forecast?.earliestDate ?? forecast?.earliest)
    };
  });
}
export const buildTapPlanningProjections = buildTapPlanningProjection;
