import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  fragmentText,
  inDom,
  makerSource,
  shopifyProducts,
  souringFromStated,
  titleAliases,
  type MakerSource,
} from "../maker.ts";

const ORIGIN = "https://omegayeast.com";

/** Omega strain pages list facts as `<dt>`/`<dd>` pairs: "Tasting Notes" (one pill per tag),
 * "Strain Type", "Phenolic", "Diastatic", … */
function readFacts(): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const term of document.querySelectorAll("dt")) {
    const value = term.nextElementSibling;
    // Tasting notes are separate pills; join them so neighbouring tags stay separate words.
    const pills = [...(value?.querySelectorAll("span") ?? [])].map((pill) =>
      (pill.textContent ?? "").trim(),
    );
    facts[(term.textContent ?? "").trim().toLowerCase()] = pills.length
      ? pills.join(", ")
      : (value?.textContent ?? "").trim();
  }
  return facts;
}

export const maker: MakerSource = {
  id: "omega",
  role: "yeasts",
  async read(limit) {
    const listed = (await shopifyProducts(ORIGIN))
      // Pinnacle dry yeasts (PIN- codes, "From Pinnacle Yeast") are AB Mauri products that
      // Omega resells; their maker is not Omega.
      .filter(
        ({ product }) =>
          /brewing yeast/i.test(product.product_type) &&
          !product.variants.some((variant) => /^PIN-/i.test(variant.sku ?? "")) &&
          !/pinnacle/i.test(`${product.title} ${product.body_html ?? ""}`),
      )
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const { product } of listed) {
      const url = `${ORIGIN}/products/${product.handle}`;
      try {
        const source = await fetchSource(url);
        const facts = await inDom(source.body, readFacts);
        const codes = product.variants
          .map((variant) => variant.sku ?? "")
          .filter((sku) => /^OYL-\d+/i.test(sku))
          .map((sku) => /^OYL-\d+/i.exec(sku)![0].toUpperCase());
        const description = await fragmentText(product.body_html ?? "");
        products.push({
          id: `omega-${product.handle}`,
          role: "yeasts",
          manufacturer: "Omega",
          manufacturerAliases: ["Omega Yeast", "Omega Yeast Labs"],
          codes: [...new Set(codes)],
          aliases: titleAliases(product.title, [], ["Yeast"]),
          flavorText: [facts["tasting notes"] ?? "", description].join("\n"),
          source: makerSource(source),
          souring: souringFromStated(`${facts["strain type"] ?? ""} ${product.title}`, description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
