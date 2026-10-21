import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.dingemansmout.be";
// Each malt is in its type's list; "Specialty Malts" repeats products of the other lists.
const LISTS = [
  "kilned-malts",
  "caramalized-malts",
  "roasted-malts",
  "organic-malts",
  "specialty-malts",
];

interface Page {
  readonly title: string;
  readonly description: string;
  readonly flavour: string;
  readonly colour: string;
}

/** Dingemans's own site (Drupal; robots.txt asks for a 10 s crawl delay). Each type list
 * (`/kilned-malts`, `/caramalized-malts`, `/roasted-malts`, `/organic-malts`) shows one
 * `div.node-teaser` per malt with `h2 > a[href^="/malt/"]`. A malt page is a `div.node-portfolio`
 * with `h1` "Special B® MD", the description in `.field-name-body` paragraphs (followed by a
 * "Request quote" button, not read), and fields: the key specifications `.field-name-field-flavour`
 * ("Heavy caramel taste, raisins, figs and toffee"), `-field-colour-ebc` and `-field-lovibond`,
 * `-field-usage` (beer styles) and `-field-rate-comment` (grain bill), and the technical
 * specifications including `-field-colour` ("270 - 350 EBC"). */
function readPage(): Page {
  const node = document.querySelector<HTMLElement>("div.node-portfolio:not(.node-teaser)");
  const value = (name: string) =>
    [...(node?.querySelectorAll(`.field-name-${name} .field-item`) ?? [])]
      .map((item) => (item as HTMLElement).innerText.replace(/\s+/g, " ").trim())
      .join("; ");
  return {
    title: (document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    description: [...(node?.querySelectorAll(".field-name-body p") ?? [])]
      .map((paragraph) => (paragraph as HTMLElement).innerText.replace(/\s+/g, " ").trim())
      .filter((paragraph) => paragraph !== "")
      .join("\n"),
    flavour: value("field-flavour"),
    colour: value("field-colour"),
  };
}

export const maker: MakerSource = {
  id: "dingemans",
  role: "fermentables",
  async read(limit) {
    const paths = new Set<string>();
    const gaps: { url: string; reason: string }[] = [];
    for (const list of LISTS) {
      const url = `${ORIGIN}/${list}`;
      try {
        const source = await fetchSource(url);
        for (const match of source.body.matchAll(/<h2><a href="(\/malt\/[^"]+)">/g))
          paths.add(match[1]!);
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const products: ParsedProduct[] = [];
    for (const path of [...paths].slice(0, limit)) {
      const url = `${ORIGIN}${path}`;
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title === "") {
          gaps.push({ url, reason: "no product title on the page" });
          continue;
        }
        // "Cara 50 MD is also known as Cara Vienna": the maltster's own second name.
        const alsoKnown = /\balso known as ([^.,]+)/i.exec(page.description)?.[1]?.trim();
        products.push({
          id: `dingemans-${slug(page.title)}`,
          role: "fermentables",
          manufacturer: "Dingemans",
          manufacturerAliases: ["Mouterij Dingemans"],
          codes: [],
          // "MD" is Mouterij Dingemans's mark on every product name.
          aliases: [
            ...new Set([
              ...titleAliases(page.title, [], ["MD"]),
              ...(alsoKnown ? [alsoKnown] : []),
            ]),
          ],
          flavorText: [page.flavour, page.description].filter((part) => part !== "").join("\n"),
          source: makerSource(source),
          limitations: page.colour ? [`Maltster colour: ${page.colour}.`] : [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
