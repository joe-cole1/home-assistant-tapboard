import type { ParsedProduct } from "../build.ts";
import {
  fragmentText,
  makerSource,
  shopifyProducts,
  slug,
  titleAliases,
  type MakerSource,
} from "../maker.ts";

const ORIGIN = "https://cellarscience.com";

export const maker: MakerSource = {
  id: "cellarscience",
  role: "yeasts",
  async read(limit) {
    const listed = (await shopifyProducts(ORIGIN))
      .filter(({ product }) => /dry beer yeast/i.test(product.title))
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    for (const { product, source } of listed) {
      // The listing carries the whole description; stop before fermentation and storage facts.
      const text = (await fragmentText(product.body_html ?? "")).split(
        /optimum fermentation temp|tech(?:nical)? (?:data )?sheet|download|rehydrat|directions/i,
      )[0]!;
      const name = product.title.replace(/\s*dry beer yeast\s*$/i, "").trim();
      const code = product.variants
        .map((variant) => variant.sku ?? "")
        .find((sku) => /^DY\d+/i.test(sku));
      products.push({
        id: `cellarscience-${slug(name)}`,
        role: "yeasts",
        manufacturer: "CellarScience",
        manufacturerAliases: ["Cellar Science"],
        codes: code ? [code.toUpperCase()] : [],
        aliases: titleAliases(product.title, [], ["Dry Beer Yeast"]).concat(name),
        flavorText: text,
        source: { ...makerSource(source), url: `${ORIGIN}/products/${product.handle}` },
        // Every listing is a "Dry Beer Yeast"; the one souring strain says it sours beer.
        souring: /\bsour(?:s|ing)? (?:the )?beer|sour beer/i.test(text),
        limitations: ["Read from the maker's product listing (products.json)."],
      });
    }
    return { products, gaps: [] };
  },
};
