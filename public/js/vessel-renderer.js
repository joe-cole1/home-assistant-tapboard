import { cancelVesselAnimation, updateVesselFill } from "./vessel-fill.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ARTWORK_VERSION = "astra-1";
let nextGraphicId = 0;
const graphicNamespace = Math.random().toString(36).slice(2, 10);
const VESSEL_IDS = new Set([
  "corny_keg",
  "pint_glass",
  "tulip_glass",
  "wheat_glass",
  "mug",
  "stout_glass",
  "snifter",
  "nonic_pint",
  "shaker_pint",
  "pilsner_flute",
  "stange",
  "goblet",
  "teku",
  "thistle",
  "ipa_glass",
  "tasting_glass",
  "stemmed_lager",
]);
const DEFAULT_GRAPHIC = Object.freeze({
  id: "pint_glass",
  token: "vessel/pint-glass",
  bodyPath: "M 45 45 H 115 L 105 220 Q 80 228 55 220 Z",
  clipPath: "M 48 48 H 112 L 102 216 Q 80 222 58 216 Z",
  rimPath:
    "M 45 45 A 35 4 0 1 0 115 45 A 35 4 0 1 0 45 45 Z M 48 45 A 32 2 0 1 1 112 45 A 32 2 0 1 1 48 45 Z",
  viewBox: "0 40 160 190",
  topY: 48,
  bottomY: 219,
  fillX: 45,
  fillWidth: 70,
  detailPaths: [],
  frontPaths: [],
});

// Paint names are finite; descriptors cannot supply arbitrary SVG URLs.
const PAINTS = Object.freeze({
  glass: [
    [0, "#F0FCFF", 0.23],
    [0.14, "#BCDCE6", 0.08],
    [0.49, "#DEEEF2", 0.025],
    [0.83, "#D5EAF0", 0.12],
    [1, "#7B9CA8", 0.26],
  ],
  handle: [
    [0, "#577482", 0.6],
    [0.3, "#D0E4EA", 0.3],
    [0.68, "#F2FCFF", 0.62],
    [1, "#879EAD", 0.5],
  ],
  base: [
    [0, "#BCD4DF", 0.07],
    [0.5, "#E7F6FA", 0.42],
    [0.72, "#F1FCFF", 0.59],
    [1, "#7C98A6", 0.32],
  ],
  rim: [
    [0, "#EEF9FC", 0.8],
    [0.36, "#A7C2CD", 0.22],
    [0.72, "#DAEAF0", 0.48],
    [1, "#5D7D8A", 0.32],
  ],
  facet: [
    [0, "#233A42", 0.12],
    [0.25, "#FFFFFF", 0.01],
    [0.76, "#FFFFFF", 0.02],
    [1, "#F1FBFF", 0.27],
  ],
  shine: [
    [0, "#FFFFFF", 0.56],
    [1, "#FFFFFF", 0],
  ],
  metal: [
    [0, "#526775", 1],
    [0.2, "#CFDEE5", 1],
    [0.38, "#8097A5", 1],
    [0.7, "#DFE9ED", 1],
    [1, "#617784", 1],
  ],
  light: [
    [0, "#FFF5BB", 0.29],
    [0.28, "#FFE1A3", 0.17],
    [0.6, "#FFD085", 0.03],
    [1, "#361300", 0.33],
  ],
  depth: [
    [0, "#FFF3D6", 0],
    [0.72, "#552200", 0],
    [1, "#6B2700", 0.2],
  ],
  foam: [
    [0, "#FFFFFF", 1],
    [0.55, "#FFFDF5", 1],
    [1, "#EDE1C7", 1],
  ],
});
const DETAIL_PAINTS = new Set(["glass", "handle", "base", "rim", "facet", "shine", "metal"]);
const BUBBLE_SPECS = [
  [0.18, 5, 2.3],
  [0.4, 10, 1.7],
  [0.62, 7, 2.1],
  [0.82, 15, 1.5],
  [0.3, 22, 1.4],
  [0.7, 27, 1.8],
  [0.1, 34, 1.2],
  [0.52, 39, 1.5],
  [0.9, 44, 1.1],
  [0.25, 50, 1.6],
  [0.68, 57, 1.3],
  [0.45, 64, 1.1],
  [0.08, 14, 1.5],
  [0.56, 18, 2],
  [0.78, 25, 1.2],
  [0.32, 31, 1.8],
  [0.92, 38, 1.3],
  [0.15, 45, 1.1],
  [0.58, 51, 1.4],
  [0.83, 58, 1.7],
  [0.38, 67, 1.2],
  [0.72, 76, 1.4],
  [0.24, 86, 1.1],
  [0.64, 95, 1.3],
];
const FOAM_PATH =
  "M 0 -2 C 1 -6 5 -8 9 -7 C 8 -12 14 -16 20 -12 C 23 -17 30 -17 34 -12 C 38 -15 44 -13 47 -9 C 51 -13 58 -12 60 -7 C 66 -9 71 -6 74 -2 L 74 6 C 65 10 56 6 46 8 C 36 10 26 6 16 7 C 9 8 4 7 0 5 Z";

function safePath(value, fallback) {
  return typeof value === "string" &&
    value.length <= 1200 &&
    /^M[\s\d.,+\-MmLlHhVvCcSsQqTtAaZzEe]+$/u.test(value)
    ? value
    : fallback;
}
function finite(value, fallback, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}
function safePaint(value) {
  return typeof value === "string" &&
    (/^#[0-9A-Fa-f]{6}$/u.test(value) || value === "none" || DETAIL_PAINTS.has(value))
    ? value
    : "none";
}
function safeDetail(value) {
  if (!value || typeof value !== "object") return undefined;
  const d = safePath(value.d, "");
  if (!d) return undefined;
  return {
    d,
    className: ["glass-detail", "glass-stem", "glass-base", "glass-highlight"].includes(
      value.className,
    )
      ? value.className
      : "glass-detail",
    fill: safePaint(value.fill),
    stroke: safePaint(value.stroke),
    strokeWidth: finite(value.strokeWidth, 0, 0, 8),
    opacity: finite(value.opacity, 1, 0, 1),
    contour: value.contour === true,
  };
}
function safeGraphic(tap) {
  const candidate = tap.graphic;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !VESSEL_IDS.has(candidate.id) ||
    candidate.token !== `vessel/${candidate.id.replace(/_/gu, "-")}`
  )
    return DEFAULT_GRAPHIC;
  const box =
    typeof candidate.viewBox === "string" ? candidate.viewBox.trim().split(/\s+/u).map(Number) : [];
  if (
    box.length !== 4 ||
    box.some((value) => !Number.isFinite(value)) ||
    box[0] !== 0 ||
    box[2] !== 160 ||
    box[1] < 0 ||
    box[3] <= 0 ||
    box[1] + box[3] > 260
  )
    return DEFAULT_GRAPHIC;
  const topY = finite(candidate.topY, -1, box[1], box[1] + box[3]);
  const bottomY = finite(candidate.bottomY, -1, topY, box[1] + box[3]);
  const fillX = finite(candidate.fillX, -1, 0, 160);
  const fillWidth = finite(candidate.fillWidth, -1, 1, 160);
  if (topY < 0 || bottomY <= topY || fillX < 0 || fillWidth < 0 || fillX + fillWidth > 160)
    return DEFAULT_GRAPHIC;
  const bodyPath = safePath(candidate.bodyPath, "");
  const clipPath = safePath(candidate.clipPath, "");
  const rimPath = safePath(candidate.rimPath, "");
  if (!bodyPath || !clipPath || !rimPath) return DEFAULT_GRAPHIC;
  return {
    id: candidate.id,
    token: candidate.token,
    bodyPath,
    clipPath,
    rimPath,
    viewBox: box.join(" "),
    topY,
    bottomY,
    fillX,
    fillWidth,
    detailPaths: Array.isArray(candidate.detailPaths)
      ? candidate.detailPaths.slice(0, 24).map(safeDetail).filter(Boolean)
      : [],
    frontPaths: Array.isArray(candidate.frontPaths)
      ? candidate.frontPaths.slice(0, 24).map(safeDetail).filter(Boolean)
      : [],
  };
}
function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}
function paint(value, clipId) {
  return DETAIL_PAINTS.has(value) ? `url(#${clipId}-${value})` : value;
}
function appendDetails(parent, details, clipId) {
  for (const item of details)
    parent.append(
      svgElement("path", {
        class: item.className,
        d: item.d,
        fill: paint(item.fill, clipId),
        stroke: paint(item.stroke, clipId),
        "stroke-width": item.strokeWidth,
        opacity: item.opacity,
        "fill-rule": "evenodd",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        ...(item.contour ? { "data-glass-contour": "true" } : {}),
      }),
    );
}
function renderGraphicStructure(svg, tap, graphic, clipId) {
  svg.replaceChildren();
  const title = svgElement("title");
  title.textContent = `${tap.accessibleLabel || tap.title || tap.beverageName || `Tap ${tap.tapNumber}`} fill level`;
  const defs = svgElement("defs");
  for (const [name, stops] of Object.entries(PAINTS)) {
    const vertical = ["base", "rim", "depth", "foam"].includes(name);
    const gradient = svgElement("linearGradient", {
      id: `${clipId}-${name}`,
      x1: "0%",
      y1: "0%",
      x2: vertical ? "0%" : "100%",
      y2: vertical ? "100%" : "0%",
    });
    for (const [offset, color, opacity] of stops)
      gradient.append(svgElement("stop", { offset, "stop-color": color, "stop-opacity": opacity }));
    defs.append(gradient);
  }
  const clip = svgElement("clipPath", { id: clipId, class: "beer-liquid-clip" });
  clip.append(svgElement("path", { d: graphic.clipPath }));
  const bubbleClip = svgElement("clipPath", { id: `${clipId}-bubbles`, class: "beer-bubble-clip" });
  bubbleClip.append(
    svgElement("rect", {
      class: "beer-bubble-clip-rect",
      x: graphic.fillX,
      width: graphic.fillWidth,
      y: graphic.bottomY,
      height: 0,
    }),
  );
  defs.append(clip, bubbleClip);
  svg.append(title, defs);
  appendDetails(svg, graphic.detailPaths, clipId);
  svg.append(
    svgElement("path", {
      class: "glass",
      d: graphic.bodyPath,
      fill: `url(#${clipId}-glass)`,
      stroke: "#8BA3AF",
      "stroke-width": 1.35,
      "data-glass-contour": "true",
    }),
  );
  const clipped = svgElement("g", { class: "beer-liquid-clip", "clip-path": `url(#${clipId})` });
  for (const [className, fill] of [
    ["liquid beer-liquid-rect", "#D97706"],
    ["beer-liquid-shadow", `url(#${clipId}-light)`],
    ["beer-liquid-depth", `url(#${clipId}-depth)`],
  ]) {
    clipped.append(
      svgElement("rect", {
        class: className,
        x: graphic.fillX,
        width: graphic.fillWidth,
        y: graphic.bottomY,
        height: 0,
        fill,
      }),
    );
  }
  const center = graphic.fillX + graphic.fillWidth / 2;
  clipped.append(
    svgElement("rect", {
      class: "beer-pour-stream",
      x: center - Math.max(2, graphic.fillWidth * 0.025),
      y: graphic.topY - 32,
      width: Math.max(4, graphic.fillWidth * 0.05),
      height: 32,
      fill: "#D97706",
      opacity: 0,
    }),
  );
  const bubbles = svgElement("g", {
    class: "beer-bubbles",
    "clip-path": `url(#${clipId}-bubbles)`,
  });
  for (const [position, offset, radius] of BUBBLE_SPECS)
    bubbles.append(
      svgElement("circle", {
        class: "beer-bubble",
        cx: graphic.fillX + graphic.fillWidth * position,
        cy: graphic.bottomY - ((graphic.bottomY - graphic.topY) * offset) / 180,
        r: radius * 0.65,
        fill: "#FFF4D7",
        "fill-opacity": 0.12,
        stroke: "#FFF4D7",
        "stroke-opacity": 0.65,
        "stroke-width": 0.55,
      }),
    );
  clipped.append(bubbles);
  const foam = svgElement("g", { class: "beer-cloud-foam" });
  const foamShape = svgElement("g", {
    transform: `translate(${graphic.fillX} 0) scale(${graphic.fillWidth / 74} 1)`,
  });
  foamShape.append(
    svgElement("path", { class: "beer-foam-shape", d: FOAM_PATH, fill: `url(#${clipId}-foam)` }),
  );
  foamShape.append(
    svgElement("path", {
      d: "M 12 -8 C 14 -12 18 -12 21 -9 M 25 -12 C 27 -14 31 -13 33 -10 M 48 -6 C 51 -9 55 -8 57 -5",
      fill: "none",
      stroke: "#FFFFFF",
      "stroke-opacity": 0.85,
      "stroke-width": 1.4,
      "stroke-linecap": "round",
    }),
  );
  foam.append(foamShape);
  clipped.append(foam);
  svg.append(clipped);
  const front = svgElement("g", { class: "glass-front" });
  appendDetails(front, graphic.frontPaths, clipId);
  svg.append(
    front,
    svgElement("path", {
      class: "rim",
      d: graphic.rimPath,
      fill: `url(#${clipId}-rim)`,
      stroke: "#C4DAE4",
      "stroke-width": 0.8,
      "fill-rule": "evenodd",
      "stroke-linejoin": "round",
    }),
  );
  svg.setAttribute("viewBox", graphic.viewBox);
  svg.dataset.artworkVersion = ARTWORK_VERSION;
}

export function applyGraphic(svg, tap) {
  const graphic = safeGraphic(tap);
  const clipId = `fill-clip-${String(tap.id)
    .replace(/[^a-zA-Z0-9_-]/gu, "-")
    .slice(0, 80)}-${graphicNamespace}-${++nextGraphicId}`;
  const needsStructure =
    svg.dataset.graphicId !== graphic.id ||
    svg.dataset.artworkVersion !== ARTWORK_VERSION ||
    !svg.querySelector(".glass-front") ||
    !svg.querySelector(".beer-bubble-clip-rect");
  if (needsStructure) {
    cancelVesselAnimation(svg);
    renderGraphicStructure(svg, tap, graphic, clipId);
  }
  svg.dataset.graphicId = graphic.id;
  svg.dataset.graphicToken = graphic.token;
  const color =
    typeof tap.displayColor === "string" && /^#[0-9A-Fa-f]{6}$/u.test(tap.displayColor)
      ? tap.displayColor
      : "#D97706";
  updateVesselFill(svg, graphic, tap.fillPercent, color, !needsStructure);
}

export function createGraphic(tap) {
  const svg = svgElement("svg", {
    class: "tap-graphic",
    role: "img",
    "aria-label": `${tap.accessibleLabel || tap.title || tap.beverageName || `Tap ${tap.tapNumber}`} fill level`,
  });
  applyGraphic(svg, tap);
  return svg;
}
