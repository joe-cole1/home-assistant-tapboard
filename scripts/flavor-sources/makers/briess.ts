import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://brewingwithbriess.com";

interface Article {
  readonly id: string;
  readonly title: string;
  readonly flavor: string;
  readonly description: readonly string[];
  readonly srm: string;
}

/** The side menu of the all-products page links the brewing categories (`/products/<category>/`).
 * Briess keeps its craft-distilling products in a separate `/craft-distilling/` tree. */
function readCategories(): string[] {
  const links = [...document.querySelectorAll("aside .side-nav-container a.nav-link")]
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => /\/products\/[a-z0-9-]+\/$/.test(href));
  return [...new Set(links)];
}

/** Product ids on a category page. */
function readArticleIds(): string[] {
  return [...document.querySelectorAll("article.product")].map((article) => article.id);
}

/** Every product is an `article.product` on the all-products page (the same markup appears on each
 * category page). `.product-top` holds the `h3.product-title` and one bold line of flavour tags
 * ("Clean, sweet, mild malty"); `.product-description` holds the character paragraph, which often
 * ends in a use or beer-style sentence. The analysis boxes (`.product-typical-analysis`, with the
 * colour in `.data-box-filled.srm`) and the "Usage Levels / Beer Styles" table are never read as
 * flavour text. */
function readArticles(): Article[] {
  const text = (element: Element | null) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  return [...document.querySelectorAll("article.product")].map((article) => ({
    id: article.id,
    title: text(article.querySelector(".product-title")),
    flavor: text(article.querySelector(".product-top b")),
    description: (article.querySelector<HTMLElement>(".product-description")?.innerText ?? "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line !== ""),
    srm: text(article.querySelector(".data-box-filled.srm .value")),
  }));
}

/** The description paragraphs keep only the sentences that state a flavour, aroma, taste,
 * sweetness, character, note or maltiness, minus plain instructions for use ("It can be used in
 * all extract beer styles to adjust color, flavor, and gravity"). Two things are removed inside
 * the kept sentences because the extractor would read them as flavours: the drum-roasting
 * process ("a drum roasted crystallized malt" is not a roasty one, while "dry roasted flavors"
 * stays) and colour names ("golden amber leaning toward orange hues" is not orange fruit). */
const FLAVOR_CUE =
  /\b(?:flavou?rs?|aromas?|tastes?|tasting|sweetness|character|notes?|maltiness)\b/i;
const INSTRUCTION =
  /\b(?:can|may) (?:also )?be (?:used|added|incorporated)\b|\bis (?:often|frequently) used\b|^use\b|\byou can (?:use|add)\b/i;
const PROCESS = /\bdrum[- ]roast(?:ed|ing)\b|\broasted(?= process\b)/gi;
const COLOR_NAMES =
  /\b(?:(?:gold(?:en)?|amber|orange|red|brown|copper|straw|mahogany|yellow)(?:\/[a-z]+)?,? (?:and )?)+(?=hues?\b|tones?\b|colou?rs?\b)/gi;
function flavorSentences(paragraphs: readonly string[]): string[] {
  return paragraphs
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
        .filter((sentence) => FLAVOR_CUE.test(sentence) && !INSTRUCTION.test(sentence))
        .map((sentence) =>
          sentence.replace(PROCESS, "").replace(COLOR_NAMES, "").replace(/\s+/g, " ").trim(),
        )
        .join(" "),
    )
    .filter((paragraph) => paragraph !== "");
}

export const maker: MakerSource = {
  id: "briess",
  role: "fermentables",
  async read(limit) {
    const listing = await fetchSource(`${ORIGIN}/products/`);
    const gaps: { url: string; reason: string }[] = [];
    // A product is for brewing when it is on one of the brewing category pages. The all-products
    // page also lists the distilling-only malts, flours and raw grains.
    const brewing = new Set<string>();
    for (const category of await inDom(listing.body, readCategories)) {
      try {
        const page = await fetchSource(category);
        for (const id of await inDom(page.body, readArticleIds)) brewing.add(id);
      } catch (error) {
        gaps.push({
          url: category,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const products: ParsedProduct[] = [];
    for (const article of (await inDom(listing.body, readArticles))
      .filter(({ id }) => brewing.has(id))
      .slice(0, limit)) {
      if (article.title === "") {
        gaps.push({ url: `${ORIGIN}/products/#${article.id}`, reason: "no product title" });
        continue;
      }
      products.push({
        id: `briess-${slug(article.title)}`,
        role: "fermentables",
        manufacturer: "Briess",
        manufacturerAliases: [
          "Briess Malt & Ingredients",
          "Briess Malt & Ingredients Co.",
          "Briess Malt & Ingredients Company",
        ],
        codes: [],
        aliases: titleAliases(article.title),
        flavorText: [article.flavor, ...flavorSentences(article.description)].join("\n"),
        source: { ...makerSource(listing), url: `${ORIGIN}/products/#${article.id}` },
        limitations: article.srm === "" ? [] : [`Maltster colour: ${article.srm} SRM.`],
      });
    }
    return { products, gaps };
  },
};
