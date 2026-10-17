import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/** Maker pages are cached under the git-ignored `data/` directory: they are copyrighted source
 * text, so only short phrases and a content hash are ever committed. */
export const CACHE_DIR = "data/flavor-sources";
const USER_AGENT = "TapboardCatalog/1.0 (personal homebrew catalog; low rate)";
const HOST_INTERVAL_MS = 2000;

export interface CachedSource {
  readonly url: string;
  readonly retrieved: string;
  /** SHA-256 of the bytes as served. */
  readonly sha256: string;
  readonly contentType: string;
  /** Text as served, or base64 bytes for PDFs and other binary documents. */
  readonly body: string;
  readonly encoding: "utf8" | "base64";
}

/** A maker page answered with a bot challenge. The fetcher never tries to pass one; the page
 * goes on the operator's gap list instead. */
export class BotChallengeError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`${url} is behind a bot challenge; it was not bypassed.`);
    this.url = url;
  }
}
/** Challenge pages from the common bot-protection services. */
export function isBotChallenge(status: number, headers: Headers, body: string): boolean {
  return (
    headers.get("x-vercel-mitigated") === "challenge" ||
    headers.has("cf-mitigated") ||
    ([403, 429, 503].includes(status) &&
      /security checkpoint|challenge-platform|cf-chl|captcha|attention required|just a moment/i.test(
        body.slice(0, 20000),
      ))
  );
}

/** Allow/disallow prefix rules for `*` from a robots.txt body; the longest matching rule wins,
 * and Allow wins a tie. */
export function robotsAllows(robots: string, path: string): boolean {
  let applies = false;
  let inGroupHeader = false;
  const rules: { allow: boolean; prefix: string }[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, field, value] = match as unknown as [string, string, string];
    const key = field.toLowerCase();
    if (key === "user-agent") {
      if (!inGroupHeader) applies = false;
      inGroupHeader = true;
      if (value.trim() === "*") applies = true;
      continue;
    }
    inGroupHeader = false;
    if (applies && (key === "allow" || key === "disallow") && value !== "")
      rules.push({ allow: key === "allow", prefix: value.trim() });
  }
  const matching = rules
    .filter((rule) => path.startsWith(rule.prefix.replace(/\*.*$/, "")))
    .sort((a, b) => b.prefix.length - a.prefix.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

const cachePath = (url: string) =>
  join(CACHE_DIR, new URL(url).host, createHash("sha1").update(url).digest("hex") + ".json");
const lastRequest = new Map<string, number>();
const robotsByOrigin = new Map<string, string>();

async function politeGet(url: string): Promise<Response> {
  // Node's fetch ignores HTTPS_PROXY unless asked; without it, proxied networks fail to resolve.
  if (process.env["HTTPS_PROXY"] && process.env["NODE_USE_ENV_PROXY"] !== "1")
    throw new Error("Run maker fetches with NODE_USE_ENV_PROXY=1 so fetch uses HTTPS_PROXY.");
  const { host } = new URL(url);
  const wait = (lastRequest.get(host) ?? 0) + HOST_INTERVAL_MS - Date.now();
  if (wait > 0) await delay(wait);
  lastRequest.set(host, Date.now());
  return fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
}

/** Fetches a maker page once, honouring robots.txt and a per-host interval, and returns the
 * cached copy on later calls. `refresh` re-reads the page to detect maker changes. */
export async function fetchSource(url: string, refresh = false): Promise<CachedSource> {
  const path = cachePath(url);
  if (!refresh) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as CachedSource;
    } catch {
      // Not cached yet.
    }
  }
  const { origin, pathname, search } = new URL(url);
  if (!robotsByOrigin.has(origin)) {
    const robots = await politeGet(`${origin}/robots.txt`);
    const text = await robots.text();
    if (isBotChallenge(robots.status, robots.headers, text)) throw new BotChallengeError(url);
    robotsByOrigin.set(origin, robots.ok ? text : "");
  }
  if (!robotsAllows(robotsByOrigin.get(origin)!, pathname + search))
    throw new Error(`robots.txt disallows ${url}`);
  const response = await politeGet(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  const binary =
    /pdf|octet-stream/i.test(contentType) || bytes.subarray(0, 5).toString() === "%PDF-";
  if (isBotChallenge(response.status, response.headers, binary ? "" : bytes.toString("utf8")))
    throw new BotChallengeError(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const source: CachedSource = {
    url,
    retrieved: new Date().toISOString().slice(0, 10),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
    body: bytes.toString(binary ? "base64" : "utf8"),
    encoding: binary ? "base64" : "utf8",
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(source));
  return source;
}

/** Plain text of a cached PDF via poppler's `pdftotext`, keeping the page layout. */
export async function pdfText(source: CachedSource): Promise<string> {
  if (source.encoding !== "base64") throw new Error(`${source.url} is not a binary document`);
  const dir = await mkdtemp(join(tmpdir(), "flavor-pdf-"));
  try {
    const file = join(dir, "source.pdf");
    await writeFile(file, Buffer.from(source.body, "base64"));
    const { stdout } = await promisify(execFile)("pdftotext", ["-layout", file, "-"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
