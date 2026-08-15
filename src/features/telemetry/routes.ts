import type { IncomingMessage, ServerResponse } from "node:http";
import { ApplicationError } from "../../shared/errors.ts";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import {
  MAX_BATCH_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  discardRequestBody,
  readJsonBody,
  readRequestBody,
} from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import { mergeDetectorConfig } from "./detector-config.ts";
import type { DetectorService } from "./detector-service.ts";
import {
  validateDetectorArbitrationGroupCreate,
  validateDetectorArbitrationGroupPatch,
  validateDetectorGroupId,
  validateDetectorTapOverridePatch,
  validateCompleteDetectorConfig,
  validateEmptyOptionalBody,
  validateGlobalDetectorConfigPatch,
} from "./detector-validation.ts";
import type { TelemetryService } from "./service.ts";
import {
  mapExternalBatchTelemetryPayloadToInternal,
  mapExternalTelemetryPayloadToInternal,
  validateTapId,
  validateExternalBatchTelemetryPayload,
  validateExternalTelemetryPayload,
} from "./telemetry-validation.ts";
import type { BatchIngestResult, SingleIngestResult, TelemetrySource } from "./types.ts";

export interface TelemetryRouteDependencies {
  readonly router: Router;
  readonly telemetryService: TelemetryService;
  readonly detectorService: DetectorService;
  readonly authService: AuthService;
}

function requireSession(request: IncomingMessage, authService: AuthService): AuthenticatedSession {
  let sessionToken: string | undefined;
  const cookieHeader = request.headers.cookie;
  if (cookieHeader !== undefined) {
    try {
      sessionToken = parseSessionCookie(cookieHeader);
    } catch {
      sessionToken = undefined;
    }
  }

  if (sessionToken === undefined) {
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Authentication is required.",
    });
  }

  const session = authService.authenticateSession(sessionToken);
  if (session === undefined) {
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Authentication is required.",
    });
  }

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

  if (session === undefined) {
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Authentication failed.",
    });
  }

  return session;
}

function requireBearerToken(request: IncomingMessage): string {
  const authHeader = request.headers.authorization;
  const match =
    typeof authHeader === "string" ? authHeader.trim().match(/^Bearer[ \t]+(\S+)$/i) : undefined;
  if (match === undefined || match === null) {
    discardRequestBody(request);
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage:
        "Machine token authorization required in 'Authorization: Bearer <token>' header.",
    });
  }
  return match[1]!;
}

function authenticateSource(
  request: IncomingMessage,
  telemetryService: TelemetryService,
): TelemetrySource {
  const token = requireBearerToken(request);
  const source = telemetryService.authenticateSourceToken(token);
  if (!source) {
    discardRequestBody(request);
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Invalid or revoked machine token.",
    });
  }
  return source;
}

async function readOptionalJsonBody(
  request: IncomingMessage,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const rawBody = await readRequestBody(request, { required: false, maxBytes });
  if (rawBody.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(rawBody.toString("utf-8"));
  } catch {
    throw new ApplicationError({
      category: "validation",
      code: "http.invalid_json",
      clientMessage: "The request body is not valid JSON.",
    });
  }
}

function singleMachineResult(result: SingleIngestResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    code: result.code,
    duplicate: result.duplicate,
    ...(result.acceptedMeasurementId !== undefined
      ? { accepted_measurement_id: result.acceptedMeasurementId }
      : {}),
    processed_at: result.processedAt,
  };
}

function batchMachineResult(result: BatchIngestResult): Record<string, unknown> {
  return {
    processed_count: result.processedCount,
    accepted_count: result.acceptedCount,
    rejected_count: result.rejectedCount,
    duplicate_count: result.duplicateCount,
    results: result.results.map((item) => ({
      index: item.index,
      tap_number: item.tapNumber,
      ...(item.clientSampleId !== undefined ? { client_sample_id: item.clientSampleId } : {}),
      outcome: item.outcome,
      code: item.code,
      duplicate: item.duplicate,
      ...(item.acceptedMeasurementId !== undefined
        ? { accepted_measurement_id: item.acceptedMeasurementId }
        : {}),
      processed_at: item.processedAt,
    })),
  };
}

function singleMachineStatus(result: SingleIngestResult): number {
  if (result.outcome === "accepted") return 200;
  return result.code === "telemetry.rate_limited" ? 429 : 409;
}

export function registerTelemetryRoutes(dependencies: TelemetryRouteDependencies): void {
  const { router, telemetryService, detectorService, authService } = dependencies;

  // ==========================================
  // External Telemetry Ingestion Endpoints (v1)
  // ==========================================

  // POST /api/v1/telemetry/taps/:tapNumber
  router.post(
    "/api/v1/telemetry/taps/:tapNumber",
    async (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      const source = authenticateSource(request, telemetryService);
      const tapNumber = Number(params.tapNumber);
      const body = await readJsonBody(request, { maxBytes: MAX_JSON_BODY_BYTES });
      const externalPayload = validateExternalTelemetryPayload(body);
      const internalPayload = mapExternalTelemetryPayloadToInternal(externalPayload);

      const result = telemetryService.ingestSingle(source, tapNumber, internalPayload);
      sendJson(response, singleMachineStatus(result), singleMachineResult(result));
    },
  );

  // POST /api/v1/telemetry/batch
  router.post(
    "/api/v1/telemetry/batch",
    async (request: IncomingMessage, response: ServerResponse) => {
      const source = authenticateSource(request, telemetryService);
      const body = await readJsonBody(request, { maxBytes: MAX_BATCH_JSON_BODY_BYTES });
      const externalPayload = validateExternalBatchTelemetryPayload(body);
      const internalPayload = mapExternalBatchTelemetryPayloadToInternal(externalPayload);

      const result = telemetryService.ingestBatch(source, internalPayload);
      sendJson(response, 200, batchMachineResult(result));
    },
  );

  // ==========================================
  // Admin Telemetry Endpoints
  // ==========================================

  router.get("/api/admin/telemetry/detector-config", (request, response) => {
    requireSession(request, authService);
    sendJson(response, 200, { config: detectorService.getGlobalConfig() });
  });

  router.patch("/api/admin/telemetry/detector-config", async (request, response) => {
    const session = requireMutationAuth(request, authService);
    const patch = validateGlobalDetectorConfigPatch(await readJsonBody(request));
    const current = detectorService.getGlobalConfig();
    const next = { ...current.config, ...patch };
    validateCompleteDetectorConfig(next);
    const config = detectorService.updateGlobalConfig(next, {
      actorType: "admin",
      actorId: session.id,
      sessionId: session.id,
    });
    sendJson(response, 200, { config });
  });

  router.get("/api/admin/taps/:tapId/detector-config", (request, response, params) => {
    requireSession(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    sendJson(response, 200, {
      tapId,
      override: detectorService.getTapOverride(tapId) ?? null,
      globalConfig: detectorService.getGlobalConfig(),
    });
  });

  router.patch("/api/admin/taps/:tapId/detector-config", async (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const patch = validateDetectorTapOverridePatch(await readJsonBody(request));
    const current = detectorService.getTapOverride(tapId)?.override ?? {};
    const next = { ...current, ...patch };
    validateCompleteDetectorConfig(
      mergeDetectorConfig(detectorService.getGlobalConfig().config, next),
    );
    const override = detectorService.setTapOverride(tapId, next, {
      actorType: "admin",
      actorId: session.id,
      sessionId: session.id,
    });
    sendJson(response, 200, { tapId, override });
  });

  router.delete("/api/admin/taps/:tapId/detector-config", (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    const tapId = validateTapId(params.tapId ?? "", "tapId");
    const cleared = detectorService.clearTapOverride(tapId, {
      actorType: "admin",
      actorId: session.id,
      sessionId: session.id,
    });
    sendJson(response, 200, { tapId, cleared });
  });

  router.get("/api/admin/taps/:tapId/telemetry/diagnostics", (request, response, params) => {
    requireSession(request, authService);
    sendJson(response, 200, {
      diagnostics: detectorService.diagnostics(validateTapId(params.tapId ?? "", "tapId")),
    });
  });

  router.post("/api/admin/taps/:tapId/telemetry/rebaseline", async (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    validateEmptyOptionalBody(await readOptionalJsonBody(request));
    const diagnostics = detectorService.manualRebaseline(
      validateTapId(params.tapId ?? "", "tapId"),
      {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      },
    );
    sendJson(response, 200, { diagnostics });
  });

  router.get("/api/admin/telemetry/arbitration-groups", (request, response) => {
    requireSession(request, authService);
    sendJson(response, 200, { groups: detectorService.listArbitrationGroups() });
  });

  router.post("/api/admin/telemetry/arbitration-groups", async (request, response) => {
    const session = requireMutationAuth(request, authService);
    const input = validateDetectorArbitrationGroupCreate(await readJsonBody(request));
    const group = detectorService.createArbitrationGroup(input.name, input.tapIds, {
      actorType: "admin",
      actorId: session.id,
      sessionId: session.id,
    });
    sendJson(response, 201, { group });
  });

  router.patch("/api/admin/telemetry/arbitration-groups/:id", async (request, response, params) => {
    const session = requireMutationAuth(request, authService);
    const group = detectorService.updateArbitrationGroup(
      validateDetectorGroupId(params.id ?? "", "id"),
      validateDetectorArbitrationGroupPatch(await readJsonBody(request)),
      {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      },
    );
    sendJson(response, 200, { group });
  });

  // GET /api/admin/telemetry/sources
  router.get(
    "/api/admin/telemetry/sources",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const sources = telemetryService.listSources();
      sendJson(response, 200, { sources });
    },
  );

  // POST /api/admin/telemetry/sources
  router.post(
    "/api/admin/telemetry/sources",
    async (request: IncomingMessage, response: ServerResponse) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const result = telemetryService.createSource(body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 201, { ...result });
    },
  );

  // GET /api/admin/telemetry/sources/:id
  router.get(
    "/api/admin/telemetry/sources/:id",
    (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      requireSession(request, authService);
      const sourceId = params.id ?? "";
      const source = telemetryService.getSourceById(sourceId);
      if (!source) {
        throw new ApplicationError({
          category: "not_found",
          code: "telemetry.source_not_found",
          clientMessage: "Telemetry source not found.",
          details: { sourceId },
        });
      }
      sendJson(response, 200, { source });
    },
  );

  // PATCH /api/admin/telemetry/sources/:id
  router.patch(
    "/api/admin/telemetry/sources/:id",
    async (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const source = telemetryService.renameSource(params.id ?? "", body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { source });
    },
  );

  // POST /api/admin/telemetry/sources/:id/rotate
  router.post(
    "/api/admin/telemetry/sources/:id/rotate",
    async (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      const session = requireMutationAuth(request, authService);
      const body = await readOptionalJsonBody(request);
      const result = telemetryService.rotateSourceKey(params.id ?? "", body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { ...result });
    },
  );

  // GET /api/admin/telemetry/authorities
  router.get(
    "/api/admin/telemetry/authorities",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const authorities = telemetryService.listAuthorities();
      sendJson(response, 200, { authorities });
    },
  );

  // GET /api/admin/taps/:tapId/authority
  router.get(
    "/api/admin/taps/:tapId/authority",
    (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      requireSession(request, authService);
      const authority = telemetryService.getTapAuthority(params.tapId ?? "");
      sendJson(response, 200, { authority });
    },
  );

  // POST /api/admin/taps/:tapId/authority
  router.post(
    "/api/admin/taps/:tapId/authority",
    async (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const result = telemetryService.setTapAuthority(params.tapId ?? "", body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { ...result });
    },
  );

  // GET /api/admin/telemetry/settings
  router.get(
    "/api/admin/telemetry/settings",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const settings = telemetryService.getSettings();
      sendJson(response, 200, { settings });
    },
  );

  // PATCH /api/admin/telemetry/settings
  router.patch(
    "/api/admin/telemetry/settings",
    async (request: IncomingMessage, response: ServerResponse) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const settings = telemetryService.updateSettings(body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { settings });
    },
  );

  // GET /api/admin/telemetry/status
  router.get(
    "/api/admin/telemetry/status",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const statuses = telemetryService.getAllHardwareStatus();
      sendJson(response, 200, { statuses });
    },
  );

  // GET /api/admin/taps/:tapId/telemetry/status
  router.get(
    "/api/admin/taps/:tapId/telemetry/status",
    (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => {
      requireSession(request, authService);
      const statuses = telemetryService.getTapLatestHardwareStatus(params.tapId ?? "");
      sendJson(response, 200, { statuses });
    },
  );

  // POST /api/admin/telemetry/prune
  router.post(
    "/api/admin/telemetry/prune",
    (request: IncomingMessage, response: ServerResponse) => {
      requireMutationAuth(request, authService);
      const result = telemetryService.pruneTelemetry();
      sendJson(response, 200, { ...result });
    },
  );
}
