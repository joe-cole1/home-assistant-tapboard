import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.fawcett-maltsters.co.uk";

interface Page {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly chart: readonly { readonly flavour: string; readonly score: number }[];
  readonly colours: readonly { readonly label: string; readonly value: string }[];
}

/** Fawcett malt pages (`/malt/<slug>/`) show the name in the `h1` under a "Brewing / Crystal
 * Malts" or "Distilling / Base Malts" pill. The first row of `section.about-section` holds the
 * description: an `h3` headline sentence and sometimes paragraphs of history and use. The second
 * row holds IOB/EBC/ASBC spec tabs (`.spec-table`, whose "Colour oEBC" and "ASBC Colour
 * oLovibond" rows give the colour) and a "taste chart": a Plotly radar whose inline script
 * scores 14 flavours (`theta`) from 0 to 5 (`r`). The chart is the maltster's own flavour
 * statement, so every flavour it scores above 0 is read, strongest first. */
function readPage(): Page {
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const script = [...document.querySelectorAll("script")]
    .map((element) => element.textContent ?? "")
    .find((source) => source.includes("theta:"));
  const scores = /r:\s*\[([^\]]*)\]/.exec(script ?? "")?.[1]?.split(",") ?? [];
  const flavours = /theta:\s*\[([^\]]*)\]/.exec(script ?? "")?.[1]?.split(",") ?? [];
  return {
    name: text(document.querySelector("h1")),
    category: text(document.querySelector(".sub-heading-pill")),
    description: (
      document.querySelector<HTMLElement>("section.about-section .container > .row")?.innerText ??
      ""
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n"),
    chart: flavours.map((flavour, index) => ({
      flavour: flavour.replace(/['"\s]/g, ""),
      score: Number(scores[index]),
    })),
    colours: [...document.querySelectorAll(".spec-table tr")]
      .map((row) => [...row.querySelectorAll("td")].map(text))
      .filter((cells) => /colour/i.test(cells[0] ?? ""))
      .map(([label, value]) => ({ label: label!, value: value ?? "" })),
  };
}

export const maker: MakerSource = {
  id: "fawcett",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/malt-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*\/malt\/[^<]+)<\/loc>/g)]
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
        if (/^distilling\b/i.test(page.category)) continue;
        // "IOB Colour oEBC" is the same colour measured by the IoB method; it is read only when
        // the page has no EBC or ASBC row.
        const own = page.colours.filter((colour) => !/^IOB\b/i.test(colour.label));
        const colour = (own.length ? own : page.colours)
          .map(
            ({ label, value }) =>
              `${value} ${label.replace(/^.*?colour\s*/i, "").replace(/^o/, "°")}`,
          )
          .join("; ");
        products.push({
          id: `fawcett-${slug(page.name)}`,
          role: "fermentables",
          manufacturer: "Thomas Fawcett",
          manufacturerAliases: ["Thomas Fawcett & Sons"],
          codes: [],
          aliases: [
            ...new Set([
              ...titleAliases(page.name),
              ...titleAliases(page.name.replace(/\s*\([^)]*\)/g, "")),
            ]),
          ],
          flavorText: [
            page.description,
            ...page.chart
              .filter(({ score }) => score > 0)
              .sort((a, b) => b.score - a.score)
              .map(({ flavour }) => flavour),
          ]
            .filter((line) => line !== "")
            .join("\n"),
          source: makerSource(source),
          limitations: colour ? [`Maltster colour: ${colour}.`] : [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
