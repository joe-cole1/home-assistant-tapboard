---
name: flavor-catalog
description: Add or update a Tapboard flavor-catalog ingredient (yeast, hop, malt, sugar, spice, fruit or other adjunct) from its name and a maker's data sheet, or fix the flavor words an ingredient produces. Use when the operator names an ingredient Tapboard doesn't recognise, pastes or links a data sheet, or says a beer's taste profile words are wrong.
---

# Add or update a flavor-catalog ingredient

The catalog lives in `src/features/story/flavor/catalog-data.ts` and is resolved by
`src/features/story/flavor/catalog.ts`. Read `docs/flavor-catalog-sources.md` ("Generic classes"
and "Adding or updating an ingredient") before editing.

## 1. Gather the identity

You need the ingredient's exact Brewfather name, its maker (yeast laboratory or supplier), the
product code, and the Brewfather type. Admin → beverage → "Why these estimates?" → "Ingredients not
in the flavor catalog" shows these exactly as Tapboard sees them. If anything is missing, ask the
operator before editing. Check today's result:

```sh
node scripts/flavor-resolve.ts yeasts "Hefeweizen IV" --maker "White Labs" --code WLP380 --type Wheat
```

## 2. Read the source

Prefer the data sheet the operator provides, then the maker's own product page. Keep 2–5 short,
lowercase tags the maker names, most prominent first. Never copy descriptions, intensity scores or
wheels. Producer sites can be blocked from cloud sessions; if you only saw a search summary or a
retailer copy, record that in `limitations`. An uploaded sheet with no public URL cites the maker's
product page and adds the limitation "Reviewed from an operator-supplied data sheet dated YYYY-MM-DD."

## 3. Choose fact or class

- **Fact** (`INGREDIENT_FACTS`, built with `fact(...)`): one named product from one maker, such as a
  yeast strain, hop variety, branded malt or branded adjunct. Hop varieties go in `hopVarieties()`
  with `variety(...)`.
- **Class** (`INGREDIENT_CLASSES`): a generic family whose members share character, such as a spice,
  a fruit or a yeast style. The first matching class wins, so keep the order: yeast styles,
  processing aids and Brewfather types, citrus peel/zest, fruit (before plants so acidity is never
  hidden), plants, spirits, honey/maple.

Fields that matter:

| Role         | Set                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yeasts       | `manufacturer` and `manufacturerAliases` (exact Brewfather laboratory spellings), `codes`, `aliases`, `descriptors`, `souring: false` for ordinary strains (`null` when the maker describes acidity or mixed cultures) |
| hops         | `aliases` (common spellings), `descriptors`; no manufacturer                                                                                                                                                           |
| fermentables | `manufacturer`, `aliases`, `family` (a `FermentableFamily`), `descriptors` from the maltster, `roastClass`/`bodyClass` when they apply                                                                                 |
| miscs        | `functions` (`botanical`, `fruit`, `processing`, …), `descriptors`, `noticeableGPerL` (the g/L at which the addition is clearly noticeable)                                                                            |

Reuse existing words and spellings ("tropical fruit", "stone fruit", "passion fruit"). Yeast words
banana, clove, phenolic, pepper and spicy weigh more than other yeast words. List the current
vocabulary with:

```sh
node --input-type=module -e 'const d = await import("./src/features/story/flavor/catalog-data.ts"); console.log([...new Set([...d.INGREDIENT_FACTS, ...d.INGREDIENT_CLASSES].flatMap((e) => e.descriptors))].sort().join(", "))'
```

## 4. Record, test and version

1. Add a line of the form ``- [Primary source](URL): `fact-id`.`` to "Primary references" in
   `docs/flavor-catalog-sources.md`. The catalog test fails if a fact is missing there.
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
