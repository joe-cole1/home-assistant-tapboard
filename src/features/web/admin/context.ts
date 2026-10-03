import type { IncomingMessage } from "node:http";
import {
  parseCsrfCookie,
  parseSessionCookie,
} from "../../../infrastructure/http/security/cookie.ts";
import type { AuthService, AuthenticatedSession } from "../../auth/service.ts";

export interface AdminContext {
  readonly session: AuthenticatedSession;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

export function cookieValue(
  request: IncomingMessage,
  parser: typeof parseSessionCookie,
): string | undefined {
  try {
    return request.headers.cookie === undefined ? undefined : parser(request.headers.cookie);
  } catch {
    return undefined;
  }
}

export function adminContext(
  request: IncomingMessage,
  authService: AuthService,
): AdminContext | undefined {
  const sessionToken = cookieValue(request, parseSessionCookie);
  if (sessionToken === undefined) return undefined;
  const session = authService.authenticateSession(sessionToken);
  if (session === undefined) return undefined;
  return {
    session,
    sessionToken,
    csrfToken: cookieValue(request, parseCsrfCookie) ?? "",
  };
}

export function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://tapboard.local");
}

export function pageMessage(request: IncomingMessage): {
  readonly notice?: string;
  readonly error?: string;
} {
  const url = requestUrl(request);
  const notice = url.searchParams.get("notice");
  const error = url.searchParams.get("error");
  return {
    ...(notice === null ? {} : { notice: notice.slice(0, 240) }),
    ...(error === null ? {} : { error: error.slice(0, 240) }),
  };
}

export function messageLocation(path: string, kind: "notice" | "error", message: string): string {
  const value = encodeURIComponent(message.slice(0, 240));
  return `${path}?${kind}=${value}`;
}

export function actor(context: AdminContext): {
  readonly actorType: "admin";
  readonly sessionId: string;
} {
  return { actorType: "admin", sessionId: context.session.id };
}
