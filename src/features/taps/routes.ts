import type { IncomingMessage, ServerResponse } from "node:http";
import { ApplicationError } from "../../shared/errors.ts";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import { readJsonBody, readRequestBody } from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import type { TapService } from "./service.ts";

export interface TapRouteDependencies {
  readonly router: Router;
  readonly tapService: TapService;
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

async function readOptionalJsonBody(request: IncomingMessage): Promise<unknown> {
  const rawBody = await readRequestBody(request, { required: false });
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

export function registerTapRoutes(dependencies: TapRouteDependencies): void {
  const { router, tapService, authService } = dependencies;

  // GET /api/public/taps
  router.get("/api/public/taps", (_request: IncomingMessage, response: ServerResponse) => {
    const taps = tapService.listPublicTaps();
    sendJson(response, 200, { taps });
  });

  // GET /api/admin/taps
  router.get("/api/admin/taps", (request: IncomingMessage, response: ServerResponse) => {
    requireSession(request, authService);
    const taps = tapService.listTaps();
    sendJson(response, 200, { taps });
  });

  // POST /api/admin/taps
  router.post("/api/admin/taps", async (request: IncomingMessage, response: ServerResponse) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request);
    const tap = tapService.createTap(body, {
      actorType: "admin",
      actorId: session.id,
      sessionId: session.id,
    });
    sendJson(response, 201, { tap });
  });

  // GET /api/admin/taps/:id
  router.get(
    "/api/admin/taps/:id",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const tap = tapService.getTap(params.id);
      sendJson(response, 200, { tap });
    },
  );

  const handleUpdateTap = async (
    request: IncomingMessage,
    response: ServerResponse,
    params: Readonly<Record<string, string>>,
  ) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request);
    const tap = tapService.updateTap(params.id, body, {
      actorType: "admin",
      actorId: session.id,
      sessionId: session.id,
    });
    sendJson(response, 200, { tap });
  };

  // PATCH /api/admin/taps/:id
  router.patch("/api/admin/taps/:id", handleUpdateTap);

  // PUT /api/admin/taps/:id
  router.put("/api/admin/taps/:id", handleUpdateTap);

  // POST /api/admin/taps/:id/assign
  router.post(
    "/api/admin/taps/:id/assign",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const result = tapService.assignFill(params.id, body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { ...result });
    },
  );

  // POST /api/admin/taps/:id/unassign
  router.post(
    "/api/admin/taps/:id/unassign",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const result = tapService.unassign(params.id, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { ...result });
    },
  );

  // POST /api/admin/taps/:id/move
  router.post(
    "/api/admin/taps/:id/move",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const result = tapService.moveFill({ tapId: params.id }, body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { ...result });
    },
  );

  // POST /api/admin/fills/:fillId/move
  router.post(
    "/api/admin/fills/:fillId/move",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const result = tapService.moveFill({ fillId: params.fillId }, body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { ...result });
    },
  );

  // POST /api/admin/taps/:id/retire
  router.post(
    "/api/admin/taps/:id/retire",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const body = await readOptionalJsonBody(request);
      const tap = tapService.retireTap(params.id, body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { tap });
    },
  );

  // GET /api/admin/taps/:id/deletion-impact
  router.get(
    "/api/admin/taps/:id/deletion-impact",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const impact = tapService.getTapDeletionImpact(params.id);
      sendJson(response, 200, { impact });
    },
  );

  // DELETE /api/admin/taps/:id
  router.delete(
    "/api/admin/taps/:id",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const body = await readOptionalJsonBody(request);
      tapService.deleteTap(params.id, body, {
        actorType: "admin",
        actorId: session.id,
        sessionId: session.id,
      });
      sendJson(response, 200, { deleted: true, tapId: params.id });
    },
  );
}
