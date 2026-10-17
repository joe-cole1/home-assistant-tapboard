import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractDescriptors } from "../scripts/flavor-sources/extract.ts";
import { buildEntry } from "../scripts/flavor-sources/build.ts";
import { isBotChallenge, parseRobots, robotsAllows } from "../scripts/flavor-sources/fetch.ts";
import { LEXICON } from "../scripts/flavor-sources/lexicon.ts";
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
    ["pairing"],
  );
  assert.doesNotThrow(() => sourcedFacts("yeasts", [built]));
});

void test("bot challenges are recognised so they become gaps instead of being bypassed", () => {
  assert.equal(isBotChallenge(429, new Headers({ "x-vercel-mitigated": "challenge" }), ""), true);
  assert.equal(isBotChallenge(403, new Headers(), "<title>Just a moment...</title> cf-chl"), true);
  assert.equal(isBotChallenge(200, new Headers(), "<h1>Citra</h1> grapefruit"), false);
  assert.equal(isBotChallenge(404, new Headers(), "Not found"), false);
});
