import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://rahrmaltingco.com";

interface Page {
  readonly title: string;
  readonly summary: string;
  readonly specs: Record<string, string>;
  readonly paragraphs: readonly string[];
}

/** Rahr Malting Co. product pages (`/rahr-<name>/`, listed in `product-sitemap.xml`; the site is
 * run by RahrBSG, but the products are Rahr Malting's own): `h1.section-single-product__heading`,
 * an optional one-line `p.section-single-product__short-desc`, `.section-single-product__spec`
 * rows (`-spec-key` such as "Color (SRM)" with `-spec-value`) and the description paragraphs in
 * `.section-single-product__description`, the last of which is the "Info Sheet" link. There is
 * no separate flavour field: the character is stated inside the description. */
function readPage(): Page {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "")
      .replace(/\u00AD/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const specs: Record<string, string> = {};
  for (const spec of document.querySelectorAll(".section-single-product__spec"))
    specs[text(spec.querySelector(".section-single-product__spec-key")).toLowerCase()] = text(
      spec.querySelector(".section-single-product__spec-value"),
    );
  return {
    title: text(document.querySelector("h1.section-single-product__heading")),
    summary: text(document.querySelector("p.section-single-product__short-desc")),
    specs,
    paragraphs: [...document.querySelectorAll(".section-single-product__description p")]
      .filter((paragraph) => paragraph.querySelector("a") === null)
      .map(text)
      .filter((paragraph) => paragraph !== ""),
  };
}

/** The description paragraphs keep only the sentences that state a flavour, aroma, taste,
 * sweetness, character, note, profile or attribute. That drops the slogans ("Rahr To Thee Pils is
 * our toast to the generations of brewers" is not toasty) and the process and usage text, and a
 * sentence comparing the malt with another Rahr malt is dropped because its words describe the
 * other malt ("the more grainy & cracker attributes found in Rahr Premium Pils"). */
const FLAVOR_CUE =
  /\b(?:flavou?rs?|aromas?|tastes?|tasting|sweetness|character|notes?|profile|overtones|attributes)\b/i;
const COMPARISON = /\b(?:compared (?:to|with)|different from)\b/i;
function flavorSentences(paragraphs: readonly string[]): string[] {
  return paragraphs
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
        .filter((sentence) => FLAVOR_CUE.test(sentence) && !COMPARISON.test(sentence))
        .join(" "),
    )
    .filter((paragraph) => paragraph !== "");
}

export const maker: MakerSource = {
  id: "rahr",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/product-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title === "") {
          gaps.push({ url, reason: "no product title in the page" });
          continue;
        }
        const text = flavorSentences([page.summary, ...page.paragraphs]);
        // Distilling malts say so and never mention beer or brewing.
        const description = [page.summary, ...page.paragraphs].join(" ");
        if (
          /distill|whisk(?:e)?y|spirit|bourbon/i.test(description) &&
          !/\b(?:beers?|brew\w*|ales?|lagers?)\b/i.test(description)
        )
          continue;
        const srm = page.specs["color (srm)"];
        products.push({
          id: `rahr-${slug(page.title.replace(/^Rahr /, ""))}`,
          role: "fermentables",
          manufacturer: "Rahr",
          manufacturerAliases: ["Rahr Malting Co.", "Rahr Malting"],
          codes: [],
          aliases: titleAliases(page.title, ["Rahr"]),
          flavorText: text.join("\n"),
          source: makerSource(source),
          limitations: srm === undefined ? [] : [`Maltster colour: ${srm} SRM.`],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
