import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://yakimachiefranches.com";
const BRANDS = `${ORIGIN}/create/brands/`;

/** The "Hop Brands" listing: one `.gallery-item` per brand, linking to its page, with an
 * `attr-N` class for each aroma in the "Filter by Aroma Profile" select (`#specialty`, whose
 * options map `.attr-N` to "Citrus", "Stone Fruit", …). */
function readBrands(): { href: string; aromas: string[] }[] {
  const labels = new Map(
    [...document.querySelectorAll("#specialty option")]
      .filter((option) => option.getAttribute("value")?.startsWith(".attr-"))
      .map((option) => [option.getAttribute("value")!.slice(1), (option.textContent ?? "").trim()]),
  );
  return [...document.querySelectorAll(".gallery-wrapper .gallery-item")].map((item) => ({
    href: item.querySelector("a")?.getAttribute("href") ?? "",
    aromas: [...item.classList].flatMap((name) => labels.get(name) ?? []),
  }));
}

/** A brand page: `h1` "Simcoe® Brand YCR 14", then paragraphs (a `<br>`-separated pair in
 * Krush's, a pasted `div` in Talus's): the description (release history and character together),
 * sometimes a breeding-history paragraph ("Originally bred in 2016, …") and a "For more
 * information on purchasing" line, which are never read. The "Field Notes" table (yield, acids,
 * oils, storage) is never read. */
function readBrand(): { title: string; paragraphs: string[] } {
  const heading = document.querySelector("h1");
  return {
    title: (heading?.textContent ?? "").replace(/\s+/g, " ").trim(),
    paragraphs: [
      ...(heading?.parentElement?.querySelectorAll<HTMLElement>(":scope > :is(p, div)") ?? []),
    ]
      .flatMap((block) => block.innerText.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^(?:for more information|originally bred)/i.test(line)),
  };
}

export const maker: MakerSource = {
  id: "ycr",
  role: "hops",
  async read(limit) {
    const listing = await fetchSource(BRANDS);
    const brands = (await inDom(listing.body, readBrands)).slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const { href, aromas } of brands) {
      const url = new URL(href, BRANDS).href;
      try {
        const source = await fetchSource(url);
        const { title, paragraphs } = await inDom(source.body, readBrand);
        if (!title || paragraphs.length === 0) {
          gaps.push({ url, reason: "no brand heading or description" });
          continue;
        }
        // "Simcoe® Brand YCR 14", "TerraFlux HBC 682": the brand name, then the breeder's code
        // for the same variety.
        const named = /^(.+?)\s+(?:Brand\s+)?((?:YCR|HBC|J)\s+\d+)$/.exec(title);
        // The listing's aroma tags are the brand's aroma profile (the page has no tag list).
        // They follow the description, whose more specific words then come first.
        const text = [...paragraphs, aromas.join(", ")].filter(Boolean).join("\n");
        products.push(
          hopVariety(source, named?.[1] ?? title, text, {
            aliases: named ? [named[2]!] : [],
            // The source hash covers the brand page; the tags come from the listing page.
            limitations: aromas.length ? [`Aroma tags read from ${BRANDS}.`] : [],
          }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
