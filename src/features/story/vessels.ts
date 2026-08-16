import {
  VESSEL_IDS,
  type VesselGeometryDescriptor,
  type VesselId,
  type VesselResolution,
} from "./types.ts";

type AnyRecord = Record<string, unknown>;

const DETAIL_STROKE = "#CBD5E0";
const DETAIL_FILL = "#1A202C";
const DETAIL_GLASS = "#E2E8F0";

function detail(
  d: string,
  className: VesselGeometryDescriptor["detailPaths"][number]["className"] = "glass-detail",
  fill = "none",
  stroke = DETAIL_STROKE,
  strokeWidth = 2,
  opacity = 0.6,
) {
  return Object.freeze({ d, className, fill, stroke, strokeWidth, opacity });
}

/**
 * Static v1 Fill Glass contours, ported as data rather than executable SVG
 * renderers.  Every path below is a source-controlled constant selected only
 * through the finite VesselId catalog; no integration or user value reaches
 * this table.
 */
const GEOMETRY: Record<VesselId, VesselGeometryDescriptor> = {
  corny_keg: {
    id: "corny_keg",
    token: "vessel/corny-keg",
    bodyPath:
      "M 46 52 H 114 A 14 14 0 0 1 128 66 V 213 A 14 14 0 0 1 114 227 H 46 A 14 14 0 0 1 32 213 V 66 A 14 14 0 0 1 46 52 Z",
    clipPath: "M 35 65 H 125 V 220 H 35 Z",
    rimPath: "M 38 20 C 38 12 122 12 122 20 L 125 50 H 35 Z",
    viewBox: "0 0 160 250",
    topY: 65,
    bottomY: 220,
    fillX: 30,
    fillWidth: 100,
    detailPaths: [
      detail(
        "M 38 20 C 38 12 122 12 122 20 L 125 50 C 125 55 35 55 35 50 Z",
        "glass-detail",
        DETAIL_FILL,
        DETAIL_FILL,
        2,
        1,
      ),
      detail("M 52 24 H 74 V 38 H 52 Z", "glass-detail", "#000000", "none", 0, 0.65),
      detail("M 86 24 H 108 V 38 H 86 Z", "glass-detail", "#000000", "none", 0, 0.65),
      detail(
        "M 76 34 A 4 4 0 1 0 84 34 A 4 4 0 1 0 76 34",
        "glass-detail",
        "#A0AEC0",
        "none",
        0,
        1,
      ),
      detail("M 35 65 H 125 V 220 H 35 Z", "glass-detail", DETAIL_FILL, DETAIL_STROKE, 2, 0.75),
      detail("M 40 68 H 46 V 215 H 40 Z", "glass-highlight", "#FFFFFF", "none", 0, 0.15),
      detail(
        "M 32 220 H 128 L 125 245 C 125 250 35 250 35 245 Z",
        "glass-base",
        DETAIL_FILL,
        "none",
        0,
        1,
      ),
      detail(
        "M 40 242 V 250 H 56 V 242 Z M 104 242 V 250 H 120 V 242 Z",
        "glass-base",
        DETAIL_FILL,
        "none",
        0,
        1,
      ),
    ],
  },
  pint_glass: {
    id: "pint_glass",
    token: "vessel/pint-glass",
    bodyPath: "M 45 40 H 115 L 105 225 H 55 Z",
    clipPath: "M 30 0 H 130 L 114 45 L 104 225 H 56 L 46 45 Z",
    rimPath: "M 45 40 H 115",
    viewBox: "0 40 160 190",
    topY: 45,
    bottomY: 225,
    fillX: 30,
    fillWidth: 100,
    detailPaths: [
      detail("M 45 40 H 115 L 105 225 H 55 Z", "glass-detail", DETAIL_FILL, DETAIL_STROKE, 2, 0.6),
      detail("M 48 45 H 54 L 59 220 H 54 Z", "glass-highlight", "#FFFFFF", "none", 0, 0.25),
    ],
  },
  tulip_glass: {
    id: "tulip_glass",
    token: "vessel/tulip-glass",
    bodyPath: "M 52 40 C 40 90 30 150 80 170 C 130 150 120 90 108 40 Z",
    clipPath: "M 30 0 H 130 L 108 40 C 120 90 130 150 80 170 C 30 150 40 90 52 40 Z",
    rimPath: "M 52 40 H 108",
    viewBox: "0 35 160 195",
    topY: 40,
    bottomY: 170,
    fillX: 25,
    fillWidth: 110,
    detailPaths: [
      detail("M 76 170 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 46 232 A 34 7 0 1 0 114 232 A 34 7 0 1 0 46 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
      detail("M 56 45 C 46 90 42 135 75 162", "glass-highlight", "none", "#FFFFFF", 2.5, 0.4),
    ],
  },
  wheat_glass: {
    id: "wheat_glass",
    token: "vessel/wheat-glass",
    bodyPath: "M 50 30 Q 30 110 62 170 L 60 220 Q 80 225 100 220 L 98 170 Q 130 110 110 30 Z",
    clipPath:
      "M 30 0 H 130 L 110 30 Q 130 110 98 170 L 100 220 Q 80 225 60 220 L 62 170 Q 30 110 50 30 Z",
    rimPath: "M 50 30 H 110",
    viewBox: "0 25 160 200",
    topY: 30,
    bottomY: 220,
    fillX: 25,
    fillWidth: 110,
    detailPaths: [
      detail("M 55 35 Q 40 100 64 165", "glass-highlight", "none", "#FFFFFF", 2.5, 0.4),
    ],
  },
  mug: {
    id: "mug",
    token: "vessel/mug",
    bodyPath:
      "M 48 50 H 112 A 8 8 0 0 1 120 58 V 212 A 8 8 0 0 1 112 220 H 48 A 8 8 0 0 1 40 212 V 58 A 8 8 0 0 1 48 50 Z",
    clipPath: "M 30 0 H 130 L 118 55 V 215 C 118 220 42 220 42 215 V 55 Z",
    rimPath: "M 40 50 H 120",
    viewBox: "0 45 160 180",
    topY: 55,
    bottomY: 215,
    fillX: 35,
    fillWidth: 90,
    detailPaths: [
      detail(
        "M 118 75 C 150 75 150 185 118 185 L 118 165 C 135 165 135 95 118 95 Z",
        "glass-detail",
        DETAIL_GLASS,
        "#A0AEC0",
        1.5,
        0.4,
      ),
      detail(
        "M 60 50 V 220 M 80 50 V 220 M 100 50 V 220",
        "glass-detail",
        "none",
        "#718096",
        1.5,
        0.4,
      ),
      detail("M 44 55 H 50 V 215 H 44 Z", "glass-highlight", "#FFFFFF", "none", 0, 0.2),
    ],
  },
  stout_glass: {
    id: "stout_glass",
    token: "vessel/stout-glass",
    bodyPath:
      "M 52 45 C 44 80 40 120 58 175 L 56 220 Q 80 225 104 220 L 102 175 C 120 120 116 80 108 45 Z",
    clipPath:
      "M 30 0 H 130 L 108 45 C 116 80 120 120 102 175 L 104 220 Q 80 225 56 220 L 58 175 C 40 120 44 80 52 45 Z",
    rimPath: "M 52 45 H 108",
    viewBox: "0 40 160 185",
    topY: 45,
    bottomY: 220,
    fillX: 25,
    fillWidth: 110,
    detailPaths: [
      detail("M 55 50 C 48 85 46 120 60 170", "glass-highlight", "none", "#FFFFFF", 2.5, 0.35),
    ],
  },
  snifter: {
    id: "snifter",
    token: "vessel/snifter",
    bodyPath: "M 58 55 C 32 105 32 155 80 175 C 128 155 128 105 102 55 Z",
    clipPath: "M 30 0 H 130 L 102 55 C 128 105 128 155 80 175 C 32 155 32 105 58 55 Z",
    rimPath: "M 58 55 H 102",
    viewBox: "0 45 160 180",
    topY: 55,
    bottomY: 175,
    fillX: 20,
    fillWidth: 120,
    detailPaths: [
      detail("M 76 175 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 45 232 A 35 7 0 1 0 115 232 A 35 7 0 1 0 45 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
      detail("M 60 60 C 40 105 42 150 72 168", "glass-highlight", "none", "#FFFFFF", 2.5, 0.4),
    ],
  },
  nonic_pint: {
    id: "nonic_pint",
    token: "vessel/nonic-pint",
    bodyPath: "M 48 45 H 112 L 116 90 L 108 225 H 52 L 44 90 Z",
    clipPath: "M 48 45 H 112 L 116 90 L 108 225 H 52 L 44 90 Z",
    rimPath: "M 48 45 H 112",
    viewBox: "0 40 160 190",
    topY: 45,
    bottomY: 225,
    fillX: 38,
    fillWidth: 84,
    detailPaths: [
      detail(
        "M 48 45 H 112 L 116 90 L 108 225 H 52 L 44 90 Z",
        "glass-detail",
        DETAIL_FILL,
        DETAIL_STROKE,
        2,
        0.6,
      ),
    ],
  },
  shaker_pint: {
    id: "shaker_pint",
    token: "vessel/shaker-pint",
    bodyPath: "M 44 45 H 116 L 108 225 H 52 Z",
    clipPath: "M 44 45 H 116 L 108 225 H 52 Z",
    rimPath: "M 44 45 H 116",
    viewBox: "0 40 160 190",
    topY: 45,
    bottomY: 225,
    fillX: 36,
    fillWidth: 88,
    detailPaths: [
      detail("M 44 45 H 116 L 108 225 H 52 Z", "glass-detail", DETAIL_FILL, DETAIL_STROKE, 2, 0.6),
    ],
  },
  pilsner_flute: {
    id: "pilsner_flute",
    token: "vessel/pilsner-flute",
    bodyPath: "M 58 30 H 102 L 112 220 H 48 Z",
    clipPath: "M 58 30 H 102 L 112 220 H 48 Z",
    rimPath: "M 58 30 H 102",
    viewBox: "0 25 160 205",
    topY: 30,
    bottomY: 220,
    fillX: 46,
    fillWidth: 68,
    detailPaths: [
      detail("M 58 30 H 102 L 112 220 H 48 Z", "glass-detail", DETAIL_FILL, DETAIL_STROKE, 2, 0.6),
    ],
  },
  stange: {
    id: "stange",
    token: "vessel/stange",
    bodyPath: "M 55 40 H 105 V 220 H 55 Z",
    clipPath: "M 55 40 H 105 V 220 H 55 Z",
    rimPath: "M 55 40 H 105",
    viewBox: "0 35 160 200",
    topY: 40,
    bottomY: 220,
    fillX: 53,
    fillWidth: 54,
    detailPaths: [
      detail("M 55 40 H 105 V 220 H 55 Z", "glass-detail", DETAIL_FILL, DETAIL_STROKE, 2, 0.6),
    ],
  },
  goblet: {
    id: "goblet",
    token: "vessel/goblet",
    bodyPath: "M 48 45 C 42 95 48 145 80 170 C 112 145 118 95 112 45 Z",
    clipPath: "M 48 45 C 42 95 48 145 80 170 C 112 145 118 95 112 45 Z",
    rimPath: "M 48 45 H 112",
    viewBox: "0 40 160 200",
    topY: 45,
    bottomY: 170,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [
      detail("M 76 170 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 46 232 A 34 7 0 1 0 114 232 A 34 7 0 1 0 46 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
    ],
  },
  teku: {
    id: "teku",
    token: "vessel/teku",
    bodyPath: "M 55 45 H 105 L 115 120 L 80 170 L 45 120 Z",
    clipPath: "M 55 45 H 105 L 115 120 L 80 170 L 45 120 Z",
    rimPath: "M 55 45 H 105",
    viewBox: "0 40 160 200",
    topY: 45,
    bottomY: 170,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [
      detail("M 76 170 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 46 232 A 34 7 0 1 0 114 232 A 34 7 0 1 0 46 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
    ],
  },
  thistle: {
    id: "thistle",
    token: "vessel/thistle",
    bodyPath: "M 58 45 C 45 95 48 145 80 170 C 112 145 115 95 102 45 Z",
    clipPath: "M 58 45 C 45 95 48 145 80 170 C 112 145 115 95 102 45 Z",
    rimPath: "M 58 45 H 102",
    viewBox: "0 40 160 200",
    topY: 45,
    bottomY: 170,
    fillX: 42,
    fillWidth: 76,
    detailPaths: [
      detail("M 76 170 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 46 232 A 34 7 0 1 0 114 232 A 34 7 0 1 0 46 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
    ],
  },
  ipa_glass: {
    id: "ipa_glass",
    token: "vessel/ipa-glass",
    bodyPath: "M 50 35 H 110 L 105 105 L 115 220 H 45 L 55 105 Z",
    clipPath: "M 50 35 H 110 L 105 105 L 115 220 H 45 L 55 105 Z",
    rimPath: "M 50 35 H 110",
    viewBox: "0 30 160 205",
    topY: 35,
    bottomY: 220,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [
      detail(
        "M 50 35 H 110 L 105 105 L 115 220 H 45 L 55 105 Z",
        "glass-detail",
        DETAIL_FILL,
        DETAIL_STROKE,
        2,
        0.6,
      ),
    ],
  },
  tasting_glass: {
    id: "tasting_glass",
    token: "vessel/tasting-glass",
    bodyPath: "M 58 55 L 102 55 C 118 110 110 150 80 165 C 50 150 42 110 58 55 Z",
    clipPath: "M 58 55 L 102 55 C 118 110 110 150 80 165 C 50 150 42 110 58 55 Z",
    rimPath: "M 58 55 H 102",
    viewBox: "0 45 160 195",
    topY: 55,
    bottomY: 165,
    fillX: 40,
    fillWidth: 80,
    detailPaths: [
      detail("M 76 165 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 46 232 A 34 7 0 1 0 114 232 A 34 7 0 1 0 46 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
    ],
  },
  stemmed_lager: {
    id: "stemmed_lager",
    token: "vessel/stemmed-lager",
    bodyPath: "M 52 40 H 108 L 105 125 C 102 155 92 170 80 175 C 68 170 58 155 55 125 Z",
    clipPath: "M 52 40 H 108 L 105 125 C 102 155 92 170 80 175 C 68 170 58 155 55 125 Z",
    rimPath: "M 52 40 H 108",
    viewBox: "0 35 160 205",
    topY: 40,
    bottomY: 175,
    fillX: 42,
    fillWidth: 76,
    detailPaths: [
      detail("M 76 175 H 84 V 235 H 76 Z", "glass-stem", DETAIL_GLASS, DETAIL_STROKE, 1.5, 0.4),
      detail(
        "M 46 232 A 34 7 0 1 0 114 232 A 34 7 0 1 0 46 232",
        "glass-base",
        DETAIL_GLASS,
        DETAIL_STROKE,
        1.5,
        0.4,
      ),
    ],
  },
};

for (const id of VESSEL_IDS) Object.freeze(GEOMETRY[id]);
Object.freeze(GEOMETRY);

export const DEFAULT_VESSEL_ID: VesselId = "pint_glass";

function record(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function normalized(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return result === "" ? null : result;
}

const VESSEL_ALIASES: Readonly<Record<string, VesselId>> = {
  pint: "pint_glass",
  glass: "pint_glass",
  tulip: "tulip_glass",
  wheat: "wheat_glass",
  stout: "stout_glass",
  lager: "stemmed_lager",
  pilsner: "pilsner_flute",
  pils: "pilsner_flute",
  ipa: "ipa_glass",
  tasting: "tasting_glass",
  goblet_glass: "goblet",
};

export function isVesselId(value: unknown): value is VesselId {
  const candidate = normalized(value);
  return candidate !== null && (VESSEL_IDS as readonly string[]).includes(candidate);
}

function explicitVessel(value: unknown): VesselId | null {
  const candidate = normalized(value);
  if (candidate === null) return null;
  if (isVesselId(candidate)) return candidate;
  return VESSEL_ALIASES[candidate] ?? null;
}

function styleValue(input: unknown): string | null {
  const object = record(input);
  if (object === null) return null;
  for (const key of ["style", "beverageStyle", "styleName", "beerStyle", "type", "beverageType"]) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return null;
}

function styleVessel(style: string | null): VesselId {
  if (style === null) return DEFAULT_VESSEL_ID;
  // Keep the reviewed v1 ordering: specific style families win before the
  // broad ale/lager rules at the end of the list.
  if (/wheat|wit|weiss|weizen/.test(style)) return "wheat_glass";
  if (/pilsner/.test(style)) return "pilsner_flute";
  if (/kolsch|kölsch|altbier/.test(style)) return "stange";
  if (/belgian|abbey|saison|tripel|triple/.test(style)) return "goblet";
  if (/ipa|pale ale/.test(style)) return "ipa_glass";
  if (/sour|lambic|wild/.test(style)) return "teku";
  if (/stout|porter/.test(style)) return "stout_glass";
  if (/wee heavy|scotch/.test(style)) return "thistle";
  if (/barleywine|strong ale/.test(style)) return "snifter";
  if (/english bitter|\bmild\b|brown|esb/.test(style)) return "nonic_pint";
  if (/american amber|\bale\b/.test(style)) return "shaker_pint";
  if (/lager|helles|marzen|märzen|bock/.test(style)) return "stemmed_lager";
  return DEFAULT_VESSEL_ID;
}

function candidateExplicit(input: unknown): VesselId | null {
  const object = record(input);
  if (object === null) return explicitVessel(input);
  for (const key of ["fillGlass", "fill_glass", "fillGlassId", "vessel", "vesselId", "glass"]) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const value = explicitVessel(object[key]);
    if (value !== null) return value;
  }
  return null;
}

export function getVesselDescriptor(value: unknown): VesselGeometryDescriptor {
  const id = explicitVessel(value) ?? DEFAULT_VESSEL_ID;
  return GEOMETRY[id];
}

export const vesselGeometry = getVesselDescriptor;
export const getSafeVesselGeometry = getVesselDescriptor;

/** Resolve explicit fill-glass selection, then style evidence, then pint. */
export function resolveVessel(input: unknown): VesselResolution {
  const explicit = candidateExplicit(input);
  if (explicit !== null) return { id: explicit, geometry: GEOMETRY[explicit], source: "explicit" };
  const style = styleValue(input);
  const id = styleVessel(style);
  return {
    id,
    geometry: GEOMETRY[id],
    source: style === null || id === DEFAULT_VESSEL_ID ? "fallback" : "style",
  };
}

export function resolveVesselId(input: unknown): VesselId {
  return resolveVessel(input).id;
}

export const chooseVessel = resolveVesselId;
export const resolveFillGlass = resolveVesselId;
export const suggestVessel = resolveVesselId;
export const FILL_GLASS_IDS = VESSEL_IDS;

export const SRM_COLOR_PALETTE: readonly { readonly srm: number; readonly color: string }[] = [
  { srm: 0, color: "#EAF6FF" },
  { srm: 1, color: "#F8F753" },
  { srm: 2, color: "#F6F513" },
  { srm: 3, color: "#ECE61A" },
  { srm: 4, color: "#D5BC00" },
  { srm: 5, color: "#BF9200" },
  { srm: 6, color: "#BF8100" },
  { srm: 7, color: "#BC6800" },
  { srm: 8, color: "#B55300" },
  { srm: 9, color: "#B34700" },
  { srm: 10, color: "#A73D00" },
  { srm: 11, color: "#9C3200" },
  { srm: 12, color: "#962D00" },
  { srm: 13, color: "#8C2400" },
  { srm: 14, color: "#801C00" },
  { srm: 15, color: "#781900" },
  { srm: 16, color: "#701600" },
  { srm: 17, color: "#681300" },
  { srm: 18, color: "#601100" },
  { srm: 19, color: "#580E00" },
  { srm: 20, color: "#530C00" },
  { srm: 21, color: "#4E0B00" },
  { srm: 22, color: "#480A00" },
  { srm: 23, color: "#420900" },
  { srm: 24, color: "#3C0800" },
  { srm: 25, color: "#380600" },
  { srm: 26, color: "#340500" },
  { srm: 27, color: "#300400" },
  { srm: 28, color: "#2C0300" },
  { srm: 29, color: "#2A0300" },
  { srm: 30, color: "#280200" },
  { srm: 31, color: "#250200" },
  { srm: 32, color: "#220200" },
  { srm: 33, color: "#200100" },
  { srm: 34, color: "#1E0100" },
  { srm: 35, color: "#1D0100" },
  { srm: 36, color: "#1B0100" },
  { srm: 37, color: "#190100" },
  { srm: 38, color: "#170100" },
  { srm: 39, color: "#150100" },
  { srm: 40, color: "#130100" },
  { srm: 45, color: "#0B0100" },
  { srm: 50, color: "#080100" },
] as const;

export const SAFE_DISPLAY_COLOR = "#D97706";

export function normalizeDisplayColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : null;
}

export function displayColorForSrm(value: unknown): string | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) return null;
  const srm = Math.min(50, Math.max(0, Math.round(parsed)));
  let closest = SRM_COLOR_PALETTE[0];
  if (closest === undefined) return null;
  let distance = Math.abs(srm - closest.srm);
  for (const candidate of SRM_COLOR_PALETTE.slice(1)) {
    const nextDistance = Math.abs(srm - candidate.srm);
    if (nextDistance < distance) {
      closest = candidate;
      distance = nextDistance;
    }
  }
  return closest.color;
}

/** Valid explicit #RRGGBB wins; otherwise use a finite SRM palette/fallback. */
export function resolveDisplayColor(input: unknown, srmValue?: unknown): string {
  const object = record(input);
  const explicit = normalizeDisplayColor(
    object === null
      ? input
      : (object["displayColor"] ?? object["display_color"] ?? object["color"]),
  );
  if (explicit !== null) return explicit;
  const srm = object === null ? srmValue : (object["srm"] ?? object["colorSrm"] ?? srmValue);
  return displayColorForSrm(srm) ?? SAFE_DISPLAY_COLOR;
}

export const safeDisplayColor = resolveDisplayColor;
export const resolveColor = resolveDisplayColor;

export { VESSEL_IDS };
export type { VesselGeometryDescriptor, VesselId, VesselResolution };
