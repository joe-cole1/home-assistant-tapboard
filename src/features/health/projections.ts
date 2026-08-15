import {
  HEALTH_CHECK_IDS,
  type HealthCheckId,
  type HealthConfig,
  type HealthConfigInheritance,
  type HealthConfigOverride,
  type HealthEvidence,
  type HealthEvidenceKey,
  type HealthReason,
  type HealthSeverity,
  type HealthState,
} from "./types.ts";
import type {
  HealthCheckStateRecord,
  HealthGlobalConfig,
  HealthIncidentRecord,
  HealthMaintenanceRecordWithSession,
} from "./repository.ts";
import type { Tap } from "../taps/types.ts";

/**
 * The projection boundary is deliberately narrower than the persistence
 * records.  In particular, source/measurement identifiers, actor/session
 * identifiers, arbitrary evidence JSON, and maintenance notes never cross
 * the overview or targeted-refresh boundary.
 */
export interface HealthProjectionContext {
  readonly tap: Tap;
  readonly global: HealthGlobalConfig;
  readonly override:
    | {
        readonly tapId: string;
        readonly revision: number;
        readonly override: HealthConfigOverride;
        readonly updatedAt: string;
      }
    | undefined;
  readonly effectiveConfig: HealthConfig;
  readonly inheritance: HealthConfigInheritance;
  readonly states: readonly HealthCheckStateRecord[];
  readonly incidents: readonly HealthIncidentRecord[];
  readonly maintenance: readonly HealthMaintenanceRecordWithSession[];
}

export interface HealthSafeEvidence {
  readonly [key: string]: string | number | boolean | null;
}

export interface HealthCheckSummary {
  readonly checkId: HealthCheckId;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason | null;
  readonly evaluatedAtMs: number | null;
  readonly conditionStartedAtMs: number | null;
  readonly lastObservationAtMs: number | null;
  readonly suppressionUntilMs: number | null;
  readonly cooldownUntilMs: number | null;
  readonly evidence?: HealthSafeEvidence;
}

export interface HealthAggregateSummary {
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly activeCount: number;
  readonly lastEvaluatedAtMs: number | null;
}

export interface HealthLineCleaningSummary {
  readonly enabled: boolean;
  readonly state: HealthState;
  readonly severity: HealthSeverity;
  readonly reason: HealthReason | null;
  readonly cleanedAtMs: number | null;
  readonly dueAtMs: number | null;
  readonly criticalAtMs: number | null;
  readonly evaluatedAtMs: number | null;
}

export interface HealthTapIdentity {
  readonly tapId: string;
  readonly tapNumber: number;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly retired: boolean;
}

export interface AdminHealthOverviewProjection extends HealthTapIdentity {
  readonly identity: HealthTapIdentity;
  readonly checks: readonly HealthCheckSummary[];
  readonly aggregate: HealthAggregateSummary;
  readonly activeIncidentCount: number;
  readonly lineCleaning: HealthLineCleaningSummary;
}

export interface HealthIncidentSummary {
  readonly id: string;
  readonly checkId: HealthCheckId;
  readonly state: "open" | "resolved";
  readonly currentSeverity: "warning" | "critical";
  readonly maxSeverity: "warning" | "critical";
  readonly openedAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly acknowledgedAtMs: number | null;
  readonly openReason: HealthReason;
  readonly resolutionReason: HealthReason | null;
  readonly openEvidence?: HealthSafeEvidence;
}

export interface AdminHealthDetailProjection extends AdminHealthOverviewProjection {
  readonly globalConfig: HealthConfig;
  readonly globalRevision: number;
  readonly globalUpdatedAt: string;
  readonly effectiveConfig: HealthConfig;
  readonly inheritance: HealthConfigInheritance;
  readonly override: HealthConfigOverride | null;
  readonly overrideRevision: number | null;
  readonly current: readonly HealthCheckSummary[];
  readonly openIncidents: readonly HealthIncidentSummary[];
  readonly incidentHistory: readonly HealthIncidentSummary[];
  readonly maintenance: readonly HealthMaintenanceSummary[];
}

export interface HealthMaintenanceSummary {
  readonly id: string;
  readonly maintenanceType: HealthMaintenanceRecordWithSession["maintenanceType"];
  readonly performedAtMs: number;
  readonly cleanedAtMs: number | null;
  readonly dueAtMs: number | null;
  readonly recordedAtMs: number;
}

export interface HealthMaintenanceDetailProjection extends HealthMaintenanceSummary {
  /** Notes are exposed only by an explicitly authenticated detail operation. */
  readonly notes: string | null;
}

export interface AdminHealthIncidentPageProjection {
  readonly incidents: readonly HealthIncidentSummary[];
  readonly nextCursor: { readonly openedAt: string; readonly id: string } | null;
}

export interface AdminHealthMaintenancePageProjection {
  readonly records: readonly HealthMaintenanceSummary[];
  readonly nextCursor: { readonly performedAt: string; readonly id: string } | null;
}

/** #76 seam: bounded summaries only, with no raw evidence, source IDs, or notes. */
export interface HealthTargetedUpdate {
  readonly tapId: string;
  readonly changedCheckIds: readonly HealthCheckId[];
  readonly checks: readonly HealthCheckSummary[];
  readonly aggregate: HealthAggregateSummary;
  readonly activeIncidentCount: number;
  readonly lineCleaning: HealthLineCleaningSummary;
  readonly evaluatedAtMs: number | null;
}

export type HealthTargetedUpdateProjection = HealthTargetedUpdate;

const EVIDENCE_KEYS: readonly HealthEvidenceKey[] = [
  "reason",
  "phase",
  "diagnosticCode",
  "measurementAgeMs",
  "authorityAgeMs",
  "unavailableAgeMs",
  "currentVolumeMl",
  "capacityMl",
  "currentPercent",
  "thresholdMl",
  "thresholdPercent",
  "criticalPercent",
  "temperatureC",
  "normalMinC",
  "normalMaxC",
  "criticalMinC",
  "criticalMaxC",
  "outOfRangeDurationMs",
  "durationMs",
  "lossMl",
  "windowMs",
  "sampleCount",
  "maxSamples",
  "resetMovementMl",
  "dueAtMs",
  "criticalAtMs",
  "ageMs",
  "intervalDays",
  "criticalAfterDays",
];

function safeEvidence(evidence: HealthEvidence): HealthSafeEvidence {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const key of EVIDENCE_KEYS) {
    const value = evidence[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (value !== undefined) safe[key] = value;
    }
  }
  return safe;
}

function orderedStates(states: readonly HealthCheckStateRecord[]): HealthCheckSummary[] {
  return HEALTH_CHECK_IDS.map((checkId) => {
    const state = states.find((candidate) => candidate.checkId === checkId);
    if (state === undefined) {
      return {
        checkId,
        state: "not_configured",
        severity: "none",
        reason: null,
        evaluatedAtMs: null,
        conditionStartedAtMs: null,
        lastObservationAtMs: null,
        suppressionUntilMs: null,
        cooldownUntilMs: null,
      } satisfies HealthCheckSummary;
    }
    return {
      checkId,
      state: state.state,
      severity: state.severity,
      reason: state.reason,
      evaluatedAtMs: state.evaluatedAtMs,
      conditionStartedAtMs: state.conditionStartedAtMs,
      lastObservationAtMs: state.lastObservationAtMs,
      suppressionUntilMs: state.suppressionUntilMs,
      cooldownUntilMs: state.cooldownUntilMs,
      evidence: safeEvidence(state.evidence),
    } satisfies HealthCheckSummary;
  });
}

function stateRank(state: HealthState): number {
  return state === "active" ? 3 : state === "degraded" ? 2 : state === "healthy" ? 1 : 0;
}

function severityRank(severity: HealthSeverity): number {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : severity === "info" ? 1 : 0;
}

function aggregate(checks: readonly HealthCheckSummary[]): HealthAggregateSummary {
  const state = checks.reduce<HealthState>(
    (current, check) => (stateRank(check.state) > stateRank(current) ? check.state : current),
    "not_configured",
  );
  const severity = checks.reduce<HealthSeverity>(
    (current, check) =>
      severityRank(check.severity) > severityRank(current) ? check.severity : current,
    "none",
  );
  const evaluated = checks
    .map((check) => check.evaluatedAtMs)
    .filter((value): value is number => value !== null);
  return {
    state,
    severity,
    activeCount: checks.filter((check) => check.state === "active").length,
    lastEvaluatedAtMs: evaluated.length === 0 ? null : Math.max(...evaluated),
  };
}

function incidentSummary(
  incident: HealthIncidentRecord,
  includeEvidence: boolean,
): HealthIncidentSummary {
  return {
    id: incident.id,
    checkId: incident.checkId,
    state: incident.resolvedAtMs === null ? "open" : "resolved",
    currentSeverity: incident.currentSeverity,
    maxSeverity: incident.maxSeverity,
    openedAtMs: incident.openedAtMs,
    resolvedAtMs: incident.resolvedAtMs,
    acknowledgedAtMs: incident.acknowledgedAtMs,
    openReason: incident.openReason,
    resolutionReason: incident.resolutionReason,
    ...(includeEvidence ? { openEvidence: safeEvidence(incident.openEvidence) } : {}),
  };
}

function maintenanceSummary(record: HealthMaintenanceRecordWithSession): HealthMaintenanceSummary {
  return {
    id: record.id,
    maintenanceType: record.maintenanceType,
    performedAtMs: record.performedAtMs,
    cleanedAtMs: record.cleanedAtMs ?? null,
    dueAtMs: record.resultingDueAtMs ?? record.dueAtMs ?? null,
    recordedAtMs: record.recordedAtMs,
  };
}

function lineCleaningSummary(
  context: HealthProjectionContext,
  checks: readonly HealthCheckSummary[],
): HealthLineCleaningSummary {
  const check = checks.find((candidate) => candidate.checkId === "line_cleaning_due");
  const latest = context.maintenance.find((record) => record.maintenanceType === "line_cleaned");
  const dueAtMs = check?.evidence?.dueAtMs;
  const criticalAtMs = check?.evidence?.criticalAtMs;
  return {
    enabled: context.effectiveConfig.line_cleaning_due.enabled,
    state: check?.state ?? "not_configured",
    severity: check?.severity ?? "none",
    reason: check?.reason ?? null,
    cleanedAtMs: latest?.performedAtMs ?? null,
    dueAtMs: typeof dueAtMs === "number" ? dueAtMs : (latest?.resultingDueAtMs ?? null),
    criticalAtMs: typeof criticalAtMs === "number" ? criticalAtMs : null,
    evaluatedAtMs: check?.evaluatedAtMs ?? null,
  };
}

function identity(tap: Tap): HealthTapIdentity {
  return {
    tapId: tap.id,
    tapNumber: tap.tapNumber,
    name: tap.name,
    enabled: tap.enabled,
    retired: tap.retiredAt !== null,
  };
}

function baseOverview(context: HealthProjectionContext): {
  readonly identity: HealthTapIdentity;
  readonly checks: readonly HealthCheckSummary[];
  readonly aggregate: HealthAggregateSummary;
  readonly activeIncidentCount: number;
  readonly lineCleaning: HealthLineCleaningSummary;
} {
  const checks = orderedStates(context.states);
  return {
    identity: identity(context.tap),
    checks,
    aggregate: aggregate(checks),
    activeIncidentCount: context.incidents.filter((incident) => incident.resolvedAtMs === null)
      .length,
    lineCleaning: lineCleaningSummary(context, checks),
  };
}

export function toAdminHealthOverview(
  context: HealthProjectionContext,
): AdminHealthOverviewProjection {
  const overview = baseOverview(context);
  return {
    ...overview.identity,
    ...overview,
  };
}

export function toAdminHealthDetail(context: HealthProjectionContext): AdminHealthDetailProjection {
  const overview = toAdminHealthOverview(context);
  const incidents = context.incidents.map((incident) => incidentSummary(incident, true));
  return {
    ...overview,
    globalConfig: context.global.config,
    globalRevision: context.global.revision,
    globalUpdatedAt: context.global.updatedAt,
    effectiveConfig: context.effectiveConfig,
    inheritance: context.inheritance,
    override: context.override?.override ?? null,
    overrideRevision: context.override?.revision ?? null,
    current: overview.checks,
    openIncidents: incidents.filter((incident) => incident.state === "open"),
    incidentHistory: incidents,
    maintenance: context.maintenance.map(maintenanceSummary),
  };
}

export function toAdminHealthIncidentPage(page: {
  readonly incidents: readonly HealthIncidentRecord[];
  readonly nextCursor: { readonly openedAt: string; readonly id: string } | null;
}): AdminHealthIncidentPageProjection {
  return {
    incidents: page.incidents.map((incident) => incidentSummary(incident, true)),
    nextCursor: page.nextCursor,
  };
}

export function toAdminHealthMaintenancePage(page: {
  readonly records: readonly HealthMaintenanceRecordWithSession[];
  readonly nextCursor: { readonly performedAt: string; readonly id: string } | null;
}): AdminHealthMaintenancePageProjection {
  return {
    records: page.records.map(maintenanceSummary),
    nextCursor: page.nextCursor,
  };
}

/** Explicit detail mapping; this is the only projection that includes notes. */
export function toAdminHealthMaintenanceDetail(
  record: HealthMaintenanceRecordWithSession,
): HealthMaintenanceDetailProjection {
  return { ...maintenanceSummary(record), notes: record.notes };
}

export function toHealthTargetedUpdate(
  context: HealthProjectionContext,
  changedCheckIds: readonly HealthCheckId[],
): HealthTargetedUpdateProjection {
  const overview = baseOverview(context);
  const changed = new Set(changedCheckIds);
  const checks = overview.checks
    .filter((check) => changed.has(check.checkId))
    .map(({ evidence: _evidence, ...check }) => check);
  return {
    tapId: context.tap.id,
    changedCheckIds: [...changedCheckIds],
    checks,
    aggregate: overview.aggregate,
    activeIncidentCount: overview.activeIncidentCount,
    lineCleaning: overview.lineCleaning,
    evaluatedAtMs: overview.aggregate.lastEvaluatedAtMs,
  };
}

// Compatibility aliases used by route adapters and tests that prefer noun-first names.
export const projectAdminHealthOverview = toAdminHealthOverview;
export const projectAdminHealthDetail = toAdminHealthDetail;
export const projectAdminHealthIncidentPage = toAdminHealthIncidentPage;
export const projectAdminHealthMaintenancePage = toAdminHealthMaintenancePage;
export const projectHealthTargetedUpdate = toHealthTargetedUpdate;
