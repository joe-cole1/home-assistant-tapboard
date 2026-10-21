import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.doubleeaglemalt.com";

interface Listed {
  readonly name: string;
  readonly colour: string;
  readonly description: string;
}

/** The Malt Portfolio page lists every malt as one `p.wp-block-paragraph` under an `h2` group
 * ("Signature Base Malts", "Alternate Grain Malts", "Kilned Malts", "Caramel Malts", "Roasted
 * Malts"). The paragraph's first line is the name and colour ("Pennypack Pils: 2.0 SRM"), then a
 * blank line and the description, sometimes ending "CURRENTLY OUT OF STOCK". Symphony's
 * description is the next paragraph instead. Other paragraphs (prices, notes, contract malting)
 * have no "name: colour SRM" first line. */
function readPortfolio(): Listed[] {
  const listed: Listed[] = [];
  for (const paragraph of document.querySelectorAll<HTMLElement>("p.wp-block-paragraph")) {
    const [first = "", ...rest] = paragraph.innerText.split("\n").map((line) => line.trim());
    const heading = /^(.+?):\s*([\d.]+(?:\s*[-–]\s*[\d.]+)?\s*SRM)$/.exec(first);
    if (!heading) continue;
    let description = rest.filter((line) => line !== "").join("\n");
    const next = paragraph.nextElementSibling as HTMLElement | null;
    if (
      description === "" &&
      next?.matches("p.wp-block-paragraph") &&
      !/ SRM$/.test(next.innerText.trim())
    )
      description = next.innerText.trim();
    listed.push({
      name: heading[1]!,
      colour: heading[2]!.replace(/\s+/g, " "),
      description,
    });
  }
  return listed;
}

export const maker: MakerSource = {
  id: "double-eagle",
  role: "fermentables",
  async read(limit) {
    const source = await fetchSource(`${ORIGIN}/malts/`);
    const listed = (await inDom(source.body, readPortfolio)).slice(0, limit);
    const gaps: { url: string; reason: string }[] = [];
    if (listed.length === 0) gaps.push({ url: source.url, reason: "no malts found on the page" });
    const products: ParsedProduct[] = listed.map((item) => ({
      id: `double-eagle-${slug(item.name)}`,
      role: "fermentables",
      manufacturer: "Double Eagle",
      manufacturerAliases: ["Double Eagle Malt"],
      codes: [],
      aliases: titleAliases(item.name),
      flavorText: item.description.replace(/\bCURRENTLY OUT OF STOCK\b\.?/g, "").trim(),
      source: makerSource(source),
      limitations: [`Maltster colour: ${item.colour}.`],
    }));
    return { products, gaps };
  },
};
