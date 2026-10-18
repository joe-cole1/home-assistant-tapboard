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

const ORIGIN = "https://www.whitelabs.com";

interface Page {
  readonly title: string;
  readonly partNo: string;
  readonly description: string;
  readonly facts: Record<string, string>;
}

/** White Labs strain pages: `h1` "WLP001 California Ale Yeast®", and a `.dynamic-content` block
 * whose text runs: the description (often a bare text node before any paragraph), then "Part
 * No:" (the strain code), part details, the "Suggested Beverages & Styles" list and food
 * pairings, which are never read. `h2.table-title` facts such as STA1 sit elsewhere. */
function readPage(): Page {
  const facts: Record<string, string> = {};
  for (const heading of document.querySelectorAll("h2.table-title")) {
    const value = heading.nextElementSibling;
    facts[
      (heading.textContent ?? "")
        .replace(/[:\s]+$/, "")
        .trim()
        .toLowerCase()
    ] = (value?.textContent ?? "").trim();
  }
  const block = document.querySelector<HTMLElement>(".dynamic-content");
  // Lines that are only a link ("Pitch Rate Calculator") are navigation, not description.
  const links = new Set(
    [...(block?.querySelectorAll("a") ?? [])].map((link) => (link.textContent ?? "").trim()),
  );
  const parts: string[] = [];
  for (const raw of (block?.innerText ?? "").split("\n")) {
    const text = raw.trim();
    if (
      /^(part no|part name|sta1 qc|type:|suggested|pairing recommendations|food pairing)/i.test(
        text,
      )
    )
      break;
    if (text && text !== "Description" && !links.has(text)) parts.push(text);
  }
  return {
    title: (document.querySelector("h1")?.textContent ?? "").trim(),
    partNo: /part no:\s*(\S+)/i.exec(block?.innerText ?? "")?.[1] ?? "",
    description: parts.join("\n"),
    facts,
  };
}

export const maker: MakerSource = {
  id: "white-labs",
  role: "yeasts",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/sitemap-1.xml`);
    const urls = [
      ...sitemap.body.matchAll(/<loc>([^<]*yeast-single\?id=\d+&amp;type=YEAST)<\/loc>/g),
    ]
      .map((match) => match[1]!.replace(/&amp;/g, "&"))
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        // The part number is the strain code; products without a WLP part number are other
        // makers' yeasts that White Labs resells (Lallemand, Pinnacle, distilling, baking).
        const wlp = /^WLP[\dA-Z]+$/i.test(page.partNo) ? page.partNo.toUpperCase() : null;
        if (!wlp || !isBeerCulture(page.title)) continue;
        const name = page.title.replace(new RegExp(`^${wlp}\\s+`, "i"), "").trim();
        products.push({
          id: `white-labs-${wlp.toLowerCase()}`,
          role: "yeasts",
          manufacturer: "White Labs",
          manufacturerAliases: ["WhiteLabs", "White Labs Inc."],
          codes: [wlp],
          // Only "Yeast" is dropped: "English Ale Yeast Blend" (WLP085) must not become WLP002's
          // "English Ale".
          aliases: titleAliases(name, [], ["Yeast"]),
          flavorText: page.description,
          source: makerSource(source),
          souring: souringFromStated(name, page.description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
