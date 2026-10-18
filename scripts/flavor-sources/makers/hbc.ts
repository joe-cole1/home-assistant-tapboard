import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

// The sitemap lists only this page: every variety is on it.
const ORIGIN = "https://www.hopbreeding.com";

interface Listed {
  readonly title: string;
  readonly target: string;
  readonly paragraphs: readonly string[] | null;
}

/** Hop Breeding Company's one-page site: `ul.variety` lists each variety as an `h4` "Citra® -
 * HBC 394" whose "View Details" link targets a `#details .toggle` block. That block holds the
 * same heading as an `h2`, the descriptive paragraph (release history and character together),
 * an analytics list (alpha, beta, oils), which is never read, and an image paragraph. The
 * brochure and press-release PDFs repeat the paragraph and are not read. */
function readVarieties(): Listed[] {
  return [...document.querySelectorAll("ul.variety > li")].map((item) => {
    const target = (item.querySelector("a.tabs")?.getAttribute("href") ?? "").replace(/^#/, "");
    const block = target ? document.getElementById(target) : null;
    return {
      title: (item.querySelector("h4")?.textContent ?? "").trim(),
      target,
      paragraphs: block
        ? [...block.querySelectorAll<HTMLElement>(":scope > p")]
            .map((paragraph) => paragraph.innerText.trim())
            .filter((text) => text !== "")
        : null,
    };
  });
}

export const maker: MakerSource = {
  id: "hbc",
  role: "hops",
  async read(limit) {
    const source = await fetchSource(ORIGIN);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const { title, target, paragraphs } of (await inDom(source.body, readVarieties)).slice(
      0,
      limit,
    )) {
      const url = `${ORIGIN}/#${target}`;
      if (!paragraphs?.length) {
        gaps.push({ url, reason: `no description block for "${title}"` });
        continue;
      }
      // "Citra® - HBC 394": the brand name, then HBC's experimental code for the same variety.
      const named = /^(.+?)\s+-\s+(HBC\s+\d+)$/.exec(title);
      products.push(
        hopVariety(source, named?.[1] ?? title, paragraphs.join("\n"), {
          aliases: named ? [named[2]!] : [],
        }),
      );
    }
    return { products, gaps };
  },
};
