import type { ParsedProduct } from "../build.ts";
import { fetchSource, pdfText } from "../fetch.ts";
import { hopVariety, inDom, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.johnihaas.com";

interface Card {
  readonly title: string;
  readonly categories: readonly string[];
  readonly region: string;
  readonly sheet: string | null;
  readonly page: string | null;
}

/** The hops listing (/products/hops/) has one `div.hop` card per variety: `h3.product-card__title`
 * with the name and, for bred varieties, the cultivar code ("Citra®" and "HBC 394 c.v."), the
 * dominant Haas Aroma Standards categories as icon `alt` texts, "Region: USA", and buttons
 * "Download Specs" (the variety's data sheet PDF) and, for some, "Learn More". The featured cards
 * above the listing repeat listed varieties. */
function readListing(): Card[] {
  return [...document.querySelectorAll<HTMLElement>("div.hop")].map((card) => ({
    title: card.querySelector<HTMLElement>(".product-card__title")?.innerText.trim() ?? "",
    categories: [...card.querySelectorAll(".product-card__icons img")].map((icon) =>
      (icon.getAttribute("alt") ?? "").trim(),
    ),
    region: (card.querySelector(".product-card__region p")?.textContent ?? "")
      .replace(/^\s*region:\s*/i, "")
      .trim(),
    sheet: card.querySelector("a[title='Download Specs']")?.getAttribute("href") ?? null,
    page: card.querySelector("a[title='Learn More' i]")?.getAttribute("href") ?? null,
  }));
}

/** Variety pages under /products/hops/: a hero intro on pedigree and use, the "Variety Details"
 * paragraph on the hop's character (`.spotlight-details__body`), dominant characteristics (the
 * listing's categories), analytics, style recommendations, sensory pairings, similar varieties,
 * reviews and product formats. Only "Variety Details" is read. */
function readVarietyPage(): string {
  return document.querySelector<HTMLElement>(".spotlight-details__body")?.innerText.trim() ?? "";
}

/** Text blocks of a PDF page laid out by pdftotext: runs of lines separated by blank lines, each
 * joined into one line. */
const blocks = (text: string): string[] =>
  text
    .split(/\n[^\S\n]*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);

// A cultivar code on its own: "HBC 1019 c.v.", or spaced out as "H B C 394 c .v.".
const CODE = /^[\sA-Z0-9-]*c\s*\.\s*v\s*\.?\s*$/;

/** Haas MiniSpecSheets (and the Hallertauer sheets in the same layout): the origin and the name in
 * capitals, the cultivar code, a background paragraph on breeding and character, the aroma
 * descriptor line, then analytics from "Alpha (%)". The aroma line comes first. */
function miniSheet(text: string): string[] | null {
  const end = text.search(/^\s*Alpha \(%\)/m);
  if (end === -1) return null;
  const read = blocks(
    text
      .slice(0, end)
      .split("\n")
      // Capitalised origin and name lines, and a cultivar code on its own ("H B C 394 c .v.").
      .filter((line) => /[a-z]/.test(line) && !CODE.test(line))
      .join("\n"),
  );
  return read.length ? [read.at(-1)!, ...read.slice(0, -1)] : null;
}

/** Hop France technical sheets (Comptoir agricole): two columns. The right one holds "TECHNICAL
 * DATA", the "AROMA QUALITIES" descriptor line (wrapped above and below the label when long) and
 * analytics; the left one the description paragraphs, then "BREWING QUALITIES" (styles) and the
 * "SENSORY EVALUATION" wheel, whose legend lists every category's example aromas and is never
 * read. */
function hopFranceSheet(text: string): string[] | null {
  const lines = text.split("\n");
  const label = lines.findIndex((line) => line.includes("AROMA QUALITIES"));
  const start = lines.findIndex((line) => line.includes("TECHNICAL DATA"));
  if (label === -1 || start === -1) return null;
  const valueFrom = lines[label]!.indexOf("AROMA QUALITIES") + "AROMA QUALITIES".length;
  const aroma = lines
    .slice(label - 1, label + 2)
    .map((line) => line.slice(valueFrom).trim())
    .filter(Boolean)
    .join(" ");
  const column = lines[start]!.indexOf("TECHNICAL DATA");
  const left: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const part = line.slice(0, column).trim();
    if (/^BREWING QUALITIES/.test(part)) break;
    left.push(part);
  }
  return [aroma, ...blocks(left.join("\n"))];
}

/** Words laid out as side-by-side tags left of `before`, each tag possibly wrapped onto the next
 * lines in its own column ("Stone Fruits," over "Banana"). */
function columnTags(lines: readonly string[], before: number): string[] {
  const tags: { from: number; to: number; text: string }[] = [];
  for (const line of lines)
    for (const match of line.slice(0, before).matchAll(/\S+(?: \S+)*/g)) {
      const from = match.index;
      const to = from + match[0].length;
      const tag = tags.find((other) => from < other.to && to > other.from);
      if (tag) tag.text += ` ${match[0]}`;
      else tags.push({ from, to, text: match[0] });
    }
  return tags.map(({ text }) => text.replace(/,$/, ""));
}

/** Running text of a page region set in side-by-side text columns, read column by column.
 * Capitalised headings, cultivar codes and the bare variety name are left out. */
function columnText(lines: readonly string[], name: string): string {
  const columns = new Map<number, { row: number; text: string }[]>();
  lines.forEach((line, row) => {
    // Words in one column are at most two spaces apart; columns are further apart.
    for (const match of line.matchAll(/\S+(?: {1,2}\S+)*/g)) {
      const text = match[0];
      if (!/[a-z]/.test(text) || CODE.test(text)) continue;
      if (text.replace(/[®™]/g, "").trim().toLowerCase() === name.toLowerCase()) continue;
      const start =
        [...columns.keys()].find((at) => Math.abs(at - match.index) <= 3) ?? match.index;
      columns.set(start, [...(columns.get(start) ?? []), { row, text }]);
    }
  });
  return [...columns]
    .sort(([a], [b]) => a - b)
    .map(([, parts]) =>
      parts
        .map(({ row, text }, at) => (at > 0 && row - parts[at - 1]!.row > 1 ? `\n${text}` : text))
        .join("\n"),
    )
    .join("\n\n");
}

// Section headings at the left margin of the Haas spec sheets; the description precedes them.
const SPEC_SECTION =
  /^ {0,9}(?:PEDIGREE|KEY FLAVORS|Key Flavors|BEER VS\. HOP ATTRIBUTES|CROP ASSESSMENT|Crop Assessment)\b/;

/** Haas spec sheets (BRU-1, Motueka, Talus, Krush, Dolcita, TerraSurge, TerraFlux): the name and
 * cultivar code, a description in one or two text columns (headed "AROMA PROFILE" on some), then
 * sections at the left margin: "PEDIGREE", "RECOMMENDED BEER STYLES", "KEY FLAVORS" (printed tags
 * on some sheets, an image on others), "CROP ASSESSMENT" and "RECOMMENDED HOP PAIRINGS", with
 * analytics in a right-hand column from "ANALYTICAL DATA" or "TOTAL OIL COMPOSITION". Later pages
 * chart beer against hop scores or quote brewers. Only the description and the printed key
 * flavours are read. */
function specSheet(text: string, name: string): string[] | null {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => SPEC_SECTION.test(line));
  if (end === -1) return null;
  const description = blocks(columnText(lines.slice(0, end), name));
  const flavors = lines.findIndex((line) => /^ {0,9}KEY FLAVORS\b/i.test(line));
  const analytics = Math.min(
    ...lines
      .map((line) => line.search(/TOTAL OIL COMPOSITION|ANALYTICAL DATA/i))
      .filter((at) => at > 0),
  );
  const after = flavors === -1 ? [] : lines.slice(flavors + 1);
  const stop = after.findIndex((line) =>
    /Haas, Inc\.|JOHNIHAAS\.COM|^\s*(?:CROP ASSESSMENT|Crop Assessment|RECOMMENDED)/i.test(
      line.slice(0, analytics),
    ),
  );
  const tags = columnTags(after.slice(0, stop === -1 ? undefined : stop), analytics);
  return [tags.join(", "), ...description];
}

/** Hop Products Australia data sheets (Galaxy, Ella, Luna, …): an introduction on the hop's story
 * and flavour, then "Breeding" (lineage) beside the "Aroma & flavour" tags (categories over
 * example aromas, running on beside "Growing"), "Contracting", brewers' quotes, sensory charts
 * and analytics. The introduction and the tags are read; the introduction's sentence listing
 * notable beers that use the hop is a list of beers, not a description, and is left out. */
function hpaSheet(text: string): string[] | null {
  const lines = text.split("\n");
  const breeding = lines.findIndex((line) => /^Breeding\b/.test(line));
  const heading = breeding === -1 ? -1 : lines[breeding]!.indexOf("Aroma & flavour");
  if (heading === -1) return null;
  const tags: string[] = [];
  for (const line of lines.slice(breeding + 1)) {
    if (/^Contracting\b|also available in/.test(line)) break;
    for (const match of line.matchAll(/\S+(?: \S+)*/g))
      if (match.index >= heading - 4) tags.push(match[0].replace(/,$/, ""));
  }
  const introduction = blocks(lines.slice(0, breeding).join("\n")).map((paragraph) =>
    paragraph
      .split(/(?<=\.)\s+/)
      .filter((sentence) => !/\bnotable beers\b/i.test(sentence))
      .join(" "),
  );
  return [tags.join(", "), ...introduction];
}

/** The name, cultivar code and experimental flag a card title prints: "Azacca®\nADHA 483 c.v.",
 * "TerraSurge™ HBC 1325 c.v.", "HBC 1134 c.v. EXPERIMENTAL HOP", "Columbus (CTZ)". */
function cardName(title: string): { printed: string; code: string | null } {
  const plain = title.replace(/experimental hop/i, "").trim();
  const split = /^([^\n®™]+?)\s*(?:[®™]\s*|\n)\s*([\s\S]*)$/.exec(plain);
  const name = (split?.[1] ?? plain).replace(/\s*c\.v\.$/i, "").trim();
  const code = (split?.[2] ?? "").replace(/\s*c\.v\.$/i, "").trim();
  return { printed: name, code: code || null };
}

/** Other names a sheet's own text gives the variety: "also known as Hersbrucker Spät",
 * "formerly named 2010/008/033 c.v.", "released in 2014 as “Equinox” … renamed". */
function statedAliases(text: string): string[] {
  const names = [
    ...text.matchAll(
      /\b(?:also|originally|formerly) (?:known as|named)\s+(.+?)(?=\s+c\.v\.|[,;]|\.(?:\s|$))/gi,
    ),
  ].map((match) => match[1]!.trim());
  if (/\brenamed\b/i.test(text))
    names.push(...[...text.matchAll(/\bas\s+[“"]([^”"]+)[”"]/g)].map((match) => match[1]!));
  return names;
}

export const maker: MakerSource = {
  id: "john-i-haas",
  role: "hops",
  async read(limit) {
    const listing = await fetchSource(`${ORIGIN}/products/hops/`);
    const cards = new Map<string, Card>();
    for (const card of await inDom(listing.body, readListing))
      if (!cards.has(card.title)) cards.set(card.title, card);
    const products: ParsedProduct[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const card of [...cards.values()].slice(0, limit)) {
      // A blend of named varieties ("MJF Blend") has no fixed composition, so it gets no entry.
      if (/\bblend\b/i.test(card.title)) continue;
      const url = card.sheet ?? card.page ?? listing.url;
      try {
        const { printed, code } = cardName(card.title);
        if (!card.sheet) {
          gaps.push({ url, reason: "no data sheet" });
          continue;
        }
        // The data sheet carries the variety's descriptors, so it is the entry's source.
        const source = await fetchSource(card.sheet);
        const sheet = await pdfText(source);
        const read =
          miniSheet(sheet) ?? hopFranceSheet(sheet) ?? hpaSheet(sheet) ?? specSheet(sheet, printed);
        if (!read) {
          gaps.push({ url, reason: "data sheet layout not recognised" });
          continue;
        }
        const [descriptors, ...paragraphs] = read;
        let details = "";
        if (card.page && new URL(card.page).pathname.startsWith("/products/hops/"))
          try {
            details = await inDom((await fetchSource(card.page)).body, readVarietyPage);
          } catch (error) {
            gaps.push({
              url: card.page,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        products.push(
          hopVariety(
            source,
            printed,
            [descriptors, card.categories.join(", "), details, ...paragraphs]
              .filter(Boolean)
              .join("\n"),
            {
              aliases: [...(code ? [code] : []), ...statedAliases(sheet)],
              limitations: card.region ? [`Origin: ${card.region}.`] : [],
            },
          ),
        );
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { products, gaps };
  },
};
