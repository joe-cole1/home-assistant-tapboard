import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, souringFromStated, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://wyeastlab.com";

/** Wyeast product pages: `h2.headline` "Strain: 1056", `h3.subheadline` name, and a
 * `.description` block with "Species:" and "Profile:" (the flavour text) before "Used in:". */
function readPage() {
  const description = document.querySelector<HTMLElement>(".description")?.innerText ?? "";
  return {
    code: (document.querySelector("h2.headline")?.textContent ?? "")
      .replace(/^\s*strain:\s*/i, "")
      .trim(),
    name: (document.querySelector("h3.subheadline")?.textContent ?? "").trim(),
    species: /species:\s*([^\n]+)/i.exec(description)?.[1]?.trim() ?? "",
    profile: /profile:\s*([\s\S]*?)(?:\n\s*used in:|$)/i.exec(description)?.[1]?.trim() ?? "",
  };
}

export const maker: MakerSource = {
  id: "wyeast",
  role: "yeasts",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/product-sitemap.xml`);
    const urls = [
      ...sitemap.body.matchAll(/<loc>(https:\/\/wyeastlab\.com\/product\/[^<]+)<\/loc>/g),
    ]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (!page.code || !page.name) {
          gaps.push({ url, reason: "no strain code or name on the page" });
          continue;
        }
        products.push({
          id: `wyeast-${page.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          role: "yeasts",
          manufacturer: "Wyeast",
          manufacturerAliases: ["Wyeast Labs", "Wyeast Laboratories"],
          codes: [page.code],
          aliases: titleAliases(page.name, [], ["Yeast"]),
          flavorText: page.profile,
          source: makerSource(source),
          souring: souringFromStated(`${page.species} ${page.name}`, page.profile),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
