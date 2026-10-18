import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  inDom,
  makerSource,
  souringFromStated,
  titleAliases,
  type MakerSource,
  isBeerCulture,
} from "../maker.ts";

const ORIGIN = "https://www.imperialyeast.com";
const SPECIES = /\b(?:saccharomyces|brettanomyces|lactobacillus|pediococcus|lachancea) \w+/i;

interface Page {
  readonly name: string;
  readonly category: string;
  readonly code: string;
  readonly tags: readonly string[];
  readonly description: string;
}

/** Imperial strain pages put everything about the strain in the `<header>` around the `h1`
 * name: the category link (`h4` "Ales"), the code (`h2` "A38", "i10", "i-347") with one `p.link`
 * per tag ("Fruity", "Hazy", "Top Cropper"), the intro paragraph, then a prose block whose text
 * (paragraphs, or a bare text node) runs: the description, then "Pro Tip:", "For Best
 * Practices…", "Use & Handling:" and "Available In:", which are never read, nor is the
 * special-order note (✪). The facts grid, beer styles and similar strains sit outside the
 * header. */
function readPage(): Page {
  const header = document.querySelector("h1")?.closest("header");
  const text = (element: Element | null | undefined) => (element?.textContent ?? "").trim();
  const description: string[] = [text(header?.querySelector("p.intro"))];
  const prose = header?.querySelector<HTMLElement>(".prose-sm");
  for (const raw of (prose?.innerText ?? "").split("\n")) {
    const line = raw.split("✪")[0]!.trim();
    if (/^(pro tip|for best practices|use & handling|available in)/i.test(line)) break;
    description.push(line);
  }
  return {
    name: text(header?.querySelector("h1")),
    category: text(header?.querySelector("a h4")),
    code: text(header?.querySelector("h2")),
    tags: [...(header?.querySelectorAll("p.link") ?? [])].map(text),
    description: description.filter((line) => line !== "").join("\n"),
  };
}

export const maker: MakerSource = {
  id: "imperial",
  role: "yeasts",
  async read(limit) {
    const listing = await fetchSource(`${ORIGIN}/yeast-strains`);
    // Strain links have no query; `/yeast-strains/lagers?homebrewing=false` is a category.
    const urls = [
      ...new Set(
        [...listing.body.matchAll(/href="(\/yeast-strains\/[a-z0-9-]+)"/g)].map(
          (match) => `${ORIGIN}${match[1]!}`,
        ),
      ),
    ].slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (!/^[a-z]-?\d{2,3}$/i.test(page.code) || page.name === "") {
          gaps.push({ url, reason: `no strain code and name in the page header` });
          continue;
        }
        // Imperial says outright which wine, cider and seltzer strains are not for wort.
        if (
          !isBeerCulture(page.name, page.category) ||
          /does not recommend[^.]*\bwort\b/i.test(page.description)
        )
          continue;
        products.push({
          id: `imperial-${page.code.toLowerCase()}`,
          role: "yeasts",
          manufacturer: "Imperial Yeast",
          manufacturerAliases: ["Imperial"],
          // Brewfather's Imperial entries carry code and name together ("B56 Rustic") as the
          // product id for some strains.
          codes: [page.code, `${page.code} ${page.name}`],
          aliases: [...titleAliases(page.name), `${page.code} ${page.name}`],
          flavorText: [page.tags.join(", "), page.description].join("\n"),
          source: makerSource(source),
          // "Wild & Sour" holds Brettanomyces, Lactobacillus and Champion, "a wine yeast,
          // Saccharomyces bayanus": the species the description names first is the culture's
          // own. Every other category (Ales, Belgian, German, Lagers, Imperialis, Seasonal) is a
          // brewing yeast.
          souring:
            page.category === "Wild & Sour"
              ? souringFromStated(
                  `${page.name} ${SPECIES.exec(page.description)?.[0] ?? ""}`,
                  page.description,
                )
              : false,
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
