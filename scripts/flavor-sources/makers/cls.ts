import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopName, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://clsfarms.com";

/** CLS Farms' site is one page (its sitemap lists only the home page). Its "Hops" section (an
 * `h2` "Hops" and the paragraph after it) names the farm's own varieties as links to their
 * brand sites, eldoradohops.com and neomexicanus.com, which are other sources; the page itself
 * describes no variety's aroma. Data sheets under /pdf/ are disallowed by robots.txt. */
function readPage() {
  const heading = [...document.querySelectorAll("h2")].find(
    (element) => (element.textContent ?? "").trim().toLowerCase() === "hops",
  );
  return [...(heading?.parentElement?.querySelectorAll("a[href^='http']") ?? [])]
    .map((link) => ({
      name: (link.textContent ?? "").replace(/[®™]/g, "").trim(),
      host: new URL(link.getAttribute("href")!).host,
    }))
    .filter(({ name, host }) => name !== "" && !host.endsWith("clsfarms.com"));
}

export const maker: MakerSource = {
  id: "cls",
  role: "hops",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const named = new Map((await inDom(source.body, readPage)).map((v) => [v.name, v.host]));
        for (const [name, host] of [...named].slice(0, limit))
          gaps.push({
            url,
            reason: `names ${hopName(name)} without describing its aroma; its page is on ${host}, another source`,
          });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
