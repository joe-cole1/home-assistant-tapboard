import type { IncomingMessage } from "node:http";

import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import { readJsonBody } from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { rejectUnknownKeys, requirePlainObject } from "../../shared/validation.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import { HEALTH_CONFIG_FIELDS } from "./config.ts";
import type {
  AdminHealthDetailProjection,
  AdminHealthIncidentPageProjection,
  AdminHealthOverviewProjection,
  AdminHealthMaintenancePageProjection,
  HealthCheckSummary,
  HealthIncidentSummary,
  HealthMaintenanceDetailProjection,
  HealthMaintenanceSummary,
} from "./projections.ts";
import { toAdminHealthMaintenanceDetail, toAdminHealthIncidentPage } from "./projections.ts";
import type {
  HealthGlobalConfig,
  HealthIncidentCursor,
  HealthIncidentRecord,
  HealthMaintenanceCursor,
} from "./repository.ts";
import type { HealthService } from "./service.ts";
import type {
  HealthConfig,
  HealthConfigInheritance,
  HealthConfigOverride,
  HealthEvidenceKey,
  HealthEvidenceScalar,
} from "./types.ts";
import { validateTapId } from "../taps/tap-validation.ts";

const MAX_HISTORY_LIMIT = 200;
const MAX_CURSOR_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SAFE_EVIDENCE_KEYS: readonly HealthEvidenceKey[] = [
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

export interface HealthRouteDependencies {
  readonly router: Router;
  readonly healthService: HealthService;
  readonly authService: AuthService;
}

function unauthorized(): never {
  throw new ApplicationError({
    category: "unauthorized",
    code: "auth.unauthorized",
    clientMessage: "Authentication is required.",
  });
}

function invalid(field: string, reason: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

function requireSession(request: IncomingMessage, authService: AuthService): AuthenticatedSession {
  let sessionToken: string | undefined;
  if (request.headers.cookie !== undefined) {
    try {
      sessionToken = parseSessionCookie(request.headers.cookie);
    } catch {
      sessionToken = undefined;
    }
  }
  if (sessionToken === undefined) unauthorized();
  const session = authService.authenticateSession(sessionToken);
  if (session === undefined) unauthorized();
  return session;
}

function requireMutationAuth(
  request: IncomingMessage,
  authService: AuthService,
): AuthenticatedSession {
  const session = authService.authorizeCookieMutation({
    cookieHeader: request.headers.cookie,
    originHeader: request.headers.origin,
    csrfHeader: request.headers["x-csrf-token"],
    canonicalOrigin: undefined,
  });
  if (session === undefined) unauthorized();
  return session;
}

function actor(session: AuthenticatedSession) {
  return {
    actorType: "admin" as const,
    actorId: session.id,
    sessionId: session.id,
  };
}

function validateResourceId(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    invalid(field, "must be a valid UUID");
  }
  return value.trim().toLowerCase();
}

function canonicalInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !RFC3339_INSTANT.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    invalid(field, "must be an exact canonical UTC timestamp");
  }
  return value;
}

function encodeCursor(cursor: Readonly<Record<string, string>>): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (encoded.length > MAX_CURSOR_BYTES) {
    throw new Error("Health cursor exceeds the HTTP cursor limit");
  }
  return encoded;
}

function decodeCursor<T extends HealthIncidentCursor | HealthMaintenanceCursor>(
  value: string | undefined,
  fields: readonly ["openedAt", "id"] | readonly ["performedAt", "id"],
  timestampField: "openedAt" | "performedAt",
): T | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > MAX_CURSOR_BYTES ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalid("cursor", "must be a valid health history cursor");
  }

  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical cursor");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("cursor", "must be a valid health history cursor");
  }
  const object = requirePlainObject(decoded, "cursor");
  rejectUnknownKeys(object, fields, "cursor");
  if (!Object.hasOwn(object, timestampField) || !Object.hasOwn(object, "id")) {
    invalid("cursor", "must contain a timestamp and id");
  }
  const timestamp = canonicalInstant(object[timestampField], `cursor.${timestampField}`);
  const id = validateResourceId(object.id, "cursor.id");
  return { [timestampField]: timestamp, id } as unknown as T;
}

function pagination(
  request: IncomingMessage,
  kind: "incidents" | "maintenance",
): {
  readonly limit?: number;
  readonly cursor?: HealthIncidentCursor | HealthMaintenanceCursor;
} {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://tapboard.local");
  } catch {
    invalid("query", "is invalid");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "cursor") invalid(key, "is not supported");
  }
  const limits = url.searchParams.getAll("limit");
  const cursors = url.searchParams.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) invalid("query", "contains duplicate values");

  let limit: number | undefined;
  if (limits.length === 1) {
    const raw = limits[0]!;
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) invalid("limit", "must be an integer");
    limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      invalid("limit", `must be between 1 and ${MAX_HISTORY_LIMIT}`);
    }
  }

  const cursor =
    cursors.length === 0
      ? undefined
      : kind === "incidents"
        ? decodeCursor<HealthIncidentCursor>(cursors[0], ["openedAt", "id"], "openedAt")
        : decodeCursor<HealthMaintenanceCursor>(cursors[0], ["performedAt", "id"], "performedAt");
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function toConfigDto(config: HealthConfig): HealthConfig {
  return {
    low_keg: {
      enabled: config.low_keg.enabled,
      thresholdPercent: config.low_keg.thresholdPercent,
      criticalPercent: config.low_keg.criticalPercent,
      fixedThresholdMl: config.low_keg.fixedThresholdMl,
      settlingMs: config.low_keg.settlingMs,
    },
    scale_availability: {
      enabled: config.scale_availability.enabled,
      degradedAfterMs: config.scale_availability.degradedAfterMs,
      activeAfterMs: config.scale_availability.activeAfterMs,
    },
    suspected_leak: {
      enabled: config.suspected_leak.enabled,
      lossThresholdMl: config.suspected_leak.lossThresholdMl,
      windowMs: config.suspected_leak.windowMs,
      pourGraceMs: config.suspected_leak.pourGraceMs,
      settlingMs: config.suspected_leak.settlingMs,
      resetMovementMl: config.suspected_leak.resetMovementMl,
      maxSamples: config.suspected_leak.maxSamples,
    },
    serving_temperature: {
      enabled: config.serving_temperature.enabled,
      normalMinC: config.serving_temperature.normalMinC,
      normalMaxC: config.serving_temperature.normalMaxC,
      criticalMinC: config.serving_temperature.criticalMinC,
      criticalMaxC: config.serving_temperature.criticalMaxC,
      durationMs: config.serving_temperature.durationMs,
    },
    line_cleaning_due: {
      enabled: config.line_cleaning_due.enabled,
      intervalDays: config.line_cleaning_due.intervalDays,
      criticalGraceDays: config.line_cleaning_due.criticalGraceDays,
    },
  };
}

function toSettingsDto(settings: HealthGlobalConfig) {
  return {
    revision: settings.revision,
    config: toConfigDto(settings.config),
    updatedAt: settings.updatedAt,
  };
}

function toOverrideSection(
  section: object | null | undefined,
  fields: readonly string[],
): Record<string, unknown> | null | undefined {
  if (section === undefined || section === null) return section;
  const values = section as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of fields) result[field] = values[field] ?? null;
  return result;
}

function toOverrideDto(
  override: HealthConfigOverride | null | undefined,
): HealthConfigOverride | null {
  if (override === undefined || override === null) return null;
  return {
    ...(override.low_keg === undefined
      ? {}
      : { low_keg: toOverrideSection(override.low_keg, HEALTH_CONFIG_FIELDS.low_keg) }),
    ...(override.scale_availability === undefined
      ? {}
      : {
          scale_availability: toOverrideSection(
            override.scale_availability,
            HEALTH_CONFIG_FIELDS.scale_availability,
          ),
        }),
    ...(override.suspected_leak === undefined
      ? {}
      : {
          suspected_leak: toOverrideSection(
            override.suspected_leak,
            HEALTH_CONFIG_FIELDS.suspected_leak,
          ),
        }),
    ...(override.serving_temperature === undefined
      ? {}
      : {
          serving_temperature: toOverrideSection(
            override.serving_temperature,
            HEALTH_CONFIG_FIELDS.serving_temperature,
          ),
        }),
    ...(override.line_cleaning_due === undefined
      ? {}
      : {
          line_cleaning_due: toOverrideSection(
            override.line_cleaning_due,
            HEALTH_CONFIG_FIELDS.line_cleaning_due,
          ),
        }),
  } as HealthConfigOverride;
}

function toInheritanceDto(inheritance: HealthConfigInheritance): HealthConfigInheritance {
  return {
    low_keg: {
      enabled: inheritance.low_keg.enabled,
      thresholdPercent: inheritance.low_keg.thresholdPercent,
      criticalPercent: inheritance.low_keg.criticalPercent,
      fixedThresholdMl: inheritance.low_keg.fixedThresholdMl,
      settlingMs: inheritance.low_keg.settlingMs,
    },
    scale_availability: {
      enabled: inheritance.scale_availability.enabled,
      degradedAfterMs: inheritance.scale_availability.degradedAfterMs,
      activeAfterMs: inheritance.scale_availability.activeAfterMs,
    },
    suspected_leak: {
      enabled: inheritance.suspected_leak.enabled,
      lossThresholdMl: inheritance.suspected_leak.lossThresholdMl,
      windowMs: inheritance.suspected_leak.windowMs,
      pourGraceMs: inheritance.suspected_leak.pourGraceMs,
      settlingMs: inheritance.suspected_leak.settlingMs,
      resetMovementMl: inheritance.suspected_leak.resetMovementMl,
      maxSamples: inheritance.suspected_leak.maxSamples,
    },
    serving_temperature: {
      enabled: inheritance.serving_temperature.enabled,
      normalMinC: inheritance.serving_temperature.normalMinC,
      normalMaxC: inheritance.serving_temperature.normalMaxC,
      criticalMinC: inheritance.serving_temperature.criticalMinC,
      criticalMaxC: inheritance.serving_temperature.criticalMaxC,
      durationMs: inheritance.serving_temperature.durationMs,
    },
    line_cleaning_due: {
      enabled: inheritance.line_cleaning_due.enabled,
      intervalDays: inheritance.line_cleaning_due.intervalDays,
      criticalGraceDays: inheritance.line_cleaning_due.criticalGraceDays,
    },
  };
}

function toEvidenceDto(
  evidence: Readonly<Record<string, HealthEvidenceScalar | undefined>>,
): Record<string, HealthEvidenceScalar> {
  const result: Record<string, HealthEvidenceScalar> = {};
  for (const key of SAFE_EVIDENCE_KEYS) {
    const value = evidence[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function toCheckDto(check: HealthCheckSummary) {
  return {
    checkId: check.checkId,
    state: check.state,
    severity: check.severity,
    reason: check.reason,
    evaluatedAtMs: check.evaluatedAtMs,
    conditionStartedAtMs: check.conditionStartedAtMs,
    lastObservationAtMs: check.lastObservationAtMs,
    suppressionUntilMs: check.suppressionUntilMs,
    cooldownUntilMs: check.cooldownUntilMs,
    ...(check.evidence === undefined ? {} : { evidence: toEvidenceDto(check.evidence) }),
  };
}

function toIncidentDto(incident: HealthIncidentSummary) {
  return {
    id: incident.id,
    checkId: incident.checkId,
    state: incident.state,
    currentSeverity: incident.currentSeverity,
    maxSeverity: incident.maxSeverity,
    openedAtMs: incident.openedAtMs,
    resolvedAtMs: incident.resolvedAtMs,
    acknowledgedAtMs: incident.acknowledgedAtMs,
    openReason: incident.openReason,
    resolutionReason: incident.resolutionReason,
    ...(incident.openEvidence === undefined
      ? {}
      : { openEvidence: toEvidenceDto(incident.openEvidence) }),
  };
}

function toIncidentRecordDto(incident: HealthIncidentRecord) {
  const page = toAdminHealthIncidentPage({ incidents: [incident], nextCursor: null });
  const summary = page.incidents[0];
  if (summary === undefined) throw new Error("Health incident projection did not persist");
  return toIncidentDto(summary);
}

function toMaintenanceSummaryDto(maintenance: HealthMaintenanceSummary) {
  return {
    id: maintenance.id,
    maintenanceType: maintenance.maintenanceType,
    performedAtMs: maintenance.performedAtMs,
    cleanedAtMs: maintenance.cleanedAtMs,
    dueAtMs: maintenance.dueAtMs,
    recordedAtMs: maintenance.recordedAtMs,
  };
}

function toMaintenanceDetailDto(maintenance: HealthMaintenanceDetailProjection) {
  return {
    id: maintenance.id,
    maintenanceType: maintenance.maintenanceType,
    performedAtMs: maintenance.performedAtMs,
    cleanedAtMs: maintenance.cleanedAtMs,
    dueAtMs: maintenance.dueAtMs,
    recordedAtMs: maintenance.recordedAtMs,
    notes: maintenance.notes,
  };
}

function toOverviewDto(overview: AdminHealthOverviewProjection) {
  const identity = {
    tapId: overview.identity.tapId,
    tapNumber: overview.identity.tapNumber,
    name: overview.identity.name,
    enabled: overview.identity.enabled,
    retired: overview.identity.retired,
  };
  return {
    ...identity,
    identity,
    checks: overview.checks.map(toCheckDto),
    aggregate: {
      state: overview.aggregate.state,
      severity: overview.aggregate.severity,
      activeCount: overview.aggregate.activeCount,
      lastEvaluatedAtMs: overview.aggregate.lastEvaluatedAtMs,
    },
    activeIncidentCount: overview.activeIncidentCount,
    lineCleaning: {
      enabled: overview.lineCleaning.enabled,
      state: overview.lineCleaning.state,
      severity: overview.lineCleaning.severity,
      reason: overview.lineCleaning.reason,
      cleanedAtMs: overview.lineCleaning.cleanedAtMs,
      dueAtMs: overview.lineCleaning.dueAtMs,
      criticalAtMs: overview.lineCleaning.criticalAtMs,
      evaluatedAtMs: overview.lineCleaning.evaluatedAtMs,
    },
  };
}

function toDetailDto(detail: AdminHealthDetailProjection) {
  return {
    ...toOverviewDto(detail),
    globalConfig: toConfigDto(detail.globalConfig),
    globalRevision: detail.globalRevision,
    globalUpdatedAt: detail.globalUpdatedAt,
    effectiveConfig: toConfigDto(detail.effectiveConfig),
    inheritance: toInheritanceDto(detail.inheritance),
    override: toOverrideDto(detail.override),
    overrideRevision: detail.overrideRevision,
    current: detail.current.map(toCheckDto),
    openIncidents: detail.openIncidents.map(toIncidentDto),
    incidentHistory: detail.incidentHistory.map(toIncidentDto),
    maintenance: detail.maintenance.map(toMaintenanceSummaryDto),
  };
}

function toIncidentPageDto(page: AdminHealthIncidentPageProjection) {
  return {
    incidents: page.incidents.map(toIncidentDto),
    nextCursor:
      page.nextCursor === null
        ? null
        : encodeCursor({ openedAt: page.nextCursor.openedAt, id: page.nextCursor.id }),
  };
}

function toMaintenancePageDto(page: AdminHealthMaintenancePageProjection) {
  return {
    records: page.records.map(toMaintenanceSummaryDto),
    nextCursor:
      page.nextCursor === null
        ? null
        : encodeCursor({ performedAt: page.nextCursor.performedAt, id: page.nextCursor.id }),
  };
}

function requireEmptyJsonBody(input: unknown): void {
  const body = requirePlainObject(input, "body");
  rejectUnknownKeys(body, [], "body");
}

function parseCooldownBody(input: unknown): string | null {
  const body = requirePlainObject(input, "body");
  rejectUnknownKeys(body, ["cooldownUntil"], "body");
  if (!Object.hasOwn(body, "cooldownUntil")) invalid("cooldownUntil", "is required");
  if (body.cooldownUntil === null) return null;
  return canonicalInstant(body.cooldownUntil, "cooldownUntil");
}

export function registerHealthRoutes({
  router,
  healthService,
  authService,
}: HealthRouteDependencies): void {
  router.get("/api/admin/health/overview", (request, response) => {
    requireSession(request, authService);
    sendJson(response, 200, {
      overview: healthService.listAdminOverview().map(toOverviewDto),
    });
  });

  router.get("/api/admin/health/settings", (request, response) => {
    requireSession(request, authService);
    sendJson(response, 200, { settings: toSettingsDto(healthService.getGlobalConfig()) });
  });

  router.patch("/api/admin/health/settings", async (request, response) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request, { maxBytes: 16 * 1024 });
    healthService.updateGlobalConfig(body, actor(session));
    sendJson(response, 200, { settings: toSettingsDto(healthService.getGlobalConfig()) });
  });

  router.get("/api/admin/taps/:tapId/health", (request, response, params) => {
    requireSession(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    sendJson(response, 200, { health: toDetailDto(healthService.getAdminDetail(tapId)) });
  });

  router.patch("/api/admin/taps/:tapId/health-overrides", async (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const body = requirePlainObject(
      await readJsonBody(request, { maxBytes: 16 * 1024 }),
      "healthConfigOverride",
    );
    const override = healthService.updateTapOverride(tapId, body, actor(session));
    sendJson(response, 200, { tapId, override: toOverrideDto(override) });
  });

  router.delete("/api/admin/taps/:tapId/health-overrides", (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const cleared = healthService.clearTapOverride(tapId, actor(session));
    sendJson(response, 200, { tapId, cleared });
  });

  router.get("/api/admin/taps/:tapId/health/incidents", (request, response, params) => {
    requireSession(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const options = pagination(request, "incidents");
    const page = healthService.getAdminIncidentPage(tapId, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor as HealthIncidentCursor }),
    });
    sendJson(response, 200, toIncidentPageDto(page));
  });

  router.post(
    "/api/admin/health/incidents/:incidentId/acknowledge",
    async (request, response, params) => {
      const session = requireMutationAuth(request, authService);
      const incidentId = validateResourceId(params.incidentId ?? "", "incidentId");
      requireEmptyJsonBody(await readJsonBody(request, { maxBytes: 16 * 1024 }));
      const incident = healthService.acknowledgeIncident(incidentId, actor(session));
      sendJson(response, 200, { incident: toIncidentRecordDto(incident) });
    },
  );

  router.patch(
    "/api/admin/health/incidents/:incidentId/cooldown",
    async (request, response, params) => {
      const session = requireMutationAuth(request, authService);
      const incidentId = validateResourceId(params.incidentId ?? "", "incidentId");
      const cooldownUntil = parseCooldownBody(await readJsonBody(request, { maxBytes: 16 * 1024 }));
      const incident = healthService.setIncidentCooldown(incidentId, cooldownUntil, actor(session));
      sendJson(response, 200, { incident: toIncidentRecordDto(incident) });
    },
  );

  router.get("/api/admin/taps/:tapId/maintenance", (request, response, params) => {
    requireSession(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const options = pagination(request, "maintenance");
    const page = healthService.getAdminMaintenancePage(tapId, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined
        ? {}
        : { cursor: options.cursor as HealthMaintenanceCursor }),
    });
    sendJson(response, 200, toMaintenancePageDto(page));
  });

  router.post("/api/admin/taps/:tapId/maintenance", async (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const record = healthService.recordMaintenance(
      tapId,
      await readJsonBody(request, { maxBytes: 16 * 1024 }),
      actor(session),
    );
    sendJson(response, 201, {
      record: toMaintenanceDetailDto(toAdminHealthMaintenanceDetail(record)),
    });
  });

  router.get("/api/admin/taps/:tapId/maintenance/:maintenanceId", (request, response, params) => {
    requireSession(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const maintenanceId = validateResourceId(params.maintenanceId ?? "", "maintenanceId");
    const record = healthService.getMaintenanceRecord(tapId, maintenanceId);
    sendJson(response, 200, {
      maintenance: toMaintenanceDetailDto(toAdminHealthMaintenanceDetail(record)),
    });
  });
}
