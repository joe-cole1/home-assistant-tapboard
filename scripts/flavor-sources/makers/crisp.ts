import type { ParsedProduct } from "../build.ts";
import { fetchSource, type CachedSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://crispmalt.com";

interface Page {
  readonly h1: string;
  readonly title: string;
  readonly labels: readonly string[];
  readonly tasting: readonly string[];
  readonly paragraphs: readonly string[];
  readonly colour: Readonly<Record<string, string>>;
}

/** Crisp product pages (`/malts/<slug>/`, and `/en-us/malts/<slug>/` for the US audience) hold
 * the name in the breadcrumb `h1` (a second printed name often sits in `<title>`, before its
 * first " | "), a "Tasting Notes" list (`.malt-post__tasting li`, one tag per item), an overview
 * table of "Beer Styles", "Usage" and "Recipe" (never read; distilling products have none of
 * the first two), the descriptive text (`.malt-post__text`, whose paragraphs may end with a "Key
 * Characteristics" list) and a "Typical Analysis" table with IoB, EBC and ASBC columns. */
function readPage(): Page {
  const text = (element: Element | null | undefined) => (element?.textContent ?? "").trim();
  const colour: Record<string, string> = {};
  const table = document.querySelector(".malt-post__table table");
  const heads = [...(table?.querySelectorAll("th") ?? [])].map(text);
  for (const row of table?.querySelectorAll("tbody tr") ?? []) {
    const cells = [...row.querySelectorAll("td")].map((cell) => text(cell).replace(/\s+/g, " "));
    if (/^colou?r$/i.test(cells[0] ?? ""))
      cells.forEach((cell, index) => {
        if (index > 0 && cell !== "") colour[heads[index] ?? ""] = cell;
      });
  }
  return {
    h1: text(document.querySelector(".breadcrumb h1")),
    title: (document.title.split(" | ")[0] ?? "").trim(),
    labels: [...document.querySelectorAll(".overview-table__column h5")].map(text),
    tasting: [...document.querySelectorAll(".malt-post__tasting li")].map(text),
    paragraphs: (document.querySelector<HTMLElement>(".malt-post__text")?.innerText ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    colour,
  };
}

/** Sentences that suggest blending with other products name those products' flavours, not the
 * malt's own. */
const BLENDING_ADVICE = /\bpair (?:it )?with\b|\bcombination of\b/i;
/** Description text without a customer's quoted testimonial (a paragraph opening with a quote
 * mark, and the line naming who said it) and without blending advice. */
function description(paragraphs: readonly string[]): string[] {
  const kept: string[] = [];
  let attribution = false;
  for (const paragraph of paragraphs) {
    if (attribution) {
      attribution = false;
      continue;
    }
    if (/^[“"]/.test(paragraph)) {
      attribution = true;
      continue;
    }
    kept.push(
      paragraph
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !BLENDING_ADVICE.test(sentence))
        .join(" "),
    );
  }
  return kept.filter((paragraph) => paragraph !== "");
}

const identity = (name: string) =>
  name
    .replace(/[®™℠]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The names the maltster prints for one page: the `h1` as printed, without a "Crisp" prefix or
 * a parenthesised number, and each multi-word side of "X or Y". The `<title>` headline counts
 * as a name unless it carries a "for…" or "from Crisp" tail: those are search-result slogans. */
function names(page: Page): string[] {
  const all = new Set<string>();
  for (const printed of /\b(?:for|from)\b/i.test(page.title) ? [page.h1] : [page.h1, page.title])
    for (const form of titleAliases(printed, ["Crisp"]))
      for (const part of [form, form.replace(/\s*\([^)]*\)/g, "")])
        for (const name of [part, ...part.split(/\s+or\s+/)])
          if (name === part || name.split(" ").length > 1) all.add(name.trim());
  return [...all].filter((name) => name !== "");
}

interface Read {
  readonly url: string;
  readonly source: CachedSource;
  readonly page: Page;
  readonly names: readonly string[];
  readonly flavorText: string;
}

export const maker: MakerSource = {
  id: "crisp",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/malts-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*\/malts\/[^<]*)<\/loc>/g)]
      .map((match) => match[1]!)
      .slice(0, limit);
    const reads: Read[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.h1 === "") {
          gaps.push({ url, reason: "no product name in the page" });
          continue;
        }
        // Distilling malts list neither beer styles nor a usage rate.
        if (!page.labels.some((label) => /^(?:beer styles|usage)$/i.test(label))) continue;
        reads.push({
          url,
          source,
          page,
          names: names(page),
          flavorText: [...page.tasting, ...description(page.paragraphs)].join("\n"),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // Many malts have a UK page and a US page of the same malt. The US page is read (it is
    // the newer text, with colour in °L); names from both pages stay aliases.
    const us = (read: Read) => read.url.includes("/en-us/");
    const groups: Read[][] = [];
    for (const read of [...reads.filter(us), ...reads.filter((other) => !us(other))]) {
      const known = new Set(read.names.map(identity));
      const same = us(read)
        ? undefined
        : groups.find(
            (group) =>
              group.length === 1 &&
              us(group[0]!) &&
              group[0]!.names.some((name) => known.has(identity(name))),
          );
      if (same) same.push(read);
      else groups.push([read]);
    }
    const products: { product: ParsedProduct; headlines: Set<string> }[] = groups.map(
      ([chosen, ...others]) => {
        // Older pages have only an IoB column, whose colour cell still states its EBC unit.
        const stated = chosen!.page.colour;
        const colour = (stated["EBC"] || stated["ASBC"] ? ["EBC", "ASBC"] : ["IoB"])
          .map((unit) => stated[unit])
          .filter((value) => value !== undefined);
        const group = [chosen!, ...others];
        const product: ParsedProduct = {
          id: `crisp-${slug(chosen!.page.h1)}`,
          role: "fermentables",
          manufacturer: "Crisp",
          manufacturerAliases: ["Crisp Malt"],
          codes: [],
          aliases: [...new Set(group.flatMap((read) => read.names))],
          flavorText: chosen!.flavorText,
          source: makerSource(chosen!.source),
          limitations: colour.length ? [`Maltster colour: ${colour.join("; ")}.`] : [],
        };
        return { product, headlines: new Set(group.map((read) => identity(read.page.h1))) };
      },
    );
    // Two different pages must not print the same name, or neither could be matched. An
    // identical page text is the same malt printed twice; otherwise a shared name stays only
    // with the page whose own headline it is.
    const kept: { product: ParsedProduct; headlines: Set<string> }[] = [];
    for (const entry of products) {
      const twin = kept.find(
        (other) =>
          other.product.flavorText.toLowerCase() === entry.product.flavorText.toLowerCase() &&
          other.product.aliases.some((alias) =>
            entry.product.aliases.some((name) => identity(name) === identity(alias)),
          ),
      );
      if (twin) {
        twin.product = {
          ...twin.product,
          aliases: [...new Set([...twin.product.aliases, ...entry.product.aliases])],
        };
        for (const headline of entry.headlines) twin.headlines.add(headline);
      } else kept.push(entry);
    }
    const owners = new Map<string, number>();
    for (const { product } of kept)
      for (const alias of new Set(product.aliases.map(identity)))
        owners.set(alias, (owners.get(alias) ?? 0) + 1);
    return {
      products: kept.map(({ product, headlines }) => ({
        ...product,
        aliases: product.aliases.filter(
          (alias) => owners.get(identity(alias)) === 1 || headlines.has(identity(alias)),
        ),
      })),
      gaps,
    };
  },
};
