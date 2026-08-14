import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import { readJsonBody, readRequestBody } from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type { FillService } from "./service.ts";

export interface FillRouteDependencies {
  readonly router: Router;
  readonly fillService: FillService;
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

export function registerFillRoutes(dependencies: FillRouteDependencies): void {
  const { router, fillService, authService } = dependencies;

  // GET /api/admin/fills/settings
  router.get("/api/admin/fills/settings", (request: IncomingMessage, response: ServerResponse) => {
    requireSession(request, authService);
    const settings = fillService.getSettings();
    sendJson(response, 200, { settings });
  });

  const handleUpdateSettings = async (request: IncomingMessage, response: ServerResponse) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request);

    const settings = fillService.updateSettings(body, {
      actorType: "admin",
      sessionId: session.id,
    });

    sendJson(response, 200, { settings });
  };

  // PUT and PATCH /api/admin/fills/settings
  router.put("/api/admin/fills/settings", handleUpdateSettings);
  router.patch("/api/admin/fills/settings", handleUpdateSettings);

  // GET /api/on-deck (Public projection)
  router.get("/api/on-deck", (_request: IncomingMessage, response: ServerResponse) => {
    const onDeck = fillService.getPublicOnDeck();
    sendJson(response, 200, { onDeck });
  });

  // GET /api/admin/fills/on-deck
  router.get("/api/admin/fills/on-deck", (request: IncomingMessage, response: ServerResponse) => {
    requireSession(request, authService);
    const onDeck = fillService.listFills({ state: "on_deck" });
    sendJson(response, 200, { onDeck });
  });

  const handleReorderOnDeck = async (request: IncomingMessage, response: ServerResponse) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request);

    const onDeck = fillService.reorderOnDeck(body, {
      actorType: "admin",
      sessionId: session.id,
    });

    sendJson(response, 200, { onDeck });
  };

  // PUT and PATCH and POST /api/admin/fills/on-deck/order
  router.put("/api/admin/fills/on-deck/order", handleReorderOnDeck);
  router.patch("/api/admin/fills/on-deck/order", handleReorderOnDeck);
  router.post("/api/admin/fills/on-deck/order", handleReorderOnDeck);

  // GET /api/admin/fills
  router.get("/api/admin/fills", (request: IncomingMessage, response: ServerResponse) => {
    requireSession(request, authService);
    let query: Record<string, string> = {};
    if (request.url) {
      try {
        const url = new URL(request.url, "http://tapboard.local");
        query = Object.fromEntries(url.searchParams.entries());
      } catch {
        query = {};
      }
    }

    const fills = fillService.listFills(query);
    sendJson(response, 200, { fills });
  });

  // POST /api/admin/fills
  router.post("/api/admin/fills", async (request: IncomingMessage, response: ServerResponse) => {
    const session = requireMutationAuth(request, authService);
    const body = await readJsonBody(request);

    const fill = fillService.createFill(body, {
      actorType: "admin",
      sessionId: session.id,
    });

    sendJson(response, 201, { fill });
  });

  // GET /api/admin/fills/:id/deletion-impact
  router.get(
    "/api/admin/fills/:id/deletion-impact",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const id = params.id;
      const impact = fillService.getDeletionImpact(id);
      sendJson(response, 200, { impact });
    },
  );

  // POST /api/admin/fills/:id/on-deck
  router.post(
    "/api/admin/fills/:id/on-deck",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id;

      const fill = fillService.markOnDeck(id, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 200, { fill });
    },
  );

  // DELETE /api/admin/fills/:id/on-deck
  router.delete(
    "/api/admin/fills/:id/on-deck",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id;

      const fill = fillService.removeFromOnDeck(id, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 200, { fill });
    },
  );

  // POST /api/admin/fills/:id/kick
  router.post(
    "/api/admin/fills/:id/kick",
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

      const result = await fillService.kickFill(id, body, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 200, {
        fill: result.fill,
        brewfatherOutcome: result.brewfatherOutcome,
        ...(result.brewfatherMessage ? { brewfatherMessage: result.brewfatherMessage } : {}),
      });
    },
  );

  // POST /api/admin/fills/:id/complete-brewfather
  router.post(
    "/api/admin/fills/:id/complete-brewfather",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireMutationAuth(request, authService);
      const id = params.id;

      const result = await fillService.completeBrewfatherBatch(id);
      sendJson(response, 200, {
        outcome: result.outcome,
        ...(result.message ? { message: result.message } : {}),
      });
    },
  );

  // GET /api/admin/fills/:id
  router.get(
    "/api/admin/fills/:id",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const id = params.id;
      const fill = fillService.getFill(id);
      sendJson(response, 200, { fill });
    },
  );

  // DELETE /api/admin/fills/:id
  router.delete(
    "/api/admin/fills/:id",
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

      const impact = fillService.deleteFill(id, body, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 200, {
        deleted: true,
        impact,
      });
    },
  );
}
