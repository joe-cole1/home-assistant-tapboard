# Recipe-informed flavor guidance

Tapboard computes deterministic guidance from local normalized brewing inputs. This is a transparent heuristic, not measured tasting data, a trained model, or a claim that recipes predict an individual drinker's perception. The offline 107-recipe corpus checks normalization, coverage, regression behavior, and counterfactuals; it is neither training data nor tasting ground truth.

The fixed axis order is malt, hops, bitterness, sweetness, body, roast, tartness, alcohol. Public values use 0–5. Stored manual overrides use 0–10 and are divided by two at projection time. Each axis independently chooses manual, recipe prediction, a reviewed exact style baseline, then unavailable. Invalid stored manual values remain unavailable. Clearing a sensory override exposes the next layer. Style is not ingredient evidence; recipe titles and style substrings do not identify products or supply numeric predictions. Non-beer recipes have no beer-formula predictions, although manual values remain available.

## Inputs and source selection

Beverages owns normalization and persisted source snapshots; Story owns calculation and privacy projections. Snapshot payload schema version 2 contains `brewingInputs`. This payload version is independent of the source record's revision. Legacy snapshots are adapted conservatively without rewriting historical rows; incomplete legacy and Custom ingredient schedules cannot establish absence.

Provider scalars use the first **valid** candidate, retaining zero, source path, units, provenance, and invalid-candidate diagnostics:

| Scalar           | Preferred candidates                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| OG               | measured batch OG, estimated batch OG, recipe OG                                                    |
| FG               | measured batch FG, estimated batch FG, recipe FG, recipe estimated FG                               |
| ABV              | measured batch ABV (provider-calculated), estimated batch ABV, recipe ABV                           |
| IBU / color      | estimated batch value, recipe value                                                                 |
| Fermenter volume | measured batch size, equipment fermenter volume, recipe batch size unless efficiency type is Kettle |

Operator scalar overrides take precedence by presence, including an explicit null that suppresses fallback. Missing, malformed, and zero are distinct. Transport validation is broader than the model's domain: model FG is 0.980–1.060, OG above 1 through 1.200, ABV 0–25%, IBU 0–200, and volume positive through 10,000 L. Bottling volume, a default density, water pH, mash pH, and carbonation targets do not stand in for these inputs.

Brewfather API-v2/export-v3 fermentables default to kg and hops to g. Misc and yeast amounts require explicit units. Mass conversion supports kg, g, mg, lb/lbs and oz; liquid and package amounts do not become mass. Custom inputs require explicit mass units and do not have a complete typed ingredient schedule. Collections are bounded to 100 rows; missing, rejected or truncated collections cannot prove absence. Complete empty arrays are distinct from missing arrays. Process step collections are bounded to 50 rows.

Hop uses normalize to boil, dry hop, whirlpool (including aroma/hopstand), first wort, mash, or unknown. Boil time is minutes only with a compatible unit. Dry-hop `day` is retained without assuming addition time; contact duration requires explicit days or the reviewed API-v2 convention. Export time without a unit is ambiguous. Day and contact duration never multiply dose. Unrecognized stages and concentrated hop forms remain limited or unavailable.

Reported batch attenuation and recipe attenuation remain separate from apparent attenuation recomputed as `100 × (OG − FG) / (OG − 1)`. Export recipe attenuation fractions are converted to percent; ambiguous fractional API values are diagnosed. Finish proxies validate each candidate and prefer applicable apparent, then reported, then recipe attenuation, without applying attenuation twice. Provider hop oil is retained without an oil-based score; bounded aroma categories can support descriptor labels without becoming magnitude coefficients.

The existing batch list (limit 50, `start_after`) and batch detail (`GET /v2/batches/:id`, no `include` filter) endpoints remain the only required reads. Detail supplies the embedded historical recipe, scalar candidates, typed ingredient arrays, process notes, mash/fermentation and water context. Hop aroma attributes (eight documented keys, 0–100), total oil, carbonation, and process steps are recognized but optional; absence is not a provider health failure. Tasting fields, readings/brew-tracker, inventory mirrors, images, account settings, arbitrary URLs and recursive prose extraction are excluded from the flavor pipeline. No new write endpoint or permission is needed; the existing completion-policy workflow is unchanged. The local 100-call/hour budget, 1 MB response limit, backoff and cancellation remain stricter than the documented provider ceiling.

## Facts, coverage, and coefficients

The local catalog contains concise categorical producer facts, reviewed aliases, identity guards, source URLs, and limitations. See [the catalog source ledger](flavor-catalog-sources.md). Strong manufacturer/laboratory plus product code matches precede exact aliases and the small reviewed category fallback. There is no runtime catalog lookup. Ambiguous Hallertau and proprietary blends do not acquire guessed constituents; original Briess Carapils, Carapils Copper and Weyermann products remain distinct. Producer descriptors are factual context, not producer endorsement of Tapboard's numeric coefficients.

The engine's coefficients are separately authored heuristics. Grist uses positive mass fractions where possible, otherwise complete percentages totaling 100 ± 0.5%. Processing aids are excluded. Numeric composition support needs complete inputs, at least 85% classified fraction, and no individual unresolved fraction above 5%. Supported absence needs complete contributor coverage. A mass/percentage disagreement above two percentage points is diagnosed. Extract ingredients above 5% are unsupported for malt/roast and receive no extract-derived adjunct body bonus.

All curves below interpolate linearly between points and clamp at endpoints. Final scores clamp to 0–5. Model version is `recipe-flavor-1`; catalog version is tracked separately. Fingerprints hash normalized sources, manual values, model and catalog versions with stable serialization; time, database access and network calls are absent.

| Axis / component                    | Curve points or calculation                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Malt                                | Fraction-weighted coefficient × `clamp((OG−1)/0.05, 0.65, 1.35)`; missing OG uses 1 with a limitation |
| Hop aroma                           | `E = Σ(grams × stage weight) / fermenter liters`; score `5 × (1 − exp(−E/5))`                         |
| Bitterness IBU base                 | (0,0), (10,0.8), (20,1.6), (35,2.5), (50,3.4), (70,4.2), (100,5)                                      |
| FG bitterness masking               | (1.010,0), (1.020,0.25), (1.030,0.5), subtracted from IBU base                                        |
| Roast weighted percent              | (0,0), (0.5,0.4), (2,1.3), (5,2.8), (10,4.2), (15,5)                                                  |
| Sweetness FG                        | (0.990,0), (1.000,0.1), (1.004,0.4), (1.008,0.8), (1.012,1.4), (1.018,2.4), (1.026,3.6), (1.040,5)    |
| Sweetness attenuation fallback      | (50,5), (60,4), (70,3), (78,2), (85,1), (92,0)                                                        |
| Lactose floor, g/L                  | (0,0), (5,0.2), (10,0.4), (20,0.8), (40,1.5)                                                          |
| Body FG                             | (0.990,0.3), (1.000,0.5), (1.006,0.9), (1.010,1.4), (1.014,2), (1.020,2.9), (1.028,3.8), (1.040,5)    |
| Body attenuation fallback           | (50,5), (60,4), (70,2.5), (78,1.5), (85,0.75), (92,0)                                                 |
| Adjunct body bonus weighted percent | (0,0), (5,0.15), (15,0.4), (30,0.75), (50,1)                                                          |
| Alcohol                             | `clamp((ABV−3)/2, 0, 5)`                                                                              |

Malt family coefficients are pilsner 1.6, pale 1.8, wheat/rye 1.4, Vienna 2.8, Munich 3.6, biscuit 4, aromatic 4.4, light crystal 3.6, dark crystal 4, roasted/chocolate/dehusked 1.8, flaked 0.7, Carapils 0.2, and sugar/lactose/processing 0. Roast weights are black 1, chocolate 0.8 and dehusked 0.35. Body weights are oats/flaked wheat/chit 1, rye 0.8, wheat 0.5 and Carapils 0.4.

Boil aroma weights interpolate (0 min,0.5), (5,0.4), (10,0.3), (20,0.15), (30,0.08), (60,0.025); first wort is 0.02, whirlpool 0.6, dry hop 1, mash 0. Complete dose/stage data and defensible volume are required; a resolved cultivar is not required for magnitude. Concentrated forms are unsupported. Unknown identities limit descriptors and remain in the denominator.

Sweetness subtracts 0.08 times the IBU base and uses lactose as a floor, not an additive double count. FG is a residual-extract proxy, not sugar concentration. Body adds `clamp((ABV−3)×0.08, 0, 0.6)` and `adjunct bonus × (1−base/5)`; polymer composition is not measured. Barrel history never boosts alcohol.

Tartness is zero only for a complete conventional recipe with known non-souring yeast, complete resolved misc inputs, complete absence support and complete process context. Zero means none expected, not measured zero acidity. Souring cultures, fruit, finished-beer acid or insufficient evidence remain null rather than receiving a fixed high score. Ordinary mash/sparge acid and water treatment do not imply finished-beer tartness; acid with ambiguous stage blocks absence. Botanical cloves and yeast clove descriptors are separate evidence.

Descriptors are bounded to six, deduplicated and balanced across ingredient roles. A hop contributor must support at least 0.1 exposure g/L and 5% of total exposure. These labels describe supported context without creating unsupported numeric axes.

## Process context and disclosure

The parser reads at most 30 authorized notes plus batch notes, with 4,000 characters and 40 clauses per text. Explicit completed barrel, wood, spirit or vanilla-extract additions can produce bounded process categories. Negated, planned, uncertain and future clauses are excluded. Contradictory timing is marked inconsistent; no duration, dosage or sensory score is inferred. Raw notes, timestamps and narrative text are not persisted in process facts.

Public flavor guidance contains generic notes, descriptors and process tags; selected source metrics, product/strain identity, evidence references, URLs and calculation diagnostics stay Admin-only. Mystery sensory disclosure controls the entire flavor projection. Process history additionally requires recipe **or** description disclosure. This applies before HTML, JSON, SVG/ARIA and targeted refresh serialization; SSE carries dirty identifiers only.

Radar requires all eight numeric axes with supported recipe or manual sources; limited and style-only filler use bars. Otherwise fixed-scale bars retain unknown markers. Null means unavailable; zero is an evidence-supported low endpoint. Reviewed exact style aliases offer partial baselines, never an automatic complete style-only radar.

## Persistence, refresh, and verification

Schema 23 adds nullable malt and hops overrides while preserving existing override values exactly. Effective guidance is derived and is not stored. The existing bounded linked-batch detail loop prioritizes old payload schemas for enrichment; it does not discover new accounts or rewrite legacy records opportunistically. Successful refresh persists a coherent last-good source state only after rechecking the same beverage link and account configuration/lifecycle across awaits. Failed detail retrieval preserves last-good data. Enrichment pending is an Admin state, not a health failure.

The full offline fixture corpus stays in test/report tooling. It is never imported into a normal volume, sent to a browser, written to logs, or fetched from a private account for this workflow. Simulation alone uses seven minimized anonymized history snapshots: five on-tap beers (Oktoberfest (fixture B064), Saison (fixture B058), Porter (fixture B061), IPA (fixture B033), Bourbon Barrel Stout (fixture B026)) and two On Deck (Hefeweizen (fixture B052), Spiced Lager (fixture B060)). Their labels are truthful style/fixture identifiers because original names are unavailable. Selected historical scalars, normalized ingredients, and process facts supply recipe guidance without fabricated sensory overrides. The internal offline attachment stores payload-schema-2 snapshots as immutable detached Custom sources in the synthetic `offline-history` namespace, with no real account, external link, HTTP route, or additional schema migration. Historical fermentation volume and simulated keg volume remain separate. Regenerate the machine-readable corpus report with Node 24:

```sh
node scripts/report-flavor-corpus.ts
# Optional explicit output path:
node scripts/report-flavor-corpus.ts /tmp/flavor-corpus.json
```

The report records availability, source, bands, resolution coverage, diagnostics and fingerprints. Report output is model evidence, not tasting accuracy. Current acceptance results belong in [the status ledger](rebuild/STATUS.md); historical audits and frozen rebuild decisions retain their original scope.

### MANUAL DEV TEST — flavor guidance

After the normal volume-preserving development rebuild, confirm `/healthz` reports schema 23. In Admin, inspect the selected scalar sources, coverage, limitations, model/catalog versions and pending enrichment. Use disposable beverages to set malt and hops overrides, confirm the stored 0–10 to displayed 0–5 conversion, then clear them and inspect fallback. An explicit null scalar override must suppress provider fallback.

Inspect a complete beer, an incomplete recipe, a non-beer beverage and Mystery views at 320/360/390/768/1280 px in both themes. Confirm eight-axis order, fixed 0–5 bars, unknown markers and no misleading complete radar. Check keyboard, no-JavaScript forms, zoom and reduced motion. Hide sensory, then vary recipe/description reveals: process context requires sensory plus either reveal, and source diagnostics never appear publicly. Use the isolated preview's disposable data; do not import offline fixtures into the normal development volume.

In Simulation, inspect all seven sample profiles and the Bourbon Barrel Stout's completed barrel context. Set a malt or hops override to 0, confirm the displayed zero, then clear it to restore recipe guidance. Confirm five on-tap samples and two On Deck in a new or untouched original workspace; customized saved profiles/layouts must retain their state. Pour, exit, and re-enter to check saved volume/history, then exit and confirm normal inventory returns. Preserve the PIN and normal volume and keep external integrations untouched.
