import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  fragmentText,
  inDom,
  makerSource,
  shopifyProducts,
  slug,
  souringFromStated,
  titleAliases,
  type MakerSource,
  type ShopifyProduct,
} from "../maker.ts";

const ORIGIN = "https://escarpmentlabs.com";

/** Escarpment strain pages hold labelled `.KeyItem` facts; "Flavour Description" is the text. */
function readFacts(): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const item of document.querySelectorAll(".KeyItem")) {
    const label = (item.querySelector("span.u-h5")?.textContent ?? "").replace(/\?/g, "").trim();
    if (label && !(label.toLowerCase() in facts))
      facts[label.toLowerCase()] = (item.querySelector("p")?.textContent ?? "").trim();
  }
  return facts;
}

const culture = (title: string) => title.replace(/\s*\[HB\]|\s*\(LSB\d+\)/gi, "").trim();

export const maker: MakerSource = {
  id: "escarpment",
  role: "yeasts",
  async read(limit) {
    // One entry per culture: the homebrew listing (cleaner text, full fact grid) when there is
    // one, otherwise the professional listing; resold Lallemand products are left out.
    const byCulture = new Map<string, ShopifyProduct>();
    for (const { product } of await shopifyProducts(ORIGIN)) {
      if (!/^(?:homebrew )?yeast$/i.test(product.product_type)) continue;
      if (/^lalbrew/i.test(product.title)) continue;
      if (product.variants.some((variant) => /^LAL-/i.test(variant.sku ?? ""))) continue;
      const key = culture(product.title).toLowerCase();
      const current = byCulture.get(key);
      if (!current || /\[HB\]/.test(product.title)) byCulture.set(key, product);
    }
    const listed = [...byCulture.values()].slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const product of listed) {
      const url = `${ORIGIN}/products/${product.handle}`;
      try {
        const source = await fetchSource(url);
        const facts = await inDom(source.body, readFacts);
        const name = culture(product.title);
        const lsb = /\((LSB\d+)\)/i.exec(product.title)?.[1];
        // Professional listings end with strain equivalents and search keywords.
        const description = (await fragmentText(product.body_html ?? "")).split(
          /strain equivalency|equivalen|substitute/i,
        )[0]!;
        products.push({
          id: `escarpment-${slug(name)}`,
          role: "yeasts",
          manufacturer: "Escarpment Labs",
          manufacturerAliases: ["Escarpment", "Escarpment Laboratories"],
          codes: lsb ? [lsb.toUpperCase()] : [],
          aliases: titleAliases(name, [], ["Yeast"]),
          flavorText: [facts["flavour description"] ?? "", description].join("\n"),
          source: makerSource(source),
          souring: souringFromStated(`${product.tags.join(" ")} ${name} yeast`),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
