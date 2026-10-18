import type { ParsedProduct } from "../build.ts";
import { fetchSource, type CachedSource } from "../fetch.ts";
import { hopName, hopVariety, inDom, slug, type MakerSource } from "../maker.ts";

const ORIGIN = "https://charlesfaram.com";

/** Hop Oracle pages (Elementor): `h1` "Summit™<br>Hop Variety Characteristics and
 * Specifications", an `h3` "Hop Variety Description" followed by its text widget, the tech
 * specs, then "In THe Beer" and "In The Rub" columns of icons whose `alt` is the label
 * ("tropical fruit", "grapefruit"). Some alts are the icon's file name
 * ("CharlesFaram-icon-citrus-04-lemon", label last), some carry an editor's note ("floral /
 * herbal for Epic Hops, Fox hops"), and a broken repeater prints placeholders
 * ("%usa_in_the_rub|alt_by_id%"). The long "More Information About …" article below (brewing
 * advice, pairings, beers that use the hop) is never read. */
function readPage() {
  const headings = [...document.querySelectorAll("h3")];
  const heading = (label: string) =>
    headings.find((element) => (element.textContent ?? "").trim().toLowerCase() === label);
  const icons = (label: string) =>
    [...(heading(label)?.closest(".elementor-column")?.querySelectorAll("img") ?? [])].map(
      (image) => image.alt.trim(),
    );
  const next = heading("hop variety description")?.closest(".elementor-widget")?.nextElementSibling;
  const description = next?.matches(".elementor-widget-text-editor") ? (next as HTMLElement) : null;
  return {
    title: (document.querySelector("h1")?.innerText ?? "").split("\n")[0]!.trim(),
    description: (description?.innerText ?? "").trim(),
    beer: icons("in the beer"),
    rub: icons("in the rub"),
  };
}

/** An icon's label: the alt text without an editor's note, or the label part of an icon file
 * name; template placeholders and empty alts are not labels. */
const iconLabel = (alt: string): string => {
  if (/^%.*%$/.test(alt) || alt === "") return "";
  const file = /^CharlesFaram-icon-[a-z]+-\d+-([a-z-]+?)(?:-UK|-alt|-\d+)*$/i.exec(alt);
  return (file ? file[1]!.replace(/-/g, " ") : alt.replace(/ for .*$/, "")).trim();
};

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

// An origin code the title prints before or after the name ("NZ Pacific Jade", "Cascade UK").
const ORIGINS: Readonly<Record<string, string>> = {
  NZ: "New Zealand",
  UK: "United Kingdom",
  US: "United States",
};
const titleOrigin = (title: string) => {
  const coded = /^(NZ|UK|US) (.+)$/.exec(title) ?? /^(.+) (NZ|UK|US)$/.exec(title);
  if (!coded) return { name: title, origin: null };
  const [code, name] = ORIGINS[coded[1]!] ? [coded[1]!, coded[2]!] : [coded[2]!, coded[1]!];
  return { name, origin: ORIGINS[code]! };
};

export const maker: MakerSource = {
  id: "charles-faram",
  role: "hops",
  async read(limit) {
    const sitemap = await fetchSource(`${ORIGIN}/hop-oracle-sitemap.xml`);
    // Each variety is listed once per region (/uk/, /ca/, /int/, /eu/); the regional pages
    // carry the same description, and only the unprefixed page carries the icons.
    const urls = [
      ...sitemap.body.matchAll(/<loc>(https:\/\/charlesfaram\.com\/hop-oracle\/[^<]+)<\/loc>/g),
    ]
      .map((match) => match[1]!)
      .slice(0, limit);
    const described: {
      source: CachedSource;
      printed: string;
      name: string;
      origin: string | null;
      text: string;
      aliases: string[];
    }[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of urls) {
      try {
        const source = await fetchSource(url);
        const page = await inDom(source.body, readPage);
        const tags = (alts: readonly string[]) => alts.map(iconLabel).filter(Boolean).join(", ");
        const text = [tags(page.beer), tags(page.rub), page.description].filter(Boolean).join("\n");
        if (!page.title || !text) {
          gaps.push({ url, reason: "no variety name, icons or description on the page" });
          continue;
        }
        const printed = hopName(page.title);
        described.push({
          source,
          printed,
          ...titleOrigin(printed),
          text,
          aliases: earlierNames(page.description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // One entry per variety: "Cascade" wins over "Cascade UK", whose origin is noted on it.
    const byVariety = new Map<string, typeof described>();
    for (const entry of described)
      byVariety.set(slug(entry.name), [...(byVariety.get(slug(entry.name)) ?? []), entry]);
    const products: ParsedProduct[] = [];
    for (const group of byVariety.values()) {
      const [kept, ...others] = [...group].sort((a, b) => Number(!!a.origin) - Number(!!b.origin));
      products.push(
        hopVariety(kept!.source, kept!.name, kept!.text, {
          aliases: [kept!.printed, ...kept!.aliases],
          limitations: [
            ...(kept!.origin ? [`Origin: ${kept!.origin}.`] : []),
            ...others
              .filter((other) => other.origin)
              .map((other) => `Also described with origin ${other.origin} (${other.printed}).`),
          ],
        }),
      );
    }
    return { products, gaps };
  },
};
