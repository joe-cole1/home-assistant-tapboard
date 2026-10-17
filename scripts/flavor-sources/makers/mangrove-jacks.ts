import type { ParsedProduct } from "../build.ts";
import {
  fragmentText,
  makerSource,
  shopifyProducts,
  souringFromStated,
  titleAliases,
  type MakerSource,
} from "../maker.ts";

const ORIGIN = "https://mangrovejacks.com";

export const maker: MakerSource = {
  id: "mangrove-jacks",
  role: "yeasts",
  async read(limit) {
    const listed = (await shopifyProducts(ORIGIN))
      .filter(
        ({ product }) => /^M\d+\s/.test(product.title) && !/cider|mead|wine/i.test(product.title),
      )
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    for (const { product, source } of listed) {
      const [, code, rest] = /^(M\d+)\s+(.*)$/.exec(product.title) as unknown as [
        string,
        string,
        string,
      ];
      const name = rest.replace(/\s*-\s*\d+\s*g\s*$/i, "").trim();
      // The description precedes the "Attenuation", "Usage Directions" and storage facts.
      const text = (await fragmentText(product.body_html ?? "")).split(
        /attenuation\s*:|usage directions|storage recommendations/i,
      )[0]!;
      products.push({
        id: `mangrove-jacks-${code.toLowerCase()}`,
        role: "yeasts",
        manufacturer: "Mangrove Jack's",
        manufacturerAliases: ["Mangrove Jacks", "Mangrove Jack"],
        codes: [code],
        aliases: [...titleAliases(name, [], ["Yeast"]), `${code} ${name}`],
        flavorText: text,
        source: { ...makerSource(source), url: `${ORIGIN}/products/${product.handle}` },
        souring: souringFromStated(`${name} yeast`),
        limitations: ["Read from the maker's product listing (products.json)."],
      });
    }
    return { products, gaps: [] };
  },
};
