import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, shopifyProducts, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://nzhops.co.nz";
/** Sections of a variety description that say what the hop smells and tastes like. */
const FLAVOUR_SECTIONS = new Set(["intro", "selection", "brewing"]);

/** NZ Hops variety descriptions (Shopify `body_html`, shown on the product page): an `h3` alpha
 * range "(10-13 % AA)", a one-line character statement (sometimes two), then `h2` (once `h3`)
 * sections "Breeding" (lineage, release history and the breeding code), "Selection" (what
 * selectors smell), "Brewing" (use and character, with pull quotes and brewer testimonials),
 * "Applications" (beer styles and hop pairings), organic certification and "Resources"
 * (downloads, analytics). Returns each paragraph with its section. */
function readSections(): { section: string; text: string }[] {
  const paragraphs: { section: string; text: string }[] = [];
  let section = "intro";
  for (const element of document.body.querySelectorAll<HTMLElement>("h2, h3, p")) {
    const text = element.innerText.replace(/\s+/g, " ").trim();
    if (element.tagName === "P") {
      if (text) paragraphs.push({ section, text });
    } else if (text && !/^\(.*AA\)$/i.test(text)) {
      // Empty headings are spacing and the alpha range is not a section; neither ends one.
      section = text.replace(/:$/, "").trim().toLowerCase();
    }
  }
  return paragraphs;
}

/** Pull quotes ("'A brewery workhorse'") and brewer testimonials ("…” says Mike Sutherland"). */
const isQuote = (text: string) => /^["“'‘–—]/.test(text) || /["”]\s*says\b/.test(text);

/** Other names the Breeding section gives the variety: its breeding or trial code ("Brand
 * HORT4337", "Trial Hop • NZH-102") and a former release name ("released in 1976 as Super
 * Alpha"). Bare selection numbers ("Brand 85-03-06") and the US accession of a parent cultivar
 * ("USDA 56013") are not names. */
function breedingAliases(breeding: string): string[] {
  const codes = [...breeding.matchAll(/\b(?:HORT|NZH-)\d+\b/g)].map((match) => match[0]);
  const former = [
    ...breeding.matchAll(/\b[Rr]eleased\b[^.]*?\bas ((?:[A-Z][\w-]*)(?: [A-Z][\w-]*)*)/g),
  ].map((match) => match[1]!);
  return [...codes, ...former];
}

export const maker: MakerSource = {
  id: "nz-hops",
  role: "hops",
  async read(limit) {
    // Hops carry use tags ("aroma", "alpha", "dual purpose"); the store also sells yeast.
    const listed = (await shopifyProducts(ORIGIN))
      .filter(({ product }) =>
        product.tags.some((tag) => /^(?:aroma|alpha|dual purpose)$/i.test(tag)),
      )
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const { product } of listed) {
      const url = `${ORIGIN}/products/${encodeURIComponent(product.handle)}`;
      try {
        // The product page shows this description; its hash records what was read.
        const source = await fetchSource(url);
        const sections = await inDom(`<body>${product.body_html ?? ""}</body>`, readSections);
        if (!sections.length) {
          gaps.push({ url, reason: "the product has no description" });
          continue;
        }
        const flavour = sections
          .filter(({ section, text }) => FLAVOUR_SECTIONS.has(section) && !isQuote(text))
          .map(({ text }) => text);
        const breeding = sections
          .filter(({ section }) => section === "breeding")
          .map(({ text }) => text)
          .join(" ");
        products.push(
          hopVariety(source, product.title, flavour.join("\n"), {
            // "NZ Southern Cross™" is Southern Cross grown in New Zealand.
            aliases: [...titleAliases(product.title, ["NZ"]), ...breedingAliases(breeding)],
            limitations: product.tags.some((tag) => tag.toLowerCase() === "nz")
              ? ["Origin: New Zealand."]
              : [],
          }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
