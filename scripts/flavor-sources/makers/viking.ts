import type { ParsedProduct } from "../build.ts";
import { fetchSource, pdfText } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://vikingmalt.com";
const SELECTION = `${ORIGIN}/malts-support/malt-selection/`;
// "Distiller's Choice" malts are for whisky and "Malted faba bean Sprau®" is a food ingredient;
// the other categories (Classic, Organic, Special, Smoked) are sold to brewers.
const NOT_BREWING = /pot-still|enzyme-malt|faba-bean/;
// Only sentences that speak of aroma, taste, flavour or notes are read: the text also gives the
// malt's class ("Caramel Pale is true caramel malt"), process, enzymes and beer styles.
const CHARACTER = /\b(?:aroma\w*|tast\w*|flavou?r\w*|notes?|nuances?|hints?)\b/i;

interface Page {
  readonly title: string;
  readonly character: string;
  readonly quote: string;
  readonly sheet: string;
}

/** Malt pages (`/malts/<name>/`) show the category in `.term-name`, the `h1` name and a
 * `.malt-content` column of paragraphs under two bold headings, "MALT CHARACTER" (flavour and
 * process) and "APPLICATIONS" (beer styles and dosage, never read; it also compares the malt to a
 * style's flavour, as the Vienna page does for Vienna lager). A pull-quote in `.malt-quote`
 * restates the flavour, and the links list holds the "Malt Data Sheet (PDF)". */
function readPage(): Page {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const character: string[] = [];
  let heading = "";
  for (const paragraph of document.querySelectorAll(".malt-content > p")) {
    const strong = paragraph.querySelector(":scope > strong");
    if (strong && text(strong) === text(paragraph)) heading = text(paragraph);
    else if (/^malt character$/i.test(heading)) character.push(text(paragraph));
  }
  return {
    title: text(document.querySelector("h1")),
    character: character.join("\n"),
    quote: text(document.querySelector(".malt-quote h4")).replace(/^[“"]|[”"]$/g, ""),
    sheet:
      [...document.querySelectorAll<HTMLAnchorElement>(".links-list a")].find((link) =>
        /\.pdf$/i.test(link.href),
      )?.href ?? "",
  };
}

/** The sheet's specification table has a "Color °EBC <range>" row, or one per variant ("Color
 * (Light)", "Color (Caramel 30)") on sheets that cover several malts. */
const colours = (sheet: string): string[] =>
  [
    ...sheet.matchAll(
      /Colou?r(?: \(([^)]+)\))?\s+°\s?EBC\s+(max\.?\s*[\d.,]+|[\d.,]+\s*[-–]\s*[\d.,]+)/g,
    ),
  ].map((match) => `Maltster colour${match[1] ? ` (${match[1]})` : ""}: ${match[2]!.trim()} EBC.`);

export const maker: MakerSource = {
  id: "viking",
  role: "fermentables",
  async read(limit) {
    const gaps: { url: string; reason: string }[] = [];
    const products: ParsedProduct[] = [];
    let urls: string[] = [];
    try {
      const selection = await fetchSource(SELECTION);
      urls = [
        ...new Set(
          [...selection.body.matchAll(/href="(https:\/\/vikingmalt\.com\/malts\/[a-z0-9-]+\/)"/g)]
            .map((match) => match[1]!)
            .filter((url) => !NOT_BREWING.test(url)),
        ),
      ].slice(0, limit);
    } catch (error) {
      gaps.push({ url: SELECTION, reason: error instanceof Error ? error.message : String(error) });
    }
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title === "" || page.character === "") {
          gaps.push({ url, reason: "no malt name and character text on the page" });
          continue;
        }
        let notes: string[] = [];
        if (page.sheet) {
          try {
            notes = colours(await pdfText(await fetchSource(page.sheet)));
          } catch (error) {
            gaps.push({
              url: page.sheet,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const sentences = [page.character, page.quote]
          .flatMap((part) => part.split(/\n|(?<=[.!?])\s+(?=[A-Z])/))
          .filter((sentence) => CHARACTER.test(sentence));
        products.push({
          id: `viking-${slug(titleAliases(page.title, ["Viking"]).at(-1)!)}`,
          role: "fermentables",
          manufacturer: "Viking Malt",
          manufacturerAliases: ["Viking"],
          codes: [],
          aliases: titleAliases(page.title, ["Viking"]),
          flavorText: sentences.join("\n"),
          source: makerSource(source),
          limitations: notes,
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
