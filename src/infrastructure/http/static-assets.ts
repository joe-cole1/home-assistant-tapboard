import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Router } from "./router.ts";
import { resolveContainedPath } from "./security/static.ts";

export type StaticAssetKind = "js" | "css" | "svg";
export interface StaticAssetDescriptor {
  readonly kind: StaticAssetKind;
  readonly file: string;
  readonly path: string;
  readonly contentType?: string;
  readonly cacheControl?: string;
}
export interface StaticAssetOptions {
  readonly root: string;
  readonly assets: readonly StaticAssetDescriptor[];
  readonly cacheControl?: string;
}

const MIME: Readonly<Record<StaticAssetKind, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};
function safeToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) && !value.includes("..");
}
function safeConfiguredPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.split("/").every(safeToken)
  );
}

export function createStaticAssetHandler(
  options: StaticAssetOptions,
): (
  request: IncomingMessage,
  response: ServerResponse,
  params: Readonly<Record<string, string>>,
) => Promise<void> {
  const root = resolve(options.root);
  const assets = new Map<string, StaticAssetDescriptor>();
  for (const asset of options.assets) {
    if (
      !safeToken(asset.kind) ||
      !safeToken(asset.file) ||
      !safeConfiguredPath(asset.path) ||
      (asset.contentType !== undefined && asset.contentType !== MIME[asset.kind])
    )
      throw new TypeError("Invalid static asset descriptor");
    const key = `${asset.kind}/${asset.file}`;
    if (assets.has(key)) throw new TypeError("Duplicate static asset descriptor");
    assets.set(key, asset);
  }
  return async (_request, response, params): Promise<void> => {
    const asset = assets.get(`${params.kind ?? ""}/${params.file ?? ""}`);
    if (!asset) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    try {
      const file = await resolveContainedPath(root, `/${asset.path}`);
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      const data = await readFile(file);
      response.writeHead(200, {
        "content-type": asset.contentType ?? MIME[asset.kind],
        "cache-control": asset.cacheControl ?? options.cacheControl ?? "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(data);
    } catch {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
    }
  };
}
export function registerStaticAssets(router: Router, options: StaticAssetOptions): void {
  router.get("/assets/:kind/:file", createStaticAssetHandler(options));
}
