import type { FermentableFamily, IngredientClass, IngredientFact } from "./catalog-types.ts";
import type { BrewingIngredientRole } from "../../beverages/brewing-types.ts";
import { SOURCED_FACTS } from "./sourced.ts";

/** Immutable short factual tags; never manufacturer intensity scores or model coefficients. */
function fact(
  id: string,
  role: BrewingIngredientRole,
  aliases: readonly string[],
  source: string,
  details: Partial<IngredientFact> = {},
): IngredientFact {
  const entry: IngredientFact = {
    id,
    role,
    aliases,
    manufacturer: null,
    manufacturerAliases: [],
    codes: [],
    family: null,
    descriptors: [],
    sourceUrls: [source],
    reviewedAt: "2026-10-04",
    scope: "Categorical ingredient identity; not finished-beer intensity.",
    limitations: ["Descriptors are expectations, not guaranteed batch flavor."],
    souring: null,
    functions: [],
    bodyClass: null,
    roastClass: "none",
    noticeableGPerL: null,
    ...details,
  };
  for (const value of Object.values(entry)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(entry);
}

/** Hand-reviewed facts, each listed in docs/flavor-catalog-sources.md. Maker-sourced entries from
 * `sourced/*.json` follow them and replace them product by product. */
export const REVIEWED_FACTS: readonly IngredientFact[] = Object.freeze([
  fact(
    "lallemand-koln",
    "yeasts",
    ["Köln Kölsch", "LalBrew Köln"],
    "https://connect.lallemandbrewing.com/wp-content/uploads/2019/10/TDS_LPS_BREWINGYEAST_KOLN_ENG_A4.pdf",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      souring: false,
    },
  ),
  fact(
    "briess-carapils",
    "fermentables",
    ["Carapils", "Cara-Pils"],
    "https://brewingwithbriess.com/products/carapils-malts/",
    { manufacturer: "Briess", family: "carapils", bodyClass: "carapils" },
  ),
  fact(
    "briess-carapils-copper",
    "fermentables",
    ["Carapils Copper"],
    "https://brewingwithbriess.com/products/carapils-malts/",
    {
      manufacturer: "Briess",
      family: "biscuit",
      limitations: ["Distinct product; do not inherit original Carapils no-flavor rule."],
    },
  ),
  fact(
    "briess-munich",
    "fermentables",
    ["Munich"],
    "https://brewingwithbriess.com/products/munich-malts/",
    {
      manufacturer: "Briess",
      family: "munich",
      limitations: ["Munich family only; intended product and corrected color cannot be inferred."],
    },
  ),
  fact(
    "briess-special-roast",
    "fermentables",
    ["Special Roast", "Special Roast Malt"],
    "https://brewingwithbriess.com/blog/malt-of-the-month-special-roast/",
    {
      manufacturer: "Briess",
      family: "biscuit",
      limitations: [
        "Biscuit-style malt; not black roasted grain despite provider Roasted category.",
      ],
    },
  ),
  fact(
    "briess-honey",
    "fermentables",
    ["American Honey Malt"],
    "https://brewingwithbriess.com/products/kilned-malts/",
    { manufacturer: "Briess", family: "aromatic" },
  ),
  fact(
    "family-pilsner-53",
    "fermentables",
    ["Pilsner", "Pilsner Malt", "Pilsen Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "pilsner",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-pale-54",
    "fermentables",
    [
      "Pale Malt",
      "Pale Malt, 2-Row",
      "Pale Malt 2-Row",
      "Pale Ale Malt 2-Row",
      "Pale Ale Malt 2-Row",
      "Brewers Malt 2-Row",
      "Brewer's Malt, 2-Row, Premium",
      "2-Row Xtra Pale Malt",
    ],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "pale",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-wheat-55",
    "fermentables",
    ["Wheat Malt", "Wheat White Malt", "White Wheat Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "wheat",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      bodyClass: "wheat",
    },
  ),
  fact(
    "family-vienna-56",
    "fermentables",
    ["Vienna Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "vienna",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-munich-57",
    "fermentables",
    ["Munich Malt", "Munich Malt, Germany", "Munich I", "Munich II"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "munich",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-flaked-58",
    "fermentables",
    ["Oats, Flaked", "Flaked Oats"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "flaked",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      bodyClass: "oats",
    },
  ),
  fact(
    "family-flaked-59",
    "fermentables",
    ["Wheat Flaked", "Flaked Wheat"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "flaked",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      bodyClass: "flaked_wheat",
    },
  ),
  fact(
    "family-flaked-60",
    "fermentables",
    ["Barley, Flaked", "Flaked Barley", "Torrefied Wheat", "Torrified Wheat"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "flaked",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-rye-61",
    "fermentables",
    ["Rye Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "rye",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      bodyClass: "rye",
    },
  ),
  fact(
    "family-biscuit-62",
    "fermentables",
    ["Biscuit Malt", "Victory Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "biscuit",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-aromatic-63",
    "fermentables",
    ["Melanoidin Malt", "Aromatic Malt", "Abbey Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "aromatic",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-crystal_dark-64",
    "fermentables",
    [
      "Special B",
      "Chateau Special B",
      "Caramel Malt 120L",
      "Caramel/Crystal Malt 120L",
      "Caramel 120",
    ],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "crystal_dark",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-crystal_light-65",
    "fermentables",
    ["Caramunich II", "Caravienne 20", "Caramel Munich 60L Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "crystal_light",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
    },
  ),
  fact(
    "family-chocolate-66",
    "fermentables",
    ["Chocolate Malt", "Chocolate", "Chocolate Rye"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "chocolate",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      roastClass: "chocolate",
    },
  ),
  fact(
    "family-roasted-67",
    "fermentables",
    ["Roasted Barley", "Black (Patent) Malt", "Black Patent Malt", "Black Malt"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "roasted",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      roastClass: "black",
    },
  ),
  fact(
    "family-sugar-68",
    "fermentables",
    [
      "Dextrose",
      "Corn Sugar (Dextrose)",
      "Corn Sugar",
      "Table Sugar",
      "Sucrose",
      "Honey",
      "Candi Sugar",
      "Belgian Candi Sugar",
      "Candi Syrup",
      "Dark Candi Syrup",
      "Candi Sugar, Clear",
      "Candi Syrup, D-180",
      "Candi Syrup, D-90",
    ],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "sugar",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      functions: ["fermentable_sugar"],
    },
  ),
  fact(
    "family-lactose-69",
    "fermentables",
    ["Lactose", "Milk Sugar"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "lactose",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      functions: ["lactose"],
    },
  ),
  fact(
    "family-processing-70",
    "fermentables",
    ["Rice Hulls"],
    "https://www.brewingwithbriess.com/wp-content/uploads/documents/Briess_TypicalAnalysis_Flyer_Malts.pdf",
    {
      family: "processing",
      limitations: [
        "Reviewed generic composition family only; no manufacturer/product sensory specifications inferred.",
      ],
      functions: ["nonextract"],
    },
  ),
  fact(
    "family-cmc-two-row",
    "fermentables",
    ["2-Row Malt", "CMC 2-Row"],
    "https://canadamalting.com/products/",
    {
      manufacturer: "Canada Malting Co",
      manufacturerAliases: ["Canada Malting", "Canada Malting Co."],
      family: "pale",
      limitations: ["Reviewed base-malt family only; no product flavor coefficient claimed."],
    },
  ),
  fact(
    "family-fawcett-golden-promise",
    "fermentables",
    ["Pale Malt, Golden Promise"],
    "https://www.fawcett-maltsters.co.uk/our-malts/",
    {
      manufacturer: "Thomas Fawcett",
      manufacturerAliases: ["Thomas Fawcett & Sons"],
      family: "pale",
      limitations: [
        "Exact pale-ale malt identity only; bare Golden Promise can identify distilling malt and is not an alias.",
      ],
    },
  ),
  fact(
    "murphy-rude-crystal40",
    "fermentables",
    ["Crystal 40L (Murphy & Rude)", "Crystal 40"],
    "https://www.murphyrudemalting.com/product-page/crystal-40",
    {
      manufacturer: "Murphy & Rude Malting Co.",
      manufacturerAliases: ["Murphy & Rude", "Murphy & Rude Malting Co"],
      family: "crystal_light",
      limitations: [
        "Current producer color ranges differ; source color remains unchanged, and light-crystal coefficient is a Tapboard heuristic.",
      ],
    },
  ),
  fact(
    "gambrinus-honey",
    "fermentables",
    ["Honey Malt"],
    "https://gambrinusmalting.com/wp-content/uploads/2025/10/HoneyMalt.pdf",
    {
      manufacturer: "Gambrinus",
      manufacturerAliases: ["Gambrinus Malting", "Cargill (Gambrinus)"],
      family: "aromatic",
      limitations: [
        "Brumalt specialty, not honey sugar; aromatic-family coefficient is an explicit Tapboard heuristic classification.",
      ],
    },
  ),
  fact(
    "misc-lactose",
    "miscs",
    ["Lactose", "Milk Sugar"],
    "https://docs.brewfather.app/api/types",
    {
      family: "lactose",
      functions: ["lactose"],
      limitations: [
        "Explicit material identity and validated mass only; dose/volume floor is a Tapboard heuristic.",
      ],
    },
  ),
  fact(
    "misc-salts",
    "miscs",
    [
      "Calcium Chloride (CaCl2)",
      "Gypsum (CaSO4)",
      "Canning Salt (NaCl)",
      "Epsom Salt (MgSO4)",
      "Slaked Lime (Ca(OH)2)",
      "Baking Soda (NaHCO3)",
      "Chalk (CaCO3)",
      "Campden Tablets",
      "Sodium Metabisulfite (Na2S2O5)",
    ],
    "https://docs.brewfather.app/api/types",
    {
      limitations: [
        "Identity/function only. Addition stage must determine relevance; no finished-beer acidity or absence claim from water treatment.",
      ],
      functions: ["water_treatment"],
    },
  ),
  fact(
    "misc-fining",
    "miscs",
    ["Whirlfloc", "Gelatin", "Irish Moss", "Polyclar Brewbrite", "Fermcap-S", "Yeast Nutrients"],
    "https://docs.brewfather.app/api/types",
    {
      limitations: [
        "Identity/function only. Addition stage must determine relevance; no finished-beer acidity or absence claim from water treatment.",
      ],
      functions: ["processing"],
    },
  ),
  fact(
    "misc-acid",
    "miscs",
    ["Lactic Acid", "Phosphoric Acid"],
    "https://docs.brewfather.app/api/types",
    {
      limitations: [
        "Identity/function only. Addition stage must determine relevance; no finished-beer acidity or absence claim from water treatment.",
      ],
      functions: ["mash_acid"],
    },
  ),
  fact("misc-antioxidant", "miscs", ["Ascorbic Acid"], "https://docs.brewfather.app/api/types", {
    limitations: [
      "Identity/function only. Addition stage must determine relevance; no finished-beer acidity or absence claim from water treatment.",
    ],
    functions: ["antioxidant"],
  }),
  fact(
    "white-labs-brewzyme-d",
    "miscs",
    ["Brewzyme-D", "Brewzyme D"],
    "https://blog.whitelabs.com/solving-diacetyl-with-brewzyme-d",
    {
      codes: ["WLE4900"],
      limitations: [
        "Exact branded identity; ALDC not glucoamylase, no inferred FG or guaranteed diacetyl removal.",
      ],
      functions: ["aldc"],
    },
  ),
  fact(
    "phantasm-powder",
    "miscs",
    ["Phantasm Powder"],
    "https://www.freestylehops.com/hops/phantasm-thiol-precursor-powder-15kg/",
    {
      limitations: [
        "Precursor context only; no concentration, hop-dose equivalence or finished flavor intensity.",
      ],
      functions: ["thiol_precursor"],
    },
  ),
  fact(
    "weyermann-carafoam-family",
    "fermentables",
    ["Carafoam", "Carapils/Carafoam", "Carapils"],
    "https://www.weyermann.de/en-us/product/weyermann-carafoam/",
    {
      manufacturer: "Weyermann",
      family: "crystal_light",
      limitations: [
        "Distinct from original Briess Carapils; no inherited no-flavor rule or numerical mouthfeel bonus.",
      ],
    },
  ),
  fact(
    "weyermann-carafa-special-i",
    "fermentables",
    ["Carafa Special I", "Carafa Special Type 1"],
    "https://www.weyermann.de/en-gb/product/weyermann-carafa-special-type-1/",
    {
      manufacturer: "Weyermann",
      family: "dehusked_roast",
      roastClass: "dehusked",
    },
  ),
  fact(
    "weyermann-carafa-iii",
    "fermentables",
    ["Carafa III", "Carafa Type 3"],
    "https://www.weyermann.de/en-gb/product/weyermann-carafa-type-3/",
    {
      manufacturer: "Weyermann",
      family: "roasted",
      roastClass: "black",
    },
  ),
  fact(
    "briess-caramel-10",
    "fermentables",
    ["Caramel Malt 10L"],
    "https://brewingwithbriess.com/products/roasted-caramel-malts/",
    { manufacturer: "Briess", family: "crystal_light" },
  ),
  fact(
    "briess-caramel-40",
    "fermentables",
    ["Caramel Malt 40L"],
    "https://brewingwithbriess.com/products/roasted-caramel-malts/",
    { manufacturer: "Briess", family: "crystal_light" },
  ),
  fact(
    "briess-caramel-120",
    "fermentables",
    ["Caramel Malt 120L"],
    "https://brewingwithbriess.com/products/roasted-caramel-malts/",
    { manufacturer: "Briess", family: "crystal_dark" },
  ),
  fact(
    "briess-golden-light-extract",
    "fermentables",
    ["CBW Golden Light DME", "Golden Light DME"],
    "https://www.brewingwithbriess.com/wp-content/uploads/2020/11/Briess_PISB_CBWGoldenLightDME.pdf",
    {
      manufacturer: "Briess",
      family: "extract_pale",
      limitations: [
        "Reviewed pale barley extract only; generic dark/wheat extracts require their own composition rule.",
      ],
    },
  ),
]);
/** Brewfather ingredient-library names for maker-sourced products whose maker prints another
 * name. Each comes from the operator's own Brewfather rows for that maker and code (Lallemand
 * rows carry no code) or, for hops, for that variety, so a Brewfather row matches without a
 * code/name conflict. They are identity only and add no flavour data. */
export const BREWFATHER_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "avangard-munich-malt": ["Munich Malt, Germany"],
  "avangard-pilsener-malt": ["Pilsner Malt"],
  "bestmalz-munich-dark": ["Best Munich Malt Dark"],
  "bestmalz-pale-ale": ["Best Pale Ale Malt"],
  "briess-aromatic-munich-malt-20l": ["Aromatic Malt"],
  // The operator's 10 SRM Briess Munich; Briess states Bonlander at 10 SRM.
  "briess-bonlander-munich-malt-10l": ["Munich"],
  "briess-brewers-barley-flakes": ["Barley, Flaked"],
  "briess-brewers-malt": ["Brewers Malt 2-Row"],
  "briess-brewers-oat-flakes": ["Oats, Flaked"],
  "briess-caramel-munich-malt-60l": ["Caramel Munich 60L Malt"],
  "briess-carapils-malt": ["Carapils"],
  // Briess's only 350 °L chocolate malt; Dark Chocolate is 420 °L.
  "briess-chocolate-malt": ["Chocolate"],
  "briess-goldpils-vienna-malt": ["Vienna Malt"],
  "briess-pale-ale-malt": ["Pale Ale Malt 2-Row"],
  "briess-special-roast-malt": ["Special Roast"],
  "briess-wheat-malt-red": ["Wheat Red Malt"],
  "briess-wheat-malt-white": ["Wheat White Malt"],
  "crisp-extra-pale-maris-otter-malt": ["Maris Otter (Extra Pale)"],
  // Named by the operator: the 4 SRM row is above all three of Crisp's Maris Otter ranges.
  "crisp-finest-maris-otter-ale-malt": ["Maris Otter"],
  "fawcett-golden-promise-pale-ale-malt": ["Pale Malt, Golden Promise"],
  "fermentis-be-134": ["Safale Belgian-Saison"],
  "fermentis-k-97": ["SafAle German Ale"],
  "fermentis-s-04": ["SafAle English Ale"],
  "fermentis-s-23": ["SafLager West European Lager"],
  "fermentis-us-05": ["Safale American"],
  "fermentis-w-34-70": ["Saflager Lager"],
  "fermentis-wb-06": ["Safbrew Wheat"],
  // The operator's plain "Cargill" rows are Gambrinus bags; Organic is Gambrinus's only wheat.
  "gambrinus-organic-wheat-malt": ["Wheat White"],
  "gambrinus-pale-malt": ["Pale Malt 2-Row"],
  "gambrinus-pilsner-malt": ["Pilsner 2-Row"],
  "great-western-crystal-15-malt": ["Crystal 2-Row"],
  "great-western-premium-two-row-malt": ["Brewer's Malt, 2-Row, Premium"],
  // Hopsteiner sells Columbus as CTZ.
  "hop-columbus": ["Columbus/Tomahawk/Zeus (CTZ)"],
  "hop-east-kent-goldings": ["East Kent Goldings (EKG)"],
  "hop-hallertauer-mittelfruh": ["Hallertauer Mittelfrueh"],
  "hop-idaho-7": ["Idaho #7"],
  "lallemand-new-england": ["New England American East Coast Ale"],
  "murphy-rude-crystal-40": ["Crystal 40L (Murphy & Rude)"],
  "lallemand-nottingham": ["Nottingham Yeast"],
  "lallemand-verdant-ipa": ["Lallemand Verdant IPA Yeast"],
  "lallemand-voss": ["Voss Kveik"],
  "omega-lutra-kveik-standard": ["Lutra Kveik"],
  "omega-voss-kveik-standard": ["Voss Kveik"],
  "proximity-crystal-15": ["Crystal 15L"],
  "proximity-crystal-120": ["Crystal 120L"],
  "proximity-crystal-40": ["Crystal 40L"],
  "proximity-prox-crystal-munich-style-60": ["CaraMunich 60L"],
  "proximity-prox-crystal-vienna-style-20": ["Caravienne 20"],
  // Rahr states 1.8–2.4 SRM for 2-Row and 2.7–4.8 for Pale Ale; the operator's rows are 1.8.
  "rahr-the-brewer-s-standard-2-row": ["Pale Malt, 2-Row"],
  // Golden Promise at 2.4 °L: Finest is 2.1–2.8 °L, Low Colour at most 1.9.
  "simpsons-finest-pale-ale-golden-promise": ["Pale Ale Golden Promise"],
  "viking-pilsner-malt": ["Pilsner"],
  "weyermann-acidulated-malt": ["Acidulated"],
  "weyermann-carafa-special-type-1": ["Carafa Special I"],
  // Carafa III without "Special" is the husked CARAFA Type 3.
  "weyermann-carafa-type-3": ["Carafa III"],
  "weyermann-caramunich-type-1": ["Caramunich I"],
  "weyermann-caramunich-type-2": ["Caramunich II"],
  // One malt sold as CARAPILS® in Europe and CARAFOAM® in the US.
  "weyermann-carapils": ["Carapils/Carafoam"],
  "weyermann-chocolate-rye-malt": ["Chocolate Rye"],
  "weyermann-munich-malt-type-1": ["Munich I"],
  "weyermann-wheat-malt-pale": ["Wheat Malt, Pale"],
  "white-labs-wlp007": ["Dry English Ale"],
  "white-labs-wlp029": ["German Ale/Kolsch", "German/Kölsch Ale"],
  "white-labs-wlp820": ["Octoberfest/Marzen Lager"],
  "wyeast-1028": ["London Ale Yeast"],
  "wyeast-3787": ["Trappist High Gravity"],
});
/** Brewfather names one maltster uses for a whole colour series, from the operator's own rows. The
 * row's colour, rounded to whole numbers as the maltster states them, picks the one product whose
 * stated range holds it; a colour in no range picks none. Bairds states SRM. Briess names its
 * caramel malts in °L, and Brewfather stores those rows as SRM converted from °L. Identity only,
 * like BREWFATHER_NAMES. */
export const BREWFATHER_COLOUR_SERIES: Readonly<
  Record<
    string,
    {
      readonly unit: "srm" | "lovibond";
      readonly ranges: Readonly<Record<string, readonly [number, number]>>;
    }
  >
> = Object.freeze({
  "Caramel/Crystal Malt": {
    unit: "srm",
    ranges: {
      "bairds-light-caramalt": [13, 17],
      "bairds-medium-caramalt": [30, 37],
      "bairds-light-crystal": [50, 60],
      "bairds-medium-crystal": [70, 80],
      "bairds-dark-crystal-malt": [95, 115],
      "bairds-extra-dark-crystal-malt": [135, 165],
    },
  },
  "Caramel Malt": {
    unit: "lovibond",
    ranges: {
      "briess-caramel-malt-10l": [10, 10],
      "briess-caramel-malt-20l": [20, 20],
      "briess-caramel-malt-30l": [30, 30],
      "briess-caramel-malt-40l": [40, 40],
      "briess-caramel-malt-60l": [60, 60],
      "briess-caramel-malt-80l": [80, 80],
      "briess-caramel-malt-90l": [90, 90],
      "briess-caramel-malt-120l": [120, 120],
    },
  },
});
export const INGREDIENT_FACTS: readonly IngredientFact[] = Object.freeze([
  ...REVIEWED_FACTS,
  ...SOURCED_FACTS.map((fact) =>
    BREWFATHER_NAMES[fact.id]
      ? { ...fact, aliases: [...fact.aliases, ...BREWFATHER_NAMES[fact.id]!] }
      : fact,
  ),
]);

/** Words a malt family names itself: smoked and peated malts are smoke by name. Every other
 * malt's words come only from its maltster. */
export const FAMILY_CHARACTER: Readonly<Partial<Record<FermentableFamily, readonly string[]>>> =
  Object.freeze({ smoked: ["smoky"], peated: ["peaty", "smoky"] });
/** Sugars that name their flavour (honey, maple, molasses or treacle). Units are
 * `potency × grist fraction` from `minFraction` up; other sugars carry no words. */
export const SUGAR_CHARACTER: readonly {
  readonly pattern: RegExp;
  readonly words: readonly string[];
  readonly potency: number;
  readonly minFraction: number;
}[] = Object.freeze([
  { pattern: /honey/, words: ["honey"], potency: 25, minFraction: 0.04 },
  { pattern: /maple/, words: ["maple"], potency: 25, minFraction: 0.04 },
  { pattern: /molasses|treacle/, words: ["molasses"], potency: 60, minFraction: 0.01 },
]);

function ingredientClass(
  id: string,
  label: string,
  roles: IngredientClass["roles"],
  pattern: RegExp,
  details: Partial<IngredientClass> = {},
): IngredientClass {
  return Object.freeze({
    id,
    label,
    roles,
    pattern,
    exclude: null,
    types: [],
    family: null,
    descriptors: [],
    functions: [],
    noticeableGPerL: null,
    ...details,
  });
}
const ADJUNCT = ["miscs", "fermentables"] as const;
const spice = (id: string, pattern: RegExp, word: string, noticeableGPerL: number) =>
  ingredientClass(id, word, ADJUNCT, pattern, {
    descriptors: [word],
    functions: ["botanical"],
    noticeableGPerL,
  });
const fruit = (id: string, pattern: RegExp, word: string, noticeableGPerL: number) =>
  ingredientClass(id, word, ADJUNCT, pattern, {
    descriptors: [word],
    functions: ["fruit"],
    noticeableGPerL,
  });

/** Generic classes, tried in order after reviewed products and property rules. Patterns test the
 * accent-folded lowercase name, and adjunct classes name the ingredient itself. There are no yeast
 * classes: a strain's character comes only from its maker. `noticeableGPerL` is a Tapboard
 * heuristic near the low end of common homebrew doses, not a sensory threshold. */
export const INGREDIENT_CLASSES: readonly IngredientClass[] = Object.freeze([
  // Processing aids, then Brewfather misc types; the engine still checks acid addition stage.
  ingredientClass(
    "class-processing",
    "processing aid",
    ADJUNCT,
    /enzyme|amylase|glucanase|protease|ultra-?ferm|clarity|\baldc\b|nutrient|servomyces|fermaid|go-?ferm|anti-?foam|foam control|fermcap|isinglass|silica|kieselsol|biofine|chitosan|pvpp|polyclar|whirlfloc|irish moss|gelatin|campden|metabisulfite|(rice|oat) hulls?/,
    { family: "processing", functions: ["processing"] },
  ),
  ingredientClass("class-water-acid", "brewing acid", ["miscs"], /acid|sauer|sour/, {
    types: ["water agent"],
    functions: ["mash_acid"],
  }),
  ingredientClass("class-water-treatment", "water treatment", ["miscs"], /./, {
    exclude: /juice|puree|fruit|peel|zest/,
    types: ["water agent"],
    functions: ["water_treatment"],
  }),
  ingredientClass("class-fining", "fining", ["miscs"], /./, {
    types: ["fining"],
    functions: ["processing"],
  }),
  // Citrus peel and zest season like spices; names that also contain a fruit word come first.
  spice("class-orange-peel", /orange.*(peel|zest|extract|oil)|(peel|zest).*orange/, "orange", 0.4),
  spice("class-lemon-peel", /lemon.*(peel|zest|extract|oil)|(peel|zest).*lemon/, "lemon", 0.4),
  spice(
    "class-lime-peel",
    /(lime|kaffir|makrut).*(peel|zest|lea(f|ves)|extract)|(peel|zest).*lime/,
    "lime",
    0.4,
  ),
  spice(
    "class-grapefruit-peel",
    /grapefruit.*(peel|zest|extract)|(peel|zest).*grapefruit/,
    "grapefruit",
    0.4,
  ),
  spice(
    "class-tangerine-peel",
    /(tangerine|mandarin|clementine|yuzu).*(peel|zest|extract)|(peel|zest).*(tangerine|mandarin|clementine|yuzu)/,
    "tangerine",
    0.4,
  ),
  spice("class-lemongrass", /lemon ?grass/, "lemongrass", 0.5),
  // Fruit, juice and hibiscus can add acidity, so they precede plant classes ("Hibiscus Tea").
  fruit("class-hibiscus", /hibiscus/, "hibiscus", 0.8),
  fruit("class-watermelon", /watermelon/, "watermelon", 60),
  fruit("class-melon", /melon|cantaloupe|honeydew/, "melon", 60),
  fruit("class-passion-fruit", /passion ?fruit|maracuja|lilikoi/, "passion fruit", 30),
  fruit("class-pineapple", /pineapple/, "pineapple", 40),
  fruit("class-raspberry", /raspberr/, "raspberry", 40),
  fruit("class-blackberry", /blackberr|boysenberr|marionberr/, "blackberry", 40),
  fruit("class-strawberry", /strawberr/, "strawberry", 50),
  fruit("class-blueberry", /blueberr/, "blueberry", 60),
  fruit("class-cranberry", /cranberr/, "cranberry", 40),
  fruit("class-currant", /currant|cassis/, "currant", 40),
  ingredientClass("class-cherry", "cherry", ADJUNCT, /cherr/, {
    exclude: /wood|smoked/,
    descriptors: ["cherry"],
    functions: ["fruit"],
    noticeableGPerL: 40,
  }),
  fruit("class-peach", /peach|nectarine/, "peach", 40),
  fruit("class-apricot", /apricot/, "apricot", 40),
  fruit("class-mango", /mango/, "mango", 40),
  fruit("class-guava", /guava/, "guava", 40),
  fruit("class-plum", /\bplums?\b|prune/, "plum", 40),
  fruit("class-grape", /\bgrapes?\b/, "grape", 60),
  fruit("class-pomegranate", /pomegranate/, "pomegranate", 40),
  fruit("class-banana", /banana/, "banana", 40),
  fruit("class-apple", /\bapples?\b|\bcider\b/, "apple", 60),
  fruit("class-pear", /\bpears?\b/, "pear", 60),
  ingredientClass("class-orange", "orange", ADJUNCT, /orange/, {
    exclude: /blossom|pekoe/,
    descriptors: ["orange"],
    functions: ["fruit"],
    noticeableGPerL: 20,
  }),
  ingredientClass("class-lemon", "lemon", ADJUNCT, /lemon/, {
    exclude: /balm|verbena/,
    descriptors: ["lemon"],
    functions: ["fruit"],
    noticeableGPerL: 10,
  }),
  ingredientClass("class-lime", "lime", ADJUNCT, /\blimes?\b/, {
    exclude: /slaked|pickling|hydrated|calcium|ca\(oh\)/,
    descriptors: ["lime"],
    functions: ["fruit"],
    noticeableGPerL: 10,
  }),
  fruit("class-grapefruit", /grapefruit/, "grapefruit", 20),
  fruit("class-tangerine", /tangerine|mandarin|clementine|yuzu/, "tangerine", 20),
  // Spices, herbs and other plant flavours.
  ingredientClass(
    "class-herbs",
    "herbal",
    ADJUNCT,
    /\bsage\b|rosemary|thyme|basil|bay lea|lemon (balm|verbena)|heather|yarrow|mugwort/,
    {
      descriptors: ["herbal"],
      functions: ["botanical"],
      noticeableGPerL: 0.3,
    },
  ),
  spice("class-clove", /\bcloves?\b/, "clove", 0.1),
  ingredientClass("class-allspice", "allspice", ADJUNCT, /all ?spice|pimento/, {
    descriptors: ["spicy"],
    functions: ["botanical"],
    noticeableGPerL: 0.1,
  }),
  spice("class-cinnamon", /cinnamon|cassia/, "cinnamon", 0.15),
  spice("class-nutmeg", /nutmeg|\bmace\b/, "nutmeg", 0.1),
  spice("class-ginger", /ginger/, "ginger", 0.6),
  spice("class-coriander", /coriander/, "coriander", 0.4),
  spice("class-cardamom", /cardamo[mn]/, "cardamom", 0.2),
  spice("class-anise", /anise|licorice|liquorice|fennel/, "anise", 0.1),
  ingredientClass("class-paradise", "grains of paradise", ADJUNCT, /paradise/, {
    descriptors: ["spicy"],
    functions: ["botanical"],
    noticeableGPerL: 0.08,
  }),
  spice(
    "class-chili",
    /chil[ei]|jalapeno|habanero|chipotle|ancho|serrano|cayenne|ghost pepper|poblano|scotch bonnet/,
    "chili",
    0.5,
  ),
  spice("class-peppercorn", /peppercorn|(black|white|pink) pepper|sichuan|szechuan/, "pepper", 0.2),
  spice("class-juniper", /juniper/, "juniper", 0.5),
  spice("class-spruce", /spruce|fir tips|pine tips/, "spruce", 1),
  spice("class-lavender", /lavender/, "lavender", 0.05),
  ingredientClass(
    "class-floral",
    "floral",
    ADJUNCT,
    /chamomile|rose ?(petals?|buds?)|elderflower|orange blossom/,
    {
      descriptors: ["floral"],
      functions: ["botanical"],
      noticeableGPerL: 0.4,
    },
  ),
  spice("class-mint", /\bmint\b|peppermint|spearmint/, "mint", 0.3),
  spice("class-tea", /\btea\b|earl grey|rooibos|matcha|chai/, "tea", 1),
  spice("class-vanilla", /vanilla/, "vanilla", 0.3),
  spice("class-coffee", /coffee|espresso|cold brew/, "coffee", 2),
  ingredientClass("class-cocoa", "cocoa", ADJUNCT, /cacao|cocoa|chocolate/, {
    exclude: /pale chocolate/,
    descriptors: ["cocoa"],
    functions: ["botanical"],
    noticeableGPerL: 2,
  }),
  spice("class-coconut", /coconut/, "coconut", 3),
  ingredientClass("class-nuts", "nutty", ADJUNCT, /hazelnut|pecan|almond|peanut|walnut|pistachio/, {
    descriptors: ["nutty"],
    functions: ["botanical"],
    noticeableGPerL: 3,
  }),
  ingredientClass("class-oak", "oak", ADJUNCT, /\boak\b/, {
    exclude: /smoked/,
    descriptors: ["oak"],
    functions: ["botanical"],
    noticeableGPerL: 1,
  }),
  // Spirits are dosed by volume; any recorded addition counts as noticeable.
  ingredientClass("class-bourbon", "bourbon", ADJUNCT, /bourbon/, {
    descriptors: ["bourbon"],
    functions: ["botanical"],
  }),
  ingredientClass("class-whiskey", "whiskey", ADJUNCT, /whiske?y/, {
    descriptors: ["whiskey"],
    functions: ["botanical"],
  }),
  ingredientClass("class-rum", "rum", ADJUNCT, /\brum\b/, {
    descriptors: ["rum"],
    functions: ["botanical"],
  }),
  // Honey and maple entered as miscs; as fermentable sugars they use SUGAR_CHARACTER.
  ingredientClass("class-honey", "honey", ["miscs"], /honey/, {
    descriptors: ["honey"],
    functions: ["fermentable_sugar"],
    noticeableGPerL: 25,
  }),
  ingredientClass("class-maple", "maple", ["miscs"], /maple/, {
    descriptors: ["maple"],
    functions: ["fermentable_sugar"],
    noticeableGPerL: 25,
  }),
]);
