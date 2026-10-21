import type { ParsedProduct } from "../build.ts";
import { fetchSource } from "../fetch.ts";
import { inDom, makerSource, slug, titleAliases, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.castlemalting.com";

interface Listed {
  readonly name: string;
  readonly href: string;
  readonly colour: string;
  readonly groups: readonly string[];
}

/** Castle's `CastleMaltingMalts.asp` lists every product once per group it belongs to: a
 * `.TabBlock` per group (`h3` "Brewing Malts", "Caramel Malts", "Bairds Malts", "Distilling
 * Malts", "Organic Malts", …) holding `.ProductItem`s, each with the printed `.ProductName`, a link
 * to its `MaltInfo/?…` page and a `.ProductDescription` starting "Wort color: 3.0-4.0 EBC/ 1.7-2.1
 * Lovibond". Flakes are in the same list. Several organic products link to the page of their
 * conventional sibling. */
function readListing(): Listed[] {
  const byName = new Map<
    string,
    { name: string; href: string; colour: string; groups: string[] }
  >();
  for (const block of document.querySelectorAll(".TabBlock")) {
    const group = (block.querySelector("h3")?.textContent ?? "").trim();
    for (const item of block.querySelectorAll(".ProductItem")) {
      const name = (item.querySelector(".ProductName")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const href = item.querySelector("a[href*='/MaltInfo/']")?.getAttribute("href") ?? "";
      const colour = /Wort color:\s*(.+)/.exec(
        (item.querySelector<HTMLElement>(".ProductDescription")?.innerText ?? "").trim(),
      );
      const listed = byName.get(name) ?? {
        name,
        href,
        colour: (colour?.[1] ?? "").replace(/\s+/g, " ").trim(),
        groups: [],
      };
      listed.groups.push(group);
      byName.set(name, listed);
    }
  }
  return [...byName.values()];
}

interface Page {
  /** Labelled sections: "Features", "Characteristics", "Usage", "Packaging", "Note". */
  readonly sections: Readonly<Record<string, string>>;
}

/** A `MaltInfo` page shows the product header, then one `div` per section: a `strong` label
 * ("Features", "Characteristics", "Usage", "Packaging", "Note") followed by a `p`. Features
 * describes the type and how the malt is made, Characteristics what it gives the beer, Usage the
 * styles and share of the mix, Note sometimes a renaming. Only Characteristics is read as flavour.
 * The specification table and the "Malt groups" line sit outside these sections. */
function readPage(): Page {
  const sections: Record<string, string> = {};
  for (const label of document.querySelectorAll("div > strong")) {
    const body = label.nextElementSibling;
    if (body?.tagName === "P")
      sections[(label.textContent ?? "").trim().toLowerCase()] = (
        body as HTMLElement
      ).innerText.trim();
  }
  return { sections };
}

const BEER = /\b(?:beers?|ales?|lagers?|porters?|stouts?)\b/i;

/** The maltster's names for a product: as printed, without the bracketed "(ORGANIC MALT)", the
 * footnote star and the Château prefix, and the separate name printed for the US market. */
function printedNames(name: string): string[] {
  const us = /([^(),]+?) for the US market/i.exec(name)?.[1];
  const plain = (text: string) => text.replace(/\s*\([^)]*\)/g, "").replace(/\*+$/, "");
  return [
    ...new Set(
      [name, plain(name), ...(us ? [us, plain(us)] : [])].flatMap((printed) =>
        titleAliases(printed.replace(/\s+/g, " ").trim(), ["MALT CHÂTEAU", "CHÂTEAU"]),
      ),
    ),
  ];
}

export const maker: MakerSource = {
  id: "castle",
  role: "fermentables",
  async read(limit) {
    const listing = await fetchSource(`${ORIGIN}/CastleMaltingMalts.asp?Language=English`);
    const listed = (await inDom(listing.body, readListing))
      // Bairds malts are Bairds products that Castle resells.
      .filter(({ groups }) => !groups.includes("Bairds Malts"))
      .slice(0, limit);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const item of listed) {
      const url = item.href;
      try {
        if (!url) {
          gaps.push({ url: listing.url, reason: `${item.name} has no MaltInfo link` });
          continue;
        }
        const source = await fetchSource(url);
        const { sections } = await inDom(source.body, readPage);
        // Whisky malts are listed with the brewing malts but their usage names no beer.
        if (item.groups.includes("Distilling Malts") && !BEER.test(sections["usage"] ?? ""))
          continue;
        const aliases = printedNames(item.name);
        // "Château Special B® became Château Special Belgium®": the former name is the
        // maltster's own and Brewfather users still write it.
        const renamed = /^(.+?)\s+became\s+(.+)$/im.exec(sections["note"] ?? "");
        if (
          renamed &&
          printedNames(renamed[2]!.trim()).some((name) =>
            aliases.some((alias) => alias.toLowerCase() === name.toLowerCase()),
          )
        )
          aliases.push(...printedNames(renamed[1]!.trim()));
        products.push({
          id: `castle-${slug(item.name)}`,
          role: "fermentables",
          manufacturer: "Castle Malting",
          manufacturerAliases: ["Malterie du Château"],
          codes: [],
          aliases: [...new Set(aliases)],
          flavorText: (sections["characteristics"] ?? "")
            // Some paragraphs end in a literal "<br><br>", and source lines break mid-sentence.
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/\s*\n\s*/g, " ")
            .trim(),
          source: makerSource(source),
          limitations: item.colour ? [`Maltster colour: ${item.colour}.`] : [],
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
