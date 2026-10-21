import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.greatwesternmalting.com";

interface Page {
  readonly category: string;
  readonly name: string;
  readonly flavor: string;
  readonly paragraphs: readonly string[];
  readonly color: string;
}

/** Great Western product pages (`/product/<slug>/`): `h2.category` ("Base Malts", "Specialty
 * Malts", "Crystal Malts", "Identity Preserved Malts", "Specialty Grains", "Distilling Malts"),
 * `h1.name`, a marketing paragraph (`p.description`) and a second paragraph (`p.additional`) that
 * often says what the malt contributes, then a `.stats-table` of `p.attribute` facts ("Color SRM",
 * "Color Profile" for appearance, "Inclusion Rate"), `p.flavor` ("FLAVOR PROFILE: Sweet, clean,
 * smooth") and `p.typical` ("TYPICAL USES", which is never read). */
function readPage(): Page {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const flavor = document.querySelector("p.flavor");
  const color = [...document.querySelectorAll(".stats-table p.attribute")].find((attribute) =>
    /^color srm$/i.test(text(attribute.querySelector(".title"))),
  );
  return {
    category: text(document.querySelector("h2.category")),
    name: text(document.querySelector("h1.name")),
    flavor: text(flavor)
      .replace(text(flavor?.querySelector(".title")), "")
      .trim(),
    paragraphs: [...document.querySelectorAll("p.description, p.additional")]
      .map(text)
      .filter((paragraph) => paragraph !== ""),
    color: text(color)
      .replace(text(color?.querySelector(".title")), "")
      .trim(),
  };
}

/** The two paragraphs keep only the sentences that state a flavour, aroma, taste, sweetness,
 * character, note or complexity, which leaves out the slogans, the sourcing story and
 * the Pink Boots mission text. A sentence about the crystal line as a whole ("a range of flavors
 * from soft and sweet caramel to dark toffee") is not about one malt, and the drum-roasting
 * process ("is roasted inside custom-designed drums") is not a flavour. */
const FLAVOR_CUE = /\b(?:flavou?rs?|aromas?|tastes?|sweetness|characters?|notes?|complexity)\b/i;
const WHOLE_LINE = /\bline of malts\b/i;
const PROCESS = /\broasted(?= inside\b)/gi;
function flavorSentences(paragraphs: readonly string[]): string[] {
  return paragraphs
    .map((paragraph) =>
      paragraph
        .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
        .filter((sentence) => FLAVOR_CUE.test(sentence) && !WHOLE_LINE.test(sentence))
        .map((sentence) => sentence.replace(PROCESS, "").replace(/\s+/g, " ").trim())
        .join(" "),
    )
    .filter((paragraph) => paragraph !== "");
}

export const maker: MakerSource = {
  id: "great-western",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/product-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*\/product\/[^<]+)<\/loc>/g)]
      .map((match) => match[1]!)
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
        if (page.category === "Distilling Malts") continue;
        products.push({
          id: `great-western-${slug(page.name)}`,
          role: "fermentables",
          manufacturer: "Great Western",
          manufacturerAliases: ["Great Western Malting"],
          codes: [],
          aliases: titleAliases(page.name, [], ["Malt"]),
          flavorText: [page.flavor, ...flavorSentences(page.paragraphs)].join("\n"),
          source: makerSource(source),
          limitations: page.color === "" ? [] : [`Maltster colour: ${page.color} SRM.`],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
