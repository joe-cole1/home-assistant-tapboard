import type { IngredientFact } from "./catalog-types.ts";
import type { BrewingIngredientRole } from "../../beverages/brewing-types.ts";

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
    ...details,
  };
  for (const value of Object.values(entry)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(entry);
}

export const INGREDIENT_FACTS: readonly IngredientFact[] = Object.freeze([
  fact(
    "fermentis-us05",
    "yeasts",
    ["Safale American", "SafAle US-05"],
    "https://fermentis.com/en/product/safale-us-05/",
    { manufacturer: "Fermentis", codes: ["US-05"], souring: false },
  ),
  fact(
    "fermentis-w3470",
    "yeasts",
    ["Saflager Lager", "SafLager W-34/70"],
    "https://fermentis.com/en/product/saflager-w-34-70/",
    {
      manufacturer: "Fermentis",
      codes: ["W-34/70"],
      descriptors: ["floral", "fruity"],
      souring: false,
    },
  ),
  fact(
    "fermentis-s04",
    "yeasts",
    ["SafAle English Ale", "SafAle S-04"],
    "https://fermentis.com/en/product/safale-s-04/",
    {
      manufacturer: "Fermentis",
      codes: ["S-04"],
      descriptors: ["fruity", "floral"],
      souring: false,
    },
  ),
  fact(
    "fermentis-s23",
    "yeasts",
    ["SafLager West European Lager", "SafLager S-23"],
    "https://fermentis.com/en/product/saflager-s%E2%80%9123/",
    { manufacturer: "Fermentis", codes: ["S-23"], descriptors: ["fruity"], souring: false },
  ),
  fact(
    "fermentis-be134",
    "yeasts",
    ["Safale Belgian-Saison", "SafAle BE-134"],
    "https://fermentis.com/en/product/safale-be-134/",
    {
      manufacturer: "Fermentis",
      codes: ["BE-134"],
      descriptors: ["fruity", "floral", "spicy"],
      souring: false,
    },
  ),
  fact(
    "fermentis-wb06",
    "yeasts",
    ["Safbrew Wheat", "SafAle WB-06"],
    "https://fermentis.com/en/product/safale-wb-06/",
    {
      manufacturer: "Fermentis",
      codes: ["WB-06"],
      descriptors: ["fruity", "phenolic"],
      souring: false,
    },
  ),
  fact(
    "lallemand-verdant",
    "yeasts",
    ["Verdant IPA", "LalBrew Verdant IPA", "Lallemand Verdant IPA Yeast"],
    "https://www.lallemandbrewing.com/en/africa/products/lalbrew-verdant-ipa/",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      descriptors: ["apricot", "tropical fruit", "citrus"],
      souring: false,
    },
  ),
  fact(
    "lallemand-pomona",
    "yeasts",
    ["Pomona", "LalBrew Pomona"],
    "https://www.lallemandbrewing.com/en/africa/products/lalbrew-pomona/",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      descriptors: ["peach", "citrus", "tropical fruit"],
      souring: false,
    },
  ),
  fact(
    "lallemand-belle",
    "yeasts",
    ["Belle Saison", "LalBrew Belle Saison"],
    "https://www.lallemandbrewing.com/en/united-states/products/belle-saison-beer-yeast/",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      descriptors: ["citrus", "pepper", "fruity", "spicy"],
      souring: false,
    },
  ),
  fact(
    "lallemand-voss",
    "yeasts",
    ["Voss Kveik", "LalBrew Voss"],
    "https://www.lallemandbrewing.com/en/united-states/products/lalbrew-voss-kveik-ale-yeast/",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      descriptors: ["orange", "citrus"],
      souring: false,
    },
  ),
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
    "wyeast-3068",
    "yeasts",
    ["Weihenstephan Weizen"],
    "https://wyeastlab.com/product/weihenstephan-weizen/",
    {
      manufacturer: "Wyeast",
      manufacturerAliases: ["Wyeast Labs"],
      codes: ["3068"],
      descriptors: ["banana", "clove"],
      souring: false,
    },
  ),
  fact(
    "wyeast-3787",
    "yeasts",
    ["Trappist High Gravity", "Belgian High Gravity"],
    "https://wyeastlab.com/product/belgian-high-gravity/",
    {
      manufacturer: "Wyeast",
      manufacturerAliases: ["Wyeast Labs"],
      codes: ["3787"],
      souring: false,
    },
  ),
  fact(
    "white-labs-wlp833",
    "yeasts",
    ["German Bock Lager"],
    "https://www.whitelabs.com/yeast-single?id=224&type=YEAST",
    {
      manufacturer: "White Labs",
      manufacturerAliases: ["WhiteLabs"],
      codes: ["WLP833"],
      souring: false,
    },
  ),
  fact(
    "white-labs-wlp029",
    "yeasts",
    ["German Ale/Kolsch", "German/Kölsch Ale", "Kölsch Ale"],
    "https://www.whitelabs.com/yeast-single?id=119&type=YEAST",
    {
      manufacturer: "White Labs",
      manufacturerAliases: ["WhiteLabs"],
      codes: ["WLP029"],
      souring: false,
    },
  ),
  fact(
    "omega-cosmic",
    "yeasts",
    ["Cosmic Punch"],
    "https://omegayeast.com/products/cosmic-punch-next",
    {
      manufacturer: "Omega",
      manufacturerAliases: ["Omega Yeast", "Omega Yeast Labs"],
      codes: ["OYL-402"],
      limitations: [
        "Thiol-oriented family context only; current NEXT generation cannot establish historical process specifications or thiol concentration.",
      ],
      souring: false,
    },
  ),
  fact(
    "fermentis-k97",
    "yeasts",
    ["SafAle German Ale", "SafAle K-97"],
    "https://fermentis.com/en/product/safale-k%E2%80%9197/",
    {
      manufacturer: "Fermentis",
      codes: ["K-97"],
      descriptors: ["floral", "fruity"],
      souring: false,
    },
  ),
  fact(
    "white-labs-wlp565",
    "yeasts",
    ["Belgian Saison I Ale"],
    "https://www.whitelabs.com/yeast-single?id=168&type=YEAST",
    {
      manufacturer: "White Labs",
      manufacturerAliases: ["WhiteLabs"],
      codes: ["WLP565"],
      descriptors: ["earthy", "pepper", "spicy"],
      souring: false,
    },
  ),
  fact(
    "lallemand-nottingham",
    "yeasts",
    ["Nottingham Yeast", "Nottingham", "LalBrew Nottingham"],
    "https://www.lallemandbrewing.com/en/asia/products/nottingham-high-performance-ale-yeast/",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      souring: false,
    },
  ),
  fact("omega-wit", "yeasts", ["Wit"], "https://omegayeast.com/products/wit-standard", {
    manufacturer: "Omega",
    manufacturerAliases: ["Omega Yeast", "Omega Yeast Labs"],
    codes: ["OYL-030"],
    descriptors: ["spicy", "fruity"],
    souring: false,
  }),
  fact("imperial-a38", "yeasts", ["Juice"], "https://www.imperialyeast.com/yeast-strains/juice", {
    manufacturer: "Imperial Yeast",
    codes: ["A38"],
    descriptors: ["fruity", "citrus"],
    souring: false,
  }),
  fact(
    "imperial-a10",
    "yeasts",
    ["Darkness"],
    "https://www.imperialyeast.com/yeast-strains/darkness",
    { manufacturer: "Imperial Yeast", codes: ["A10"], souring: false },
  ),
  fact("imperial-a01", "yeasts", ["House"], "https://www.imperialyeast.com/yeast-strains/house", {
    manufacturer: "Imperial Yeast",
    codes: ["A01"],
    souring: false,
  }),
  fact("imperial-g03", "yeasts", ["Dieter"], "https://www.imperialyeast.com/yeast-strains/dieter", {
    manufacturer: "Imperial Yeast",
    codes: ["G03"],
    souring: false,
  }),
  fact("imperial-g01", "yeasts", ["Stefon"], "https://www.imperialyeast.com/yeast-strains/stefon", {
    manufacturer: "Imperial Yeast",
    codes: ["G01"],
    descriptors: ["banana", "clove"],
    souring: false,
  }),
  fact(
    "imperial-b44",
    "yeasts",
    ["Whiteout"],
    "https://www.imperialyeast.com/yeast-strains/whiteout",
    {
      manufacturer: "Imperial Yeast",
      codes: ["B44"],
      descriptors: ["spicy", "fruity"],
      limitations: [
        "Producer describes acidity; this is not a calibrated finished-beer tartness value or a souring-process assertion.",
      ],
    },
  ),
  fact(
    "imperial-b56",
    "yeasts",
    ["Rustic", "B56 Rustic"],
    "https://www.imperialyeast.com/yeast-strains/rustic",
    {
      manufacturer: "Imperial Yeast",
      codes: ["B56", "B56 Rustic"],
      descriptors: ["bubblegum", "fruity", "clove"],
      souring: false,
    },
  ),
  fact(
    "imperial-b64",
    "yeasts",
    ["Napoleon"],
    "https://www.imperialyeast.com/yeast-strains/napoleon",
    {
      manufacturer: "Imperial Yeast",
      codes: ["B64"],
      descriptors: ["citrus", "pepper"],
      souring: false,
    },
  ),
  fact("hop-citra-brand", "hops", ["Citra"], "https://www.yakimachief.com/variety/citra-brand", {
    descriptors: ["citrus", "stone fruit", "tropical fruit"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-mosaic-brand", "hops", ["Mosaic"], "https://www.yakimachief.com/variety/mosaic-brand", {
    descriptors: ["berry", "citrus", "tropical fruit", "stone fruit"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-cascade", "hops", ["Cascade"], "https://www.yakimachief.com/variety/cascade", {
    descriptors: ["grapefruit", "floral", "pine", "herbal", "grassy"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-liberty", "hops", ["Liberty"], "https://www.yakimachief.com/variety/liberty", {
    descriptors: ["spicy", "floral", "tea", "woody"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-willamette", "hops", ["Willamette"], "https://www.yakimachief.com/variety/willamette", {
    descriptors: ["citrus", "hay", "tea", "woody"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-magnum", "hops", ["Magnum"], "https://www.yakimachief.com/variety/magnum", {
    descriptors: ["citrus", "herbal", "pineapple", "grassy"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-saaz-saz01", "hops", ["Saaz"], "https://www.yakimachief.com/variety/saaz-saz01", {
    descriptors: ["spicy", "earthy", "floral", "grassy", "woody"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-simcoe-brand", "hops", ["Simcoe"], "https://www.yakimachief.com/variety/simcoe-brand", {
    descriptors: ["citrus", "grapefruit", "stone fruit", "tropical fruit", "woody"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact(
    "hop-amarillo-brand",
    "hops",
    ["Amarillo"],
    "https://www.yakimachief.com/variety/amarillo-brand",
    {
      descriptors: ["citrus", "herbal", "spicy", "woody", "stone fruit"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
  fact(
    "hop-hallertauer-mittelfruher",
    "hops",
    ["Hallertauer Mittelfrüher", "Hallertauer Mittelfrueh", "Hallertauer Mittelfrüh"],
    "https://www.yakimachief.com/variety/hallertauer-mittelfruher",
    {
      descriptors: ["herbal", "citrus", "spicy", "woody"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
  fact(
    "hop-northern-brewer",
    "hops",
    ["Northern Brewer"],
    "https://www.yakimachief.com/variety/northern-brewer",
    {
      descriptors: ["herbal", "citrus", "resinous", "spicy"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
  fact(
    "hop-warrior-brand",
    "hops",
    ["Warrior"],
    "https://www.yakimachief.com/variety/warrior-brand",
    {
      descriptors: ["citrus", "herbal", "stone fruit", "grassy", "woody"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
  fact("hop-azacca-brand", "hops", ["Azacca"], "https://www.yakimachief.com/variety/azacca-brand", {
    descriptors: ["citrus", "pine", "tropical fruit", "berry", "stone fruit"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-talus-brand", "hops", ["Talus"], "https://www.yakimachief.com/variety/talus-brand", {
    descriptors: ["grapefruit", "herbal", "pine", "rose", "tropical fruit"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact("hop-sabro-brand", "hops", ["Sabro"], "https://www.yakimachief.com/variety/sabro-brand", {
    descriptors: ["citrus", "stone fruit", "coconut", "tropical fruit"],
    limitations: [
      "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
    ],
  }),
  fact(
    "hop-idaho-7-brand",
    "hops",
    ["Idaho 7", "Idaho #7"],
    "https://www.yakimachief.com/variety/idaho-7-brand",
    {
      descriptors: ["berry", "bubblegum", "citrus", "stone fruit", "tropical fruit"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
  fact(
    "hop-east-kent-golding",
    "hops",
    ["East Kent Golding", "East Kent Goldings", "East Kent Goldings (EKG)", "EKG"],
    "https://www.yakimachief.com/variety/east-kent-golding",
    {
      descriptors: ["spicy", "herbal", "earthy", "woody"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
  fact("hop-vic-secret", "hops", ["Vic Secret"], "https://hops.com.au/vic-secret/", {
    descriptors: ["pineapple", "pine"],
  }),
  fact("hop-strata", "hops", ["Strata"], "https://indiehops.com/hops/strata", {
    descriptors: ["passion fruit", "melon", "strawberry", "grapefruit"],
    limitations: ["Variety character only; concentrated forms do not inherit mass equivalence."],
  }),
  fact(
    "hop-riwaka",
    "hops",
    ["Riwaka"],
    "https://www.claytonhops.co.nz/blogs/news/riwaka-from-unicorn-to-staple",
    { descriptors: ["passion fruit", "grapefruit", "citrus"] },
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
      descriptors: ["toasty", "malty"],
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
      descriptors: ["toasty", "biscuity"],
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
    { manufacturer: "Briess", family: "aromatic", descriptors: ["honey", "bread", "biscuit"] },
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
      descriptors: ["brown sugar", "vanilla", "stone fruit"],
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
      descriptors: ["bread crust", "honey", "toast", "toffee"],
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
  fact("botanical-cloves", "miscs", ["Cloves", "Clove"], "https://docs.brewfather.app/api/types", {
    descriptors: ["clove"],
    limitations: [
      "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
    ],
    functions: ["botanical"],
  }),
  fact(
    "botanical-coriander",
    "miscs",
    ["Coriander Seed", "Coriander Seed (crushed)"],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["coriander"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
    },
  ),
  fact(
    "botanical-orange-peel",
    "miscs",
    [
      "Orange Peel, Bitter",
      "Orange Peel, Sweet",
      "Orange Peel, Sweet (FRESH ONLY)",
      "Orange Zest",
      "Orange Extract",
    ],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["orange"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
    },
  ),
  fact(
    "botanical-ginger",
    "miscs",
    ["Ginger Root", "Ginger"],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["ginger"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
    },
  ),
  fact(
    "botanical-cinnamon",
    "miscs",
    ["Cinnamon Stick", "Cinnamon Powder"],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["cinnamon"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
    },
  ),
  fact(
    "botanical-paradise",
    "miscs",
    ["Paradise Seed (Ground)", "Grains of paradise"],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["spicy"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
    },
  ),
  fact(
    "botanical-allspice",
    "miscs",
    ["All Spice", "Allspice"],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["spicy"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
    },
  ),
  fact(
    "botanical-chamomile",
    "miscs",
    ["Dried Chamomile Flowers"],
    "https://docs.brewfather.app/api/types",
    {
      descriptors: ["floral"],
      limitations: [
        "Explicit named botanical identity only; provider type/amount/unit retained separately, intensity not established.",
      ],
      functions: ["botanical"],
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
    "fruit-frozen-blueberry",
    "miscs",
    ["frozen blueberry"],
    "https://docs.brewfather.app/api/types",
    {
      limitations: [
        "Explicit material identity; prevents unsupported nonsour absence conclusion. No acid/sugar equivalence.",
      ],
      functions: ["fruit"],
    },
  ),
  fact(
    "fruit-frozen-raspberry",
    "miscs",
    ["frozen raspberry"],
    "https://docs.brewfather.app/api/types",
    {
      limitations: [
        "Explicit material identity; prevents unsupported nonsour absence conclusion. No acid/sugar equivalence.",
      ],
      functions: ["fruit"],
    },
  ),
  fact("fruit-Hibiscus", "miscs", ["Hibiscus"], "https://docs.brewfather.app/api/types", {
    limitations: [
      "Explicit material identity; prevents unsupported nonsour absence conclusion. No acid/sugar equivalence.",
    ],
    functions: ["fruit"],
  }),
  fact(
    "weyermann-carafoam",
    "fermentables",
    ["Carafoam", "Carapils/Carafoam", "Carapils"],
    "https://www.weyermann.de/en-us/product/weyermann-carafoam/",
    {
      manufacturer: "Weyermann",
      family: "crystal_light",
      descriptors: ["malty", "light caramel"],
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
      descriptors: ["coffee", "cocoa"],
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
      descriptors: ["coffee", "cocoa"],
    },
  ),
  fact(
    "briess-caramel-10",
    "fermentables",
    ["Caramel Malt 10L"],
    "https://brewingwithbriess.com/products/roasted-caramel-malts/",
    { manufacturer: "Briess", family: "crystal_light", descriptors: ["caramel"] },
  ),
  fact(
    "briess-caramel-40",
    "fermentables",
    ["Caramel Malt 40L"],
    "https://brewingwithbriess.com/products/roasted-caramel-malts/",
    { manufacturer: "Briess", family: "crystal_light", descriptors: ["caramel", "toffee"] },
  ),
  fact(
    "briess-caramel-120",
    "fermentables",
    ["Caramel Malt 120L"],
    "https://brewingwithbriess.com/products/roasted-caramel-malts/",
    { manufacturer: "Briess", family: "crystal_dark", descriptors: ["caramel", "dried fruit"] },
  ),
  fact(
    "briess-golden-light-extract",
    "fermentables",
    ["CBW Golden Light DME", "Golden Light DME"],
    "https://www.brewingwithbriess.com/wp-content/uploads/2020/11/Briess_PISB_CBWGoldenLightDME.pdf",
    {
      manufacturer: "Briess",
      family: "extract_pale",
      descriptors: ["malty"],
      limitations: [
        "Reviewed pale barley extract only; generic dark/wheat extracts require their own composition rule.",
      ],
    },
  ),
]);
