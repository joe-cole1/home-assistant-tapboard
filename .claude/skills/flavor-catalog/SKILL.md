---
name: flavor-catalog
description: Add or update a Tapboard flavor-catalog ingredient (yeast, hop, malt, sugar, spice, fruit or other adjunct) from its name and a maker's data sheet, or fix the flavor words an ingredient produces. Use when the operator names an ingredient Tapboard doesn't recognise, pastes or links a data sheet, or says a beer's taste profile words are wrong.
---

# Add or update a flavor-catalog ingredient

The catalog lives in `src/features/story/flavor/catalog-data.ts` (hand-reviewed facts and classes)
and `src/features/story/flavor/sourced/<role>.json` (entries generated from makers' own pages), and
is resolved by `src/features/story/flavor/catalog.ts`. Read `docs/flavor-catalog-sources.md`
("Maker-sourced datasets", "Generic classes" and "Adding or updating an ingredient") before editing.

No guesses: an ingredient's words are only what its maker states, extracted by the same rules as
the generated data. Never add a word because it is typical of a style.

## 1. Gather the identity

You need the ingredient's exact Brewfather name, its maker (yeast laboratory or supplier), the
product code, and the Brewfather type. Admin → beverage → "Why these estimates?" → "Ingredients not
in the flavor catalog" shows these exactly as Tapboard sees them. If anything is missing, ask the
operator before editing. Check today's result:

```sh
node scripts/flavor-resolve.ts yeasts "Hefeweizen IV" --maker "White Labs" --code WLP380 --type Wheat
```

## 2. A yeast, hop or malt from a source with a reader

The labs, hop sources and maltsters in `scripts/flavor-sources/makers/` are read in full. A missing
or changed strain, variety or malt from one of them is a refresh, never a hand edit:

```sh
NODE_USE_ENV_PROXY=1 node scripts/flavor-sources/run.ts <lab> --refresh
```

Review `data/flavor-sources/out/<lab>.json`: the text read for the strain, the words kept, the
mentions left out and any unreadable pages. Then `node scripts/flavor-sources/run.ts --write yeasts`
(or `--write hops`, which merges every hop source into one entry per variety by the priority in
`merge.ts`, or `--write fermentables`). A maltster's entry supplies words only; the malt's family
still comes from the reviewed guards and the Brewfather category and colour. If Brewfather calls the product something no source prints, add the Brewfather name to
`BREWFATHER_NAMES` in `catalog-data.ts` (identity only). A reader that misreads a page is fixed in
its `makers/<lab>.ts` with the page structure described in its doc comment. Lallemand asks for 60
seconds between requests and Wyeast 10, so a refresh of those labs is slow.

## 3. Anything else: a reviewed fact from the maker's text

For a product from a maker without a reader, a withdrawn product, or an operator-supplied data
sheet, prefer the sheet, then the maker's own product page. Save the flavour text (or the PDF) and
extract its words:

```sh
node scripts/flavor-sources/words.ts yeasts sheet.pdf
```

Use exactly the `words` it prints, in order (at most 8). If the maker's phrase is a real flavour the
lexicon lacks (it shows up under `unmatched`), add it to `scripts/flavor-sources/lexicon.ts` with a
test in `test/flavor-sources.test.ts`; only spelling, plural and part-of-speech variants may share a
word. Never copy descriptions, intensity scores or wheels. If you only saw a search summary or a
retailer copy, record that in `limitations`. An uploaded sheet with no public URL cites the maker's
product page and adds the limitation "Reviewed from an operator-supplied data sheet dated
YYYY-MM-DD."

Choose fact or class:

- **Fact** (`REVIEWED_FACTS`, built with `fact(...)`): one named product from one maker, such as a
  branded malt or branded adjunct.
- **Class** (`INGREDIENT_CLASSES`): a generic adjunct family that names itself, such as a spice or a
  fruit. There are no yeast classes. The first matching class wins, so keep the order: processing
  aids and Brewfather types, citrus peel/zest, fruit (before plants so acidity is never hidden),
  plants, spirits, honey/maple.

Fields that matter:

| Role         | Set                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yeasts       | `manufacturer` and `manufacturerAliases` (exact Brewfather laboratory spellings), `codes`, `aliases`, `descriptors`; `souring` true for a stated souring organism or sour culture, false for a stated Saccharomyces or ordinary ale/lager/wheat/kveik yeast, otherwise null |
| hops         | `aliases` (common spellings), `descriptors`; no manufacturer                                                                                                                                                                                                                |
| fermentables | `manufacturer`, `aliases`, `family` (a `FermentableFamily`), `descriptors` from the maltster, `roastClass`/`bodyClass` when they apply                                                                                                                                      |
| miscs        | `functions` (`botanical`, `fruit`, `processing`, …), `descriptors`, `noticeableGPerL` (the g/L at which the addition is clearly noticeable)                                                                                                                                 |

Yeast words banana, clove, phenolic, pepper and spicy weigh more than other yeast words.

## 4. Record, test and version

1. Add a line of the form ``- [Primary source](URL): `fact-id`.`` to "Primary references" in
   `docs/flavor-catalog-sources.md`. The catalog test fails if a reviewed fact is missing there.
2. Add a resolution assertion to `test/flavor-catalog.test.ts` (exact name with maker and code,
   expected id and descriptors). When a corpus beer changes, add an expectation in
   `test/flavor-corpus.test.ts` and run `node scripts/report-flavor-corpus.ts`.
3. If `origin/main` already has the current `CATALOG_VERSION` in `catalog.ts`, increment it
   (`tapboard-flavor-catalog-N+1`) and the version line in `docs/flavor-catalog-sources.md`. Engine
   changes bump `MODEL_VERSION` in `engine.ts` the same way.
4. Re-run `node scripts/flavor-resolve.ts ...`, then `npm run check`.

The PR's MANUAL DEV TEST should name a beer using the ingredient: its Admin "Ingredients not in the
flavor catalog" list no longer shows it, and the public flavor words include the new tags when the
dose is large enough.
