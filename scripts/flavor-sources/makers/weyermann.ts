import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.weyermann.de";
// The international site is the main source; the USA & Canada site sells the same range under a
// few other names (CARAFOAM® for CARAPILS®) and adds Brewing Malt Type Cologne.
const BRAND = ["Weyermann"];
const LISTINGS = [`${ORIGIN}/en-gb/products/brewery/`, `${ORIGIN}/en-us/products-2/brewery-2/`];

/** The brewery listing is a `.av-portfolio_sitemap` of `li.post` links grouped by category. A
 * product listed under two categories (CARAWHEAT®, CARABELGE®) has two links to one page. The
 * `?cat=` query only sets the breadcrumb, and a `*` marks "available in organic quality". */
function readListing(): { href: string; name: string }[] {
  return [...document.querySelectorAll<HTMLAnchorElement>(".av-portfolio_sitemap li.post a")].map(
    (link) => ({
      href: link.href.split("?")[0]!,
      name: (link.textContent ?? "")
        .replace(/\s*\*$/, "")
        .replace(/\s+/g, " ")
        .trim(),
    }),
  );
}

interface Page {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

/** Product pages put the title in an `h2.av-special-head...` and the product text in the one
 * `section.av_textblock_section` that holds the colour line (a tagline block such as "made from
 * dehusked barley" can come before it). Its paragraphs run: the description; "Sensory:", the
 * flavour field (the diastatic malt calls it "properties and flavors:"); the usage line and the
 * beer-style list, which are never read; "Recommended addition", "Enzyme activity" and "Color:".
 * Malt extracts have the description, the process, a taste-and-appearance comparison with a
 * beer style, the style list and "Color in 13% wort:". */
function readPage(): Page {
  const main = document.querySelector<HTMLElement>("#main");
  const block = [
    ...(main?.querySelectorAll<HTMLElement>("section.av_textblock_section") ?? []),
  ].find((section) => /^(?:sensory|colou?r)\b/im.test(section.innerText));
  return {
    title: (main?.querySelector(".av-special-heading-tag")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    paragraphs: (block?.innerText ?? "")
      .trim()
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim()),
  };
}

const FLAVOUR_FIELD = /(?:^|\s)(?:sensory|properties and flavou?rs)\b:?\s*([^\n]*)/i;
const CHARACTER = /\b(?:aroma\w*|tast\w*|flavou?r\w*|notes?)\b/i;

/** The flavour field plus the sentences of the description that speak of aroma, taste, flavour or
 * notes. The description mixes character ("the dark caramel notes", "a fine, sweet malt aroma")
 * with process ("a complete caramelization within the grain"), colour and use, so only its
 * character sentences count; LME SINAMAR®, a colour extract, has none. */
function flavourText(paragraphs: readonly string[]): string {
  const field = FLAVOUR_FIELD.exec(paragraphs.join("\n"))?.[1]?.trim() ?? "";
  // The Cologne malt runs "Sensory: …" on in the same paragraph as its description.
  const description = (paragraphs[0] ?? "").split(/\s*\bsensory\b/i)[0]!;
  return [
    ...description.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((sentence) => CHARACTER.test(sentence)),
    field,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** "Color:" (or "Color in 13% wort:" for extracts) and the EBC and Lovibond lines below it. */
function colour(paragraphs: readonly string[]): string | null {
  const match = /^(colou?r[^:\n]*):?\s*([\s\S]*)$/i.exec(
    paragraphs.find((paragraph) => /^colou?r\b/i.test(paragraph)) ?? "",
  );
  if (!match) return null;
  const value = match[2]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
  return value === ""
    ? null
    : `Maltster ${match[1]!.trim().replace(/^colou?r/i, "colour")}: ${value}.`;
}

export const maker: MakerSource = {
  id: "weyermann",
  role: "fermentables",
  async read(limit) {
    const gaps: { url: string; reason: string }[] = [];
    const listed: { href: string; name: string }[] = [];
    for (const listing of LISTINGS) {
      try {
        const source = await fetchSource(listing);
        // A product the first site already lists is the same product on the other site.
        const known = new Set(listed.map((item) => item.name));
        for (const item of await inDom(source.body, readListing))
          if (!known.has(item.name) && !listed.some((seen) => seen.href === item.href))
            listed.push(item);
      } catch (error) {
        gaps.push({ url: listing, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const products: ParsedProduct[] = [];
    for (const item of listed.slice(0, limit)) {
      try {
        const source = await fetchSource(item.href);
        const page = await inDom(source.body, readPage);
        if (page.title === "" || page.paragraphs.join("") === "") {
          gaps.push({ url: item.href, reason: "no product title or text block on the page" });
          continue;
        }
        // "Abbey Malt® (Biscuit Malt)": the title also gives the product's other name.
        const other = /\(([^)]+)\)$/.exec(page.title)?.[1];
        const note = colour(page.paragraphs);
        products.push({
          id: `weyermann-${slug(titleAliases(item.name, BRAND).at(-1)!)}`,
          role: "fermentables",
          manufacturer: "Weyermann",
          manufacturerAliases: [
            "Weyermann Specialty Malts",
            "Weyermann Specialty Malting",
            "Weyermann Spezialmalze",
            "Weyermann Malt",
            "Malzfabrik Weyermann",
          ],
          codes: [],
          aliases: [
            ...new Set([
              ...titleAliases(item.name, BRAND),
              ...titleAliases(page.title, BRAND),
              ...(other ? [other] : []),
            ]),
          ],
          flavorText: flavourText(page.paragraphs),
          source: makerSource(source),
          limitations: note ? [note] : [],
        });
      } catch (error) {
        gaps.push({
          url: item.href,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { products, gaps };
  },
};
