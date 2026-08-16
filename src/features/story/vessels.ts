import {
  VESSEL_IDS,
  type VesselGeometryDescriptor,
  type VesselId,
  type VesselResolution,
} from "./types.ts";

type AnyRecord = Record<string, unknown>;

const GEOMETRY: Record<VesselId, VesselGeometryDescriptor> = {
  corny_keg: {
    id: "corny_keg",
    token: "vessel/corny-keg",
    width: 1,
    height: 1,
    bowlWidth: 1,
    stemHeight: 0,
  },
  pint_glass: {
    id: "pint_glass",
    token: "vessel/pint-glass",
    width: 1,
    height: 1.3,
    bowlWidth: 0.92,
    stemHeight: 0,
  },
  tulip_glass: {
    id: "tulip_glass",
    token: "vessel/tulip-glass",
    width: 1,
    height: 1.35,
    bowlWidth: 1,
    stemHeight: 0.05,
  },
  wheat_glass: {
    id: "wheat_glass",
    token: "vessel/wheat-glass",
    width: 0.92,
    height: 1.6,
    bowlWidth: 0.9,
    stemHeight: 0,
  },
  mug: {
    id: "mug",
    token: "vessel/mug",
    width: 1.15,
    height: 1.05,
    bowlWidth: 1.05,
    stemHeight: 0,
  },
  stout_glass: {
    id: "stout_glass",
    token: "vessel/stout-glass",
    width: 1.08,
    height: 1.08,
    bowlWidth: 1,
    stemHeight: 0,
  },
  snifter: {
    id: "snifter",
    token: "vessel/snifter",
    width: 1.1,
    height: 1.25,
    bowlWidth: 1.05,
    stemHeight: 0.35,
  },
  nonic_pint: {
    id: "nonic_pint",
    token: "vessel/nonic-pint",
    width: 1,
    height: 1.28,
    bowlWidth: 0.96,
    stemHeight: 0,
  },
  shaker_pint: {
    id: "shaker_pint",
    token: "vessel/shaker-pint",
    width: 0.9,
    height: 1.35,
    bowlWidth: 0.86,
    stemHeight: 0,
  },
  pilsner_flute: {
    id: "pilsner_flute",
    token: "vessel/pilsner-flute",
    width: 0.75,
    height: 1.8,
    bowlWidth: 0.72,
    stemHeight: 0.2,
  },
  stange: {
    id: "stange",
    token: "vessel/stange",
    width: 0.58,
    height: 1.75,
    bowlWidth: 0.56,
    stemHeight: 0,
  },
  goblet: {
    id: "goblet",
    token: "vessel/goblet",
    width: 1.05,
    height: 1.35,
    bowlWidth: 1,
    stemHeight: 0.42,
  },
  teku: {
    id: "teku",
    token: "vessel/teku",
    width: 1.02,
    height: 1.4,
    bowlWidth: 0.96,
    stemHeight: 0.38,
  },
  thistle: {
    id: "thistle",
    token: "vessel/thistle",
    width: 0.95,
    height: 1.5,
    bowlWidth: 0.9,
    stemHeight: 0.35,
  },
  ipa_glass: {
    id: "ipa_glass",
    token: "vessel/ipa-glass",
    width: 0.92,
    height: 1.5,
    bowlWidth: 0.86,
    stemHeight: 0.2,
  },
  tasting_glass: {
    id: "tasting_glass",
    token: "vessel/tasting-glass",
    width: 0.62,
    height: 1,
    bowlWidth: 0.58,
    stemHeight: 0.12,
  },
  stemmed_lager: {
    id: "stemmed_lager",
    token: "vessel/stemmed-lager",
    width: 0.8,
    height: 1.55,
    bowlWidth: 0.76,
    stemHeight: 0.34,
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
  if (/wild|lambic|gueuze/.test(style)) return "teku";
  if (/sour|berliner|gose|flanders|kettle/.test(style)) return "tulip_glass";
  if (/hazy|ne\s*ipa|new\s+england|west\s+coast|\bipa\b|india\s+pale/.test(style))
    return "ipa_glass";
  if (/stout|porter/.test(style)) return "stout_glass";
  if (/wheat|weiss|weizen|witbier/.test(style)) return "wheat_glass";
  if (/kolsch|kölsch|stange/.test(style)) return "stange";
  if (/pils|pilsner/.test(style)) return "pilsner_flute";
  if (/lager|helles|kellerbier/.test(style)) return "stemmed_lager";
  if (/strong|barleywine|old\s+ale|quadrupel|quad|snifter/.test(style)) return "snifter";
  if (/tripel|triple|goblet/.test(style)) return "goblet";
  if (/saison|farmhouse|thistle/.test(style)) return "thistle";
  if (/mead|cider|fruit/.test(style)) return "tulip_glass";
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
