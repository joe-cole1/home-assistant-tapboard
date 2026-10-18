import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  fragmentText,
  makerSource,
  shopifyProducts,
  slug,
  souringFromStated,
  titleAliases,
  type MakerSource,
  isBeerCulture,
} from "../maker.ts";

const ORIGIN = "https://cellarscience.com";

export const maker: MakerSource = {
  id: "cellarscience",
  role: "yeasts",
  async read(limit) {
    const listed = (await shopifyProducts(ORIGIN))
      .filter(({ product }) => /yeast$/i.test(product.title.trim()) && isBeerCulture(product.title))
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const { product } of listed) {
      const url = `${ORIGIN}/products/${product.handle}`;
      // The product page shows the listing's description; its hash records what was read.
      let source;
      try {
        source = await fetchSource(url);
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // The listing carries the whole description; stop before fermentation and storage facts.
      const text = (await fragmentText(product.body_html ?? "")).split(
        /optimum fermentation temp|tech(?:nical)? (?:data )?sheet|download|rehydrat|directions/i,
      )[0]!;
      const name = product.title.replace(/\s*(?:dry beer|dry|high-gravity) yeast\s*$/i, "").trim();
      const code = product.variants
        .map((variant) => variant.sku ?? "")
        .find((sku) => /^DY\d+/i.test(sku));
      products.push({
        id: `cellarscience-${slug(name)}`,
        role: "yeasts",
        manufacturer: "CellarScience",
        manufacturerAliases: ["Cellar Science"],
        codes: code ? [code.toUpperCase()] : [],
        aliases: [...new Set([...titleAliases(product.title), name])],
        flavorText: text,
        source: makerSource(source),
        // Every listing is a beer yeast; a souring strain says in its text that it sours beer.
        souring: /\bsour(?:s|ing)? (?:the )?beer|sour beer/i.test(text)
          ? true
          : souringFromStated(product.title, text),
      });
    }
    return { products, gaps };
  },
};
