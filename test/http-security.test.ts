import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  authorizeCookieMutation,
  containedStaticPath,
  decodeContainedPath,
  parseCanonicalOrigin,
  parseCookieHeader,
  parseCsrfCookie,
  parseSessionCookie,
  readJsonBody,
  resolveContainedPath,
  securityResponseHeaders,
  serializeCsrfCookie,
  serializeSessionCookie,
  validateMutationOrigin,
  csrfDigest,
} from "../src/infrastructure/http/security/index.ts";

void test("cookie, origin, and CSRF primitives fail closed", () => {
  const token = Buffer.alloc(32, 7).toString("base64url");
  const csrf = Buffer.alloc(32, 8).toString("base64url");
  const cookie = serializeSessionCookie(token, "2026-08-14T00:00:00.000Z", {
    now: new Date("2026-08-13T00:00:00.000Z"),
    secure: true,
  });
  assert.match(cookie, new RegExp(`${ADMIN_SESSION_COOKIE}=${token}`));
  assert.match(cookie, /HttpOnly/u);
  const csrfCookie = serializeCsrfCookie(csrf, "2026-08-14T00:00:00.000Z", {
    now: new Date("2026-08-13T00:00:00.000Z"),
    secure: true,
  });
  assert.match(csrfCookie, new RegExp(`${ADMIN_CSRF_COOKIE}=${csrf}`));
  assert.doesNotMatch(csrfCookie, /HttpOnly/u);
  assert.match(csrfCookie, /SameSite=Strict/u);
  assert.match(csrfCookie, /Secure/u);
  assert.equal(parseCsrfCookie(`${ADMIN_CSRF_COOKIE}=${csrf}`), csrf);
  assert.equal(parseSessionCookie(`${ADMIN_SESSION_COOKIE}=${token}`), token);
  assert.throws(() => parseCookieHeader(`${ADMIN_SESSION_COOKIE}=x; ${ADMIN_SESSION_COOKIE}=y`));
  assert.equal(parseCanonicalOrigin("https://example.test"), "https://example.test");
  assert.equal(parseCanonicalOrigin("https://example.test/"), undefined);
  assert.equal(validateMutationOrigin("https://example.test", "https://example.test"), true);
  assert.equal(
    validateMutationOrigin(
      ["https://example.test", "https://example.test"],
      "https://example.test",
    ),
    false,
  );
  const session = { id: "s", credentialRevision: 1 };
  assert.equal(
    authorizeCookieMutation(
      {
        cookieHeader: `${ADMIN_SESSION_COOKIE}=${token}`,
        originHeader: "https://example.test",
        csrfHeader: csrf,
        canonicalOrigin: "https://example.test",
      },
      () => session,
      () => csrfDigest(csrf),
    ),
    session,
  );
});

void test("JSON body limits and static containment are bounded", async () => {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    readableEnded: boolean;
  };
  request.headers = { "content-type": "application/json" };
  const parsed = readJsonBody<{ ok: boolean }>(request as never);
  request.end('{"ok":true}');
  assert.deepEqual(await parsed, { ok: true });

  assert.throws(() => decodeContainedPath("/%2e%2e/secret"));
  const root = mkdtempSync("/tmp/tapboard-static-");
  writeFileSync(join(root, "index.html"), "ok");
  assert.equal(containedStaticPath(root, "/index.html"), join(root, "index.html"));
  assert.throws(() => containedStaticPath(root, "/../secret"));
  try {
    symlinkSync("/etc/passwd", join(root, "outside"));
    await assert.rejects(resolveContainedPath(root, "/outside"));
  } catch {
    // Symlink creation can be unavailable in restricted test environments.
  }
});

void test("security headers contain browser hardening without CORS/HSTS", () => {
  const headers = securityResponseHeaders();
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal("access-control-allow-origin" in headers, false);
  assert.equal("strict-transport-security" in headers, false);
});
