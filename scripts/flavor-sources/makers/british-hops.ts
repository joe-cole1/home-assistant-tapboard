import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.britishhops.org.uk";
// Flavour sections, in page order. "Bittering Characteristics" describes how the bitterness
// tastes ("sweet, smooth and honey-like"); "Flavour Intensity" (a score), "Breeding" (lineage
// and agronomy) and the analysis table are never read.
const FLAVOUR_SECTIONS = [
  "flavour and aroma",
  "characteristics",
  "bittering characteristics",
  "about this hop",
];

/** British Hop Association variety pages: `h1` "Cascade (UK)" in the banner, then `main .row`
 * blocks, each an `h2` label ("Flavour and Aroma", "Characteristics" (a short tag list),
 * "Bittering Characteristics", "Flavour Intensity", "About this Hop", "Breeding") and a
 * `.content` block, then the "Analysis" table. */
function readPage() {
  const sections: Record<string, string> = {};
  for (const row of document.querySelectorAll("main .row")) {
    const label = (row.querySelector("h2")?.textContent ?? "").trim().toLowerCase();
    const content = row.querySelector<HTMLElement>(".content")?.innerText ?? "";
    if (label) sections[label] = content.trim();
  }
  return { title: (document.querySelector("h1")?.textContent ?? "").trim(), sections };
}

// Other names a description gives for the variety: "Formerly known as Denali", "originally
// named YQH-1320", "Once designated HRC-003 or W1108-333", "once known as “Experimental Pine
// Fruit”", "Synonymous with English Goldings". A name is a run of capitalised words or codes
// ending at punctuation or a lowercase word, so a run-on ("Styrian Golding ‘B’Light floral …")
// yields nothing.
const NAME = String.raw`((?:[“‘"']?[A-Z0-9][\w/-]*[”’"']?)(?: [“‘"']?[A-Z0-9][\w/-]*[”’"']?)*)(?=[,.;:)]|\s+[a-z]|$)`;
const EARLIER_NAME = new RegExp(
  String.raw`\b(?:(?:[Ff]ormerly|[Pp]reviously|[Oo]riginally|[Oo]nce|[Aa]lso) (?:known? as|named|called|designated)|[Ss]ynonymous with) ${NAME}(?: or ${NAME})?`,
  "g",
);
const earlierNames = (text: string) =>
  [...text.matchAll(EARLIER_NAME)]
    .flatMap((match) => [match[1], match[2]])
    .filter((name): name is string => !!name)
    .map((name) => name.replace(/[“”‘’"']/g, ""));

export const maker: MakerSource = {
  id: "british-hops",
  role: "hops",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/hop_variety-sitemap.xml`);
    const urls = [
      ...sitemap.body.matchAll(
        /<loc>(https:\/\/www\.britishhops\.org\.uk\/varieties\/[^<]+)<\/loc>/g,
      ),
    ]
      .map((match) => match[1]!)
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        const text = FLAVOUR_SECTIONS.map((label) => page.sections[label] ?? "")
          .filter(Boolean)
          .join("\n");
        if (!page.title || !text) {
          gaps.push({ url, reason: "no variety name or flavour sections" });
          continue;
        }
        const aliases = earlierNames(text);
        // The association lists British-grown varieties; "Cascade (UK)" says so in its name.
        products.push(
          hopVariety(source, page.title, text, {
            aliases,
            limitations: ["Origin: United Kingdom."],
          }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
