import type { ParsedProduct } from "../build.ts";
import { fetchSource, pdfText, type CachedSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.avangard-malz.de";
// The English pages are read; the German pages list the same products.
const PRODUCTS = `${ORIGIN}/en/products/`;
const DOWNLOADS = `${ORIGIN}/en/downloads/`;
// Only sentences that speak of aroma, taste, flavour or notes are read: the table's "Use/Effect"
// column and the data sheets mix beer-style lists, usage rates and mashing advice with the odd
// flavour statement ("Provides colour, body and malty taste").
const CHARACTER = /\b(?:aroma\w*|tast\w*|flavou?r\w*|notes?)\b/i;

interface Row {
  readonly name: string;
  readonly colour: string;
  readonly use: string;
}

/** The "Range of Products" table has one `tr` per malt; its name is the first `p`, and the other
 * cells carry a `products-prop-<FIELD>` class ("COLOUREBC", "USE_EFFECT"). The cells are never
 * closed in the HTML, so they are found by class rather than by position. */
function readRows(): Row[] {
  const text = (element: Element | null) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  return [...document.querySelectorAll("table.products-list tbody tr[id]")].map((row) => ({
    name: text(row.querySelector("p")),
    colour: text(row.querySelector(".products-prop-COLOUREBC p")),
    use: text(row.querySelector(".products-prop-USE_EFFECT p")),
  }));
}

/** The "Craft Brewer's Malt" row of the downloads table links one data sheet per malt type. */
function readSheets(): { name: string; href: string }[] {
  const row = [...document.querySelectorAll("tr")].find((tr) =>
    /^craft brewer/i.test(tr.querySelector(".certificates-sections-name")?.textContent ?? ""),
  );
  return [...(row?.querySelectorAll<HTMLAnchorElement>("a.download-single-file-link") ?? [])].map(
    (link) => ({
      name: (link.querySelector(".download-single-file-name")?.textContent ?? "").trim(),
      href: link.getAttribute("href") ?? "",
    }),
  );
}

const sentences = (text: string): string[] =>
  text
    .replace(/\s*\n\s*/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .filter((sentence) => CHARACTER.test(sentence));

/** A data sheet is a title, the description (several paragraphs) and a SPECIFICATIONS table. */
const sheetDescription = (text: string): string => text.split(/\bSPECIFICATIONS\b/)[0] ?? "";

export const maker: MakerSource = {
  id: "avangard",
  role: "fermentables",
  async read(limit) {
    const gaps: { url: string; reason: string }[] = [];
    const products: ParsedProduct[] = [];
    let page: CachedSource;
    let rows: Row[];
    const sheets = new Map<string, CachedSource>();
    try {
      page = await fetchSource(PRODUCTS);
      rows = await inDom(page.body, readRows);
    } catch (error) {
      gaps.push({ url: PRODUCTS, reason: error instanceof Error ? error.message : String(error) });
      return { products, gaps };
    }
    try {
      const downloads = await fetchSource(DOWNLOADS);
      for (const sheet of await inDom(downloads.body, readSheets)) {
        const url = new URL(sheet.href, ORIGIN).href;
        try {
          sheets.set(sheet.name.toLowerCase(), await fetchSource(url));
        } catch (error) {
          gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      gaps.push({ url: DOWNLOADS, reason: error instanceof Error ? error.message : String(error) });
    }
    for (const row of rows.slice(0, limit)) {
      // "Light Caramel Malt" and "Dark Caramel Malt" share the one "Caramel malt" sheet, which
      // describes light and dark separately: a sentence naming the other colour is not theirs.
      const colour = /^(light|dark)\b/i.exec(row.name)?.[1]?.toLowerCase();
      const sheet = sheets.get(row.name.toLowerCase().replace(/^(?:light|dark) /, ""));
      let sheetText: string[] = [];
      if (sheet) {
        try {
          sheetText = sentences(sheetDescription(await pdfText(sheet))).filter((sentence) => {
            const named = /\b(light|medium|dark) caramel\b/i.exec(sentence)?.[1]?.toLowerCase();
            return !named || named === colour;
          });
        } catch (error) {
          gaps.push({
            url: sheet.url,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      products.push({
        id: `avangard-${slug(row.name)}`,
        role: "fermentables",
        manufacturer: "Avangard",
        manufacturerAliases: ["Avangard Malz", "Avangard-Malz", "Avangard Malz AG"],
        codes: [],
        // The caramel sheet calls them "Dark caramel" and "light caramel" as well.
        aliases: [...titleAliases(row.name), ...(colour ? [row.name.replace(/ malt$/i, "")] : [])],
        flavorText: [...sentences(row.use), ...sheetText].join("\n"),
        source: makerSource(sheet ?? page),
        limitations: row.colour ? [`Maltster colour: ${row.colour} EBC.`] : [],
      });
    }
    return { products, gaps };
  },
};
