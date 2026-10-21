import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://bestmalz.de";
// The English overview links every English product page. The German pages (/malze/) and the
// distillers' pages (/en/distillers-malts/) are the same products in other markets and are not
// read.
const OVERVIEW = `${ORIGIN}/en/bestmalz-bestmalts-the-best-in-beer/`;

// The description mixes character ("the typical malty note", "aromas reminiscent of bread
// crumbs") with the product's class ("a dark caramel malt"), its colour, process ("caramel
// formation in the grain"), brewing advice and legal notes, so only the sentences that speak of
// aroma, taste, flavour or notes are read, plus the aroma tags.
const CHARACTER = /\b(?:aroma\w*|tast\w*|flavou?r\w*|notes?)\b/i;

interface Page {
  readonly title: string;
  readonly description: string;
  readonly use: string;
  readonly aromas: readonly string[];
  readonly colour: readonly string[];
}

/** English product pages (`/en/malts/best-…/`) put the product in a Kadence layout: the `h1`
 * name, then two `.kb-dynamic-html` blocks, the description (flavour, body and process mixed in
 * one paragraph) and the use line ("Base malt for …", a beer-style list, not read), and an
 * `.aroma-wrapper` with one `.aroma-title` per aroma tag ("Malt", "Bread"). The specification
 * table row "Wort color" holds the minimum and maximum as "EBC / L" pairs. */
function readPage(): Page {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const blocks = [...document.querySelectorAll(".kb-dynamic-html")].map(text);
  const row = [...document.querySelectorAll("tr")].find((tr) =>
    /^wort colou?r/i.test(text(tr.querySelector("td"))),
  );
  return {
    title: text(document.querySelector("h1")),
    description: blocks[0] ?? "",
    use: blocks[1] ?? "",
    aromas: [...document.querySelectorAll(".aroma-wrapper .aroma-title")].map(text),
    colour: [...(row?.querySelectorAll("td") ?? [])].slice(1).map(text),
  };
}

/** "Wort color" cells: minimum and maximum, each an "EBC / L" pair as printed, and the units
 * ("EBC* / L*"). Heidelberg gives only a maximum. */
function colourNote(cells: readonly string[]): string[] {
  const [min = "", max = "", unit = ""] = cells;
  const parts = (value: string) => value.split("/").map((part) => part.trim());
  const units = parts(unit.replace(/\*/g, ""));
  const low = parts(min);
  const high = parts(max);
  if (!high[0] || high.length !== units.length) return [];
  const range = (at: number) => (low[0] ? `${low[at]} – ${high[at]}` : `max ${high[at]}`);
  return [`Maltster colour: ${units.map((u, at) => `${range(at)} ${u}`).join(" / ")}.`];
}

export const maker: MakerSource = {
  id: "bestmalz",
  role: "fermentables",
  async read(limit) {
    const gaps: { url: string; reason: string }[] = [];
    const products: ParsedProduct[] = [];
    let urls: string[] = [];
    try {
      const overview = await fetchSource(OVERVIEW);
      urls = [
        ...new Set(
          [
            ...overview.body.matchAll(/href="(https:\/\/bestmalz\.de\/en\/malts\/[a-z0-9-]+\/)"/g),
          ].map((match) => match[1]!),
        ),
      ].slice(0, limit);
    } catch (error) {
      gaps.push({ url: OVERVIEW, reason: error instanceof Error ? error.message : String(error) });
    }
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title === "" || page.description === "") {
          gaps.push({ url, reason: "no product name and description on the page" });
          continue;
        }
        // The diastatic malts say outright that they are for bakeries and the food industry.
        if (/\bbakeries\b/i.test(page.use)) continue;
        products.push({
          id: `bestmalz-${slug(titleAliases(page.title, ["BEST"]).at(-1)!)}`,
          role: "fermentables",
          manufacturer: "BestMalz",
          manufacturerAliases: ["BESTMALZ BESTmalts", "BESTmalts"],
          codes: [],
          aliases: titleAliases(page.title, ["BEST"]),
          flavorText: [
            ...page.description.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => CHARACTER.test(s)),
            page.aromas.join(", "),
          ]
            .filter((part) => part !== "")
            .join("\n"),
          source: makerSource(source),
          limitations: colourNote(page.colour),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
