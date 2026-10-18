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

const ORIGIN = "https://www.lallemandbrewing.com";
const PRODUCTS = `${ORIGIN}/en/global/products/`;
// A strain withdrawn from the global site can still be listed regionally.
const REGIONS = ["global", "united-states", "canada", "united-kingdom", "continental-europe"];

/** The first regional page of a product that exists. */
async function productPage(name: string) {
  for (const region of REGIONS) {
    try {
      return await fetchSource(`${ORIGIN}/en/${region}/products/${name}/`);
    } catch (error) {
      if (!(error instanceof Error && / answered 404$/.test(error.message))) throw error;
    }
  }
  throw new Error(`${name} answered 404 in every region`);
}

/** Lallemand product pages: `h1` "LalBrew Nottingham™", the description block right after the
 * heading, and the "Quick facts" table ("Strain", "Aroma", "Beer styles", …). Beer styles are
 * never read. */
function readPage() {
  const facts: Record<string, string> = {};
  for (const row of document.querySelectorAll("#quick-facts tr")) {
    const [label, value] = [...row.querySelectorAll("th, td")].map((cell) =>
      (cell.textContent ?? "").trim(),
    );
    if (label) facts[label.toLowerCase()] = value ?? "";
  }
  const heading = document.querySelector("h1");
  return {
    title: (heading?.textContent ?? "").trim(),
    description: (
      (heading?.parentElement?.nextElementSibling as HTMLElement | null)?.innerText ?? ""
    ).trim(),
    facts,
  };
}

export const maker: MakerSource = {
  id: "lallemand",
  role: "yeasts",
  async read(limit) {
    // The category pages embed their full product lists; a few strains appear only in the
    // sitemap, so both are read. Every page is then checked for a stated strain.
    const slugs = new Set<string>();
    for (const category of ["brewing-yeast", "bacteria-for-brewing"]) {
      const page = await fetchSource(`${PRODUCTS}${category}/`);
      for (const match of page.body.matchAll(
        /https:\/\/www\.lallemandbrewing\.com\/en\/global\/products\/([a-z0-9-]+)\/"/g,
      ))
        slugs.add(match[1]!);
    }
    const sitemap = await fetchSource(`${ORIGIN}/sitemaps/sitemap_en.xml`);
    if (!sitemap.body.includes("<urlset")) throw new Error(`${sitemap.url} is not a sitemap`);
    for (const match of sitemap.body.matchAll(
      /<loc>https:\/\/www\.lallemandbrewing\.com\/en\/global\/products\/([a-z0-9-]+)\/?<\/loc>/g,
    ))
      if (/yeast|lalbrew|wildbrew|sourvisiae/.test(match[1]!)) slugs.add(match[1]!);
    const candidates = [...slugs]
      .filter(
        (name) =>
          !/^(?:brewing-yeast|bacteria-for-brewing|nutrients|process-aids|enzymes|brewing-flavors|home-wine-yeast|sensory-kit|laboratory-media)$/.test(
            name,
          ),
      )
      .filter((name) => !/^lalvin-|medium/.test(name))
      .sort()
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const name of candidates) {
      const url = `${PRODUCTS}${name}/`;
      try {
        const source = await productPage(name);
        const page = await inDom(source.body, readPage);
        const strain = page.facts["strain"] ?? "";
        if (!strain) continue;
        const title = page.title.replace(/[\u2010-\u2014]/g, "-").replace(/\s+/g, " ");
        products.push({
          id: `lallemand-${slug(title.replace(/^(?:lalbrew|wildbrew)\s*[®™]?\s*/i, ""))}`,
          role: "yeasts",
          manufacturer: "Lallemand",
          manufacturerAliases: ["Lallemand Brewing", "LalBrew", "Danstar"],
          codes: [],
          aliases: titleAliases(title, ["LalBrew", "WildBrew"], ["Yeast"]),
          flavorText: [page.facts["aroma"] ?? "", page.description].join("\n"),
          source: makerSource(source),
          souring: souringFromStated(`${strain} ${title}`, page.description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
