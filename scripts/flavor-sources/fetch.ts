import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Maker pages are cached under the git-ignored `data/` directory: they are copyrighted source
 * text, so only short phrases and a content hash are ever committed. */
export const CACHE_DIR = "data/flavor-sources";
const USER_AGENT = "TapboardCatalog/1.0 (personal homebrew catalog; low rate)";
const HOST_INTERVAL_MS = 2000;

export interface CachedSource {
  readonly url: string;
  readonly retrieved: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly body: string;
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
    robotsByOrigin.set(origin, robots.ok ? await robots.text() : "");
  }
  if (!robotsAllows(robotsByOrigin.get(origin)!, pathname + search))
    throw new Error(`robots.txt disallows ${url}`);
  const response = await politeGet(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const body = await response.text();
  const source: CachedSource = {
    url,
    retrieved: new Date().toISOString().slice(0, 10),
    sha256: createHash("sha256").update(body).digest("hex"),
    contentType: response.headers.get("content-type") ?? "",
    body,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(source));
  return source;
}
