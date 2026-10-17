import { chromium, type Browser } from "@playwright/test";
import type { BrewingIngredientRole } from "../../src/features/beverages/brewing-types.ts";
import type { ParsedProduct } from "./build.ts";
import type { CachedSource } from "./fetch.ts";

/** One maker's catalog reader: it enumerates the maker's own product list, reads each page
 * through `fetchSource`, and reports pages it could not read instead of guessing them. */
export interface MakerSource {
  readonly id: string;
  readonly role: BrewingIngredientRole;
  /** `limit` reads only the first N products, for parser development. */
  readonly read: (limit?: number) => Promise<MakerResult>;
}
export interface MakerResult {
  readonly products: readonly ParsedProduct[];
  readonly gaps: readonly { readonly url: string; readonly reason: string }[];
}

/** Source metadata for a dataset entry read from the maker's own page. */
export const makerSource = (source: CachedSource): ParsedProduct["source"] => ({
  url: source.url,
  kind: "maker",
  via: null,
  retrieved: source.retrieved,
  sha256: source.sha256,
});

let browser: Promise<Browser> | null = null;
/** Runs `read` against cached HTML in Chromium with scripts and network disabled, so parsers use
 * real DOM selectors without the page doing anything. `read` runs inside the page and must be
 * self-contained. */
export async function inDom<R>(html: string, read: () => R): Promise<R> {
  browser ??= chromium.launch({
    ...(process.env["TAPBOARD_E2E_CHROMIUM_PATH"]
      ? { executablePath: process.env["TAPBOARD_E2E_CHROMIUM_PATH"] }
      : {}),
  });
  const context = await (await browser).newContext({ javaScriptEnabled: false });
  await context.route("**/*", (route) => route.abort());
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await page.evaluate(read);
  } finally {
    await context.close();
  }
}
export async function closeDom(): Promise<void> {
  if (browser) await (await browser).close();
  browser = null;
}

/** Lowercase hyphen-joined id fragment from a maker's product name. */
export const slug = (text: string): string =>
  text
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/[®™℠]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Exact-name aliases a maker title yields: the title as printed, then without trademark signs
 * and without the given brand prefixes or generic suffixes. Mechanical spelling variants only. */
export function titleAliases(
  title: string,
  prefixes: readonly string[] = [],
  suffixes: readonly string[] = [],
): string[] {
  const clean = title.replace(/[®™℠]/g, "").replace(/\s+/g, " ").trim();
  const variants = new Set([title.trim(), clean]);
  let core = clean;
  for (const prefix of prefixes)
    if (core.toLowerCase().startsWith(prefix.toLowerCase() + " "))
      core = core.slice(prefix.length).trim();
  variants.add(core);
  for (const suffix of suffixes)
    if (core.toLowerCase().endsWith(" " + suffix.toLowerCase()))
      variants.add(core.slice(0, -suffix.length).trim());
  return [...variants].filter((name) => name !== "");
}

const SOURING_ORGANISM =
  /lacto|pedio|bacteri|\blab\b|brett|lachancea|acetobacter|kombucha|\bsour|lambic|gueuze|geuze|berliner|flemish|flanders|roeselare|bruin|mixed (?:culture|ferment)/i;
const BREWING_SPECIES = /saccharomyces|cerevisiae|pastorianus|bayanus|uvarum/i;
const ORDINARY_YEAST =
  /brewer.?s yeast|\bale\b|lager|wheat|weizen|kveik|\byeast\b|saison|k[oö]lsch/i;
/** Souring from what a lab states about a culture. `stated` is what names the culture itself
 * (species, strain type, category, product name) and `text` is its description:
 * - a souring organism or sour style in `stated` makes it souring;
 * - otherwise a stated Saccharomyces species makes it not souring;
 * - otherwise a souring organism mentioned in `text` (a blend partner or a pairing) leaves it
 *   unknown;
 * - otherwise an ordinary ale, lager, wheat or kveik yeast is not souring, and anything else is
 *   unknown. A blend or culture is not souring by that word alone. */
export function souringFromStated(stated: string, text = ""): boolean | null {
  if (SOURING_ORGANISM.test(stated)) return true;
  if (BREWING_SPECIES.test(stated)) return false;
  if (SOURING_ORGANISM.test(text)) return null;
  return ORDINARY_YEAST.test(stated) ? false : null;
}

export interface ShopifyProduct {
  readonly handle: string;
  readonly title: string;
  readonly body_html: string | null;
  readonly product_type: string;
  readonly tags: readonly string[];
  readonly variants: readonly { readonly sku: string | null }[];
}
/** Every product of a Shopify store from its public `products.json` (robots-checked by the
 * fetcher), with the cached page source of each listing page. */
export async function shopifyProducts(
  origin: string,
): Promise<{ product: ShopifyProduct; source: CachedSource }[]> {
  const { fetchSource } = await import("./fetch.ts");
  const all: { product: ShopifyProduct; source: CachedSource }[] = [];
  for (let page = 1; page <= 20; page++) {
    const source = await fetchSource(`${origin}/products.json?limit=250&page=${page}`);
    const { products } = JSON.parse(source.body) as { products: ShopifyProduct[] };
    if (products.length === 0) break;
    all.push(...products.map((product) => ({ product, source })));
  }
  return all;
}
/** Visible text of an HTML fragment, with block boundaries as line breaks. */
export const fragmentText = (html: string): Promise<string> =>
  inDom(`<body>${html}</body>`, () => document.body.innerText.trim());
