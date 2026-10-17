import type { FermentableFamily, IngredientClass, IngredientFact } from "./catalog-types.ts";
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
    noticeableGPerL: null,
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
      descriptors: ["fruity", "phenolic"],
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
  fact(
    "hop-magnum",
    "hops",
    ["Magnum", "Hallertau Magnum", "Hallertauer Magnum"],
    "https://www.yakimachief.com/variety/magnum",
    {
      descriptors: ["citrus", "herbal", "pineapple", "grassy"],
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
      ],
    },
  ),
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
    [
      "Hallertauer Mittelfrüher",
      "Hallertauer Mittelfrueh",
      "Hallertauer Mittelfrüh",
      "Hallertau Mittelfrüh",
      "Hallertau Mittelfrueh",
    ],
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
  ...hopVarieties(),
  fact(
    "family-hop-hallertau",
    "hops",
    ["Hallertau", "Hallertauer"],
    "https://www.yakimachief.com/variety/hallertauer-mittelfruher",
    {
      descriptors: ["herbal", "spicy", "woody", "citrus"],
      sourceUrls: [
        "https://www.yakimachief.com/variety/hallertauer-mittelfruher",
        "https://www.barthhaas.com/hops-and-products/hops/hallertau-tradition",
        "https://www.yakimachief.com/variety/hersbrucker-spat",
      ],
      limitations: [
        "Regional class only: character named by at least two of the reviewed Hallertau aroma varieties (Mittelfrüh, Tradition, Hersbrucker); the variety is unknown.",
      ],
    },
  ),
  fact(
    "white-labs-wlp013",
    "yeasts",
    ["London Ale", "London Ale Yeast"],
    "https://www.whitelabs.com/yeast-bank/wlp013-london-ale-yeast",
    {
      manufacturer: "White Labs",
      manufacturerAliases: ["WhiteLabs"],
      codes: ["WLP013"],
      descriptors: ["fruity"],
      souring: false,
    },
  ),
  fact(
    "wyeast-1028",
    "yeasts",
    ["London Ale", "London Ale Yeast"],
    "https://wyeastlab.com/product/london-ale",
    {
      manufacturer: "Wyeast",
      manufacturerAliases: ["Wyeast Labs"],
      codes: ["1028"],
      descriptors: ["fruity"],
      souring: false,
    },
  ),
  fact(
    "omega-voss",
    "yeasts",
    ["Voss Kveik"],
    "https://omegayeast.com/yeast/norwegian-ales/voss-kveik",
    {
      manufacturer: "Omega",
      manufacturerAliases: ["Omega Yeast", "Omega Yeast Labs"],
      codes: ["OYL-061"],
      descriptors: ["orange", "citrus"],
      souring: false,
    },
  ),
  fact(
    "lallemand-new-england",
    "yeasts",
    ["New England", "LalBrew New England", "New England American East Coast Ale"],
    "https://files.scottlab.com/uploads/NEW%20ENGLAND%20TDS.pdf",
    {
      manufacturer: "Lallemand",
      manufacturerAliases: ["Lallemand (LalBrew)", "LalBrew"],
      descriptors: ["stone fruit", "peach", "tropical fruit"],
      souring: false,
    },
  ),
  fact(
    "mangrove-jacks-m21",
    "yeasts",
    ["Belgian Wit", "M21 Belgian Wit"],
    "https://brouwland.com/en/yeast-and-bacteria/1942-dried-brewing-yeast-belgian-wit-m21-mangrove-jack-s-craft-series-10-g.html",
    {
      manufacturer: "Mangrove Jack's",
      manufacturerAliases: ["Mangrove Jacks"],
      codes: ["M21"],
      descriptors: ["fruity", "spicy", "phenolic"],
      souring: false,
      limitations: [
        "Manufacturer description as reproduced by a retailer; the official product page was not reviewed.",
        "Descriptors are expectations, not guaranteed batch flavor.",
      ],
    },
  ),
]);

/** Variety pages reviewed 2026-10-17 through search summaries of the cited producer pages. */
function hopVarieties(): IngredientFact[] {
  const variety = (
    id: string,
    aliases: readonly string[],
    source: string,
    descriptors: readonly string[],
    note?: string,
  ) =>
    fact(id, "hops", aliases, source, {
      descriptors,
      limitations: [
        "Variety character only; supplier, origin and concentrated form equivalence are not established. Woody aroma does not establish wood contact.",
        ...(note ? [note] : []),
      ],
    });
  return [
    variety(
      "hop-tettnanger",
      ["Tettnanger", "Tettnang", "Tettnang Tettnanger"],
      "https://www.yakimachief.com/variety/tettnanger",
      ["spicy", "floral", "tea", "woody"],
    ),
    variety(
      "hop-hersbrucker-spat",
      ["Hersbrucker", "Hersbrucker Spät", "Hersbrucker Spat", "Hersbrucker Spaet"],
      "https://www.yakimachief.com/variety/hersbrucker-spat",
      ["hay", "orange", "spicy", "woody"],
    ),
    variety("hop-perle", ["Perle"], "https://hopsteiner.com/variety-data-sheets/Perle", [
      "tea",
      "spicy",
      "pepper",
      "green fruit",
    ]),
    variety("hop-nugget", ["Nugget"], "https://www.yakimachief.com/variety/nugget", [
      "citrus",
      "stone fruit",
      "tropical fruit",
      "woody",
    ]),
    variety(
      "hop-crystal",
      ["Crystal"],
      "https://www.johnihaas.com/wp-content/uploads/2015/01/Crystal.pdf",
      ["spicy", "floral"],
      "Published Crystal descriptors conflict between suppliers; only the mild spicy/floral character is used.",
    ),
    variety(
      "hop-mt-hood",
      ["Mt. Hood", "Mt Hood", "Mount Hood"],
      "https://www.yakimachief.com/variety/mt-hood",
      ["hay", "herbal", "spicy", "woody"],
    ),
    variety(
      "hop-fuggle",
      ["Fuggle", "Fuggles", "UK Fuggle"],
      "https://www.yakimachief.com/variety/fuggle",
      ["herbal", "grassy", "earthy", "woody"],
    ),
    variety("hop-centennial", ["Centennial"], "https://www.yakimachief.com/variety/centennial", [
      "lemon",
      "floral",
      "orange",
      "tropical fruit",
      "woody",
    ]),
    variety(
      "hop-el-dorado",
      ["El Dorado"],
      "https://www.johnihaas.com/wp-content/uploads/2017/09/El-Dorado-1.pdf",
      ["tropical fruit", "pear", "watermelon", "stone fruit"],
    ),
    variety("hop-bravo", ["Bravo"], "https://hopsteiner.com/variety-data-sheets/bravo", [
      "orange",
      "lime",
      "fruity",
      "floral",
    ]),
    variety(
      "hop-mandarina-bavaria",
      ["Mandarina Bavaria"],
      "https://www.barthhaas.com/hops-and-products/hops/mandarina-bavaria",
      ["tangerine", "orange", "currant"],
    ),
    variety(
      "hop-hallertauer-tradition",
      ["Hallertauer Tradition", "Hallertau Tradition", "Tradition", "German Tradition"],
      "https://www.barthhaas.com/hops-and-products/hops/hallertau-tradition",
      ["citrus", "lime", "woody", "herbal", "grassy"],
    ),
    variety(
      "hop-ctz",
      ["Columbus/Tomahawk/Zeus (CTZ)", "CTZ", "Columbus", "Columbus (Tomahawk)", "Tomahawk"],
      "https://www.yakimachief.com/variety/ctz",
      ["citrus", "dank", "earthy", "woody"],
      "Sold as the CTZ designation; Columbus and Tomahawk names share one aroma class. Bare Zeus is not aliased.",
    ),
  ];
}

/** Typical malt-class character, used only when a product has no producer descriptors.
 * Textbook class words, not producer claims; crystal malts use the colour bands below. */
export const FAMILY_CHARACTER: Readonly<Partial<Record<FermentableFamily, readonly string[]>>> =
  Object.freeze({
    pilsner: ["grainy", "cracker"],
    pale: ["bready"],
    wheat: ["bready", "doughy"],
    vienna: ["toasty", "bready"],
    munich: ["toasty", "bread crust"],
    biscuit: ["biscuit", "toasty"],
    aromatic: ["malty", "bread crust"],
    rye: ["spicy rye"],
    chocolate: ["chocolate", "coffee"],
    roasted: ["roast", "coffee"],
    dehusked_roast: ["smooth roast", "cocoa"],
    smoked: ["smoky"],
    peated: ["peaty", "smoky"],
  });
export const HONEY_MALT_CHARACTER: readonly string[] = Object.freeze(["honey", "bread crust"]);
/** Crystal/caramel character by colour band; `below` is an exclusive upper bound in °L. */
export const CRYSTAL_CHARACTER: readonly {
  readonly below: number;
  readonly words: readonly string[];
}[] = Object.freeze([
  { below: 25, words: ["light caramel", "honey"] },
  { below: 75, words: ["caramel", "toffee"] },
  { below: Infinity, words: ["dark caramel", "raisin"] },
]);
/** Flavoured sugars by name and colour (SRM). Units are `potency × grist fraction` from
 * `minFraction` up; plain sugars carry no words. Heuristic class character, not producer claims. */
export const SUGAR_CHARACTER: readonly {
  readonly pattern: RegExp;
  readonly minSrm: number;
  readonly words: readonly string[];
  readonly potency: number;
  readonly minFraction: number;
}[] = Object.freeze([
  { pattern: /honey/, minSrm: 0, words: ["honey"], potency: 25, minFraction: 0.04 },
  { pattern: /maple/, minSrm: 0, words: ["maple"], potency: 25, minFraction: 0.04 },
  { pattern: /molasses|treacle/, minSrm: 0, words: ["molasses"], potency: 60, minFraction: 0.01 },
  {
    pattern: /candi/,
    minSrm: 150,
    words: ["dark fruit", "toffee"],
    potency: 20,
    minFraction: 0.02,
  },
  { pattern: /candi/, minSrm: 30, words: ["caramel", "toffee"], potency: 12, minFraction: 0.02 },
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
    souring: null,
    noticeableGPerL: null,
    ...details,
  });
}
// Untyped yeasts stay unresolved so tartness keeps requiring a Brewfather Ale or Wheat type.
const ALE_YEAST = ["ale", "wheat"];
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
 * accent-folded lowercase name (yeasts: name and product code). A yeast class names typical
 * style-family character; adjunct classes name the ingredient itself. `noticeableGPerL` is a
 * Tapboard heuristic near the low end of common homebrew doses, not a sensory threshold. */
export const INGREDIENT_CLASSES: readonly IngredientClass[] = Object.freeze([
  // Yeast families whose strains share a defining character. Kveik, English, American, Kölsch and
  // lager strains differ too much by strain to name.
  ingredientClass(
    "class-hefeweizen",
    "hefeweizen",
    ["yeasts"],
    /hefe|weizen|weiss|weihenstephan|bavarian wheat/,
    {
      exclude: /american/,
      types: ALE_YEAST,
      descriptors: ["banana", "clove"],
      souring: false,
    },
  ),
  ingredientClass("class-wit", "witbier", ["yeasts"], /\bwit\b|witbier|blanche/, {
    types: ALE_YEAST,
    descriptors: ["spicy", "fruity"],
    souring: false,
  }),
  ingredientClass("class-saison", "saison", ["yeasts"], /saison/, {
    types: ALE_YEAST,
    descriptors: ["pepper", "spicy", "fruity"],
    souring: false,
  }),
  ingredientClass(
    "class-belgian",
    "Belgian ale",
    ["yeasts"],
    /abbey|abbaye|trappist|monastery|dubbel|tripel|belgian|ardennes/,
    {
      types: ALE_YEAST,
      descriptors: ["fruity", "spicy"],
      souring: false,
    },
  ),
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
