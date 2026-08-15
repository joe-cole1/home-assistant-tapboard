import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import { readJsonBody } from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import type { ForecastService } from "./service.ts";
import { decodeForecastHistoryCursor, type ForecastHistoryCursor } from "./forecast-validation.ts";

export interface ForecastRouteDependencies {
  readonly router: Router;
  readonly forecastService: ForecastService;
  readonly authService: AuthService;
}
function unauthorized(): never {
  throw new ApplicationError({
    category: "unauthorized",
    code: "auth.unauthorized",
    clientMessage: "Authentication is required.",
  });
}
function requireSession(request: IncomingMessage, auth: AuthService): AuthenticatedSession {
  let token: string | undefined;
  try {
    token =
      request.headers.cookie === undefined ? undefined : parseSessionCookie(request.headers.cookie);
  } catch {
    token = undefined;
  }
  if (!token) unauthorized();
  const session = auth.authenticateSession(token);
  if (!session) unauthorized();
  return session;
}
function requireMutation(request: IncomingMessage, auth: AuthService): AuthenticatedSession {
  const session = auth.authorizeCookieMutation({
    cookieHeader: request.headers.cookie,
    originHeader: request.headers.origin,
    csrfHeader: request.headers["x-csrf-token"],
    canonicalOrigin: undefined,
  });
  if (!session) unauthorized();
  return session;
}
function invalid(field: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason: "is invalid" },
  });
}
function historyQuery(request: IncomingMessage): {
  limit?: number;
  cursor?: ForecastHistoryCursor;
} {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://tapboard.local");
  } catch {
    return invalid("query");
  }
  for (const key of url.searchParams.keys()) if (key !== "limit" && key !== "cursor") invalid(key);
  const limitValues = url.searchParams.getAll("limit"),
    cursorValues = url.searchParams.getAll("cursor");
  if (limitValues.length > 1 || cursorValues.length > 1) invalid("query");
  let limit: number | undefined;
  if (limitValues.length === 1) {
    const raw = limitValues[0]!;
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) invalid("limit");
    limit = Number(raw);
    if (!Number.isSafeInteger(limit)) invalid("limit");
  }
  const cursor =
    cursorValues.length === 1 ? decodeForecastHistoryCursor(cursorValues[0]) : undefined;
  return { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) };
}

export function registerForecastRoutes({
  router,
  forecastService,
  authService,
}: ForecastRouteDependencies): void {
  router.get(
    "/api/admin/fills/:fillId/pours",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const page = forecastService.getPourHistory(params.fillId, historyQuery(request));
      sendJson(response, 200, { pours: page.pours, nextCursor: page.nextCursor });
    },
  );
  router.get(
    "/api/admin/fills/:fillId/forecast",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      sendJson(response, 200, { forecast: forecastService.getForecast(params.fillId) });
    },
  );
  router.get(
    "/api/admin/forecast/settings",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      sendJson(response, 200, { settings: forecastService.getSettings() });
    },
  );
  router.patch(
    "/api/admin/forecast/settings",
    async (request: IncomingMessage, response: ServerResponse) => {
      const session = requireMutation(request, authService);
      const settings = forecastService.updateSettings(
        await readJsonBody(request, { maxBytes: 16 * 1024 }),
        { actorId: session.id, sessionId: session.id },
      );
      sendJson(response, 200, { settings });
    },
  );
}
