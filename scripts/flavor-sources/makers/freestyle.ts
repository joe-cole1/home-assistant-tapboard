import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopName, hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.freestylehops.com";
const LISTING = `${ORIGIN}/hop-varieties/`;
// Freestyle is a Nelson grower: the listing introduces "the hops that we grow", every page gives
// its Upper Moutere, Nelson address, and the Singles Collection sells "iconic New Zealand
// varieties".
const ORIGIN_NOTE = "Origin: New Zealand.";
// Products that are not one variety, in the site's own words: in-field and fruit blends ("our
// passion fruit blend", "an exciting new blend"), SubZero Hop Kief liquid hops and their fruit
// infusions, and a box of four varieties.
const NOT_A_VARIETY = /\bblend\b|hop kief|liquid (?:dry )?hops?\b|in one box/i;

/** The "Hops and SubZero Hop Kief®" listing: one `.varietal-card` per product with an
 * `h4.card-title` "Freestyle Nelson Sauvin", a short aroma summary in `p small` and a "View"
 * link to the product page. */
function readCards(): { title: string; summary: string; href: string }[] {
  return [...document.querySelectorAll(".varietal-card")].map((card) => ({
    title: (card.querySelector("h4.card-title")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    summary: (card.querySelector<HTMLElement>("p small")?.innerText ?? "").trim(),
    href: card.querySelector("a")?.getAttribute("href") ?? "",
  }));
}

/** A product page's `.typography` block: a "View In Webstore" link, then the description
 * (a lead `h5` and paragraphs on harvest timing, character and pairing). Lines that are only
 * a link are navigation, not description. */
function readDescription(): string[] {
  const block = document.querySelector<HTMLElement>(".typography");
  const links = new Set(
    [...(block?.querySelectorAll("a") ?? [])].map((link) => (link.textContent ?? "").trim()),
  );
  return (block?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !links.has(line));
}

export const maker: MakerSource = {
  id: "freestyle",
  role: "hops",
  async read(limit) {
    const listing = await fetchSource(LISTING);
    const cards = (await inDom(listing.body, readCards)).slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const card of cards) {
      const url = new URL(card.href, LISTING).href;
      try {
        const source = await fetchSource(url);
        const description = await inDom(source.body, readDescription);
        if (NOT_A_VARIETY.test([card.title, card.summary, ...description].join("\n"))) continue;
        if (description.length === 0) {
          gaps.push({ url, reason: `no description for "${card.title}"` });
          continue;
        }
        // "Freestyle Nelson Sauvin" and "Nectaron® by Freestyle" are the variety under the
        // grower's own name; the pages call the hops "Nelson Sauvin" and "the Nectaron® varietal".
        const variety = card.title.replace(/^Freestyle\s+|\s+by Freestyle$/g, "");
        products.push(
          hopVariety(source, variety, [card.summary, ...description].filter(Boolean).join("\n"), {
            aliases: hopName(variety) === hopName(card.title) ? [] : [card.title],
            // The source hash covers the product page; the summary comes from the listing page.
            limitations: [
              ORIGIN_NOTE,
              ...(card.summary ? [`Aroma summary read from ${LISTING}.`] : []),
            ],
          }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
