# Flavor catalog sources

Catalog version: `tapboard-flavor-catalog-2`. Reviewed: 2026-10-17.

The local catalog stores short paraphrased categorical tags and exact identity aliases. It has no numerical sensory coefficients, runtime network lookup, brewing account data, copied marketing descriptions, images, wheels, or producer sensory scores. The mathematical model is a separate versioned engineering heuristic. These facts do not validate finished-beer predictions.

Generic malt-class character (`FAMILY_CHARACTER`, crystal colour bands and honey malt) is a separate, explicitly non-producer layer of common brewing vocabulary, for example grainy/cracker for pilsner malt, toasty/bread crust for Munich and caramel/toffee for 25–75 °L crystal. It applies only when an ingredient has no producer descriptors, never overrides a producer fact, and the public disclosure says typical malt-class character is used. Caramel colour bands follow the progression in Briess's caramel malt descriptions (light honey/caramel, then caramel/toffee, then burnt sugar/raisin); the cut points are pragmatic interpolations between products, not measured transitions.

Identity resolution uses role plus manufacturer/laboratory and product code, then exact reviewed name aliases. Manufacturer-specific rules require a matching manufacturer; a full exact branded Verdant name can supply its laboratory. Unknown populated yeast codes prevent name-only substitution. A known manufacturer/code with conflicting name retains a diagnostic. Generic reviewed grist names establish a family, not the supplier's product specification. Provider base-grain categories resolve four families directly. Other unknown grains receive a generic `property-*` class from name tokens, Brewfather category and colour; they never inherit a producer's descriptors, and colour that conflicts with the category (or smoked, peated, acidulated and extract products) stays unresolved with a diagnostic.

Original Briess Carapils, Carapils Copper and reviewed Weyermann Carapils/Carafoam remain separate. Weyermann Carafoam supports light caramel/malty character and receives no original-Carapils body bonus. Carafa Special I is dehusked, whereas regular Carafa III is not given the dehusked rule. Briess Munich remains family-level with anomalous color preserved. Briess Special Roast is biscuit-style even when its provider category says Roasted. Hop variety is separate from physical form, origin and supplier. Descriptor resolution never establishes concentrated-product dose equivalence. Bare Hallertau resolves only to a labelled regional class, never a guessed variety. CTZ resolves through its sold designation (Columbus and Tomahawk names too; bare Zeus does not). Proprietary Arctic Blend remains an explicit unknown, and Styrian Goldings is ambiguous between reviewed regional products and remains unknown.

Yeast tags represent fermentation expectations, never actual fruit/spice additions. Diastatic strains are not classified as infection or souring. Whiteout has unknown souring applicability because its maker describes substantial acidity without a calibrated tartness measurement. The engine must inspect missing yeast and material acid/fruit/process evidence before asserting none expected. The current Cosmic Punch page redirects to NEXT; only thiol-family context is retained, without historical strain performance or extra hop score.

Lactose may be explicitly recorded in either fermentables or miscellaneous ingredients; both roles use the same validated mass/volume floor. This is an exact common-name material rule, not a producer intensity score.

Miscellaneous identities distinguish explicit botanicals, ALDC, thiol precursors, water treatment, processing aids, fruit and antioxidant. Lactic/phosphoric acid tags identify brewing-acid context, but the engine must inspect stage: mash/sparge acid is not finished-beer sourness, while a material later acid addition cannot be dismissed. Ascorbic acid is an antioxidant. Unresolved Amylase Enzyme is not given an invented fermentability coefficient. Phantasm Powder is a precursor context only; the cited producer explicitly calls the powder a thiol precursor. Liquid Propper Phantasm specifications are not applied to it.

Common-name botanical/family resolution uses the explicit supplied identity and the approved composition categories; API documentation supports ingredient roles/units, not a producer's finished-beer descriptor. No manufacturer or product-specific performance claim is made for these generic entries. Briess's analysis flyer provides malt-family context; only manufacturer-specific entries carry producer character tags.

## Primary references

- [Primary source](https://fermentis.com/en/product/safale-us-05/): `fermentis-us05`.
- [Primary source](https://fermentis.com/en/product/saflager-w-34-70/): `fermentis-w3470`.
- [Primary source](https://fermentis.com/en/product/safale-s-04/): `fermentis-s04`.
- [Primary source](https://fermentis.com/en/product/saflager-s%E2%80%9123/): `fermentis-s23`.
- [Primary source](https://fermentis.com/en/product/safale-be-134/): `fermentis-be134`.
- [Primary source](https://fermentis.com/en/product/safale-wb-06/): `fermentis-wb06`.
- [Primary source](https://www.lallemandbrewing.com/en/africa/products/lalbrew-verdant-ipa/): `lallemand-verdant`.
- [Primary source](https://www.lallemandbrewing.com/en/africa/products/lalbrew-pomona/): `lallemand-pomona`.
- [Primary source](https://www.lallemandbrewing.com/en/united-states/products/belle-saison-beer-yeast/): `lallemand-belle`.
- [Primary source](https://www.lallemandbrewing.com/en/united-states/products/lalbrew-voss-kveik-ale-yeast/): `lallemand-voss`.
- [Primary source](https://connect.lallemandbrewing.com/wp-content/uploads/2019/10/TDS_LPS_BREWINGYEAST_KOLN_ENG_A4.pdf): `lallemand-koln`.
- [Primary source](https://wyeastlab.com/product/weihenstephan-weizen/): `wyeast-3068`.
- [Primary source](https://wyeastlab.com/product/belgian-high-gravity/): `wyeast-3787`.
- [Primary source](https://www.whitelabs.com/yeast-single?id=224&type=YEAST): `white-labs-wlp833`.
- [Primary source](https://www.whitelabs.com/yeast-single?id=119&type=YEAST): `white-labs-wlp029`.
- [Primary source](https://omegayeast.com/products/cosmic-punch-next): `omega-cosmic`.
- [Primary source](https://fermentis.com/en/product/safale-k%E2%80%9197/): `fermentis-k97`.
- [Primary source](https://www.whitelabs.com/yeast-single?id=168&type=YEAST): `white-labs-wlp565`.
- [Primary source](https://www.lallemandbrewing.com/en/asia/products/nottingham-high-performance-ale-yeast/): `lallemand-nottingham`.
- [Primary source](https://omegayeast.com/products/wit-standard): `omega-wit`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/juice): `imperial-a38`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/darkness): `imperial-a10`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/house): `imperial-a01`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/dieter): `imperial-g03`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/stefon): `imperial-g01`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/whiteout): `imperial-b44`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/rustic): `imperial-b56`.
- [Primary source](https://www.imperialyeast.com/yeast-strains/napoleon): `imperial-b64`.
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
- [Primary source](https://docs.brewfather.app/api/types): `misc-lactose`, `botanical-cloves`, `botanical-coriander`, `botanical-orange-peel`, `botanical-ginger`, `botanical-cinnamon`, `botanical-paradise`, `botanical-allspice`, `botanical-chamomile`, `misc-salts`, `misc-fining`, `misc-acid`, `misc-antioxidant`, `fruit-frozen-blueberry`, `fruit-frozen-raspberry`, `fruit-Hibiscus`.
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
- [Primary source](https://www.whitelabs.com/yeast-bank/wlp013-london-ale-yeast): `white-labs-wlp013`.
- [Primary source](https://wyeastlab.com/product/london-ale): `wyeast-1028`.
- [Primary source](https://omegayeast.com/yeast/norwegian-ales/voss-kveik): `omega-voss`.
- [Lallemand technical data sheet, distributor copy](https://files.scottlab.com/uploads/NEW%20ENGLAND%20TDS.pdf): `lallemand-new-england`.
- [Manufacturer description, retailer copy](https://brouwland.com/en/yeast-and-bacteria/1942-dried-brewing-yeast-belgian-wit-m21-mangrove-jack-s-craft-series-10-g.html): `mangrove-jacks-m21`.

The 2026-10-17 entries above were reviewed through search-result summaries of the cited pages because direct page fetches were unavailable in the authoring environment; they keep only short paraphrased tags the summaries attribute to the producer. Where producers disagree (Crystal), only the shared mild character is kept. The Hallertau regional class keeps the character named by at least two of the three reviewed Hallertau aroma varieties and records that the variety is unknown. Strains whose producer describes no flavour beyond clean or lager-like fermentation (WLP007, WLP820, Wyeast 1056, Omega Kölsch II, Lutra and Oktoberfest) are intentionally not added: they would carry no descriptors, and an unresolved Brewfather Ale/Lager/Wheat yeast is already treated as non-souring. Sterling, DrYeast Y36 and Wyeast 1728 have no reviewed producer description and stay unresolved.

Follow-up priority coverage uses [Canada Malting](https://canadamalting.com/products/) for the exact CMC two-row base family, [Fawcett](https://www.fawcett-maltsters.co.uk/our-malts/) for the exact Golden Promise pale-ale malt, [Murphy & Rude Crystal 40](https://www.murphyrudemalting.com/product-page/crystal-40) for the manufacturer-guarded crystal family and character, and [Gambrinus Honey Malt](https://gambrinusmalting.com/wp-content/uploads/2025/10/HoneyMalt.pdf) for Brumalt identity and bread-crust/honey/toast/toffee expectations. Gambrinus aromatic-family scoring is an explicit engineering interpretation; it is not honey sugar. Bare Golden Promise is not an alias because the maker also lists distilling malt. Crystal 40 color ranges differ between current/older official pages, so no fixed source color is imposed. Exact Corn Sugar (Dextrose) is a simple-sugar family alias only; no corn grain/syrup equivalence is inferred. Epiphany Malted Oats has no reviewed product rule and is not assumed flaked; it receives only the generic base class its colour supports. Weyermann Acidulated is not classified because its producer allows both pH adjustment and sour-beer use; above 3% of the grist it blocks a none-expected tartness conclusion.

## Reuse and gaps

Producer sites show copyright/trademark notices. No permissive bulk-data license was established. Retain attribution and short factual paraphrases only; adding full descriptions, wheels, images, proprietary scores or a bulk download requires a separate reuse review. Lallemand links its user terms and co-branding guidance; brand/logo permissions are not presumed. No third-party catalogs are copied.

Official pages were read during implementation research, including Fermentis's corrected Unicode-hyphen S-23/K-97 URLs. Earlier guessed Lallemand Belle/Voss URLs and the direct flyer retrieval failed; the current official pages and indexed official flyer were used instead. Remaining inventory identities without verified product facts stay unresolved rather than inheriting descriptors from beer names/styles. Missing hop variety does not remove valid mass from the independent exposure calculation. Empty or missing yeast does not establish neutral fermentation.

Historical Candi Syrup D-90/D-180 identities are treated only as explicitly supplied sugar/syrup family records, without formulation or flavor specifications; the current [maker site](https://www.candisyrup.com/) says it no longer serves brewing customers.

Carapils Copper's biscuit-family applicability is an engineering classification based on the sourced malty, graham-cracker and toasty character; no manufacturer coefficient is claimed. The coordinator owns acceptance of that family in the numeric engine.

Identity coverage of the 61-batch history with catalog 2, as batch occurrences that resolve to a product, family or generic class: fermentables 266/267, hops 194/205, yeasts 54/62, misc 432/433. This is an identity coverage diagnostic, not sensory or end-to-end validation. All named yeast in the 13 priority cases resolve; B053's empty list remains unknown. Remaining hop gaps are Styrian Goldings (regional/product ambiguity), proprietary Arctic Blend, Sterling and unnamed additions; remaining yeast gaps are the deliberately omitted clean and lager strains plus Wyeast 1728 and DrYeast Y36. Generic dark/wheat extracts do not have an applicability rule. Unresolved material must reduce support; these gaps are not zero contributions or neutral fermentation evidence.
