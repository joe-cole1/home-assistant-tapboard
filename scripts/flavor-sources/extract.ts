import type { BrewingIngredientRole } from "../../src/features/beverages/brewing-types.ts";
import { IGNORED_PHRASES, LEXICON, type LexiconTerm } from "./lexicon.ts";

export interface ExtractedWord {
  readonly word: string;
  /** The maker's own phrase, normalised, that produced the word. */
  readonly evidence: string;
}
export interface ExcludedWord extends ExtractedWord {
  readonly reason: "negated" | "conditional" | "pairing" | "other ingredient";
}
export interface Extraction {
  readonly words: readonly ExtractedWord[];
  readonly excluded: readonly ExcludedWord[];
  /** Content words the lexicon does not know, for deliberate lexicon review. */
  readonly unmatched: readonly string[];
}

// A negator reaches forward to the next comma in its clause: "low fruitiness and esters" negates
// both, while "no diacetyl, fruity" keeps "fruity".
const NEGATOR =
  /\b(?:no|not|non|low(?:er)?(?! (?:doses?|dosage|dosing|rates?|temperatures?|gravit(?:y|ies)|hopping))|minimal|minimum|without|free of|clear of|void of|devoid of|none of|little of|absence of|absent|lacks?|lacking|less|reduced|reduces?|suppress\w*|avoid\w*|never|nor|zero)\b/g;
// Conditional and temperature-dependent statements describe what can happen, not what the
// product gives. A condition covers its own comma-separated part of the clause and everything
// after it, so "fruity, especially at higher temperatures" keeps "fruity" while "at warmer
// temperatures, banana" and "may produce banana, clove" leave every word out. "When paired with"
// is pairing advice and "when all is said and done" an idiom, not conditions.
const CONDITIONAL =
  /\b(?:if|when(?! paired\b| all is said and done)|whenever|unless|depending|depends|can(?! (?:all |also |often )?be (?:found|detected|noticed|tasted|smelled|perceived))|could|may|might|potentially|optionally|at (?:the )?(?:higher|lower|warmer|cooler|high|low|warm|cool|upper)|with (?:warmer|cooler|higher|lower)|warmer temperatures|cooler temperatures|higher temperatures|lower temperatures)\b/;
// A pairing or use marker covers the next few words, which name other ingredients or beer
// styles ("ideal for fruity Belgian ales"); flavour named later in the clause is the product's own.
const PAIRING =
  /\b(?:(?<!\b(?:notable|celebrated|known|looking|aiming|prized|renowned|famous|valued|loved|noted|bred|selected|appreciated|recognised|recognized|revered) )for|ideal for|suited (?:to|for)|recommended for|great for|perfect for|used in|use(?: it)? in|pair(?:s|ed)?(?: well| \w+ly)? with|complement\w*|accentuat\w*|enhanc(?:e|es|ing)\b|matches up|showcas\w*|alongside|blends?(?: well)? with|works well with|similar to|substitute\w*|replacement for)\b/g;
const PAIRING_REACH_WORDS = 4;
// A comparison names another product: its own phrase, and a "which…" phrase describing that
// product ("unlike WLP840, which tends toward apple, WLP940…"), belong to it.
const COMPARISON = /\b(?:unlike|compared (?:to|with)|as opposed to|in contrast to)\b/g;
// A flavour credited to another ingredient or material right after it ("a hint of spice from
// hops", "grape derived products", "tolerates acidic wort"), or naming another ingredient
// ("tropical hops" in yeast text; a hop maker's "fruity hop" is the hop itself).
const FROM_OTHER_INGREDIENT =
  /^ (?:(?:(?:that )?comes? )?from (?:the )?(?:hops?|malts?|grains?|grist|adjuncts?)|based|derived|worts?|water)\b/;
const OTHER_NOUN: Readonly<Record<BrewingIngredientRole, RegExp>> = {
  fermentables: /^ hops?\b/,
  hops: /^ malts?\b/,
  yeasts: /^ (?:hops?|malts?)\b/,
  miscs: /^ (?:hops?|malts?)\b/,
};
const STOPWORDS = new Set(
  "a an and are as at be been but by character characteristics contributes delivers distinct excellent flavor flavors flavour flavours from gives good great has have high hints imparts in into is it its known light medium mild moderate more most notes of on or over pleasant produces profile provides rich slightly strong subtle that the these this to touch very well which with aroma aromas aromatic taste tastes beer beers brewing brew style styles use used variety hop hops malt malts yeast strain also intense intensely nice clean crisp neutral balanced smooth dry sweet sweetness bitter bitterness body full finish mouthfeel".split(
    " ",
  ),
);

function normalise(text: string): string {
  return (
    text
      .replace(/[®™℠]/g, "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[‐‑–—-]/g, " ")
      // A slash joins alternatives inside one statement ("resinous/piney" shares its negation).
      .replace(/\//g, " / ")
      .replace(/&/g, " and ")
      .replace(/\+/g, " , ")
      .replace(/[^\S\n]+/g, " ")
  );
}
const escape = (phrase: string) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const entries: readonly { readonly phrase: string; readonly term: LexiconTerm | null }[] = [
  ...LEXICON.flatMap((term) => term.phrases.map((phrase) => ({ phrase, term }))),
  ...IGNORED_PHRASES.map((phrase) => ({ phrase, term: null })),
].sort((a, b) => b.phrase.length - a.phrase.length);
const byPhrase = new Map(entries.map((entry) => [entry.phrase, entry.term]));
const PHRASES = new RegExp(
  `\\b(?:${entries.map((entry) => escape(entry.phrase)).join("|")})\\b`,
  "g",
);

/** Deterministic flavour words from a maker's own text. Only lexicon phrases are recorded, in
 * the maker's order; negated, conditional and pairing mentions are reported, never kept. The
 * product's own names never yield a word ("Tsingtao Flower" is not floral). */
export function extractDescriptors(
  text: string,
  role: BrewingIngredientRole,
  ownNames: readonly string[] = [],
): Extraction {
  const words: ExtractedWord[] = [];
  const excluded: ExcludedWord[] = [];
  const unmatched = new Set<string>();
  const seen = new Set<string>();
  let normalised = normalise(text);
  for (const name of ownNames
    .map((own) => normalise(own).trim())
    .filter((own) => /[a-z]{3}/.test(own))
    .sort((a, b) => b.length - a.length))
    normalised = normalised.replace(new RegExp(`\\b${escape(name)}\\b`, "g"), " ");
  for (const clause of normalised.split(/[.;!?:\n]+|\b(?:but|while|whereas|however)\b/)) {
    const condition = CONDITIONAL.exec(clause);
    const conditionalFrom = condition ? clause.lastIndexOf(",", condition.index) + 1 : Infinity;
    const pairings = [...clause.matchAll(PAIRING)].map((match) => match.index + match[0].length);
    const negators = [...clause.matchAll(NEGATOR)].map((match) => match.index);
    const comparisons = [...clause.matchAll(COMPARISON)].map((match) => {
      const comma = clause.indexOf(",", match.index);
      const next = comma === -1 ? -1 : clause.indexOf(",", comma + 1);
      const describes = comma !== -1 && /^ (?:which|that|who)\b/.test(clause.slice(comma + 1));
      return {
        from: match.index,
        to: comma === -1 ? clause.length : describes && next !== -1 ? next : comma,
      };
    });
    let consumedTo = 0;
    for (const match of clause.matchAll(PHRASES)) {
      for (const token of clause.slice(consumedTo, match.index).match(/[a-z]{4,}/g) ?? [])
        if (!STOPWORDS.has(token)) unmatched.add(token);
      consumedTo = match.index + match[0].length;
      const term = byPhrase.get(match[0]);
      if (!term) continue;
      const evidence = match[0];
      const negatedBy = negators.findLast((at) => at < match.index);
      const reason: ExcludedWord["reason"] | null =
        (term.maltOnly && role === "yeasts") ||
        FROM_OTHER_INGREDIENT.test(clause.slice(match.index + match[0].length)) ||
        OTHER_NOUN[role].test(clause.slice(match.index + match[0].length)) ||
        comparisons.some(({ from, to }) => match.index > from && match.index < to)
          ? "other ingredient"
          : // A negator reaches to the next comma or a reversal ("less guava and more melon").
            negatedBy !== undefined && !/,|\bmore\b/.test(clause.slice(negatedBy, match.index))
            ? "negated"
            : match.index >= conditionalFrom
              ? "conditional"
              : pairings.some(
                    (end) =>
                      end <= match.index &&
                      clause.slice(end, match.index).split(/\s+/).filter(Boolean).length <
                        PAIRING_REACH_WORDS,
                  )
                ? "pairing"
                : null;
      if (reason) excluded.push({ word: term.word, evidence, reason });
      else if (!seen.has(term.word)) {
        seen.add(term.word);
        words.push({ word: term.word, evidence });
      }
    }
    for (const token of clause.slice(consumedTo).match(/[a-z]{4,}/g) ?? [])
      if (!STOPWORDS.has(token)) unmatched.add(token);
  }
  return { words, excluded, unmatched: [...unmatched].sort() };
}
