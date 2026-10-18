import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://indiehops.com";
// Every page's menu lists Indie Hops' own varieties, then "We also offer classic varieties that
// excel in Oregon terroir"; the variety pages credit Oregon State University with the breeding.
const ORIGIN_NOTE = "Origin: Oregon, United States.";

interface Page {
  readonly title: string;
  readonly profile: readonly string[];
  /** The "FORMS" entry that is this page's own product, when the page lists forms. */
  readonly form: string | null;
}

/** Indie Hops variety pages (`hops` posts): in `.hop-overview-info`, an `h1.hop-title-single`
 * "Strata" (Strata CGX's title is two spans), an `h4.hop-subtitle-single` "BREWING PROFILE"
 * followed by the profile paragraph, and for varieties sold in several forms a "FORMS" list
 * whose entry for the page's own product links to `#hop-chem-pack-block`. The tasting-note
 * illustrations, "Brewing notes by beer style" tips, chemistry, "Origins" history, brewer
 * quotes and related products are never read. */
function readPage(): Page {
  const subtitle = document.querySelector(".hop-overview-info h4.hop-subtitle-single");
  const profile: string[] = [];
  let next = subtitle?.nextElementSibling;
  while (next?.tagName === "P") {
    profile.push((next as HTMLElement).innerText.trim());
    next = next.nextElementSibling;
  }
  const own = document.querySelector('.packs-overview a[href="#hop-chem-pack-block"]');
  return {
    title: (document.querySelector("h1.hop-title-single")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    profile: profile.filter((text) => text !== ""),
    form: own ? (own.textContent ?? "").trim() : null,
  };
}

export const maker: MakerSource = {
  id: "indie-hops",
  role: "hops",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/hops-sitemap.xml`);
    if (!sitemap.body.includes("<urlset")) throw new Error(`${sitemap.url} is not a sitemap`);
    const urls = [...sitemap.body.matchAll(/<loc>(https:\/\/indiehops\.com\/hops\/[^<]+)<\/loc>/g)]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        // Cryogenic lupulin pellets and hop-oil extracts are other forms of a variety that has
        // its own page; only the T90 and whole-cone page describes the variety itself.
        if (page.form && /lupulin|cryo|extract|oil/i.test(page.form)) continue;
        if (!page.title || page.profile.length === 0) {
          gaps.push({ url, reason: "no variety title or brewing profile" });
          continue;
        }
        // "US Fuggle" and "US Tettnanger" keep their printed names: the US Tettnanger page says
        // it is an Old English variety that US growers call Tettnanger.
        products.push(
          hopVariety(source, page.title, page.profile.join("\n"), { limitations: [ORIGIN_NOTE] }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
