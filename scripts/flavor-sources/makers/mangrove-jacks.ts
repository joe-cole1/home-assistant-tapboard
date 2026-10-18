import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  fragmentText,
  makerSource,
  shopifyProducts,
  souringFromStated,
  titleAliases,
  type MakerSource,
  isBeerCulture,
} from "../maker.ts";

const ORIGIN = "https://mangrovejacks.com";

export const maker: MakerSource = {
  id: "mangrove-jacks",
  role: "yeasts",
  async read(limit) {
    const listed = (await shopifyProducts(ORIGIN))
      .filter(({ product }) => /^M\d+\s/.test(product.title) && isBeerCulture(product.title))
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
        source: makerSource(source),
        souring: souringFromStated(name, text),
      });
    }
    return { products, gaps };
  },
};
