import type { IncomingMessage } from "node:http";

import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type { AuthenticatedSession, AuthService } from "./service.ts";

export interface MutationAuthOptions {
  readonly message?: string;
}

function unauthorized(message: string): never {
  throw new ApplicationError({
    category: "unauthorized",
    code: "auth.unauthorized",
    clientMessage: message,
  });
}

export function requireSession(
  request: IncomingMessage,
  authService: AuthService,
): AuthenticatedSession {
  let token: string | undefined;
  if (request.headers.cookie !== undefined) {
    try {
      token = parseSessionCookie(request.headers.cookie);
    } catch {
      token = undefined;
    }
  }
  if (token === undefined) unauthorized("Authentication is required.");
  const session = authService.authenticateSession(token);
  if (session === undefined) unauthorized("Authentication is required.");
  return session;
}

export function requireMutationAuth(
  request: IncomingMessage,
  authService: AuthService,
  options: MutationAuthOptions = {},
): AuthenticatedSession {
  const session = authService.authorizeCookieMutation({
    cookieHeader: request.headers.cookie,
    originHeader: request.headers.origin,
    csrfHeader: request.headers["x-csrf-token"],
    canonicalOrigin: undefined,
  });
  if (session === undefined) unauthorized(options.message ?? "Authentication failed.");
  return session;
}
