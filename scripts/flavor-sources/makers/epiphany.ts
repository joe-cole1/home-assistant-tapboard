import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.epiphanymalt.com";
// Custom and service lines, not fixed products: "Infused" (any grain, flavoured to order), "Toll
// Road" (the brewer's own grain malted for them), "Smoked" and "Nordic" (made to order).
const SERVICE_LINES = ["infused", "toll-road", "smoked", "nordic"];

interface Card {
  readonly name: string;
  readonly category: string;
  readonly colour: string;
}

/** The home page's malt list is one Elementor loop card (`div.e-loop-item.product`) per product,
 * with a `product_cat-*` class for its group ("low-kiln", "high-kiln", "roasts", "crystal", …), an
 * `h2` name and `h3` lines: the grain ("2 row winter barley"), the colour ("250.0 - 300.0 SRM")
 * and a type tag ("Coffee Style", "Moderately Well Modified"). Epiphany's product pages and API
 * hold no description at all, and the type tags name a malt type, not what it contributes, so no
 * flavour text is read. */
function readCards(): Card[] {
  return [...document.querySelectorAll(".e-loop-item.product")].map((card) => ({
    name: (card.querySelector("h2")?.textContent ?? "").trim(),
    category: [...card.classList].find((name) => name.startsWith("product_cat-"))?.slice(12) ?? "",
    colour:
      [...card.querySelectorAll("h3")]
        .map((line) => (line.textContent ?? "").trim())
        .find((line) => /^[\d.]+(?:\s*-\s*[\d.]+)?\s*SRM$/.test(line)) ?? "",
  }));
}

export const maker: MakerSource = {
  id: "epiphany",
  role: "fermentables",
  async read(limit) {
    const source = await fetchSource(`${ORIGIN}/`);
    const cards = (await inDom(source.body, readCards))
      .filter(({ category }) => !SERVICE_LINES.includes(category))
      .slice(0, limit);
    const gaps: { url: string; reason: string }[] = [];
    if (cards.length === 0) gaps.push({ url: source.url, reason: "no malt cards on the page" });
    const products: ParsedProduct[] = cards.map((card) => ({
      id: `epiphany-${slug(card.name)}`,
      role: "fermentables",
      manufacturer: "Epiphany Craft Malt",
      manufacturerAliases: [],
      codes: [],
      aliases: [
        ...new Set([
          ...titleAliases(card.name),
          ...titleAliases(card.name.replace(/\s*\([^)]*\)$/, "")),
        ]),
      ],
      flavorText: "",
      source: makerSource(source),
      limitations: card.colour ? [`Maltster colour: ${card.colour}.`] : [],
    }));
    return { products, gaps };
  },
};
