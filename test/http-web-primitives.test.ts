import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { readFormBody } from "../src/infrastructure/http/form.ts";
import { redirect, sendHtml } from "../src/infrastructure/http/html.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createStaticAssetHandler } from "../src/infrastructure/http/static-assets.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { createLogger } from "../src/shared/logging.ts";

class Response {
  status = 0;
  headers: Record<string, string> = {};
  body: string | Uint8Array = "";
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  end(body: string | Uint8Array = ""): void {
    this.body = body;
  }
}

void test("HTML helpers set UTF-8/no-store and reject redirect injection", () => {
  const response = new Response();
  sendHtml(response as never, 200, "<h1>x</h1>");
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "same-origin");
  assert.throws(() => redirect(response as never, "https://example.test"));
  assert.throws(() => redirect(response as never, "/ok\r\nX: y"));
});

void test("forms accept only strict urlencoded UTF-8 and reject duplicate keys", async () => {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    readableEnded: boolean;
  };
  request.headers = { "content-type": "application/x-www-form-urlencoded" };
  const result = readFormBody(request as never);
  request.end("a=one&b=two");
  assert.equal((await result).a, "one");
  assert.equal((await result).b, "two");

  const duplicate = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    readableEnded: boolean;
  };
  duplicate.headers = { "content-type": "application/x-www-form-urlencoded" };
  const rejected = readFormBody(duplicate as never);
  duplicate.end("a=1&a=2");
  await assert.rejects(rejected);
});

function assetRoot(context: TestContext): string {
  const root = mkdtempSync("/tmp/tapboard-assets-");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "css"));
  writeFileSync(join(root, "css", "tokens.css"), ":root{}", "utf8");
  mkdirSync(join(root, "fonts"));
  writeFileSync(join(root, "fonts", "sample.woff2"), "font-bytes", "utf8");
  return root;
}

void test("static assets are explicit, typed, cached, and traversal-safe", async (context) => {
  const handler = createStaticAssetHandler({
    root: assetRoot(context),
    cacheControl: "public, max-age=300",
    assets: [
      { kind: "css", file: "tokens.css", path: "css/tokens.css" },
      { kind: "font", file: "sample.woff2", path: "fonts/sample.woff2" },
    ],
  });
  const served = new Response();
  await handler({} as never, served as never, { kind: "css", file: "tokens.css" });
  assert.equal(served.status, 200);
  assert.equal(served.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(served.headers["cache-control"], "public, max-age=300");
  assert.equal(String(served.body), ":root{}");

  const font = new Response();
  await handler({} as never, font as never, { kind: "font", file: "sample.woff2" });
  assert.equal(font.status, 200);
  assert.equal(font.headers["content-type"], "font/woff2");
  assert.match(font.headers.etag ?? "", /^"[0-9a-f]{64}"$/u);

  const traversal = new Response();
  await handler({} as never, traversal as never, { kind: "css", file: "../../package.json" });
  assert.equal(traversal.status, 404);
  assert.equal(traversal.body, "");
});

void test("malformed encoded route parameters fail as a safe client error", async () => {
  const router = new Router(createLogger({ sink: () => undefined }));
  router.get("/assets/:kind/:file", () => undefined);
  const response = new Response();
  await router.handle({ method: "GET", url: "/assets/%ZZ/tokens.css" } as never, response as never);
  assert.equal(response.status, 400);
  assert.match(String(response.body), /http\.invalid_request_target/u);
});

void test("Router allows Admin HTML 404 presentation without changing JSON or 405 semantics", async () => {
  const router = new Router(createLogger({ sink: () => undefined }));
  router.get("/known", () => undefined);
  router.setNotFoundHandler((_request, response, pathname) => {
    if (pathname.startsWith("/admin/")) {
      sendHtml(response, 404, "<h1>Admin page not found</h1>");
      return;
    }
    throw new ApplicationError({
      category: "not_found",
      code: "http.not_found",
      clientMessage: "Resource not found.",
    });
  });

  const admin = new Response();
  await router.handle({ method: "GET", url: "/admin/unknown" } as never, admin as never);
  assert.equal(admin.status, 404);
  assert.equal(admin.headers["content-type"], "text/html; charset=utf-8");
  assert.match(String(admin.body), /Admin page not found/u);

  const api = new Response();
  await router.handle({ method: "GET", url: "/api/unknown" } as never, api as never);
  assert.equal(api.status, 404);
  assert.match(String(api.body), /http\.not_found/u);

  const publicPath = new Response();
  await router.handle({ method: "GET", url: "/unknown" } as never, publicPath as never);
  assert.equal(publicPath.status, 404);
  assert.equal(publicPath.headers["content-type"], "application/json; charset=utf-8");

  const method = new Response();
  await router.handle({ method: "POST", url: "/known" } as never, method as never);
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET");
});
