import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.simpsonsmalt.co.uk";
const BREWING_SECTIONS =
  /\/our-malts\/(?:base-malts|highly-kilned-malts|crystal-malts|roasted-malts|special-malts|unmalted-adjuncts)\/[a-z0-9-]+\/$/;

interface Page {
  readonly name: string;
  readonly title: string;
  readonly introduction: readonly string[];
  readonly flavours: string;
  readonly colours: readonly {
    readonly unit: string;
    readonly min: string;
    readonly max: string;
  }[];
}

/** Simpsons product pages (`/our-malts/<section>/<slug>/`) name the malt in the `h1` and
 * `<title>` (before its " | "). `#malt-page-intro` holds the descriptive paragraphs (character,
 * colour, comparisons with sister malts, usual use). Below the spec tabs, `.substyles-list`
 * blocks hold the beer-style links, then a plain list of flavour tags ("Grassy, Mild Toffee,
 * Sweet"), then the formats on offer ("Whole, Milled"), which unmalted adjuncts lack. Only the
 * flavour tags and the paragraphs (without their comparisons) are read. The EBC and ASBC spec tabs list `Colour ° EBC` and
 * `Colour ° Lovibond` rows with Min and Max cells. */
function readPage(): Page {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const tags = [...document.querySelectorAll(".substyles-list .links")]
    .filter((block) => block.querySelector("a") === null)
    .map(text)
    .filter((list) => !list.split(",").every((item) => /^(?:whole|milled)\b/i.test(item.trim())));
  return {
    name: text(document.querySelector("h1")),
    title: (document.title.split(" | ")[0] ?? "").trim(),
    introduction: [...document.querySelectorAll("#malt-page-intro .component-inner p")]
      .map(text)
      .filter((paragraph) => paragraph !== ""),
    flavours: tags[0] ?? "",
    colours: [...document.querySelectorAll("#ebc tr, #asbc tr")]
      .map((row) => [...row.querySelectorAll("td")].map(text))
      .filter((cells) => /^colou?r/i.test(cells[0] ?? ""))
      .map(([label, min, max]) => ({
        unit: label!.replace(/^colou?r\s*/i, "").replace(/°\s*/, "°"),
        min: min ?? "",
        max: max ?? "",
      })),
  };
}

/** Sentences opening with a comparison ("Compared to Munich Malt, …", "Against Maris Otter, …",
 * "Unlike our standard Malted Oats, …") describe the sister malts they name, so they are not
 * read. */
const COMPARISON_SENTENCE = /^(?:compared (?:to|with)|in comparison (?:to|with)|against|unlike)\b/i;
const ownSentences = (paragraphs: readonly string[]): string[] =>
  paragraphs
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !COMPARISON_SENTENCE.test(sentence))
        .join(" "),
    )
    .filter((paragraph) => paragraph !== "");

export const maker: MakerSource = {
  id: "simpsons",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*)<\/loc>/g)]
      .map((match) => match[1]!)
      .filter((url) => BREWING_SECTIONS.test(url))
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.name === "") {
          gaps.push({ url, reason: "no product name in the page" });
          continue;
        }
        const colour = page.colours.map(({ unit, min, max }) =>
          min && max ? `${min}–${max} ${unit}` : min ? `min ${min} ${unit}` : `max ${max} ${unit}`,
        );
        products.push({
          id: `simpsons-${slug(page.name)}`,
          role: "fermentables",
          manufacturer: "Simpsons Malt",
          manufacturerAliases: ["Simpsons", "Simpsons Malt Limited"],
          codes: [],
          aliases: [...new Set([...titleAliases(page.name), ...titleAliases(page.title)])],
          flavorText: [page.flavours, ...ownSentences(page.introduction)]
            .filter((line) => line !== "")
            .join("\n"),
          source: makerSource(source),
          limitations: colour.length ? [`Maltster colour: ${colour.join("; ")}.`] : [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
