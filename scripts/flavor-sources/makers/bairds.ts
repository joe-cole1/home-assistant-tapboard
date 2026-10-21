import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.bairds-malt.co.uk";

interface Page {
  readonly title: string;
  readonly menu: readonly { readonly href: string; readonly label: string }[];
  readonly introduction: string;
  readonly labelled: Readonly<Record<string, string>>;
  readonly colours: Readonly<Record<string, string>>;
}

/** Bairds product pages (Divi page builder) put the name in an `h1` module and then, in page
 * order: an introduction paragraph module, the "Malt Analysis" heading with IOB/EBC/ASBC tabs,
 * and a "Malt details" heading followed by one module whose paragraphs start with a `<mark>`
 * label: "Suggested Use:", "Flavour profile:", "Inclusion rate:", "Order options:". Only the
 * introduction and the "Flavour profile" paragraph are read. Every page carries the "Malt menu"
 * of product links, whose label is the page's second printed name. */
function readPage(): Page {
  const text = (element: Element | null | undefined) => (element?.textContent ?? "").trim();
  const labelled: Record<string, string> = {};
  for (const mark of document.querySelectorAll("#main-content mark")) {
    labelled[text(mark).replace(/:$/, "").toLowerCase()] = text(mark.closest("p"))
      .slice(text(mark).length)
      .trim();
  }
  const modules = [...document.querySelectorAll<HTMLElement>("#main-content .et_pb_text_inner")];
  const first = modules.findIndex((module) => module.querySelector("h1"));
  const heading = modules.findIndex((module, index) => index > first && module.querySelector("h3"));
  const colours: Record<string, string> = {};
  for (const tabs of document.querySelectorAll("#main-content .et_pb_tabs")) {
    const labels = [...tabs.querySelectorAll(".et_pb_tabs_controls li")].map(text);
    [...tabs.querySelectorAll(".et_pb_tab_content")].forEach((content, index) => {
      const line = [...content.querySelectorAll("p")]
        .map(text)
        .find((paragraph) => /^colour/i.test(paragraph));
      if (line) colours[labels[index]!] = line.slice(line.indexOf(":") + 1).trim();
    });
  }
  return {
    title: text(document.querySelector("#main-content h1")),
    menu: [...document.querySelectorAll("#menu-malt-menu a")].map((link) => ({
      href: link.getAttribute("href") ?? "",
      label: text(link),
    })),
    introduction: modules
      .slice(first + 1, heading === -1 ? first + 2 : heading)
      .map((module) => module.innerText.trim())
      .join("\n"),
    labelled,
    colours,
  };
}

export const maker: MakerSource = {
  id: "bairds",
  role: "fermentables",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/page-sitemap.xml`);
    const urls = [...sitemap.body.matchAll(/<loc>([^<]*)<\/loc>/g)]
      .map((match) => match[1]!)
      .filter((url) =>
        /\/(?:base-malts|roasted-malts|highly-kilned-malts|other-malts|the-1823-heritage-collection)\/[a-z0-9-]+\/$/.test(
          url,
        ),
      )
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        if (page.title === "") {
          gaps.push({ url, reason: "no product name in the page" });
          continue;
        }
        // The organic-malt and toll-malting pages describe a certification and a service: they
        // have no "Malt details" labels, analysis tabs or flavour profile.
        if (Object.keys(page.labelled).length === 0) continue;
        // The IOB tab states its colour in EBC by another method; EBC and ASBC (SRM) are read.
        const colour = ["EBC", "ASBC"]
          .map((tab) => page.colours[tab])
          .filter((value) => value !== undefined);
        const menuLabel = page.menu.find((link) => link.href === url)?.label ?? "";
        products.push({
          id: `bairds-${slug(page.title)}`,
          role: "fermentables",
          manufacturer: "Bairds",
          manufacturerAliases: ["Bairds Malt"],
          codes: [],
          aliases: [
            ...new Map(
              [...titleAliases(page.title), ...titleAliases(menuLabel)].map((name) => [
                name.toLowerCase(),
                name,
              ]),
            ).values(),
          ],
          flavorText: [page.introduction, page.labelled["flavour profile"] ?? ""]
            .filter((line) => line !== "")
            .join("\n"),
          source: makerSource(source),
          limitations: colour.length ? [`Maltster colour: ${colour.join("; ")}.`] : [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
