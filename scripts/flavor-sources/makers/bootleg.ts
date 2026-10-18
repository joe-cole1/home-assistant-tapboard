import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  fragmentText,
  makerSource,
  slug,
  souringFromStated,
  titleAliases,
  type MakerSource,
  isBeerCulture,
} from "../maker.ts";

const ORIGIN = "https://bootlegbiology.com";

interface StoreProduct {
  readonly name: string;
  readonly sku: string;
  readonly permalink: string;
  readonly description: string;
  readonly categories: readonly { readonly name: string }[];
}

/** Bootleg Biology cultures from the shop's public Store API. Each description lists
 * "Type:" (the organisms) and "Flavor/Aroma Profile:" lines; homebrew and commercial-pitch
 * listings of one culture share a code (the commercial SKU adds "-CP"). */
export const maker: MakerSource = {
  id: "bootleg",
  role: "yeasts",
  async read(limit) {
    const listed: StoreProduct[] = [];
    for (let page = 1; page <= 10; page++) {
      const listing = await fetchSource(
        `${ORIGIN}/wp-json/wc/store/v1/products?per_page=100&page=${page}`,
      );
      const batch = JSON.parse(listing.body) as StoreProduct[];
      listed.push(...batch);
      if (batch.length < 100) break;
    }
    const byCode = new Map<string, StoreProduct>();
    for (const product of listed) {
      const categories = product.categories.map((category) => category.name);
      if (!categories.includes("Cultures")) continue;
      const code = product.sku.toUpperCase().replace(/-CP$/, "");
      const current = byCode.get(code);
      if (!current || categories.includes("Homebrew")) byCode.set(code, product);
    }
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const [code, product] of [...byCode].slice(0, limit)) {
      try {
        const text = await fragmentText(product.description);
        const type = /^\s*type\s*:\s*(.+)$/im.exec(text)?.[1]?.trim();
        // Bundles, gel packs and custom-blend services state no organisms.
        if (!type || !isBeerCulture(product.name)) continue;
        const profile =
          /^\s*flavou?r\s*\/?\s*aroma profile\s*:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
        const name = (await fragmentText(product.name))
          .replace(/\s*[–-]\s*(?:commercial pitch|sold out)\b/gi, "")
          .replace(/\s*\*beta\*/gi, "")
          .trim();
        // The product page shows this description; its hash records what was read.
        const source = await fetchSource(product.permalink);
        products.push({
          id: `bootleg-${slug(code)}`,
          role: "yeasts",
          manufacturer: "Bootleg Biology",
          manufacturerAliases: ["Bootleg", "Bootleg Bio"],
          codes: [code],
          aliases: titleAliases(name, ["FerMENTORS Series:"], ["Yeast"]),
          flavorText: profile,
          source: makerSource(source),
          souring: souringFromStated(`${type} ${name}`, profile),
        });
      } catch (error) {
        gaps.push({
          url: product.permalink,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { products, gaps };
  },
};
