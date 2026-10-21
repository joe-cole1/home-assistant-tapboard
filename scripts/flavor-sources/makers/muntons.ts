import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.muntons.com";
// Malts, flakes and extracts of the brewing and distilling range, and the home-brewing
// Spraymalt and malt extracts. Home-brewing kits, yeasts, food and beverage products are other
// post types, or other pages of the home-brewing type, and are never listed.
const HOME_BREWING_INGREDIENT = /\/home_brewing\/[a-z0-9-]*(?:spraymalt|malt-extract)[a-z0-9-]*\/$/;
const DISTILLING_ONLY = /\b(?:distilling|peated|pot still)\b/i;

interface Page {
  readonly name: string;
  readonly lines: readonly string[];
}

/** Muntons product pages use the Oxygen page builder; the product name is the first `h1`.
 * Brewing and distilling pages put the description in one `.oxy-stock-content-styles` block:
 * paragraphs, then "Applications:" (beer styles, inclusion rates and, often, the flavour
 * line such as "Copper/red/amber in colour with sweet toffee, biscuit, nutty, malty
 * flavours"), then a "Typical Analysis:" heading over an image. Home-brewing pages have no
 * such block: the lines between the name and the "Product Details" heading are the
 * description. A malt flavour wheel text that precedes the name on some pages is shared by all
 * malts and is not read. */
function readPage(): Page {
  const name = (document.querySelector("h1")?.textContent ?? "").trim();
  const block = document.querySelector<HTMLElement>(".oxy-stock-content-styles");
  const text = block
    ? block.innerText
    : ((document.querySelector("h1")?.closest("section") as HTMLElement | null)?.innerText ?? "");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (block) return { name, lines: lines.filter((line) => !/^typical analysis:?$/i.test(line)) };
  const from = lines.indexOf(name) + 1;
  const to = lines.findIndex((line) => /^product details$/i.test(line));
  return { name, lines: lines.slice(from, to === -1 ? undefined : to) };
}

export const maker: MakerSource = {
  id: "muntons",
  role: "fermentables",
  async read(limit) {
    const urls: string[] = [];
    for (const type of ["brewing_distilling", "home_brewing"]) {
      const sitemap = await fetchSource(`${ORIGIN}/wp-sitemap-posts-${type}-1.xml`);
      urls.push(
        ...[...sitemap.body.matchAll(/<loc>([^<]*)<\/loc>/g)]
          .map((match) => match[1]!)
          .filter((url) => type === "brewing_distilling" || HOME_BREWING_INGREDIENT.test(url)),
      );
    }
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    const firstUrl = new Map<string, string>();
    for (const url of urls.slice(0, limit)) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.name === "") {
          gaps.push({ url, reason: "no product name in the page" });
          continue;
        }
        if (DISTILLING_ONLY.test(page.name)) continue;
        // Home-brewing pages repeat product names of other pages (as "-duplicate-1" copies);
        // one printed name must point to one product.
        const id = `muntons-${slug(page.name)}`;
        const first = products.find((product) => product.id === id);
        const flavorText = page.lines.join("\n");
        if (first) {
          if (first.flavorText.toLowerCase() !== flavorText.toLowerCase())
            gaps.push({
              url,
              reason: `prints the name "${page.name}" already printed at ${firstUrl.get(id)} with different text; one name cannot name two products`,
            });
          continue;
        }
        firstUrl.set(id, url);
        products.push({
          id,
          role: "fermentables",
          manufacturer: "Muntons",
          manufacturerAliases: [],
          codes: [],
          aliases: titleAliases(page.name),
          flavorText,
          source: makerSource(source),
          limitations: [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
