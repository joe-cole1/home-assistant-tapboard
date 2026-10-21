import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://proximitymalt.com";

interface Page {
  readonly title: string;
  readonly sections: Record<string, readonly string[]>;
}

/** Proximity product pages (WooCommerce, `/product/<slug>/`): inside `.summary.entry-summary`,
 * the `h2.product_title` is followed by sections whose headings are bold paragraphs ("TYPICAL
 * ANALYSIS", "BEST SUITED FOR", "FLAVOR PROFILE", "STORAGE/SHELF LIFE", "DISCLAIMER"), each
 * followed by a list or paragraphs. Only the FLAVOR PROFILE section is read, minus the carbon
 * sentence that ReGenMalt pages put on a line of its own after it; the colour is the "COLOR:" line
 * of the analysis, printed without a unit. */
function readPage(): Page {
  const summary = document.querySelector(".summary.entry-summary");
  const sections: Record<string, string[]> = {};
  let heading = "";
  for (const element of summary?.children ?? []) {
    const bold = element.matches("p") ? element.querySelector(":scope > strong") : null;
    if (bold && (element.textContent ?? "").trim() === (bold.textContent ?? "").trim()) {
      heading = (bold.textContent ?? "").replace(/\s+/g, " ").trim().toUpperCase();
      sections[heading] ??= [];
    } else if (heading !== "" && element.matches("p, ul, ol")) {
      // A line break inside a paragraph separates statements, so lines are read from innerText.
      sections[heading]!.push(
        ...(element as HTMLElement).innerText
          .split("\n")
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter((line) => line !== ""),
      );
    }
  }
  return {
    title: (summary?.querySelector("h2.product_title")?.textContent ?? "").trim(),
    sections,
  };
}

export const maker: MakerSource = {
  id: "proximity",
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
        if (page.title === "") {
          gaps.push({ url, reason: "no product title in the page" });
          continue;
        }
        // Spirits-only malts say so under "BEST SUITED FOR" (Distillers: "Malt Whiskey", "Scotch
        // Whiskey", "Most Spirits as a substitute for raw grains").
        const suited = (page.sections["BEST SUITED FOR"] ?? []).join(" ");
        if (
          /whisk(?:e)?y|spirits/i.test(suited) &&
          !/\b(?:beers?|brew\w*|ales?|lagers?)\b/i.test(suited)
        )
          continue;
        const color = page.sections["TYPICAL ANALYSIS"]
          ?.map((line) => /^color:\s*(.+)$/i.exec(line)?.[1])
          .find((value) => value !== undefined);
        products.push({
          id: `proximity-${slug(page.title)}`,
          role: "fermentables",
          manufacturer: "Proximity Malt",
          manufacturerAliases: ["Proximity"],
          codes: [],
          aliases: titleAliases(page.title, ["Prox"]),
          flavorText: (page.sections["FLAVOR PROFILE"] ?? [])
            .filter((line) => !/\bcarbon emissions\b/i.test(line))
            .join("\n"),
          source: makerSource(source),
          limitations: color === undefined ? [] : [`Maltster colour: ${color} (no unit stated).`],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
