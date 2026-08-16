import type { ServerResponse } from "node:http";

function hasControl(value: string): boolean {
  return /[\r\n\u0000]/u.test(value);
}

/** Send an HTML document with conservative cache behaviour. */
export function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // Chromium otherwise serializes a normal same-origin form navigation as
    // Origin: null under the server-wide no-referrer policy. This preserves no
    // cross-origin referrer disclosure while allowing exact Origin validation.
    "referrer-policy": "same-origin",
    ...headers,
  });
  response.end(html);
}

/** Redirect only to a local absolute path; callers cannot inject a Location header. */
export function redirect(response: ServerResponse, location: string): void {
  if (
    typeof location !== "string" ||
    !location.startsWith("/") ||
    location.startsWith("//") ||
    hasControl(location)
  ) {
    throw new TypeError("Redirect location must be a safe local absolute path");
  }
  response.writeHead(303, { location, "cache-control": "no-store" });
  response.end();
}
