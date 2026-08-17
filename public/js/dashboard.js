import { createDirtyQueue } from "/assets/js/dirty-targets.js";
import {
  apply as applyPreferences,
  read as readPreferences,
} from "/assets/js/display-preferences.js";
import { connect } from "/assets/js/sse.js";

const root = document.querySelector("[data-dashboard]");
const grid = document.querySelector("[data-tap-grid]");
const SVG_NS = "http://www.w3.org/2000/svg";
const onDeckMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
let rotationTimer;
let rotationPage = 0;
let onDeckFrame;
let onDeckDirection = 1;
let onDeckPauseUntil = 0;
let onDeckPaused = false;
let onDeckHover = false;
let onDeckFocus = false;
let onDeckInteractionUntil = 0;
let onDeckLastFrame;
let onDeckPosition = 0;
let onDeckListenersAttached = false;

function text(element, value) {
  if (element) element.textContent = value ?? "";
}

function optionalText(element, value) {
  if (!element) return;
  element.hidden = value === null || value === undefined || value === "";
  text(element, element.hidden ? "" : String(value));
}

function createTextElement(tag, field, className) {
  const element = document.createElement(tag);
  element.dataset.field = field;
  if (className) element.className = className;
  return element;
}

function createUnitTextElement(field, className) {
  const element = createTextElement("p", field, className);
  for (const unit of ["metric", "us"]) {
    const value = document.createElement("span");
    value.dataset.unit = unit;
    element.append(value);
  }
  return element;
}

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
  bodyPath: "M 45 40 H 115 L 105 225 H 55 Z",
  clipPath: "M 30 0 H 130 L 114 45 L 104 225 H 56 L 46 45 Z",
  rimPath: "M 45 40 H 115",
  viewBox: "0 40 160 190",
  topY: 45,
  bottomY: 225,
  fillX: 30,
  fillWidth: 100,
  detailPaths: [],
});

function safePath(value, fallback) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1200 &&
    !/[<>]/u.test(value)
    ? value
    : fallback;
}

function safeDetail(value) {
  if (!value || typeof value !== "object") return undefined;
  const detail = value;
  const className = ["glass-detail", "glass-stem", "glass-base", "glass-highlight"].includes(
    detail.className,
  )
    ? detail.className
    : "glass-detail";
  if (
    typeof detail.d !== "string" ||
    detail.d.length === 0 ||
    detail.d.length > 1200 ||
    /[<>]/u.test(detail.d)
  )
    return undefined;
  const finite = (candidate, fallback, minimum, maximum) =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= minimum &&
    candidate <= maximum
      ? candidate
      : fallback;
  const color = (candidate, fallback) =>
    typeof candidate === "string" && (/^#[0-9A-Fa-f]{6}$/u.test(candidate) || candidate === "none")
      ? candidate
      : fallback;
  return {
    d: detail.d,
    className,
    fill: color(detail.fill, "none"),
    stroke: color(detail.stroke, "none"),
    strokeWidth: finite(detail.strokeWidth, 0, 0, 8),
    opacity: finite(detail.opacity, 1, 0, 1),
    contour: detail.contour === true,
  };
}

function safeGraphic(tap) {
  const candidate = tap.graphic && typeof tap.graphic === "object" ? tap.graphic : undefined;
  const candidateId =
    candidate && typeof candidate.id === "string" && VESSEL_IDS.has(candidate.id)
      ? candidate.id
      : undefined;
  const expectedToken =
    candidateId === undefined ? undefined : `vessel/${candidateId.replace(/_/gu, "-")}`;
  if (candidateId !== undefined && candidate?.token !== expectedToken)
    return { ...DEFAULT_GRAPHIC };
  const id = candidateId ?? (VESSEL_IDS.has(tap.graphicId) ? tap.graphicId : DEFAULT_GRAPHIC.id);
  if (candidateId === undefined || candidate === undefined) return { ...DEFAULT_GRAPHIC };
  const value = (name, fallback, minimum, maximum) => {
    const raw = candidate?.[name];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= minimum && raw <= maximum
      ? raw
      : fallback;
  };
  const bodyPath = safePath(candidate.bodyPath, DEFAULT_GRAPHIC.bodyPath);
  const clipPath = safePath(candidate.clipPath, DEFAULT_GRAPHIC.clipPath);
  const rimPath = safePath(candidate.rimPath, DEFAULT_GRAPHIC.rimPath);
  const detailPaths = Array.isArray(candidate.detailPaths)
    ? candidate.detailPaths.map(safeDetail).filter(Boolean).slice(0, 16)
    : [];
  return {
    id,
    token: expectedToken,
    bodyPath,
    clipPath,
    rimPath,
    viewBox: safePath(candidate.viewBox, DEFAULT_GRAPHIC.viewBox),
    topY: value("topY", DEFAULT_GRAPHIC.topY, 0, 240),
    bottomY: value("bottomY", DEFAULT_GRAPHIC.bottomY, 1, 250),
    fillX: value("fillX", DEFAULT_GRAPHIC.fillX, 0, 160),
    fillWidth: value("fillWidth", DEFAULT_GRAPHIC.fillWidth, 1, 160),
    detailPaths,
  };
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function safeColor(value) {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/u.test(value) ? value : "currentColor";
}

const BUBBLE_SPECS = Object.freeze([
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
]);

function renderGraphicStructure(svg, tap, graphic, clipId) {
  svg.replaceChildren();
  const title = svgElement("title");
  svg.append(title);
  const definitions = svgElement("defs");
  const clip = svgElement("clipPath", { id: clipId, class: "beer-liquid-clip" });
  clip.append(svgElement("path", { d: graphic.clipPath }));
  const bubbleClipId = `${clipId}-bubbles`;
  const bubbleClip = svgElement("clipPath", { id: bubbleClipId, class: "beer-bubble-clip" });
  bubbleClip.append(
    svgElement("rect", {
      class: "beer-bubble-clip-rect",
      x: graphic.fillX,
      width: graphic.fillWidth,
      y: graphic.bottomY,
      height: 0,
    }),
  );
  definitions.append(clip);
  definitions.append(bubbleClip);
  svg.append(definitions);
  svg.append(svgElement("path", { class: "glass", d: graphic.bodyPath }));
  for (const item of graphic.detailPaths) {
    svg.append(
      svgElement("path", {
        class: item.className,
        d: item.d,
        fill: item.fill,
        stroke: item.stroke,
        "stroke-width": item.strokeWidth,
        opacity: item.opacity,
        ...(item.contour === true ? { "data-glass-contour": "true" } : {}),
      }),
    );
  }
  const clipped = svgElement("g", { class: "beer-liquid-clip", "clip-path": `url(#${clipId})` });
  const center = graphic.fillX + graphic.fillWidth / 2;
  clipped.append(
    svgElement("rect", {
      class: "liquid beer-liquid-rect",
      x: graphic.fillX,
      width: graphic.fillWidth,
    }),
    svgElement("rect", {
      class: "beer-liquid-shadow",
      x: graphic.fillX + graphic.fillWidth / 2,
      width: graphic.fillWidth / 2,
      fill: "rgba(0, 0, 0, 0.22)",
    }),
    svgElement("rect", {
      class: "beer-pour-stream",
      x: center - Math.max(2, graphic.fillWidth * 0.025),
      y: graphic.topY - 32,
      width: Math.max(4, graphic.fillWidth * 0.05),
      height: graphic.bottomY - graphic.topY + 32,
    }),
  );
  const foam = svgElement("g", { class: "beer-cloud-foam" });
  const beerColor = safeColor(tap.displayColor);
  const foamColor =
    beerColor === "#080100" || beerColor === "#130100" || beerColor === "#200100"
      ? "#F5EBE6"
      : "#FFFDF5";
  foam.append(
    svgElement("rect", {
      x: graphic.fillX,
      y: -8,
      width: graphic.fillWidth,
      height: 16,
      fill: foamColor,
      opacity: 0.9,
    }),
    svgElement("circle", {
      cx: graphic.fillX + graphic.fillWidth * 0.22,
      cy: -5,
      r: Math.max(6, graphic.fillWidth * 0.11),
      fill: foamColor,
    }),
    svgElement("circle", {
      cx: graphic.fillX + graphic.fillWidth * 0.43,
      cy: -8,
      r: Math.max(7, graphic.fillWidth * 0.14),
      fill: foamColor,
    }),
    svgElement("circle", {
      cx: graphic.fillX + graphic.fillWidth * 0.65,
      cy: -7,
      r: Math.max(7, graphic.fillWidth * 0.13),
      fill: foamColor,
    }),
    svgElement("circle", {
      cx: graphic.fillX + graphic.fillWidth * 0.84,
      cy: -5,
      r: Math.max(6, graphic.fillWidth * 0.1),
      fill: foamColor,
    }),
    svgElement("circle", {
      cx: center,
      cy: -9,
      r: Math.max(5, graphic.fillWidth * 0.09),
      fill: "#FFFFFF",
      opacity: 0.5,
    }),
  );
  clipped.append(foam);
  const bubbles = svgElement("g", {
    class: "beer-bubbles",
    "clip-path": `url(#${bubbleClipId})`,
  });
  for (const [position, offset, radius] of BUBBLE_SPECS) {
    bubbles.append(
      svgElement("circle", {
        class: "beer-bubble",
        cx: graphic.fillX + graphic.fillWidth * position,
        cy: graphic.bottomY - offset,
        r: radius,
        fill: "#FFFFFF",
        opacity: 0.6,
      }),
    );
  }
  clipped.append(bubbles);
  svg.append(clipped, svgElement("path", { class: "rim", d: graphic.rimPath }));
  svg.setAttribute("viewBox", graphic.viewBox);
  title.textContent = `${publicTapLabel(tap)} fill level`;
}

function updateGraphicFill(svg, tap, graphic) {
  const percentage = Math.max(0, Math.min(100, Number(tap.fillPercent) || 0));
  const liquidY = graphic.bottomY - ((graphic.bottomY - graphic.topY) * percentage) / 100;
  const height = graphic.bottomY - liquidY + 4;
  const color =
    safeColor(tap.displayColor) === "currentColor" ? "#D97706" : safeColor(tap.displayColor);
  const liquid = svg.querySelector(".beer-liquid-rect");
  const shadow = svg.querySelector(".beer-liquid-shadow");
  const stream = svg.querySelector(".beer-pour-stream");
  const foam = svg.querySelector(".beer-cloud-foam");
  const bubbles = svg.querySelector(".beer-bubbles");
  const bubbleBounds = svg.querySelector(".beer-bubble-clip-rect");
  for (const element of [liquid, shadow]) {
    if (!element) continue;
    element.setAttribute("y", String(liquidY));
    element.setAttribute("height", String(height));
  }
  liquid?.setAttribute("fill", color);
  stream?.setAttribute("fill", color);
  if (foam) {
    foam.setAttribute("transform", `translate(0 ${liquidY})`);
    foam.setAttribute("data-base-y", String(liquidY));
    foam.toggleAttribute("hidden", percentage <= 0);
  }
  if (bubbleBounds) {
    bubbleBounds.setAttribute("y", String(liquidY));
    bubbleBounds.setAttribute("height", String(height));
  }
  if (bubbles) bubbles.toggleAttribute("hidden", percentage <= 0);
  if (liquid) {
    liquid.dataset.fillPercent = String(percentage);
    liquid.dataset.field = "fill-graphic";
  }
  svg.dataset.fillTopY = String(graphic.topY);
  svg.dataset.fillBottomY = String(graphic.bottomY);
}

function applyGraphic(svg, tap) {
  const graphic = safeGraphic(tap);
  const clipId = `fill-clip-${String(tap.id)
    .replace(/[^a-zA-Z0-9_-]/gu, "-")
    .slice(0, 80)}`;
  const needsStructure =
    svg.dataset.graphicId !== graphic.id ||
    !svg.querySelector(".glass") ||
    !svg.querySelector(".beer-bubbles") ||
    !svg.querySelector(".beer-bubble-clip-rect");
  if (needsStructure) renderGraphicStructure(svg, tap, graphic, clipId);
  svg.dataset.graphicId = graphic.id;
  svg.dataset.graphicToken = graphic.token;
  updateGraphicFill(svg, tap, graphic);
}

function createGraphic(tap) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("tap-graphic");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${publicTapLabel(tap)} fill level`);
  applyGraphic(svg, tap);
  return svg;
}

function publicTapLabel(tap) {
  return tap.accessibleLabel || tap.title || tap.beverageName || `Tap ${tap.tapNumber}`;
}

function isStoryCard(tap) {
  return typeof tap.storyPath === "string" && tap.storyPath.startsWith("/taps/");
}

function retagCard(card, tagName) {
  const replacement = document.createElement(tagName);
  for (const attribute of card.attributes)
    replacement.setAttribute(attribute.name, attribute.value);
  while (card.firstChild) replacement.append(card.firstChild);
  card.replaceWith(replacement);
  return replacement;
}

function promoteStoryCard(card) {
  if (!card.matches("a.tap-card")) return card;
  const href = card.getAttribute("href");
  const article = retagCard(card, "article");
  article.removeAttribute("href");
  if (href) {
    const storyLink = document.createElement("a");
    storyLink.className = "tap-story-overlay";
    storyLink.dataset.field = "story-link";
    storyLink.href = href;
    storyLink.setAttribute("aria-label", article.getAttribute("aria-label") || "Open Brew Story");
    if (article.dataset.adminPourPreview === "true")
      storyLink.setAttribute("aria-keyshortcuts", "Shift+Space");
    article.append(storyLink);
  }
  return article;
}

function restoreStoryCard(card) {
  if (!card.matches("article.tap-card")) return card;
  const storyLink = card.querySelector('[data-field="story-link"]');
  if (!storyLink) return card;
  const href = storyLink.getAttribute("href");
  storyLink.remove();
  const anchor = retagCard(card, "a");
  if (href) anchor.href = href;
  return anchor;
}

function createCard(tap) {
  const story = isStoryCard(tap);
  const title = tap.title || tap.beverageName || "Empty Tap";
  const card = document.createElement(story ? "a" : "article");
  card.className = "tap-card";
  if (story) card.href = tap.storyPath;
  card.dataset.tapId = String(tap.id);
  if (root?.dataset.adminPourPreview === "true") {
    card.dataset.adminPourPreview = "true";
    if (!story) card.setAttribute("aria-keyshortcuts", "Shift+Space");
  }
  card.setAttribute(
    "aria-label",
    tap.accessibleLabel || (story ? `${title} story` : `Tap ${tap.tapNumber}, ${title}`),
  );
  if (!story) card.tabIndex = 0;
  const copy = document.createElement("div");
  copy.className = "tap-copy";
  const titleRow = document.createElement("div");
  titleRow.className = "tap-title-row";
  const badge = createTextElement("span", "tap-number", "tap-number-badge");
  badge.setAttribute("aria-hidden", "true");
  titleRow.append(badge, createTextElement("h2", "tap-name"));
  const metadata = document.createElement("div");
  metadata.className = "tap-meta-row";
  metadata.append(createTextElement("p", "style-line", "meta tap-style-line"));
  const metrics = document.createElement("dl");
  metrics.className = "tap-metrics";
  metrics.dataset.field = "metrics";
  copy.append(
    metadata,
    metrics,
    createTextElement("p", "description", "description"),
    createUnitTextElement("temperature", "temperature"),
  );
  const visual = document.createElement("div");
  visual.className = "tap-visual";
  const pourStatus = createTextElement("span", "pour-preview-status", "pour-preview-status");
  pourStatus.setAttribute("data-pour-preview-status", "");
  pourStatus.setAttribute("aria-live", "polite");
  pourStatus.hidden = true;
  text(pourStatus, "Now pouring");
  visual.append(
    createGraphic(tap),
    pourStatus,
    createTextElement("p", "remaining-readout", "remaining-readout"),
  );
  const forecast = createTextElement("p", "forecast", "forecast");
  forecast.append(
    createTextElement("span", "forecast-servings"),
    createTextElement("span", "forecast-days"),
    createTextElement("span", "forecast-status"),
  );
  visual.append(forecast);
  const badges = document.createElement("div");
  badges.className = "tap-badges";
  const health = document.createElement("span");
  health.className = "health-badge";
  health.dataset.field = "health";
  const dot = document.createElement("span");
  dot.className = "health-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = createTextElement("span", "health-label");
  health.append(dot, label);
  badges.append(health);
  card.append(titleRow, copy, visual, badges);
  return card;
}

function finiteDataNumber(card, name) {
  const raw = card.dataset[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readout(card, mode) {
  if (card.dataset.waitingForMeasurement === "true") return "Waiting for measurement";
  const fillPercent = finiteDataNumber(card, "fillPercent");
  const remainingVolumeMl = finiteDataNumber(card, "remainingVolumeMl");
  const capacityMl = finiteDataNumber(card, "capacityMl");
  const servingsRemaining = finiteDataNumber(card, "servingsRemaining");
  if (mode === "percent" && fillPercent !== null) return `${Math.round(fillPercent)}% remaining`;
  if (mode === "pints" && remainingVolumeMl !== null)
    return `${(remainingVolumeMl / 473.176473).toFixed(1)} pints remaining`;
  if (mode === "pours" && servingsRemaining !== null)
    return `${Math.max(0, Math.floor(servingsRemaining))} pours remaining`;
  if (mode === "volume" && remainingVolumeMl !== null && capacityMl !== null) {
    const metric = document.documentElement.dataset.unitSystem === "metric";
    const divisor = metric ? 1000 : 3785.411784;
    const suffix = metric ? " L" : " gal";
    return `${(remainingVolumeMl / divisor).toFixed(1)}${suffix} / ${(capacityMl / divisor).toFixed(1)}${suffix}`;
  }
  return "Measurement unavailable";
}

function patchMetrics(card, metrics) {
  const field = card.querySelector('[data-field="metrics"]');
  if (!field) return;
  const values = (Array.isArray(metrics) ? metrics : []).filter((metric) => metric?.key !== "abv");
  field.hidden = values.length === 0;
  field.replaceChildren(
    ...values.map((metric) => {
      const wrapper = document.createElement("div");
      const label = document.createElement("dt");
      const value = document.createElement("dd");
      text(label, metric?.label);
      text(value, metric?.value);
      wrapper.append(label, value);
      return wrapper;
    }),
  );
}

function patchStyleLine(card, metrics, style) {
  const field = card.querySelector('[data-field="style-line"]');
  if (!field) return;
  const abv = (Array.isArray(metrics) ? metrics : []).find((metric) => metric?.key === "abv");
  optionalText(field, [abv?.value, style].filter(Boolean).join(" · "));
}

function patchUnits(card) {
  const temperature = finiteDataNumber(card, "temperatureC");
  const temperatureField = card.querySelector('[data-field="temperature"]');
  if (temperatureField) temperatureField.hidden = !Number.isFinite(temperature);
  if (Number.isFinite(temperature)) {
    text(temperatureField?.querySelector('[data-unit="metric"]'), `${temperature.toFixed(1)} °C`);
    text(
      temperatureField?.querySelector('[data-unit="us"]'),
      `${((temperature * 9) / 5 + 32).toFixed(1)} °F`,
    );
  }
  text(
    card.querySelector('[data-field="remaining-readout"]'),
    readout(card, document.documentElement.dataset.remainingMode || "percent"),
  );
}

function patchForecast(card, tap) {
  const forecast = card.querySelector('[data-field="forecast"]');
  if (!forecast) return;
  const servings =
    !tap.waitingForMeasurement && typeof tap.servingsRemaining === "number"
      ? `${Math.max(0, Math.floor(tap.servingsRemaining))} servings`
      : "";
  const days =
    !tap.waitingForMeasurement && typeof tap.daysRemaining === "number"
      ? `${tap.daysRemaining} days`
      : "";
  const status = tap.waitingForMeasurement
    ? "Waiting for measurement"
    : servings || days
      ? ""
      : "Measurement unavailable";
  const values = [
    ["forecast-servings", servings],
    ["forecast-days", days],
    ["forecast-status", status],
  ];
  for (const [field, value] of values) {
    const element = forecast.querySelector(`[data-field="${field}"]`);
    if (!element) continue;
    element.hidden = value === "";
    text(element, value);
  }
}

function patchTap(tap) {
  let card = grid.querySelector(`[data-tap-id="${CSS.escape(String(tap.id))}"]`);
  const link = isStoryCard(tap);
  const title = tap.title || tap.beverageName || "Empty Tap";
  if (!card) {
    const previous = card;
    card = createCard(tap);
    previous?.replaceWith(card);
    if (!previous) grid.append(card);
  }
  if (!link && card.matches("a.tap-card")) {
    card = retagCard(card, "article");
    card.removeAttribute("href");
  }
  card.dataset.tapNumber = String(tap.tapNumber);
  card.dataset.health = ["healthy", "degraded", "unknown"].includes(tap.health)
    ? tap.health
    : "unknown";
  if (typeof tap.temperatureC === "number" && Number.isFinite(tap.temperatureC))
    card.dataset.temperatureC = String(tap.temperatureC);
  else delete card.dataset.temperatureC;
  if (typeof tap.remainingVolumeMl === "number" && Number.isFinite(tap.remainingVolumeMl))
    card.dataset.remainingVolumeMl = String(tap.remainingVolumeMl);
  else delete card.dataset.remainingVolumeMl;
  if (typeof tap.capacityMl === "number" && Number.isFinite(tap.capacityMl))
    card.dataset.capacityMl = String(tap.capacityMl);
  else delete card.dataset.capacityMl;
  if (typeof tap.fillPercent === "number" && Number.isFinite(tap.fillPercent))
    card.dataset.fillPercent = String(tap.fillPercent);
  else delete card.dataset.fillPercent;
  if (typeof tap.servingsRemaining === "number" && Number.isFinite(tap.servingsRemaining))
    card.dataset.servingsRemaining = String(tap.servingsRemaining);
  else delete card.dataset.servingsRemaining;
  card.dataset.waitingForMeasurement = tap.waitingForMeasurement === true ? "true" : "false";
  if (root?.dataset.adminPourPreview === "true") {
    card.dataset.adminPourPreview = "true";
    if (!link) card.setAttribute("aria-keyshortcuts", "Shift+Space");
    else card.removeAttribute("aria-keyshortcuts");
  } else {
    delete card.dataset.adminPourPreview;
    card.removeAttribute("aria-keyshortcuts");
  }
  let storyLink = card.querySelector('[data-field="story-link"]');
  const linkedRoot = card.matches("a.tap-card");
  if (link && linkedRoot) {
    card.href = tap.storyPath;
    storyLink?.remove();
    storyLink = null;
  } else if (link && !storyLink) {
    storyLink = document.createElement("a");
    storyLink.className = "tap-story-overlay";
    storyLink.dataset.field = "story-link";
    card.append(storyLink);
  }
  if (storyLink) {
    if (link) {
      storyLink.href = tap.storyPath;
      storyLink.hidden = false;
      storyLink.setAttribute("aria-label", tap.accessibleLabel || `${title} story`);
      if (root?.dataset.adminPourPreview === "true")
        storyLink.setAttribute("aria-keyshortcuts", "Shift+Space");
      else storyLink.removeAttribute("aria-keyshortcuts");
    } else storyLink.remove();
  }
  if (link) card.removeAttribute("tabindex");
  else card.tabIndex = 0;
  text(card.querySelector('[data-field="tap-number"]'), tap.tapNumber);
  text(card.querySelector('[data-field="tap-name"]'), title);
  patchStyleLine(card, tap.metrics, tap.style);
  text(
    card.querySelector('[data-field="health-label"]'),
    tap.health === "healthy" ? "Healthy" : tap.health === "degraded" ? "Degraded" : "Unknown",
  );
  patchMetrics(card, tap.metrics);
  optionalText(card.querySelector('[data-field="description"]'), tap.description);
  patchForecast(card, tap);
  const svg = card.querySelector(".tap-graphic");
  if (svg) {
    const graphicLabel = `${publicTapLabel(tap)} fill level`;
    applyGraphic(svg, tap);
    svg.setAttribute("aria-label", graphicLabel);
    text(svg.querySelector("title"), graphicLabel);
  }
  card.setAttribute(
    "aria-label",
    tap.accessibleLabel || (link ? `${title} story` : `Tap ${tap.tapNumber}, ${title}`),
  );
  patchUnits(card);
  grid.append(
    ...[...grid.children].sort(
      (left, right) => Number(left.dataset.tapNumber) - Number(right.dataset.tapNumber),
    ),
  );
  return card;
}

const pourTimers = new WeakMap();
const pourSuppressClick = new WeakMap();

function closestTarget(target, selector) {
  return target && typeof target.closest === "function" ? target.closest(selector) : null;
}

function adminPourEnabled(card) {
  return root?.dataset.adminPourPreview === "true" && card.dataset.adminPourPreview === "true";
}

function activatePourPreview(card) {
  if (!adminPourEnabled(card)) return;
  window.clearTimeout(pourTimers.get(card));
  card.classList.add("is-pour-preview");
  const status = card.querySelector("[data-pour-preview-status]");
  if (status) status.hidden = false;
  pourSuppressClick.set(card, true);
  pourTimers.set(
    card,
    window.setTimeout(() => {
      card.classList.remove("is-pour-preview");
      if (status) status.hidden = true;
      pourSuppressClick.delete(card);
    }, 3500),
  );
}

function attachPourPreviewListeners() {
  if (!grid || root?.dataset.adminPourPreview !== "true") return;
  let hold;
  let pointer;
  grid.addEventListener(
    "pointerdown",
    (event) => {
      const card = closestTarget(event.target, "[data-tap-id]");
      const graphic = card?.querySelector(".tap-graphic");
      const bounds = graphic?.getBoundingClientRect();
      if (
        !bounds ||
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        return;
      if (!card || !adminPourEnabled(card)) return;
      pointer = { card, id: event.pointerId, x: event.clientX, y: event.clientY, fired: false };
      window.clearTimeout(hold);
      hold = window.setTimeout(() => {
        if (!pointer || pointer.card !== card) return;
        pointer.fired = true;
        activatePourPreview(card);
      }, 650);
    },
    true,
  );
  grid.addEventListener(
    "pointermove",
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10) {
        window.clearTimeout(hold);
        pointer = undefined;
      }
    },
    true,
  );
  const cancel = (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    window.clearTimeout(hold);
    pointer = undefined;
  };
  grid.addEventListener("pointerup", cancel, true);
  grid.addEventListener("pointercancel", cancel, true);
  grid.addEventListener(
    "click",
    (event) => {
      const card = closestTarget(event.target, "[data-tap-id]");
      if (card && pourSuppressClick.get(card) === true) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  grid.addEventListener("contextmenu", (event) => {
    const card = closestTarget(event.target, "[data-tap-id]");
    const bounds = card?.querySelector(".tap-graphic")?.getBoundingClientRect();
    if (
      bounds &&
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    )
      event.preventDefault();
  });
  grid.addEventListener("keydown", (event) => {
    if (!event.shiftKey || event.code !== "Space") return;
    const card = closestTarget(event.target, "[data-tap-id]");
    if (!card || !adminPourEnabled(card)) return;
    event.preventDefault();
    activatePourPreview(card);
  });
}

function onDeckElements() {
  const root = document.querySelector("[data-on-deck]");
  const viewport = root?.querySelector("[data-on-deck-viewport]");
  const toggle = root?.querySelector("[data-on-deck-toggle]");
  return { root, viewport, toggle };
}

function onDeckShouldPause() {
  return (
    onDeckPaused ||
    onDeckHover ||
    onDeckFocus ||
    document.hidden ||
    Date.now() < onDeckInteractionUntil ||
    onDeckMotionQuery.matches
  );
}

function stopOnDeckAnimation() {
  if (onDeckFrame !== undefined) {
    window.cancelAnimationFrame(onDeckFrame);
    onDeckFrame = undefined;
  }
  onDeckLastFrame = undefined;
}

function runOnDeckAnimation(timestamp) {
  const { viewport } = onDeckElements();
  if (!viewport) return stopOnDeckAnimation();
  const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  if (maxScroll <= 0 || onDeckShouldPause()) return stopOnDeckAnimation();
  if (onDeckLastFrame === undefined) onDeckLastFrame = timestamp;
  const elapsed = Math.min(80, timestamp - onDeckLastFrame);
  onDeckLastFrame = timestamp;
  if (timestamp >= onDeckPauseUntil) {
    onDeckPosition = Math.max(
      0,
      Math.min(maxScroll, onDeckPosition + onDeckDirection * elapsed * 0.018),
    );
    viewport.scrollLeft = onDeckPosition;
    if (onDeckDirection > 0 && onDeckPosition >= maxScroll - 1) {
      onDeckPosition = maxScroll;
      viewport.scrollLeft = maxScroll;
      onDeckDirection = -1;
      onDeckPauseUntil = timestamp + 1000;
    } else if (onDeckDirection < 0 && onDeckPosition <= 1) {
      onDeckPosition = 0;
      viewport.scrollLeft = 0;
      onDeckDirection = 1;
      onDeckPauseUntil = timestamp + 1000;
    }
  }
  onDeckFrame = window.requestAnimationFrame(runOnDeckAnimation);
}

function syncOnDeckAnimation() {
  stopOnDeckAnimation();
  const { viewport, toggle } = onDeckElements();
  const canScroll = viewport ? Math.max(0, viewport.scrollWidth - viewport.clientWidth) > 1 : false;
  if (toggle) {
    toggle.hidden = !canScroll || onDeckMotionQuery.matches;
    toggle.textContent = onDeckPaused ? "Resume" : "Pause";
    toggle.setAttribute("aria-label", `${onDeckPaused ? "Resume" : "Pause"} On Deck scrolling`);
    toggle.setAttribute("aria-pressed", String(onDeckPaused));
  }
  if (!viewport || !canScroll || onDeckShouldPause()) return;
  onDeckPosition = Math.max(
    0,
    Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft),
  );
  onDeckFrame = window.requestAnimationFrame(runOnDeckAnimation);
}

function resetOnDeckAnimation() {
  const { viewport } = onDeckElements();
  if (!viewport) return;
  stopOnDeckAnimation();
  viewport.scrollLeft = 0;
  onDeckPosition = 0;
  onDeckDirection = 1;
  onDeckPauseUntil = 0;
  syncOnDeckAnimation();
}

function markOnDeckInteraction() {
  onDeckInteractionUntil = Date.now() + 2000;
  syncOnDeckAnimation();
  window.setTimeout(syncOnDeckAnimation, 2050);
}

function attachOnDeckListeners() {
  if (onDeckListenersAttached) return;
  const { root, viewport, toggle } = onDeckElements();
  if (!root || !viewport || !toggle) return;
  onDeckListenersAttached = true;
  viewport.addEventListener("pointerenter", () => {
    onDeckHover = true;
    stopOnDeckAnimation();
  });
  viewport.addEventListener("pointerleave", () => {
    onDeckHover = false;
    syncOnDeckAnimation();
  });
  viewport.addEventListener("focusin", () => {
    onDeckFocus = true;
    stopOnDeckAnimation();
  });
  viewport.addEventListener("focusout", () => {
    onDeckFocus = viewport.matches(":focus-within");
    if (!onDeckFocus) syncOnDeckAnimation();
  });
  viewport.addEventListener("wheel", markOnDeckInteraction, { passive: true });
  viewport.addEventListener("touchstart", markOnDeckInteraction, { passive: true });
  toggle.addEventListener("click", () => {
    onDeckPaused = !onDeckPaused;
    syncOnDeckAnimation();
  });
  window.addEventListener("resize", syncOnDeckAnimation, { passive: true });
  document.addEventListener("visibilitychange", syncOnDeckAnimation);
  onDeckMotionQuery.addEventListener("change", syncOnDeckAnimation);
  syncOnDeckAnimation();
}

function patchOnDeck(items) {
  const list = document.querySelector("[data-on-deck-list]");
  if (!list) return;
  const values = Array.isArray(items) ? items : [];
  const children =
    values.length === 0
      ? [
          Object.assign(document.createElement("li"), {
            className: "on-deck-empty",
            textContent: "Nothing queued",
          }),
        ]
      : values.map((item, index) => {
          const element = document.createElement("li");
          element.dataset.fillId = String(item.fillId);
          const number = document.createElement("span");
          number.className = "on-deck-number";
          number.setAttribute("aria-hidden", "true");
          text(number, index + 1);
          element.append(number);
          const content = document.createElement("span");
          const name = document.createElement("strong");
          text(name, item.name);
          content.append(name);
          if (item.style) {
            const style = document.createElement("span");
            text(style, item.style);
            content.append(" — ", style);
          }
          element.append(content);
          return element;
        });
  list.replaceChildren(...children);
  attachOnDeckListeners();
  resetOnDeckAnimation();
}

function patchHeader(header) {
  text(document.querySelector(".public-brand"), header.tapboardName);
  text(
    document.querySelector(".public-header [data-connectivity-label]"),
    header.connectivityLabel,
  );
  const element = document.querySelector(".public-header");
  if (element) {
    element.dataset.connectivity = header.connectivity;
    element.dataset.connectivityLabel = header.connectivityLabel;
  }
  document.title = header.tapboardName;
}

function patchSharedDisplay(shared) {
  const element = document.documentElement;
  element.dataset.displayRevision = String(shared.revision);
  element.dataset.remainingMode = String(shared.remainingMode || "percent");
  text(document.querySelector(".public-brand"), shared.tapboardName);
  document.title = shared.tapboardName;
  for (const name of [
    "theme",
    "font",
    "accent",
    "unitSystem",
    "showServingTemperature",
    "layoutMode",
    "remainingMode",
  ]) {
    element.dataset[`shared${name[0].toUpperCase()}${name.slice(1)}`] = String(shared[name]);
  }
  applyPreferences(readPreferences());
  for (const card of grid.querySelectorAll("[data-tap-id]")) patchUnits(card);
}

function reconcile(dashboard) {
  patchSharedDisplay(dashboard.sharedDisplay);
  patchHeader(dashboard.header);
  const present = new Set(dashboard.taps.map((tap) => String(tap.id)));
  for (const tap of dashboard.taps) patchTap(tap);
  for (const card of grid.querySelectorAll("[data-tap-id]"))
    if (!present.has(card.dataset.tapId)) card.remove();
  patchOnDeck(dashboard.onDeck.items);
  patchTapWars(dashboard.tapWars ?? null);
  updateRotation();
}

async function json(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) return undefined;
  return response.json();
}

async function refresh(target) {
  if (target === "header") {
    const header = await json("/api/public/dashboard/header");
    if (header) patchHeader(header);
    return;
  }
  if (target === "ondeck") {
    const onDeck = await json("/api/public/dashboard/on-deck");
    if (onDeck) patchOnDeck(onDeck.items);
    return;
  }
  if (target === "display") {
    const shared = await json("/api/public/dashboard/display");
    if (shared) patchSharedDisplay(shared);
    return;
  }
  const response = await fetch(`/api/public/dashboard/taps/${encodeURIComponent(target)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404)
    grid.querySelector(`[data-tap-id="${CSS.escape(String(target))}"]`)?.remove();
  else if (response.ok) patchTap(await response.json());
  updateRotation();
}

async function reconnectRefresh() {
  if (reconnectPromise) {
    // A newer stream can have observed changes outside the current snapshot's interval.
    reconnectDirtyOverflow = true;
    return reconnectPromise;
  }
  reconnectReconciling = true;
  reconnectPromise = (async () => {
    try {
      for (;;) {
        reconnectDirtyOverflow = false;
        try {
          const dashboard = await json("/api/public/dashboard");
          if (dashboard) {
            reconcile(dashboard);
            if (!reconnectDirtyOverflow) break;
            continue;
          }
        } catch {
          // The subscribed stream stays open while authoritative reconciliation retries.
        }
        await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_RETRY_MS));
      }
    } finally {
      reconnectReconciling = false;
      for (const target of reconnectDirty) queue(target);
      reconnectDirty.clear();
      reconnectPromise = undefined;
    }
  })();
  return reconnectPromise;
}

function updateRotation() {
  window.clearInterval(rotationTimer);
  const cards = [...grid.children];
  const rotates =
    document.documentElement.dataset.layoutMode === "rotation" &&
    cards.length > 6 &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!rotates) {
    rotationPage = 0;
    for (const card of cards) card.hidden = false;
    return;
  }
  const renderPage = () => {
    const pageCount = Math.ceil(cards.length / 6);
    rotationPage %= pageCount;
    cards.forEach((card, index) => {
      card.hidden = Math.floor(index / 6) !== rotationPage;
    });
  };
  renderPage();
  rotationTimer = window.setInterval(() => {
    rotationPage += 1;
    renderPage();
  }, 20_000);
}

function tapWarsHeadline(war) {
  if (war.status === "active") return "TAP WARS! Vote below";
  if (war.status === "paused") return "TAP WARS! Voting paused";
  if (war.isTie) return "TAP WARS — IT'S A TIE!";
  return `TAP WARS WINNER — ${war.winnerSide === 1 ? war.side1.title : war.side2.title}!`;
}

function tapWarsMeterLabel(war) {
  if (war.totalVotes === 0) return `${war.side1.title} versus ${war.side2.title}. No votes yet.`;
  return `Vote split: ${war.side1.title} ${war.side1.percentage} percent; ${war.side2.title} ${war.side2.percentage} percent.`;
}

function tapWarsResultLabel(war) {
  if (war.totalVotes === 0)
    return war.status === "completed" ? "Final result: Tie. Total votes: 0." : "No votes yet.";
  if (war.status === "completed") {
    if (war.isTie) return `Final result: Tie. Total votes: ${war.totalVotes}.`;
    const winner = war.winnerSide === 1 ? war.side1.title : war.side2.title;
    return `Final result: ${winner} wins. Total votes: ${war.totalVotes}.`;
  }
  if (war.isTie) return `Tie. Total votes: ${war.totalVotes}.`;
  const leader = war.leaderSide === 1 ? war.side1.title : war.side2.title;
  return `${leader} is currently leading. Total votes: ${war.totalVotes}.`;
}

function patchTapWarsMeter(meter, war, sideSelector) {
  if (!meter) return;
  const neutral = war.totalVotes === 0;
  meter.classList.toggle("is-neutral", neutral);
  meter.setAttribute("aria-label", tapWarsMeterLabel(war));
  for (const side of [war.side1, war.side2]) {
    const segment = meter.querySelector(`[${sideSelector}="${side.side}"]`);
    if (segment) segment.style.width = `${neutral ? 0 : side.percentage}%`;
  }
}

function createTapWarsCardControls(war, side) {
  const controls = document.createElement("div");
  controls.className = "tap-wars-card-controls";
  controls.dataset.tapWarsCardControls = "";
  controls.dataset.warId = war.id;
  controls.dataset.warStatus = war.status;
  controls.dataset.warSide = String(side.side);
  const badge = document.createElement("span");
  badge.className = "tap-wars-card-badge";
  badge.dataset.tapWarsCardBadge = "";
  text(badge, "Tap Wars");
  controls.append(badge);
  if (war.status === "active" && war.canVote) {
    const form = document.createElement("form");
    form.className = "tap-wars-vote-form";
    form.dataset.tapWarsVote = "";
    form.action = war.votePath;
    form.method = "post";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "side";
    input.value = String(side.side);
    const button = document.createElement("button");
    button.type = "submit";
    text(button, "Vote for this tap");
    const live = document.createElement("span");
    live.className = "tap-wars-vote-feedback";
    live.dataset.tapWarsVoteStatus = "";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    form.append(input, button, live);
    controls.append(form);
  } else {
    const paused = document.createElement("p");
    paused.className = "tap-wars-card-paused";
    text(paused, "Voting paused");
    controls.append(paused);
  }
  return controls;
}

function patchTapWarsCard(card, war, side) {
  card.dataset.tapWarsParticipant = String(side.side);
  const existing = card.querySelector("[data-tap-wars-card-controls]");
  const sameControls =
    existing?.dataset.warId === war.id &&
    existing.dataset.warStatus === war.status &&
    existing.dataset.warSide === String(side.side) &&
    Boolean(existing.querySelector("[data-tap-wars-vote]")) ===
      (war.status === "active" && war.canVote);
  if (sameControls) {
    const form = existing.querySelector("[data-tap-wars-vote]");
    if (form) {
      form.action = war.votePath;
      const input = form.querySelector('input[name="side"]');
      if (input) input.value = String(side.side);
      text(form.querySelector('button[type="submit"]'), "Vote for this tap");
    }
    return;
  }
  existing?.remove();
  const controls = createTapWarsCardControls(war, side);
  const description = card.querySelector('[data-field="description"]');
  if (description) description.after(controls);
  else card.querySelector(".tap-copy")?.prepend(controls);
}

function patchTapWarsDialog(war) {
  const results = document.querySelector("[data-tap-wars-dialog-results]");
  text(document.querySelector("[data-tap-wars-dialog-status]"), tapWarsResultLabel(war));
  if (results) {
    results.replaceChildren(
      ...[war.side1, war.side2].map((side) => {
        const row = document.createElement("div");
        row.dataset.tapWarsDialogSide = String(side.side);
        const term = document.createElement("dt");
        text(term, `Tap ${side.tapNumber} · ${side.title}`);
        const detail = document.createElement("dd");
        const votes = document.createElement("strong");
        text(votes, `${side.voteCount} ${side.voteCount === 1 ? "vote" : "votes"}`);
        const percentage = document.createElement("span");
        text(percentage, side.percentage === null ? "—" : `${side.percentage}%`);
        detail.append(votes, percentage);
        row.append(term, detail);
        return row;
      }),
    );
  }
  patchTapWarsMeter(
    document.querySelector("[data-tap-wars-dialog-meter]"),
    war,
    "data-tap-wars-dialog-meter-side",
  );
}

function patchTapWars(war) {
  const banner = document.querySelector("[data-tap-wars]");
  if (!banner) return;
  const participantTapIds =
    war && war.status !== "completed"
      ? new Set(
          [war.side1, war.side2]
            .filter((side) => side.isCardParticipant !== false)
            .map((side) => String(side.tapId)),
        )
      : new Set();
  for (let card of grid.querySelectorAll("[data-tap-id]")) {
    delete card.dataset.tapWarsParticipant;
    if (!participantTapIds.has(String(card.dataset.tapId))) {
      card.querySelector("[data-tap-wars-card-controls]")?.remove();
      card = restoreStoryCard(card);
    }
  }
  banner.hidden = !war;
  if (!war) {
    const dialog = document.querySelector("[data-tap-wars-dialog]");
    if (dialog?.open) dialog.close();
    return;
  }
  text(banner.querySelector("[data-tap-wars-status]"), tapWarsHeadline(war));
  text(banner.querySelector("[data-tap-wars-message]"), war.statusLabel);
  for (const side of [war.side1, war.side2]) {
    text(banner.querySelector(`[data-tap-wars-side="${side.side}"]`), side.title);
    text(
      banner.querySelector(`[data-tap-wars-percent="${side.side}"]`),
      side.percentage === null ? "—" : `${side.percentage}%`,
    );
    if (war.status === "completed") continue;
    if (side.isCardParticipant === false) continue;
    let card = grid.querySelector(`[data-tap-id="${CSS.escape(String(side.tapId))}"]`);
    if (card) {
      card = promoteStoryCard(card);
      patchTapWarsCard(card, war, side);
    }
  }
  patchTapWarsMeter(banner.querySelector("[data-tap-wars-meter]"), war, "data-tap-wars-meter-side");
  patchTapWarsDialog(war);
}

function announceVote(element, message) {
  text(element, "");
  window.setTimeout(() => text(element, message), 0);
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-tap-wars-results]")) return;
  const dialog = document.querySelector("[data-tap-wars-dialog]");
  if (dialog && !dialog.open) dialog.showModal();
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-tap-wars-vote]");
  if (!form) return;
  event.preventDefault();
  const live = form.querySelector("[data-tap-wars-vote-status]");
  try {
    const response = await fetch(form.action, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(new FormData(form)).toString(),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    announceVote(live, response.ok ? "Vote counted!" : "Vote could not be counted.");
    const current = await json("/api/public/tap-wars");
    patchTapWars(current?.tapWars ?? payload?.tapWars ?? null);
  } catch {
    announceVote(live, "Vote could not be counted.");
  }
});

const queue = createDirtyQueue(refresh);
const reconnectDirty = new Set();
const RECONNECT_DIRTY_LIMIT = 64;
const RECONNECT_RETRY_MS = 1500;
let reconnectReconciling = false;
let reconnectDirtyOverflow = false;
let reconnectPromise;

function queueDirty(target) {
  if (!reconnectReconciling) {
    queue(target);
    return;
  }
  if (reconnectDirty.has(target)) return;
  if (reconnectDirty.size >= RECONNECT_DIRTY_LIMIT) {
    reconnectDirtyOverflow = true;
    return;
  }
  reconnectDirty.add(target);
}

connect(
  root.dataset.ssePath,
  (name, event) => {
    try {
      const data = JSON.parse(event.data);
      if (["tap.updated", "telemetry.updated", "health.updated"].includes(name)) {
        queueDirty(data.tapId);
        queueDirty("header");
      } else if (name === "fill.updated") {
        queueDirty(data.tapId);
        queueDirty("header");
      } else if (name === "ondeck.updated") queueDirty("ondeck");
      else if (name === "display.updated") {
        queueDirty("display");
        if (data.target === "cards") {
          for (const card of grid.querySelectorAll("[data-tap-id]")) {
            if (card.dataset.tapId) queueDirty(card.dataset.tapId);
          }
        }
      } else if (name === "tap_wars.updated") {
        void json("/api/public/tap-wars")
          .then((value) => patchTapWars(value?.tapWars ?? null))
          .catch(() => undefined);
      } else queueDirty("header");
    } catch {
      // A malformed ephemeral event is ignored; reconnect remains authoritative.
    }
  },
  reconnectRefresh,
);

document.addEventListener("tapboard:display-preferences", () => {
  for (const card of grid.querySelectorAll("[data-tap-id]")) patchUnits(card);
  updateRotation();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) window.clearInterval(rotationTimer);
  else updateRotation();
});
document.addEventListener("focusin", () => window.clearInterval(rotationTimer));
document.addEventListener("focusout", updateRotation);
attachOnDeckListeners();
attachPourPreviewListeners();
applyPreferences(readPreferences());
void json("/api/public/tap-wars")
  .then((value) => patchTapWars(value?.tapWars ?? null))
  .catch(() => undefined);
updateRotation();
