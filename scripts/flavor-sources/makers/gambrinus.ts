import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://gambrinusmalting.com";

interface Page {
  readonly title: string;
  readonly colour: readonly string[];
  readonly description: string;
}

/** Gambrinus product pages (WordPress): `h1.section-single-product__heading` "Gambrinus Munich
 * Light", a `.section-single-product__spec` per fact (key "Colour Lovibond", "Colour SRM",
 * "Colour EBC", "Usage Rate", …), an optional one-line `.section-single-product__short-desc`
 * headline, and `.section-single-product__description`: one paragraph on the malt's character and
 * the styles it suits, then an "INFO SHEET" link (the PDF is not read). */
function readPage(): Page {
  const text = (element: Element | null) =>
    ((element as HTMLElement | null)?.innerText ?? "").trim();
  const description = document.querySelector(".section-single-product__description");
  // Lines that are only a link ("INFO SHEET", "Product Information Sheet") are navigation.
  const links = new Set([...(description?.querySelectorAll("a") ?? [])].map(text));
  return {
    title: text(document.querySelector("h1")),
    colour: [...document.querySelectorAll(".section-single-product__spec")]
      .map((spec) => ({
        key: text(spec.querySelector(".section-single-product__spec-key")),
        value: text(spec.querySelector(".section-single-product__spec-value")),
      }))
      .filter(({ key }) => /^colou?r /i.test(key))
      .map(({ key, value }) => `${value} ${key.replace(/^colou?r /i, "")}`),
    description: [
      text(document.querySelector(".section-single-product__short-desc")),
      text(description),
    ]
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !links.has(line))
      .join("\n"),
  };
}

export const maker: MakerSource = {
  id: "gambrinus",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/product-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*\/gambrinus-[^<]*)<\/loc>/g)]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title === "") {
          gaps.push({ url, reason: "no product title on the page" });
          continue;
        }
        products.push({
          id: `gambrinus-${slug(page.title.replace(/^Gambrinus\s+/i, ""))}`,
          role: "fermentables",
          manufacturer: "Gambrinus",
          manufacturerAliases: ["Cargill (Gambrinus)", "Gambrinus Malting"],
          codes: [],
          // No generic-suffix aliases: "Honey" would hide the flavour word in its own text.
          aliases: titleAliases(page.title, ["Gambrinus"]),
          flavorText: page.description,
          source: makerSource(source),
          limitations: page.colour.length ? [`Maltster colour: ${page.colour.join(", ")}.`] : [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
