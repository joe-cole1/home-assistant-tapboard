import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractDescriptors } from "../scripts/flavor-sources/extract.ts";
import { buildEntry } from "../scripts/flavor-sources/build.ts";
import { isBotChallenge, parseRobots, robotsAllows } from "../scripts/flavor-sources/fetch.ts";
import { LEXICON } from "../scripts/flavor-sources/lexicon.ts";
import {
  hopName,
  isBeerCulture,
  slug,
  souringFromStated,
} from "../scripts/flavor-sources/maker.ts";
import { mergeHops } from "../scripts/flavor-sources/merge.ts";
import { REVIEWED_FACTS } from "../src/features/story/flavor/catalog-data.ts";
import { sourcedFacts } from "../src/features/story/flavor/sourced.ts";

const words = (text: string, role: "fermentables" | "hops" | "yeasts" | "miscs") =>
  extractDescriptors(text, role).words.map((item) => item.word);
const reasons = (text: string, role: "fermentables" | "hops" | "yeasts" | "miscs") =>
  extractDescriptors(text, role).excluded.map((item) => `${item.word}:${item.reason}`);

void test("extraction keeps the maker's words in order and only spelling variants share a word", () => {
  assert.deepEqual(
    words(
      "Pink grapefruit, citrus rinds, dried roses, pine resin, tropical fruits and sage.",
      "hops",
    ),
    ["grapefruit", "citrus", "rose", "pine", "tropical fruit", "sage"],
  );
  // A different fruit is never substituted, and the longest phrase wins.
  assert.deepEqual(words("Mandarin, stone fruits and bread crust.", "fermentables"), [
    "mandarin",
    "stone fruit",
    "bread crust",
  ]);
  assert.deepEqual(words("Citrus, citrusy CITRUS™ and Mittelfrüh-style lemon.", "hops"), [
    "citrus",
    "lemon",
  ]);
  assert.deepEqual(extractDescriptors("Notes of bread and toffee.", "fermentables").words, [
    { word: "bready", evidence: "bread" },
    { word: "toffee", evidence: "toffee" },
  ]);
});

void test("negated, conditional and pairing mentions are reported, never kept", () => {
  const clean =
    "Very clean with low fruitiness and mild ester production. Mild citrus notes develop with cooler fermentations.";
  assert.deepEqual(words(clean, "yeasts"), []);
  assert.deepEqual(reasons(clean, "yeasts"), ["fruity:negated", "citrus:conditional"]);
  // Negation reaches only to the next comma.
  assert.deepEqual(words("No diacetyl, fruity character and a hint of banana.", "yeasts"), [
    "fruity",
    "banana",
  ]);
  // A line break ends a statement: a fact line never inherits the next sentence's condition.
  assert.deepEqual(
    words("Fruity, slight banana and clove\nA strain that can be used widely.", "yeasts"),
    ["fruity", "banana", "clove"],
  );
  // A condition covers its own part of the sentence and what follows, never what precedes it.
  assert.deepEqual(
    words("Provides fruity flavors, specially at higher densities and temperatures.", "yeasts"),
    ["fruity"],
  );
  assert.deepEqual(reasons("May produce banana, clove and bubblegum.", "yeasts"), [
    "banana:conditional",
    "clove:conditional",
    "bubblegum:conditional",
  ]);
  // A comparison's own phrase describes the other product.
  assert.deepEqual(
    words(
      "Unlike WLP840, which tends toward a light apple fruitiness, it ferments neutrally. Compared to similar products, it displays enhanced citrus.",
      "yeasts",
    ),
    ["citrus"],
  );
  assert.deepEqual(reasons("Saison like phenols at the high end of the range.", "yeasts"), [
    "phenolic:conditional",
  ]);
  assert.deepEqual(words("Offers less guava and more melon and mango.", "yeasts"), [
    "melon",
    "mango",
  ]);
  assert.deepEqual(reasons("Free of phenols; fruity at warmer temperatures.", "yeasts"), [
    "phenolic:negated",
    "fruity:conditional",
  ]);
  assert.deepEqual(words("A strain ideal for fruity Belgian ales.", "yeasts"), []);
  // A pairing marker covers only the words right after it; the product's own flavour stays.
  assert.deepEqual(
    words("Residual sweetness accentuates malt character along with mild fruity esters.", "yeasts"),
    ["fruity"],
  );
  assert.deepEqual(reasons("Matches up perfectly with roasted and caramel malts.", "yeasts"), [
    "roast:other ingredient",
    "caramel:other ingredient",
  ]);
  assert.deepEqual(
    reasons("Clean and crisp, with the slightest hint of spice from hops.", "yeasts"),
    ["spicy:other ingredient"],
  );
  assert.deepEqual(words("Horse blanket, fresh leather; funky and tart.", "yeasts"), [
    "horse blanket",
    "leather",
    "funky",
    "tart",
  ]);
  // Words naming another ingredient or material belong to it, but a hop maker's "fruity hop" is
  // the hop itself.
  assert.deepEqual(
    words("Huge citrus and mango; emphasizes the juiciness of tropical hops.", "yeasts"),
    ["citrus", "mango"],
  );
  assert.deepEqual(words("For honey based meads and grape derived products.", "yeasts"), []);
  assert.deepEqual(words("A fruity hop with melon notes.", "hops"), ["fruity", "melon"]);
  assert.deepEqual(reasons("Clean, steering clear of heavy esters or phenolics.", "yeasts"), [
    "phenolic:negated",
  ]);
  assert.deepEqual(words("Citrus aromas this side of an orange grove.", "yeasts"), ["citrus"]);
  // Names of processes, styles, communities and confections are not flavours.
  assert.deepEqual(
    words(
      "Tolerates acidic wort; no need to kettle sour. Isolated by Milk the Funk members; dried fruit leather.",
      "yeasts",
    ),
    [],
  );
  // Hop sources: "void of" negates a whole slash list, "notable for" and "can all be found"
  // describe the hop itself, and adverbs do not hide pairing advice.
  assert.deepEqual(words("Almost completely void of the resinous/piney character.", "hops"), []);
  assert.deepEqual(words("Notable for its complexity of fruity and citrus flavors.", "hops"), [
    "fruity",
    "citrus",
  ]);
  assert.deepEqual(words("Peach-mango lemonade, papaya and guava can all be found.", "hops"), [
    "peach",
    "mango",
    "papaya",
    "guava",
  ]);
  assert.deepEqual(words("Pairs excellently with hops that bring resinous depth.", "hops"), []);
  assert.deepEqual(
    words("Melon, citrus-lime, apple blossom and green pepper; juniper and gin berries.", "hops"),
    ["melon", "citrus", "lime", "floral", "green pepper", "juniper"],
  );
  // Dried and dark fruit are yeast esters too, unlike caramel or bread.
  assert.deepEqual(words("Caramel, plum and dark fruit esters.", "yeasts"), ["plum", "dark fruit"]);
});

void test("ignored phrases consume look-alike words and unknown words are reported", () => {
  const history = extractDescriptors(
    "Its popularity rose to new heights; gooseberry and kiwi.",
    "hops",
  );
  assert.deepEqual(
    history.words.map((item) => item.word),
    ["gooseberry"],
  );
  assert.ok(history.unmatched.includes("kiwi"));
  assert.deepEqual(words("Use with grains of paradise.", "miscs"), []);
});

const entry = (patch: Record<string, unknown> = {}) => ({
  id: "maker-product",
  manufacturer: "Maker",
  manufacturerAliases: [],
  codes: ["P1"],
  aliases: ["Product"],
  descriptors: [{ word: "fruity", evidence: "fruity esters" }],
  source: {
    url: "https://maker.example/product",
    kind: "maker",
    via: null,
    retrieved: "2026-10-18",
    sha256: "a".repeat(64),
  },
  family: null,
  souring: false,
  functions: [],
  bodyClass: null,
  roastClass: "none",
  noticeableGPerL: null,
  limitations: [],
  ...patch,
});

void test("sourced entries convert to facts and every malformed entry is rejected", () => {
  const [fact] = sourcedFacts("yeasts", [entry()]);
  assert.deepEqual(fact!.descriptors, ["fruity"]);
  assert.deepEqual(fact!.sourceUrls, ["https://maker.example/product"]);
  const [copy] = sourcedFacts("yeasts", [
    entry({ source: { ...entry().source, kind: "maker-copy", via: "Brewfather library" } }),
  ]);
  assert.ok(copy!.limitations.includes("Maker text as reproduced by Brewfather library."));
  for (const [problem, patch] of [
    ["http source", { source: { ...entry().source, url: "http://maker.example" } }],
    ["copy without via", { source: { ...entry().source, kind: "maker-copy" } }],
    ["missing hash", { source: { ...entry().source, sha256: "" } }],
    ["no alias", { aliases: [] }],
    ["yeast without maker", { manufacturer: null }],
    ["word without evidence", { descriptors: [{ word: "fruity", evidence: "" }] }],
    ["capitalised word", { descriptors: [{ word: "Fruity", evidence: "fruity" }] }],
    [
      "duplicate words",
      {
        descriptors: [
          { word: "fruity", evidence: "fruity" },
          { word: "fruity", evidence: "fruitiness" },
        ],
      },
    ],
    ["unknown family", { family: "imaginary" }],
  ] as const)
    assert.throws(() => sourcedFacts("yeasts", [entry(patch)]), Error, problem);
  assert.equal(sourcedFacts("hops", [entry({ manufacturer: null })])[0]!.manufacturer, null);
});

void test("committed sourced words come only from the lexicon with their maker phrase", () => {
  const phrases = new Map(LEXICON.map((term) => [term.word, new Set(term.phrases)]));
  const reviewedIds = new Set(REVIEWED_FACTS.map((fact) => fact.id));
  const names = new Map<string, string>();
  for (const role of ["fermentables", "hops", "yeasts", "miscs"] as const) {
    const raw = JSON.parse(
      readFileSync(
        new URL(`../src/features/story/flavor/sourced/${role}.json`, import.meta.url),
        "utf8",
      ),
    ) as { id: string; descriptors: { word: string; evidence: string }[] }[];
    const facts = sourcedFacts(role, raw);
    raw.forEach((item, index) => {
      assert.equal(reviewedIds.has(item.id), false, `${item.id} duplicates a reviewed fact`);
      for (const { word, evidence } of item.descriptors)
        assert.ok(
          phrases.get(word)?.has(evidence),
          `${item.id}: "${evidence}" is not a ${word} phrase`,
        );
      const fact = facts[index]!;
      for (const alias of fact.aliases) {
        const key = `${role}|${fact.manufacturer ?? ""}|${alias.trim().toLowerCase()}`;
        assert.equal(names.get(key), undefined, `${fact.id} and ${names.get(key)} share ${alias}`);
        names.set(key, fact.id);
      }
    });
  }
  for (const fact of REVIEWED_FACTS)
    for (const alias of fact.aliases) {
      const key = `${fact.role}|${fact.manufacturer ?? ""}|${alias.trim().toLowerCase()}`;
      assert.equal(names.get(key), undefined, `${names.get(key)} must replace reviewed ${fact.id}`);
    }
});
void test("robots.txt rules for every agent decide what the fetcher may read", () => {
  const robots = [
    "User-agent: SomeBot",
    "Disallow: /",
    "",
    "User-agent: *",
    "Disallow: /cart",
    "Disallow: /products/private",
    "Allow: /products/private/data-sheets",
  ].join("\n");
  assert.equal(robotsAllows(robots, "/variety/citra"), true);
  assert.equal(robotsAllows(robots, "/cart/checkout"), false);
  assert.equal(robotsAllows(robots, "/products/private/notes"), false);
  assert.equal(robotsAllows(robots, "/products/private/data-sheets/a.pdf"), true);
  assert.equal(robotsAllows("", "/anything"), true);
  // Wildcards: Fermentis forbids every query string but not its plain product pages.
  const fermentis = "User-agent: *\nDisallow: /*?*\nDisallow: /*.pdf$\nCrawl-delay: 10";
  assert.equal(robotsAllows(fermentis, "/en/product/safale-us-05/"), true);
  assert.equal(robotsAllows(fermentis, "/en/products/?page=2"), false);
  assert.equal(robotsAllows(fermentis, "/sheet.pdf"), false);
  assert.equal(robotsAllows(fermentis, "/sheet.pdf.html"), true);
  assert.equal(parseRobots(fermentis).crawlDelaySeconds, 10);
});

void test("a built entry carries only extracted words and says when the maker names none", () => {
  const product = {
    id: "maker-clean-ale",
    role: "yeasts" as const,
    manufacturer: "Maker",
    manufacturerAliases: [],
    codes: ["M1"],
    aliases: ["Clean Ale"],
    flavorText: "Clean and neutral with low esters; for American ales with citrus hops.",
    source: entry().source as never,
  };
  const { entry: built, extraction } = buildEntry(product);
  assert.deepEqual(built.descriptors, []);
  assert.ok(built.limitations.includes("The maker's text names no flavour words."));
  assert.deepEqual(
    extraction.excluded.map((item) => item.reason),
    ["other ingredient"],
  );
  assert.doesNotThrow(() => sourcedFacts("yeasts", [built]));
});

void test("bot challenges are recognised so they become gaps instead of being bypassed", () => {
  assert.equal(isBotChallenge(429, new Headers({ "x-vercel-mitigated": "challenge" }), ""), true);
  assert.equal(isBotChallenge(403, new Headers(), "<title>Just a moment...</title> cf-chl"), true);
  assert.equal(isBotChallenge(200, new Headers(), "<h1>Citra</h1> grapefruit"), false);
  assert.equal(isBotChallenge(404, new Headers(), "Not found"), false);
});

void test("souring follows what names the culture, and a description mention leaves it unknown", () => {
  assert.equal(souringFromStated("Yeast & Lactic Acid Bacteria blend. Saccharomyces"), true);
  assert.equal(souringFromStated("Belgian Lambic Blend"), true);
  assert.equal(souringFromStated("Brettanomyces bruxellensis variant"), true);
  // A blend or culture of brewing yeasts is not souring by that word alone.
  assert.equal(souringFromStated("Blend of Saccharomyces yeast cultures (non-STA1)"), false);
  assert.equal(souringFromStated("American Ale Yeast Blend", "Clean and versatile."), false);
  assert.equal(
    souringFromStated("American Farmhouse Blend", "A farmhouse strain mixed with Brettanomyces."),
    null,
  );
  assert.equal(souringFromStated("Wild Sacch"), null);
  // Look-alike words are not souring organisms.
  assert.equal(souringFromStated("West Coast Ale", "Diacetyl eliminated at the source."), false);
  assert.equal(
    souringFromStated("Kveik Ring", "Sourced from a farmhouse, isolated in our lab."),
    false,
  );
  assert.equal(souringFromStated("Milkshake IPA Yeast", "Pairs with the lactose."), false);
  assert.equal(souringFromStated("Blend of Saccharomyces cerevisiae, LAB"), true);
  // Sour styles in a description are pairing advice; kveik is a mixed culture of yeasts.
  assert.equal(
    souringFromStated("Belgian Golden Ale Yeast", "From East Flanders; great for sours."),
    false,
  );
  assert.equal(souringFromStated("Opshaug Kveik Ale Yeast", "A traditional mixed culture."), false);
  assert.equal(souringFromStated("Flemish Ale Blend"), true);
  // A stated species outranks a pairing mention in the description.
  assert.equal(souringFromStated("Saccharomyces cerevisiae", "A good choice for sours."), false);
});

void test("ids drop trademark signs before folding accents", () => {
  assert.equal(slug("SafBrew™ HA-18"), "safbrew-ha-18");
  assert.equal(slug("RØKKAR Kölsch®"), "rokkar-kolsch");
});

void test("the beer catalog leaves out wine, cider, mead and other non-beer cultures", () => {
  assert.equal(isBeerCulture("WLP715 Champagne Yeast"), true);
  assert.equal(isBeerCulture("Funky Cider Blend"), false);
  assert.equal(isBeerCulture("Seltzer", "INIS-802 Seltzer Yeast"), false);
  assert.equal(isBeerCulture("Malolactic Blend"), false);
});

void test("hop sources merge into one entry per variety, preferring owners that name flavours", () => {
  const hop = (id: string, aliases: string[], words: string[]) =>
    entry({
      id,
      manufacturer: null,
      codes: [],
      aliases,
      descriptors: words.map((word) => ({ word, evidence: word })),
      souring: null,
    }) as never;
  const { entries, merged } = mergeHops([
    { maker: "charles-faram", entries: [hop("hop-citra", ["Citra"], ["grapefruit"])] },
    { maker: "hbc", entries: [hop("hop-citra", ["Citra"], ["lime", "passion fruit"])] },
    // A wordless breeder page gives way to the next source that names flavours.
    {
      maker: "barthhaas",
      entries: [hop("hop-hallertauer-mittelfruh", ["Hallertauer Mittelfrüh"], [])],
    },
    {
      maker: "crosby",
      entries: [
        hop(
          "hop-hallertau-mittelfrueh",
          ["Hallertau Mittelfrueh", "Hallertauer Mittelfrueh"],
          ["floral"],
        ),
      ],
    },
  ]);
  const citra = entries.find((item) => item.id === "hop-citra")!;
  assert.deepEqual(
    citra.descriptors.map((item) => item.word),
    ["lime", "passion fruit"],
  );
  const mittelfruh = entries.find((item) => item.id === "hop-hallertau-mittelfrueh")!;
  assert.deepEqual(
    mittelfruh.descriptors.map((item) => item.word),
    ["floral"],
  );
  assert.deepEqual(mittelfruh.aliases, [
    "Hallertauer Mittelfrüh",
    "Hallertau Mittelfrueh",
    "Hallertauer Mittelfrueh",
  ]);
  assert.ok(mittelfruh.limitations.some((text) => text.includes("barthhaas")));
  assert.equal(entries.length, 2);
  assert.equal(merged.length, 1);
  // An owner ranks as a grower for a variety outside its home region or a regional growing.
  const origin = (id: string, aliases: string[], words: string[], where: string) =>
    ({ ...(hop(id, aliases, words) as object), limitations: [`Origin: ${where}.`] }) as never;
  const regional = mergeHops([
    {
      maker: "nz-hops",
      entries: [origin("hop-nz-fuggle", ["NZ Fuggle", "Fuggle"], ["spicy"], "New Zealand")],
    },
    {
      maker: "british-hops",
      entries: [origin("hop-fuggle", ["Fuggle"], ["earthy"], "United Kingdom")],
    },
    { maker: "hpa", entries: [origin("hop-cascade", ["Cascade"], ["citrus"], "United States")] },
    { maker: "hopsteiner", entries: [hop("hop-cascade", ["Cascade"], ["grapefruit"])] },
  ]).entries;
  assert.deepEqual(
    regional.map((item) => [item.id, item.descriptors.map((word) => word.word)]),
    [
      ["hop-fuggle", ["earthy"]],
      ["hop-cascade", ["grapefruit"]],
    ],
  );
  // A source without a place in the priority order cannot be merged silently.
  assert.throws(
    () => mergeHops([{ maker: "unknown-site", entries: [hop("hop-x", ["X"], [])] }]),
    Error,
  );
  assert.equal(hopName("Citra® Hops (US)"), "Citra");
});
