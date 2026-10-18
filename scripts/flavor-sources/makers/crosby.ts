import type { ParsedProduct } from "../build.ts";
import { fetchSource, type CachedSource } from "../fetch.ts";
import { hopName, hopVariety, inDom, slug, type MakerSource } from "../maker.ts";

const ORIGIN = "https://www.crosbyhops.com";
// Origin prefixes Crosby prints before a variety name ("Czech Saaz", "GR Perle", "NZ Cascade").
const ORIGINS: Readonly<Record<string, string>> = {
  AU: "Australia",
  CZ: "Czech Republic",
  Czech: "Czech Republic",
  FR: "France",
  GR: "Germany",
  NZ: "New Zealand",
  SI: "Slovenia",
  UK: "United Kingdom",
  US: "United States",
};

/** Crosby's current variety pages (HubSpot), listed on /hops/varieties/: `h1` "Citra® HBC 394"
 * (Deep Cut™ Cascade has only the page title), the description rich text just before "Available
 * Formats", a "Characteristics" heading followed by three tag cards, then labelled rich texts
 * "Profile …", "Beer Styles …" and "Pairings …", the "Brewing Values" table and a "Sensory
 * Analysis" testimonial. Only the description, the characteristic tags and the profile are read. */
function readVariety() {
  const rich = [...document.querySelectorAll<HTMLElement>(".hs_cos_wrapper_type_rich_text")].map(
    (block) => block.innerText.trim(),
  );
  const formats = rich.indexOf("Available Formats");
  const heading = [...document.querySelectorAll("h4")].find(
    (element) => (element.textContent ?? "").trim() === "Characteristics",
  );
  const cards = [...document.querySelectorAll(".cards")].find(
    (element) =>
      heading && heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const profile = rich.find((text) => /^Profile\b/.test(text)) ?? "";
  return {
    title: (document.querySelector("h1")?.textContent || document.title).trim(),
    description: formats > 0 ? rich[formats - 1]! : "",
    characteristics: [...(cards?.querySelectorAll(".card__content") ?? [])].map((card) =>
      (card.textContent ?? "").trim(),
    ),
    profile: profile.replace(/^Profile\s*:?\s*/, ""),
  };
}

/** Crosby's older brewer-portal product pages (/products/<code>, still in the sitemap): the page
 * title "GR Perle", then "Hop Description" and "Aroma Profile" (a tag list) as `h5` labels with
 * a `p.pdp-text` each, then the analysis table. Pages without data say "No information
 * currently available." */
function readProduct() {
  const field = (label: string) =>
    [...document.querySelectorAll("h5")]
      .find((heading) => (heading.textContent ?? "").trim() === label)
      ?.nextElementSibling?.textContent?.replace(/\s+/g, " ")
      .trim() ?? "";
  return {
    title: document.title.trim(),
    description: field("Hop Description"),
    aroma: field("Aroma Profile"),
  };
}

interface Described {
  readonly url: string;
  readonly source: CachedSource;
  /** The title as printed, without what follows a dash or comma ("Thora - Estate Grown"). */
  readonly printed: string;
  readonly name: string;
  readonly origin: string | null;
  /** Other names: a breeder code in the title ("HBC 394") and earlier names the text gives. */
  readonly codes: readonly string[];
  readonly limitations: readonly string[];
  readonly text: string;
  readonly blend: boolean;
}

/** Name parts of a Crosby title: a breeder code after the trademark sign ("Citra® HBC 394",
 * "Amarillo® VGXP01 c.v.", "Azacca® (ADHA-483)"), which is another name for the variety, an
 * origin prefix ("GR Perle", "Czech Saaz") and a grower or form prefix ("Hop Revolution
 * Riwaka™", "Organic El Dorado®"). */
function parseTitle(title: string) {
  let printed = title
    .replace(/\s+/g, " ")
    .split(/ [-–] |,/)[0]!
    .trim();
  const codes: string[] = [];
  const limitations: string[] = [];
  const coded = /^(.+?[®™]) ?\(?([A-Z]{2,}[ -]?\d+[\w-]*)\)?(?: c\.v\.)?$/.exec(printed);
  if (coded) {
    printed = coded[1]!;
    codes.push(coded[2]!);
  }
  let name = printed;
  let origin: string | null = null;
  const prefixed = /^(\S+) (.+)$/.exec(name);
  if (prefixed && ORIGINS[prefixed[1]!]) {
    origin = ORIGINS[prefixed[1]!]!;
    name = prefixed[2]!;
    limitations.push(`Origin: ${origin}.`);
  }
  const grower = /^(Hop Revolution|Organic) (.+)$/.exec(name);
  if (grower) {
    name = grower[2]!;
    if (grower[1] === "Hop Revolution") limitations.push("Grower: Hop Revolution.");
  }
  return { printed, name, origin, codes, limitations };
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

// A blend of named varieties ("Crosby Blend", "this unique blend of choice Riwaka™, Moutere™
// and Motueka™") has no single variety; "a unique blend of citrus, melon …" is a flavour.
const isBlend = (title: string, description: string) =>
  /\bblend\b/i.test(title) || /\bblend of\s+(?:\w+\s+)?[A-Z]/.test(description);

export const maker: MakerSource = {
  id: "crosby",
  role: "hops",
  async read(limit) {
    const listing = await fetchSource(`${ORIGIN}/hops/varieties/`);
    const varieties = [
      ...new Set(
        [
          ...listing.body.matchAll(
            /href="(https:\/\/www\.crosbyhops\.com\/hops\/varieties\/[^"?]+)/g,
          ),
        ].map((match) => match[1]!),
      ),
    ];
    const sitemap = await fetchSource(`${ORIGIN}/sitemap.xml`);
    const products = [
      ...sitemap.body.matchAll(
        /<loc>(https:\/\/www\.crosbyhops\.com\/products\/[a-z0-9]+)<\/loc>/g,
      ),
    ].map((match) => match[1]!);
    const described: Described[] = [];
    const gaps: { url: string; reason: string }[] = [];
    for (const url of [...varieties, ...products].slice(0, limit)) {
      try {
        const source = await fetchSource(url);
        const variety = url.includes("/hops/varieties/");
        const page = variety
          ? await inDom(source.body, readVariety)
          : await inDom(source.body, readProduct);
        const lines =
          "profile" in page
            ? [page.characteristics.join(", "), page.profile, page.description]
            : [page.aroma, page.description];
        const text = lines.filter(Boolean).join("\n");
        if (!page.title || !text) {
          gaps.push({ url, reason: "the page has no description or aroma profile" });
          continue;
        }
        const title = parseTitle(page.title);
        described.push({
          url,
          source,
          ...title,
          codes: [...title.codes, ...earlierNames(page.description)],
          text,
          blend: isBlend(page.title, page.description),
        });
      } catch (error) {
        gaps.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // One entry per variety, where pages share a name or another name ("Vista (also known as
    // USDA Elite Line 074)" and "USDA 074 (also known as USDA Elite Line 074)"): a current
    // variety page wins over an older product page, an unprefixed name over an origin-prefixed
    // one, then the listing order. Other origins are noted on the kept entry, and every page's
    // names name it.
    const groups: { names: Set<string>; entries: Described[] }[] = [];
    for (const entry of described.filter((entry) => !entry.blend)) {
      const names = new Set([entry.name, ...entry.codes].map((name) => slug(hopName(name))));
      const matching = groups.filter((group) => [...names].some((name) => group.names.has(name)));
      const merged = { names, entries: [entry] };
      for (const group of matching) {
        group.names.forEach((name) => merged.names.add(name));
        merged.entries.unshift(...group.entries);
        groups.splice(groups.indexOf(group), 1);
      }
      groups.push(merged);
    }
    const kind = (entry: Described) =>
      (entry.url.includes("/products/") ? 2 : 0) + (entry.origin ? 1 : 0);
    const result: ParsedProduct[] = [];
    for (const { entries: group } of groups) {
      const [kept, ...others] = [...group].sort((a, b) => kind(a) - kind(b));
      const otherOrigins = others
        .filter((other) => other.origin && other.origin !== kept!.origin)
        .map((other) => `Also described with origin ${other.origin} (${hopName(other.printed)}).`);
      result.push(
        hopVariety(kept!.source, kept!.name, kept!.text, {
          aliases: [kept!.printed, ...group.flatMap((entry) => [entry.name, ...entry.codes])],
          limitations: [...new Set([...kept!.limitations, ...otherOrigins])],
        }),
      );
    }
    return { products: result, gaps };
  },
};
