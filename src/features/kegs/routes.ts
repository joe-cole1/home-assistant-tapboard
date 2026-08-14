import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import { readJsonBody, readRequestBody } from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type { KegService } from "./service.ts";
import type {
  AdminDeletionImpactView,
  AdminKegDetailView,
  AdminKegSummaryView,
  AdminMaintenanceView,
  AdminTareHistoryView,
  KegDeletionImpact,
  KegMaintenanceRecord,
  KegTareHistoryRecord,
  PhysicalKeg,
} from "./types.ts";

export interface KegRouteDependencies {
  readonly router: Router;
  readonly kegService: KegService;
  readonly authService: AuthService;
}

function toKegSummaryView(keg: PhysicalKeg): AdminKegSummaryView {
  return {
    id: keg.id,
    kegNumber: keg.kegNumber,
    label: keg.label,
    capacityMl: keg.capacityMl,
    currentTareG: keg.currentTareG,
    isActive: keg.isActive,
    createdAt: keg.createdAt,
    updatedAt: keg.updatedAt,
  };
}

function toTareHistoryView(record: KegTareHistoryRecord): AdminTareHistoryView {
  return {
    id: record.id,
    previousTareG: record.previousTareG,
    newTareG: record.newTareG,
    recordedAt: record.recordedAt,
    reason: record.reason,
    actorType: record.actorType,
    actorId: record.actorId,
  };
}

function toMaintenanceView(record: KegMaintenanceRecord): AdminMaintenanceView {
  return {
    id: record.id,
    maintenanceType: record.maintenanceType,
    notes: record.notes,
    recordedAt: record.recordedAt,
    actorType: record.actorType,
    actorId: record.actorId,
  };
}

function toKegDetailView(
  keg: PhysicalKeg,
  tareHistory: readonly KegTareHistoryRecord[],
  maintenanceHistory: readonly KegMaintenanceRecord[],
): AdminKegDetailView {
  return {
    ...toKegSummaryView(keg),
    tareHistory: tareHistory.map(toTareHistoryView),
    maintenanceHistory: maintenanceHistory.map(toMaintenanceView),
  };
}

function toDeletionImpactView(impact: KegDeletionImpact): AdminDeletionImpactView {
  return {
    kegId: impact.kegId,
    kegNumber: impact.kegNumber,
    impacts: impact.impacts,
  };
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

export function registerKegRoutes(dependencies: KegRouteDependencies): void {
  const { router, kegService, authService } = dependencies;

  // GET /api/admin/kegs
  router.get("/api/admin/kegs", (request: IncomingMessage, response: ServerResponse) => {
    requireSession(request, authService);

    const kegs = kegService.listKegs();
    sendJson(response, 200, {
      kegs: kegs.map(toKegSummaryView),
    });
  });

  // POST /api/admin/kegs
  router.post("/api/admin/kegs", async (request: IncomingMessage, response: ServerResponse) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request);

    const created = kegService.createKeg(body, {
      actorType: "admin",
      sessionId: session.id,
    });

    sendJson(response, 201, {
      keg: toKegSummaryView(created),
    });
  });

  // GET /api/admin/kegs/:id
  router.get(
    "/api/admin/kegs/:id",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const id = params.id;

      const { keg, tareHistory, maintenanceHistory } = kegService.getKeg(id);
      sendJson(response, 200, {
        keg: toKegDetailView(keg, tareHistory, maintenanceHistory),
      });
    },
  );

  // PATCH /api/admin/kegs/:id
  router.patch(
    "/api/admin/kegs/:id",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id;
      const body = await readJsonBody(request);

      const updated = kegService.updateKeg(id, body, {
        actorType: "admin",
        sessionId: session.id,
      });

      const { tareHistory, maintenanceHistory } = kegService.getKeg(updated.id);
      sendJson(response, 200, {
        keg: toKegDetailView(updated, tareHistory, maintenanceHistory),
      });
    },
  );

  // POST /api/admin/kegs/:id/maintenance
  router.post(
    "/api/admin/kegs/:id/maintenance",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id;
      const body = await readJsonBody(request);

      const record = kegService.recordMaintenance(id, body, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 201, {
        record: toMaintenanceView(record),
      });
    },
  );

  // GET /api/admin/kegs/:id/deletion-impact
  router.get(
    "/api/admin/kegs/:id/deletion-impact",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const id = params.id;

      const impact = kegService.getDeletionImpact(id);
      sendJson(response, 200, {
        impact: toDeletionImpactView(impact),
      });
    },
  );

  // DELETE /api/admin/kegs/:id
  router.delete(
    "/api/admin/kegs/:id",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id;

      let body: unknown;
      const rawBody = await readRequestBody(request, { required: false });
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString("utf-8"));
        } catch {
          throw new ApplicationError({
            category: "validation",
            code: "http.invalid_json",
            clientMessage: "The request body is not valid JSON.",
          });
        }
      }

      const impact = kegService.deleteKeg(id, body, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 200, {
        deleted: true,
        impact: toDeletionImpactView(impact),
      });
    },
  );
}
