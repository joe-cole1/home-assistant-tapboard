import type { ParsedProduct } from "../build.ts";
import { fetchSource, type CachedSource } from "../fetch.ts";
import { hopName, hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://hops.com.au";

interface Card {
  /** The card's heading; HPA's own varieties show a logo image instead. */
  readonly name: string;
  readonly region: string;
  readonly flavour: string;
  readonly url: string;
}

/** HPA's hop listing (`/hops/`): one Elementor loop card (`.e-loop-item`) per variety. A card
 * has an `h2` name (HPA's own varieties show a logo image instead), the region ("Australia",
 * "Europe", "United States"), then a `.details` block whose first, screen-hidden container holds
 * the flavour line that the card's taste-tag image draws ("Passionfruit, Peach, Citrus"), the
 * alpha and oil ranges, a data-sheet link and a link to the variety page. */
function readListing(): Card[] {
  return [...document.querySelectorAll<HTMLElement>(".e-loop-item")].map((card) => {
    const details = card.querySelector<HTMLElement>(".details");
    const hidden = ".elementor-hidden-desktop.elementor-hidden-tablet.elementor-hidden-mobile";
    return {
      name: (card.querySelector("h2")?.textContent ?? "").trim(),
      region: ((details?.previousElementSibling as HTMLElement | null)?.innerText ?? "").trim(),
      flavour: (details?.querySelector<HTMLElement>(hidden)?.innerText ?? "").trim(),
      url:
        [...card.querySelectorAll("a")]
          .map((anchor) => anchor.href)
          .find((href) => /^https:\/\/hops\.com\.au\/[a-z0-9-]+\/$/.test(href)) ?? "",
    };
  });
}

/** HPA variety pages: the title "Galaxy – HPA", and for HPA's own varieties (and its Cascade) a
 * text column whose text widgets run: the description, "Flavour Profile" (an image of tags),
 * "Ancestry" and "Recommended beer styles"; only the description is read. Pages of the varieties
 * HPA merchants (Simcoe, Saaz, …) carry only the name. */
function readPage() {
  const texts = [...document.querySelectorAll<HTMLElement>("main .elementor-widget-text-editor")]
    .map((widget) => widget.innerText.trim())
    .filter((text) => text);
  const marker = texts.findIndex((text) => /^flavou?r profile$/i.test(text));
  return {
    title: document.title.replace(/\s*[–-]\s*HPA\s*$/, "").trim(),
    description: marker === -1 ? "" : texts.slice(0, marker).join("\n"),
  };
}

export const maker: MakerSource = {
  id: "hpa",
  role: "hops",
  async read(limit) {
    const listing = await fetchSource(`${ORIGIN}/hops/`);
    const cards = await inDom(listing.body, readListing);
    const gaps: { url: string; reason: string }[] = [];
    const read: { card: Card; printed: string; description: string; source: CachedSource }[] = [];
    for (const card of cards.slice(0, limit)) {
      if (!card.url) {
        gaps.push({ url: listing.url, reason: `the card "${card.name}" links no variety page` });
        continue;
      }
      try {
        const source = await fetchSource(card.url);
        const page = await inDom(source.body, readPage);
        const printed = card.name || page.title;
        if (printed) read.push({ card, printed, description: page.description, source });
        else gaps.push({ url: card.url, reason: "no variety name on the card or the page" });
      } catch (error) {
        gaps.push({
          url: card.url,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // HPA lists Cascade twice, Australian and US grown: the Australian crop is HPA's own and is
    // kept, and the other origins are noted.
    const products: ParsedProduct[] = [];
    const byName = Map.groupBy(read, ({ printed }) => hopName(printed).toLowerCase());
    for (const same of byName.values()) {
      const primary = same.find(({ card }) => card.region === "Australia") ?? same[0]!;
      const others = same.filter((other) => other !== primary && other.card.region);
      const { card, printed, description, source } = primary;
      products.push(
        // The flavour line is the listing card's; the variety page is cited when it adds the
        // description, and the listing otherwise.
        hopVariety(
          description ? source : listing,
          printed,
          [card.flavour, description].filter((text) => text).join("\n"),
          {
            limitations: [
              ...(card.region ? [`Origin: ${card.region}.`] : []),
              ...(others.length
                ? [`The source also lists it from: ${others.map((o) => o.card.region).join(", ")}.`]
                : []),
            ],
          },
        ),
      );
    }
    return { products, gaps };
  },
};
