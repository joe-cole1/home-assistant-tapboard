import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  inDom,
  makerSource,
  souringFromStated,
  titleAliases,
  type MakerSource,
  isBeerCulture,
} from "../maker.ts";

const ORIGIN = "https://www.jasperyeast.com";

/** Jasper strain pages: `h1` "JY215 - Chico Ale", the description in `.trix-content`, and the
 * category in the breadcrumb link to `/styles/<n>-<category>` (the site menu links there too). */
function readPage() {
  return {
    title: (document.querySelector("h1")?.textContent ?? "").trim(),
    description: (document.querySelector<HTMLElement>(".trix-content")?.innerText ?? "").trim(),
    category: (
      document.querySelector('p.text-underline-div-none a[href^="/styles/"]')?.textContent ?? ""
    ).trim(),
  };
}

export const maker: MakerSource = {
  id: "jasper",
  role: "yeasts",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/sitemap.xml`);
    const urls = [
      ...sitemap.body.matchAll(/<loc>(https:\/\/www\.jasperyeast\.com\/yeasts\/[^<]+)<\/loc>/g),
    ]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    // A few strains are listed at two addresses with the same text; the first is kept.
    const seen = new Set<string>();
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        // Codes are "JY215", "JY-Lplant" for bacteria and "NA304" for non-alcoholic strains.
        const code = /^((?:JY|NA)-?[a-z]*\d*)\s+[-–]\s+(.+)$/i.exec(page.title);
        if (!code) {
          gaps.push({ url, reason: `no Jasper code in title "${page.title}"` });
          continue;
        }
        const category = page.category.toLowerCase();
        if (!isBeerCulture(category, page.title)) continue;
        const [, jy, name] = code as unknown as [string, string, string];
        if (seen.has(jy.toUpperCase())) continue;
        seen.add(jy.toUpperCase());
        products.push({
          id: `jasper-${jy.toLowerCase()}`,
          role: "yeasts",
          manufacturer: "Jasper",
          manufacturerAliases: ["Jasper Yeast"],
          codes: [jy.toUpperCase()],
          aliases: [...titleAliases(name, [], ["Yeast"]), `${jy.toUpperCase()} ${name}`],
          flavorText: page.description,
          source: makerSource(source),
          // Jasper groups souring cultures as Bacteria, Brettanomyces and Quick Sour; its other
          // groups are ordinary brewing yeasts, except "Special Strains", where the name decides.
          souring: /bacteria|brettanomyces|quick sour/.test(category)
            ? true
            : /special/.test(category)
              ? souringFromStated(name, page.description)
              : category
                ? false
                : null,
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
