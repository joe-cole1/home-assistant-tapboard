import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

// Hopsteiner's English variety pages live on the German group site, which the Hopsteiner PIM
// feeds and which lists every variety the group sells (US, European, UK and Southern Hemisphere).
// hopsteiner.us builds its list in the browser from a data script that answered the fetcher
// with an empty body, and pim.hopsteiner.de serves the same data sheets as PDFs only.
const ORIGIN = "https://www.hopsteiner.de";
const LISTING = `${ORIGIN}/en/products/all-hop-varieties`;

/** The listing's result cards (`a.c-hop-variety-card`): the variety page link and the growing
 * country (`.card-text`), which some variety pages leave out. */
function readListing() {
  return [...document.querySelectorAll("a.c-hop-variety-card")].map((card) => ({
    href: card.getAttribute("href") ?? "",
    country: (card.querySelector(".card-text")?.textContent ?? "").trim(),
  }));
}

/** Every listed variety; the first result page links every other one. */
async function listedVarieties(): Promise<{ url: string; country: string }[]> {
  const first = await fetchSource(LISTING);
  const last = Math.max(
    1,
    ...[...first.body.matchAll(/tx_solr%5Bpage%5D=(\d+)/g)].map((match) => Number(match[1])),
  );
  const varieties = new Map<string, string>();
  for (let page = 1; page <= last; page++) {
    const listing = page === 1 ? first : await fetchSource(`${LISTING}?tx_solr%5Bpage%5D=${page}`);
    for (const { href, country } of await inDom(listing.body, readListing))
      varieties.set(new URL(href, ORIGIN).href, country);
  }
  return [...varieties].map(([url, country]) => ({ url, country }));
}

/** Hopsteiner variety pages: `h1` name in `.c-hop-variety-header` with the predominant-taste tags
 * (`.c-hop-variety-header__tag`, e.g. "Fruity", "Citrusy") and a "Genetic origin" lineage line,
 * read only to recognise blends. `.c-hop-variety-content` holds one column per field: the "Aroma
 * evaluation" chart (0 to 5 scores), the "Aroma description" paragraph and, on some pages, an
 * unheaded paragraph that so far states only oil chemistry; only the aroma description is read.
 * Agronomy, analytics and "Alternative varieties" (substitutes) are never read. */
function readPage() {
  const header = document.querySelector(".c-hop-variety-header");
  const aroma = [...document.querySelectorAll(".c-hop-variety-content h2")].find(
    (heading) => (heading.textContent ?? "").trim().toLowerCase() === "aroma description",
  );
  return {
    name: (header?.querySelector("h1")?.textContent ?? "").trim(),
    tags: [...(header?.querySelectorAll(".c-hop-variety-header__tag") ?? [])].map((tag) =>
      (tag.textContent ?? "").trim(),
    ),
    lineage: (
      [...(header?.querySelectorAll("p") ?? [])].find((line) =>
        /^\s*genetic origin/i.test(line.textContent ?? ""),
      )?.textContent ?? ""
    ).trim(),
    description: [...(aroma?.parentElement?.querySelectorAll("p") ?? [])]
      .map((paragraph) => (paragraph as HTMLElement).innerText.trim())
      .filter(Boolean)
      .join("\n"),
  };
}

export const maker: MakerSource = {
  id: "hopsteiner",
  role: "hops",
  async read(limit) {
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const { url, country } of (await listedVarieties()).slice(0, limit)) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        // A blend of named varieties (Trident) has no fixed composition, so it gets no entry.
        if (/\bblend\b/i.test(`${page.name} ${page.lineage}`)) continue;
        // The description comes first: the dataset keeps a variety's first eight words, and the
        // tags are broad categories.
        const flavorText = [page.description, page.tags.join(", ")].filter(Boolean).join("\n");
        if (!page.name || !flavorText) {
          gaps.push({ url, reason: "no variety name or aroma text on the page" });
          continue;
        }
        // "Columbus/ Tomahawk" prints two names of one variety; "Lubelski (Lublin)" and
        // "Styrian Golding (Celeia)" print a second name in brackets, where "Golding (UK)"
        // prints an origin.
        const [printed, ...others] = page.name.split("/").map((name) => name.trim());
        const bracketed = /\(([^)]+)\)\s*$/.exec(page.name)?.[1]?.trim();
        const aliases =
          bracketed && !/^(?:UK|US|USA|NZ|AU|DE|CZ|FR|SI|PL)$/i.test(bracketed)
            ? [...others, bracketed]
            : others;
        products.push(
          hopVariety(source, printed!, flavorText, {
            aliases,
            limitations: country ? [`Origin: ${country}.`] : [],
          }),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
