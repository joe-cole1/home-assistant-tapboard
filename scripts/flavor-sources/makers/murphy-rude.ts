import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.murphyrudemalting.com";

interface Page {
  readonly title: string;
  readonly description: string;
}

/** Murphy & Rude product pages (Wix store): `h1[data-hook=product-title]` and
 * `[data-hook=description]`, one block of text. For malts it is the character in a sentence or
 * two, then "Color: 40-42L" and "Grist: 5-15%" (on their own lines, or after the sentences on
 * one line), sometimes "RIYL: …" naming other makers' malts. The store also sells Greenmont hops
 * (their description ends "Flavor/Aroma: …  Alpha Acid: …") and merchandise, neither of which
 * states a colour. */
function readPage(): Page {
  return {
    title: (document.querySelector<HTMLElement>("h1")?.innerText ?? "").trim(),
    description: (
      document.querySelector<HTMLElement>("[data-hook=description]")?.innerText ?? ""
    ).trim(),
  };
}

/** The character text of a malt page without its specification lines, the colour it states, and
 * the name it was "Previously known as". */
function parseDescription(description: string): {
  text: string;
  colour: string | null;
  formerName: string | null;
} {
  const clean = description.replace(/[​ ]/g, " ");
  return {
    text: clean
      .split("\n")
      // Colour and grist are specifications, and RIYL ("recommended if you like") names other
      // makers' malts.
      .map((line) =>
        line
          .replace(/\bColors?:.*$/, "")
          .replace(/\bGrist:.*$/, "")
          .replace(/\bRIYL\b.*$/, "")
          .trim(),
      )
      .filter((line) => line !== "")
      .join("\n"),
    colour: /\bColors?:\s*([^;\n]+)/.exec(clean)?.[1]?.trim() ?? null,
    formerName: /Previously known as ([^,.\n]+)/.exec(clean)?.[1]?.trim() ?? null,
  };
}

export const maker: MakerSource = {
  id: "murphy-rude",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/store-products-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*\/product-page\/[^<]*)<\/loc>/g)].map(
      (match) => match[1]!,
    );
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      if (products.length >= (limit ?? Infinity)) break;
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        const { text, colour, formerName } = parseDescription(page.description);
        if (page.title === "") {
          gaps.push({ url, reason: "no product title on the page" });
          continue;
        }
        // Hops and merchandise state no colour.
        if (colour === null) continue;
        products.push({
          id: `murphy-rude-${slug(page.title)}`,
          role: "fermentables",
          manufacturer: "Murphy & Rude Malting Co.",
          manufacturerAliases: ["Murphy & Rude"],
          codes: [],
          aliases: [...new Set([...titleAliases(page.title), ...(formerName ? [formerName] : [])])],
          flavorText: text,
          source: makerSource(source),
          limitations: [`Maltster colour: ${colour}.`],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
