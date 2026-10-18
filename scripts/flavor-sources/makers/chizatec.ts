import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

// The Hop Research Institute's English "Czech hop varieties" atlas (2022), linked from
// /en/czech-hop-varieties/. It is a flipbook whose basic-HTML version has one page per atlas page.
const ATLAS = "https://www.chizatec.cz/atlas_chmele/en/";

/** Atlas pages in the basic-HTML version carry the page's PDF text in one `pre code` block,
 * laid out in columns. A variety page starts "IHGC VARIETAL CODE: PRE", then the variety name,
 * then "DESCRIPTION" with the left-column paragraph (breeding history, aroma, use) until "HOP
 * AROMA". "HOP AROMA" is a spider chart whose axis labels (herbal, woody, fruity, …) are the
 * same on every page, so it is never read, nor are the agronomy and chemistry tables after it.
 * Introduction, comparison-table and genetic-map pages have no varietal code. */
function readPage() {
  const text = document.querySelector("pre code")?.textContent ?? "";
  const lines = text.split("\n").map((line) => line.trim());
  const codeAt = lines.findIndex((line) => /^IHGC VARIETAL CODE:/i.test(line));
  if (codeAt === -1) return null;
  const name = lines.slice(codeAt + 1).find((line) => line !== "") ?? "";
  const from = lines.indexOf("DESCRIPTION", codeAt);
  const to = lines.findIndex((line, index) => index > from && /^HOP\s+AROMA$/.test(line));
  return {
    name,
    // The paragraph is wrapped to the column; a line ending in a hyphen continues a compound.
    description:
      from === -1 || to === -1
        ? ""
        : lines
            .slice(from + 1, to)
            .join("\n")
            .replace(/-\n/g, "-")
            .replace(/\s+/g, " ")
            .trim(),
  };
}

export const maker: MakerSource = {
  id: "chizatec",
  role: "hops",
  async read(limit) {
    const config = await fetchSource(`${ATLAS}mobile/javascript/config.js`);
    const pages = Number(/bookConfig\.totalPageCount\s*=\s*(\d+)/.exec(config.body)?.[1] ?? 0);
    if (!pages) throw new Error(`${config.url} states no page count`);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (let number = 1; number <= pages && products.length < (limit ?? Infinity); number++) {
      const url = `${ATLAS}files/basic-html/page${number}.html`;
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (!page) continue;
        if (!page.name || !page.description) {
          gaps.push({ url, reason: "variety page without a name or DESCRIPTION paragraph" });
          continue;
        }
        // The atlas covers Czech varieties only (its title is "Czech hop varieties").
        products.push(
          hopVariety(source, page.name, page.description, {
            limitations: ["Origin: Czech Republic."],
          }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
