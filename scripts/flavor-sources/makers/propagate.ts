import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, souringFromStated, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://propagatelab.com";

/** Propagate product pages: `h1` name, the SKU (their culture code), the product category link,
 * the attribute table (yeast pages list Flocculation and Attenuation) and the Description tab,
 * whose award lines ("2023 GABF Gold – …") follow the strain text and are never read. */
function readPage() {
  const attributes: Record<string, string> = {};
  for (const row of document.querySelectorAll(".woocommerce-product-attributes tr"))
    attributes[(row.querySelector("th")?.textContent ?? "").trim().toLowerCase()] = (
      row.querySelector("td")?.textContent ?? ""
    ).trim();
  const tab = document.querySelector<HTMLElement>("#tab-description");
  const lines: string[] = [];
  for (const block of tab?.querySelectorAll("p, li") ?? []) {
    const text = ((block as HTMLElement).innerText ?? "").trim();
    if (/^\d{4}\s/.test(text)) break;
    if (text) lines.push(text);
  }
  return {
    name: (document.querySelector("h1")?.textContent ?? "").trim(),
    sku: (document.querySelector(".sku")?.textContent ?? "").trim(),
    category: (document.querySelector('a[href*="/product-category/"]')?.textContent ?? "").trim(),
    attributes,
    description: lines.join("\n"),
  };
}

export const maker: MakerSource = {
  id: "propagate",
  role: "yeasts",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/product-sitemap.xml`);
    const urls = [
      ...sitemap.body.matchAll(/<loc>(https:\/\/propagatelab\.com\/product\/[^<]+)<\/loc>/g),
    ]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        // Nutrients, finings, lab services and kits have no fermentation attributes; sake and
        // seltzer cultures are not beer ingredients.
        if (!("flocculation" in page.attributes || "attenuation" in page.attributes)) continue;
        if (/sake|seltzer|wine|cider|mead/i.test(`${page.category} ${page.name}`)) continue;
        if (!page.name) {
          gaps.push({ url, reason: "no product name on the page" });
          continue;
        }
        const slugPart = new URL(url).pathname.split("/").filter(Boolean).at(-1)!;
        products.push({
          id: `propagate-${slugPart}`,
          role: "yeasts",
          manufacturer: "Propagate Lab",
          manufacturerAliases: ["Propagate", "Propagate Labs"],
          codes: page.sku ? [page.sku.toUpperCase()] : [],
          aliases: titleAliases(page.name, [], ["Yeast"]),
          flavorText: page.description,
          source: makerSource(source),
          souring: souringFromStated(`${page.category} ${page.name}`, page.description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
