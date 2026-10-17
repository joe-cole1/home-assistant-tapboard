import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  inDom,
  makerSource,
  slug,
  souringFromStated,
  titleAliases,
  type MakerSource,
} from "../maker.ts";

const ORIGIN = "https://fermentis.com";

/** Fermentis product pages: `h1` "SafAle US‑05™", the breadcrumb ("Beer & brewing solutions /
 * …"), and a Description tab whose top-level blocks run: tagline heading, description,
 * "Ingredients: Yeast (Saccharomyces cerevisiae)…", an overview grid, then "… sensory profile"
 * with its paragraph, then technical features, which are never read. */
function readPage() {
  const description: string[] = [];
  const sensory: string[] = [];
  let ingredients = "";
  let section = "description";
  for (const block of document.querySelector("#tab-description")?.children ?? []) {
    const heading = block.querySelector("h2, h3");
    if (block.classList.contains("section-title-container") && heading) {
      const title = (heading.textContent ?? "").toLowerCase();
      section = /sensory profile/.test(title)
        ? "sensory"
        : block.querySelector("h2")
          ? "description"
          : "other";
      continue;
    }
    if (block.tagName !== "P") continue;
    const text = ((block as HTMLElement).innerText ?? "").trim();
    if (/^ingredients\s*:/i.test(text)) ingredients = text;
    else if (text && section === "description") description.push(text);
    else if (text && section === "sensory") sensory.push(text);
  }
  return {
    title: (document.querySelector("h1")?.textContent ?? "").trim(),
    breadcrumb: (
      document.querySelector(".woocommerce-breadcrumb, .breadcrumbs")?.textContent ?? ""
    ).trim(),
    description: description.join("\n"),
    sensory: sensory.join("\n"),
    ingredients,
  };
}

export const maker: MakerSource = {
  id: "fermentis",
  role: "yeasts",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/product-sitemap.xml`);
    const urls = [
      ...sitemap.body.matchAll(/<loc>(https:\/\/fermentis\.com\/en\/product\/[^<]+)<\/loc>/g),
    ]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        // Wine, cider, spirits, coffee and process aids are not beer cultures; beer cultures
        // state their organism under "Ingredients".
        if (!/beer/i.test(page.breadcrumb) || !page.ingredients) continue;
        // Fermentis prints non-breaking hyphens ("US‑05"); brewers type plain ones.
        const title = page.title.replace(/[\u2010-\u2014]/g, "-").replace(/\s+/g, " ");
        const core = title
          .replace(/[®™]/g, "")
          .replace(/^saf\w+\s+/i, "")
          .trim();
        const code = /^[a-z]{1,3}[- ]?\d+(?:[-/]\d+)?$/i.test(core) ? core.toUpperCase() : null;
        products.push({
          id: `fermentis-${slug(core)}`,
          role: "yeasts",
          manufacturer: "Fermentis",
          manufacturerAliases: ["Fermentis by Lesaffre", "Lesaffre"],
          codes: code ? [code] : [],
          aliases: titleAliases(title, ["SafAle", "SafLager", "SafBrew", "SafSour"]),
          flavorText: [page.description, page.sensory].join("\n"),
          source: makerSource(source),
          souring: souringFromStated(`${page.ingredients} ${title}`, page.description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
