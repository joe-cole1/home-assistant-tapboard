import type { ParsedProduct } from "../build.ts";
import { fetchSource, type CachedSource } from "../fetch.ts";
import { hopName, hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.barthhaas.com";

interface Page {
  readonly title: string;
  readonly origin: string;
  readonly tastes: readonly string[];
  readonly description: string;
  readonly profiles: readonly string[];
}

/** BarthHaas variety pages (`/hops-and-products/hops/<slug>`): a hero (`.hn__detail`) with the
 * key-flavour tags (`ul.section-card-text__tastes li`), the `h1` name "Citra®", the three-letter
 * variety code, the origin ("United States") and a description that mixes history and
 * character; then aroma tabs ("Aroma Profile", crop years such as "2023") whose paragraphs
 * describe the aroma (the aroma wheels are canvas charts), and "Analyses", "Ancestry" and
 * related products, which are never read. */
function readPage(): Page {
  const hero = document.querySelector<HTMLElement>(".hn__detail");
  const text = (element: Element | null | undefined) =>
    ((element as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
  return {
    title: text(hero?.querySelector("h1")),
    origin: text(hero?.querySelector("p.text-display-4")),
    tastes: [...(hero?.querySelectorAll(".section-card-text__tastes li") ?? [])]
      .map(text)
      .filter((taste) => taste),
    description: [...(hero?.querySelectorAll("p.text-copy-1") ?? [])]
      .map(text)
      .filter((paragraph) => paragraph)
      .join("\n"),
    profiles: [...document.querySelectorAll(".section-tabbar-tabs p.text-copy-1")]
      .map(text)
      .filter((paragraph) => paragraph),
  };
}

/** The page's own other names for the variety: an experimental code after the name in the
 * title ("TerraFlux™ HBC 682"), a cultivar code ("Loral® (HBC 291 c.v.)") and names introduced
 * as former or other names ("also known as Super Styrian Aurora", "formerly known as Pahto",
 * "originally known as 2011/02/04", "previous breeding number of 2013/017/107"). A name runs
 * over capitalised words, codes and trial numbers. */
function names(title: string, text: string): { printed: string; aliases: string[] } {
  const coded = /^(.+?[®™])\s+([A-Z]{2,}[ -]?\d+)$/.exec(title);
  const printed = coded ? coded[1]! : title;
  const aliases = coded ? [title, coded[2]!] : [];
  for (const match of text.matchAll(/\b([A-Z]{2,}[A-Z0-9]*[ -]?\d+) c\.\s?v\./g))
    aliases.push(match[1]!);
  for (const match of text.matchAll(
    /\b(?:[Aa]lso known as|[Ff]ormerly known as|[Ff]ormerly named|[Oo]riginally known as|previous breeding number of|named(?= [\d#]\S* as a trial))\s+([A-Z0-9#][\w#/-]*(?: [A-Z0-9][\w/-]*)*)/g,
  ))
    aliases.push(match[1]!);
  return { printed, aliases: [...new Set(aliases)] };
}

/** A tab paragraph that makes another variety of this source its subject ("…, Kazbek is equally
 * outstanding" on the Harmonie page) without naming the page's own variety is that variety's
 * text, published on the wrong page. */
function describesOther(text: string, own: string, others: readonly string[]): string | null {
  if (text.toLowerCase().includes(own.toLowerCase())) return null;
  return (
    others.find((other) =>
      new RegExp(
        `\\b${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[®™]?\\s+(?:is|has|offers|displays|presents)\\b`,
      ).test(text),
    ) ?? null
  );
}

export const maker: MakerSource = {
  id: "barthhaas",
  role: "hops",
  async read(limit) {
    const index = await fetchSource(`${ORIGIN}/sitemap.xml`);
    const pagesSitemap = /<loc>([^<]*sitemap=pages[^<]*)<\/loc>/.exec(index.body)?.[1];
    if (!pagesSitemap) throw new Error(`${index.url} lists no pages sitemap`);
    const sitemap = await fetchSource(pagesSitemap.replace(/&amp;/g, "&"));
    const urls = [
      ...new Set(
        [
          ...sitemap.body.matchAll(
            /<loc>(https:\/\/www\.barthhaas\.com\/hops-and-products\/hops\/[a-z0-9-]+)<\/loc>/g,
          ),
        ].map((match) => match[1]!),
      ),
    ].slice(0, limit);
    const gaps: { url: string; reason: string }[] = [];
    const read: { source: CachedSource; page: Page }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title) read.push({ source, page });
        else gaps.push({ url, reason: "no variety name on the page" });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const nameOf = (page: Page) => hopName(names(page.title, "").printed);
    const products: ParsedProduct[] = [];
    for (const { source, page } of read) {
      const own = nameOf(page);
      const others = read.map((other) => nameOf(other.page)).filter((name) => name !== own);
      const profiles = page.profiles.filter((profile) => {
        const other = describesOther(profile, own, others);
        if (other)
          gaps.push({ url: source.url, reason: `an aroma profile paragraph describes ${other}` });
        return !other;
      });
      const text = [page.description, ...profiles];
      const { printed, aliases } = names(page.title, text.join("\n"));
      products.push(
        hopVariety(
          source,
          printed,
          [page.tastes.join(", "), ...text].filter((part) => part).join("\n"),
          { aliases, limitations: page.origin ? [`Origin: ${page.origin}.`] : [] },
        ),
      );
    }
    return { products, gaps };
  },
};
