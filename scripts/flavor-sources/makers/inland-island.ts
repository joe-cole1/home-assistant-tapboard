import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import {
  fragmentText,
  makerSource,
  souringFromStated,
  titleAliases,
  type MakerSource,
  isBeerCulture,
} from "../maker.ts";

const ORIGIN = "https://inlandislandyeast.com";

interface Strain {
  readonly title: { readonly rendered: string };
  readonly content: { readonly rendered: string };
  readonly link: string;
  readonly class_list: readonly string[];
}

/** Inland Island's strain library (WordPress `yeast-library` posts): the title "INIS-010
 * American Ale Yeast", the description shown on the strain page, and a `yeast-strain-category-*`
 * class such as `bacteria`, `wild-brett`, `lager` or `kveik`. */
export const maker: MakerSource = {
  id: "inland-island",
  role: "yeasts",
  async read(limit) {
    const strains: Strain[] = [];
    for (let page = 1; page <= 10; page++) {
      const listing = await fetchSource(
        `${ORIGIN}/wp-json/wp/v2/yeast-library?per_page=100&page=${page}`,
      );
      const batch = JSON.parse(listing.body) as Strain[];
      strains.push(...batch);
      if (batch.length < 100) break;
    }
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const strain of strains.slice(0, limit)) {
      try {
        const title = (await fragmentText(strain.title.rendered)).replace(/\*+$/, "").trim();
        const code = /^(INIS-\d+)\s+(.+)$/i.exec(title);
        if (!code) {
          gaps.push({ url: strain.link, reason: `no INIS code in title "${title}"` });
          continue;
        }
        const [, inis, name] = code as unknown as [string, string, string];
        if (!isBeerCulture(name)) continue;
        const category =
          strain.class_list
            .find((item) => item.startsWith("yeast-strain-category-"))
            ?.slice("yeast-strain-category-".length)
            .replace(/-/g, " ") ?? "";
        // The strain page shows this description; its hash records what was read.
        const source = await fetchSource(strain.link);
        const description = await fragmentText(strain.content.rendered);
        products.push({
          id: `inland-island-${inis.toLowerCase()}`,
          role: "yeasts",
          manufacturer: "Inland Island",
          manufacturerAliases: ["Inland Island Yeast", "Inland Island Yeast Laboratories"],
          codes: [inis.toUpperCase()],
          aliases: [...titleAliases(name, [], ["Yeast"]), `${inis.toUpperCase()} ${name}`],
          flavorText: description,
          source: makerSource(source),
          // Bacteria are souring; "Wild & Brett" holds both Brettanomyces and wild Saccharomyces,
          // so the name decides there; every other category is an ordinary brewing yeast.
          souring:
            category === "bacteria"
              ? true
              : category === "wild brett" || category === "alternative"
                ? souringFromStated(name, description)
                : false,
        });
      } catch (error) {
        gaps.push({
          url: strain.link,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { products, gaps };
  },
};
