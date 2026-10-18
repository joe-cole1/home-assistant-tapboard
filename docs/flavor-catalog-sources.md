# Flavor catalog sources

Catalog version: `tapboard-flavor-catalog-3`. Hand-reviewed facts: 2026-10-17. Maker-sourced entries record their own retrieval dates.

The local catalog stores short paraphrased categorical tags and exact identity aliases. It has no numerical sensory coefficients, runtime network lookup, brewing account data, copied marketing descriptions, images, wheels, or producer sensory scores. The mathematical model is a separate versioned engineering heuristic. These facts do not validate finished-beer predictions.

Generic malt-class character (`FAMILY_CHARACTER`, crystal colour bands, honey malt and flavoured sugars in `SUGAR_CHARACTER`) is a separate, explicitly non-producer layer of common brewing vocabulary, for example grainy/cracker for pilsner malt, toasty/bread crust for Munich and caramel/toffee for 25–75 °L crystal. It applies only when an ingredient has no producer descriptors, never overrides a producer fact, and the public disclosure says typical malt-class character is used. Yeasts have no such layer. Caramel colour bands follow the progression in Briess's caramel malt descriptions (light honey/caramel, then caramel/toffee, then burnt sugar/raisin); the cut points are pragmatic interpolations between products, not measured transitions.

Identity resolution uses role plus manufacturer/laboratory and product code, then exact reviewed name aliases. Manufacturer-specific rules require a matching manufacturer; a full exact branded Verdant name can supply its laboratory. Unknown populated yeast codes prevent name-only product substitution, and no class stands in for an unknown strain. A known manufacturer/code with conflicting name retains a diagnostic. Brewfather library names for maker-sourced products whose maker prints another name (`BREWFATHER_NAMES` in `catalog-data.ts`, for example "Safale American" for SafAle US-05) are identity aliases taken from the operator's own Brewfather rows; they add no flavour data. Generic reviewed grist names establish a family, not the supplier's product specification. Provider base-grain categories resolve four families directly. Other unknown grains receive a generic `property-*` class from name tokens, Brewfather category and colour; they never inherit a producer's descriptors, and colour that conflicts with the category (or an extract) stays unresolved with a diagnostic. Smoked and peated malts form their own families (smoky; peaty and smoky). Acidulated malt is classified as pilsner-based malt, and the tartness rule still inspects its share by name. Maltodextrin is a dextrin class that adds body and no words.

Original Briess Carapils, Carapils Copper and reviewed Weyermann Carapils/Carafoam remain separate. Weyermann Carafoam supports light caramel/malty character and receives no original-Carapils body bonus. Carafa Special I is dehusked, whereas regular Carafa III is not given the dehusked rule. Briess Munich remains family-level with anomalous color preserved. Briess Special Roast is biscuit-style even when its provider category says Roasted. Hop variety is separate from physical form, origin and supplier. Descriptor resolution never establishes concentrated-product dose equivalence. Bare Hallertau resolves only to a labelled regional class, never a guessed variety. CTZ resolves through its sold designation (Columbus and Tomahawk names too; bare Zeus does not). Proprietary Arctic Blend remains an explicit unknown, and Styrian Goldings is ambiguous between reviewed regional products and remains unknown.

Yeast tags represent fermentation expectations, never actual fruit/spice additions. Wyeast 3787 carries the fruity esters and phenolics its maker names. Diastatic strains are not classified as infection or souring. A non-souring strain whose maker words are tart, sour or acidic (Imperial Whiteout's "significant amount of acidity") leaves tartness unknown, because no calibrated tartness measurement exists. The engine must inspect missing yeast and material acid/fruit/process evidence before asserting none expected.

Lactose may be explicitly recorded in either fermentables or miscellaneous ingredients; both roles use the same validated mass/volume floor. This is an exact common-name material rule, not a producer intensity score.

Miscellaneous identities distinguish explicit botanicals, ALDC, thiol precursors, water treatment, processing aids, fruit and antioxidant. Lactic/phosphoric acid tags identify brewing-acid context, but the engine must inspect stage: mash/sparge acid is not finished-beer sourness, while a material later acid addition cannot be dismissed. Ascorbic acid is an antioxidant. Amylase Enzyme is a generic processing aid with no invented fermentability coefficient. Phantasm Powder is a precursor context only; the cited producer explicitly calls the powder a thiol precursor. Liquid Propper Phantasm specifications are not applied to it.

Common-name family resolution and generic classes use the explicit supplied identity and the approved composition categories; API documentation supports ingredient roles/units, not a producer's finished-beer descriptor. No manufacturer or product-specific performance claim is made for these generic entries. Briess's analysis flyer provides malt-family context; only manufacturer-specific entries carry producer character tags.

## Generic classes

`INGREDIENT_CLASSES` in `catalog-data.ts` is the last fallback after reviewed products and the malt property rules. Each class matches name tokens (accent-folded and lowercase), optionally limited to Brewfather types, and resolves at family level with a `class-*` id and a "no reviewed product entry" diagnostic. Classes never override a reviewed product.

- There are no yeast classes. A strain's words come only from its maker; an unknown strain adds no words and is listed for Admin. An unresolved Brewfather Ale, Lager or Wheat yeast with a name or product code and no souring words still counts as non-souring for tartness.
- Miscellaneous by Brewfather type: Water Agent is water treatment (a mash acid when the name contains "acid", still subject to the stage rule) and Fining is a processing aid.
- Processing aids by name (enzymes, nutrients, finings, antifoam, rice or oat hulls) carry no words and do not block a "none expected" tartness.
- Flavour adjuncts name themselves: spices, herbs, citrus peel or zest, fruit and juice, coffee, cocoa, coconut, nuts, vanilla, oak, spirits, and honey or maple entered as miscs. Fruit, juice and hibiscus keep the `fruit` function, so tartness stays unknown. The same classes apply to fermentables of Brewfather type Other, Adjunct or untyped (never grains, malts, sugars or extracts); those rows are not grist and are dosed per litre like miscs.
- `noticeableGPerL` is a Tapboard heuristic near the low end of common homebrew doses, not a measured sensory threshold.

Hop variety names have no reliable style classes. Instead an unmatched hop name is retried without origin and conventional-form words (for example "Hallertau Magnum", "Saaz (CZ)" or "Cascade Whole Leaf"), with a diagnostic; "Hallertau Blanc" stays unknown because "Blanc" is not a reviewed variety. Concentrated products (Cryo, LupuMax, Incognito, Spectrum, extracts and oils) stay unresolved with an explicit reason because no dose equivalence is modelled.

Admin lists every unresolved ingredient under "Ingredients not in the flavor catalog" in the beverage's "Why these estimates?" disclosure.

## Maker-sourced datasets

`src/features/story/flavor/sourced/<role>.json` holds entries generated from makers' own pages by `scripts/flavor-sources/`; words are never typed by hand. Each entry records its source URL, retrieval date and a SHA-256 of the page, and whether the text is the maker's own (`maker`) or the maker's text reproduced elsewhere (`maker-copy`, with `via` naming where), which is used only when the maker's own copy is unavailable. Fetched pages are cached under the git-ignored `data/flavor-sources/` and never committed.

Words come from a fixed lexicon (`scripts/flavor-sources/lexicon.ts`): only spelling, plural and part-of-speech variants of one flavour share a word, and every stored word keeps the maker phrase it came from. Negated ("low fruitiness"), conditional ("fruity at warmer temperatures"; a condition covers its own part of the sentence and what follows), pairing or style ("for fruity Belgian ales") mentions, words naming another ingredient or material ("tropical hops", "acidic wort", "spice from hops"), a compared product's character ("unlike WLP840, which tends toward apple"), the product's own name ("Tsingtao Flower" is not floral) and, for yeasts, grain or sugar words are reported for review and never kept. A page whose flavour text names none of the lexicon's words yields an entry with no words. The loader rejects an entry without a source, an `https` URL, a hash or an exact name; a test rejects any word that is not a lexicon word with one of its phrases as evidence, and any sourced entry that shares a name with a hand-reviewed fact it has not replaced.

### Yeasts

`sourced/yeasts.json` holds every beer culture in the current catalogs of thirteen labs, read from each lab's own sitemap, store listing or category pages within its robots.txt: White Labs, Wyeast, Imperial Yeast, Omega, Escarpment Labs, Inland Island, Jasper, Propagate Lab, Bootleg Biology, Fermentis, Lallemand, CellarScience and Mangrove Jack's. The flavour text is only the lab's description, tasting notes or aroma fields; style lists, food pairings, reviews, equivalence tables and usage instructions are never read. Wine, cider, mead, sake, seltzer, malolactic, kombucha, baking and distilling cultures are out of scope (Imperial's own "does not recommend … wort" marks its cider and seltzer strains), and products a lab resells for another maker (Pinnacle at Omega and White Labs, Lallemand at White Labs and Escarpment) are left to that maker.

Souring follows what names the culture (species, strain type, category, product name and product type): a souring organism (Lactobacillus, Pediococcus, Brettanomyces, Lachancea, acetic or other bacteria) or sour style there makes it souring; otherwise a stated Saccharomyces species makes it not souring; otherwise a souring organism named only in the description (a blend partner or a suggested partner) leaves it unknown; otherwise an ordinary ale, lager, wheat or kveik yeast is not souring. "Blend", "culture" and "mixed culture" alone are not souring, because kveik is a mixed culture of Saccharomyces.

Rebuild with `NODE_USE_ENV_PROXY=1 node scripts/flavor-sources/run.ts <lab…> [--refresh]` (lab ids are the file names in `scripts/flavor-sources/makers/`; `--refresh` re-reads cached pages to pick up new strains), review `data/flavor-sources/out/<lab>.json` (the text read, the words kept and left out, and pages that could not be read), then `node scripts/flavor-sources/run.ts --write yeasts`. The write step refuses two entries of one maker sharing a name or code.

Not covered: Lallemand's withdrawn LalBrew Köln and London ESB have no current maker page (Köln keeps its reviewed identity without words); DrYeast has no maker site; GigaYeast and Yeast Bay are defunct.

### Hops

Hop varieties have no manufacturer and many sources describe each one, so `--write hops` merges the hop readers' output: entries sharing a name (case, accents and German spellings folded) are one variety, and the best-ranked source that names flavour words is kept, with every source's spelling as an alias (`scripts/flavor-sources/merge.ts`). Owners and national breeders' bodies rank first for their own region's varieties, then breeder-merchants, then growers and merchants; an owner's out-of-region listing or an origin-prefixed regional growing ("NZ Fuggle") ranks as a grower. Readers exist for fourteen sources, but `sourced/hops.json` stays empty until their output is reviewed, so hop words still come from the hand-reviewed facts below.

## Adding or updating an ingredient

Bring the ingredient's exact Brewfather name, its maker and product code, and the maker's data sheet or product page. A Claude Code session follows `.claude/skills/flavor-catalog/SKILL.md`: a strain from a lab above is refreshed by re-reading that lab; any other named product from one maker becomes a reviewed fact in `INGREDIENT_FACTS` whose words are what `node scripts/flavor-sources/words.ts <role> <sheet.pdf|notes.txt>` extracts from the maker's text, with its source URL in the list below and a resolution test; a generic ingredient family (a spice, a fruit) becomes or extends a class in `INGREDIENT_CLASSES`. `node scripts/flavor-resolve.ts <role> "<name>" [--maker M] [--code C] [--type T]` shows how an ingredient resolves before and after. The catalog test fails when a fact is missing from this list.

## Primary references

- [Primary source](https://connect.lallemandbrewing.com/wp-content/uploads/2019/10/TDS_LPS_BREWINGYEAST_KOLN_ENG_A4.pdf): `lallemand-koln`.
- [Primary source](https://www.yakimachief.com/variety/citra-brand): `hop-citra-brand`.
- [Primary source](https://www.yakimachief.com/variety/mosaic-brand): `hop-mosaic-brand`.
- [Primary source](https://www.yakimachief.com/variety/cascade): `hop-cascade`.
- [Primary source](https://www.yakimachief.com/variety/liberty): `hop-liberty`.
- [Primary source](https://www.yakimachief.com/variety/willamette): `hop-willamette`.
- [Primary source](https://www.yakimachief.com/variety/magnum): `hop-magnum`.
- [Primary source](https://www.yakimachief.com/variety/saaz-saz01): `hop-saaz-saz01`.
- [Primary source](https://www.yakimachief.com/variety/simcoe-brand): `hop-simcoe-brand`.
- [Primary source](https://www.yakimachief.com/variety/amarillo-brand): `hop-amarillo-brand`.
- [Primary source](https://www.yakimachief.com/variety/hallertauer-mittelfruher): `hop-hallertauer-mittelfruher`.
- [Primary source](https://www.yakimachief.com/variety/northern-brewer): `hop-northern-brewer`.
- [Primary source](https://www.yakimachief.com/variety/warrior-brand): `hop-warrior-brand`.
- [Primary source](https://www.yakimachief.com/variety/azacca-brand): `hop-azacca-brand`.
- [Primary source](https://www.yakimachief.com/variety/talus-brand): `hop-talus-brand`.
- [Primary source](https://www.yakimachief.com/variety/sabro-brand): `hop-sabro-brand`.
- [Primary source](https://www.yakimachief.com/variety/idaho-7-brand): `hop-idaho-7-brand`.
- [Primary source](https://www.yakimachief.com/variety/east-kent-golding): `hop-east-kent-golding`.
- [Primary source](https://hops.com.au/vic-secret/): `hop-vic-secret`.
- [Primary source](https://indiehops.com/hops/strata): `hop-strata`.
- [Primary source](https://www.claytonhops.co.nz/blogs/news/riwaka-from-unicorn-to-staple): `hop-riwaka`.
- [Primary source](https://brewingwithbriess.com/products/carapils-malts/): `briess-carapils`, `briess-carapils-copper`.
- [Primary source](https://brewingwithbriess.com/products/munich-malts/): `briess-munich`.
- [Primary source](https://brewingwithbriess.com/blog/malt-of-the-month-special-roast/): `briess-special-roast`.
- [Primary source](https://brewingwithbriess.com/products/kilned-malts/): `briess-honey`.
- [Primary source](https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf): `family-pilsner-53`, `family-pale-54`, `family-wheat-55`, `family-vienna-56`, `family-munich-57`, `family-flaked-58`, `family-flaked-59`, `family-flaked-60`, `family-rye-61`, `family-biscuit-62`, `family-aromatic-63`, `family-crystal_dark-64`, `family-crystal_light-65`, `family-chocolate-66`, `family-roasted-67`, `family-sugar-68`, `family-lactose-69`, `family-processing-70`.
- [Primary source](https://docs.brewfather.app/api/types): `misc-lactose`, `misc-salts`, `misc-fining`, `misc-acid`, `misc-antioxidant`; also the Brewfather misc and fermentable types used by generic classes.
- [Primary source](https://blog.whitelabs.com/solving-diacetyl-with-brewzyme-d): `white-labs-brewzyme-d`.
- [Primary source](https://www.freestylehops.com/hops/phantasm-thiol-precursor-powder-15kg/): `phantasm-powder`.
- [Primary source](https://www.weyermann.de/en-us/product/weyermann-carafoam/): `weyermann-carafoam`.
- [Primary source](https://www.weyermann.de/en-gb/product/weyermann-carafa-special-type-1/): `weyermann-carafa-special-i`.
- [Primary source](https://www.weyermann.de/en-gb/product/weyermann-carafa-type-3/): `weyermann-carafa-iii`.
- [Primary source](https://brewingwithbriess.com/products/roasted-caramel-malts/): `briess-caramel-10`, `briess-caramel-40`, `briess-caramel-120`.
- [Primary source](https://www.brewingwithbriess.com/wp-content/uploads/2020/11/Briess_PISB_CBWGoldenLightDME.pdf): `briess-golden-light-extract`.
- [Primary source](https://www.yakimachief.com/variety/tettnanger): `hop-tettnanger`.
- [Primary source](https://www.yakimachief.com/variety/hersbrucker-spat): `hop-hersbrucker-spat`, `family-hop-hallertau`.
- [Primary source](https://hopsteiner.com/variety-data-sheets/Perle): `hop-perle`.
- [Primary source](https://www.yakimachief.com/variety/nugget): `hop-nugget`.
- [Primary source](https://www.johnihaas.com/wp-content/uploads/2015/01/Crystal.pdf): `hop-crystal`.
- [Primary source](https://www.yakimachief.com/variety/mt-hood): `hop-mt-hood`.
- [Primary source](https://www.yakimachief.com/variety/fuggle): `hop-fuggle`.
- [Primary source](https://www.yakimachief.com/variety/centennial): `hop-centennial`.
- [Primary source](https://www.johnihaas.com/wp-content/uploads/2017/09/El-Dorado-1.pdf): `hop-el-dorado`.
- [Primary source](https://hopsteiner.com/variety-data-sheets/bravo): `hop-bravo`.
- [Primary source](https://www.barthhaas.com/hops-and-products/hops/mandarina-bavaria): `hop-mandarina-bavaria`.
- [Primary source](https://www.barthhaas.com/hops-and-products/hops/hallertau-tradition): `hop-hallertauer-tradition`, `family-hop-hallertau`.
- [Primary source](https://www.yakimachief.com/variety/ctz): `hop-ctz`.
- [Primary source](https://www.yakimachief.com/variety/hallertauer-mittelfruher): `family-hop-hallertau`.
- [Primary source](https://canadamalting.com/products/): `family-cmc-two-row`.
- [Primary source](https://www.fawcett-maltsters.co.uk/our-malts/): `family-fawcett-golden-promise`.
- [Primary source](https://www.murphyrudemalting.com/product-page/crystal-40): `murphy-rude-crystal40`.
- [Primary source](https://gambrinusmalting.com/wp-content/uploads/2025/10/HoneyMalt.pdf): `gambrinus-honey`.

The 2026-10-17 entries above were reviewed through search-result summaries of the cited pages because direct page fetches were unavailable in the authoring environment; they keep only short paraphrased tags the summaries attribute to the producer. Where producers disagree (Crystal), only the shared mild character is kept. The Hallertau regional class keeps the character named by at least two of the three reviewed Hallertau aroma varieties and records that the variety is unknown. Sterling has no reviewed producer description and stays unresolved.

Follow-up priority coverage uses [Canada Malting](https://canadamalting.com/products/) for the exact CMC two-row base family, [Fawcett](https://www.fawcett-maltsters.co.uk/our-malts/) for the exact Golden Promise pale-ale malt, [Murphy & Rude Crystal 40](https://www.murphyrudemalting.com/product-page/crystal-40) for the manufacturer-guarded crystal family and character, and [Gambrinus Honey Malt](https://gambrinusmalting.com/wp-content/uploads/2025/10/HoneyMalt.pdf) for Brumalt identity and bread-crust/honey/toast/toffee expectations. Gambrinus aromatic-family scoring is an explicit engineering interpretation; it is not honey sugar. Bare Golden Promise is not an alias because the maker also lists distilling malt. Crystal 40 color ranges differ between current/older official pages, so no fixed source color is imposed. Exact Corn Sugar (Dextrose) is a simple-sugar family alias only; no corn grain/syrup equivalence is inferred. Epiphany Malted Oats has no reviewed product rule and is not assumed flaked; it receives only the generic base class its colour supports. Weyermann Acidulated is classified only as pilsner-based malt because its producer allows both pH adjustment and sour-beer use; above 3% of the grist it blocks a none-expected tartness conclusion.

## Reuse and gaps

Producer sites show copyright/trademark notices. No permissive bulk-data license was established. Retain attribution and short factual paraphrases only; adding full descriptions, wheels, images, proprietary scores or a bulk download requires a separate reuse review. Lallemand links its user terms and co-branding guidance; brand/logo permissions are not presumed. No third-party catalogs are copied.

Official pages were read during implementation research, including Fermentis's corrected Unicode-hyphen S-23/K-97 URLs. Earlier guessed Lallemand Belle/Voss URLs and the direct flyer retrieval failed; the current official pages and indexed official flyer were used instead. Remaining inventory identities without verified product facts stay unresolved rather than inheriting descriptors from beer names/styles. Missing hop variety does not remove valid mass from the independent exposure calculation. Empty or missing yeast does not establish neutral fermentation.

Historical Candi Syrup D-90/D-180 identities are explicitly supplied sugar/syrup family records without formulation specifications; the current [maker site](https://www.candisyrup.com/) says it no longer serves brewing customers. Their words come from the generic `SUGAR_CHARACTER` colour bands (caramel and toffee from 30 SRM, dark fruit and toffee from 150 SRM), not from the maker.

Carapils Copper's biscuit-family applicability is an engineering classification based on the sourced malty, graham-cracker and toasty character; no manufacturer coefficient is claimed. The coordinator owns acceptance of that family in the numeric engine.

Identity coverage of the 61-batch history with catalog 3, as batch occurrences that resolve to a product, family or generic class: fermentables 267/267, hops 194/205, yeasts 61/62, misc 433/433. This is an identity coverage diagnostic, not sensory or end-to-end validation. All named yeast in the 13 priority cases resolve; B053's empty list remains unknown. Remaining hop gaps are Styrian Goldings (regional/product ambiguity), proprietary Arctic Blend, Sterling and unnamed additions; the remaining yeast gap is DrYeast Y36, whose maker has no site. Generic dark/wheat extracts do not have an applicability rule. Unresolved material must reduce support; these gaps are not zero contributions or neutral fermentation evidence.
