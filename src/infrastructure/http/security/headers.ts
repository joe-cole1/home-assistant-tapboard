import type { ServerResponse } from "node:http";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  vary: "Origin",
};

export function securityResponseHeaders(): Readonly<Record<string, string>> {
  return { ...SECURITY_HEADERS };
}

export function applySecurityHeaders(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) return;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

export const setSecurityHeaders = applySecurityHeaders;
export const getSecurityHeaders = securityResponseHeaders;
