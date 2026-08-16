import { createDirtyQueue } from "/assets/js/dirty-targets.js";
import {
  apply as applyPreferences,
  read as readPreferences,
} from "/assets/js/display-preferences.js";
import { connect } from "/assets/js/sse.js";

const root = document.querySelector("[data-dashboard]");
const grid = document.querySelector("[data-tap-grid]");
const SVG_NS = "http://www.w3.org/2000/svg";
let rotationTimer;
let rotationPage = 0;

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

function renderGraphicStructure(svg, tap, graphic, clipId) {
  svg.replaceChildren();
  const title = svgElement("title");
  svg.append(title);
  const definitions = svgElement("defs");
  const clip = svgElement("clipPath", { id: clipId, class: "beer-liquid-clip" });
  clip.append(svgElement("path", { d: graphic.clipPath }));
  definitions.append(clip);
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
      }),
    );
  }
  const clipped = svgElement("g", { class: "beer-liquid-clip", "clip-path": `url(#${clipId})` });
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
  );
  const foam = svgElement("g", { class: "beer-cloud-foam" });
  const center = graphic.fillX + graphic.fillWidth / 2;
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
  svg.append(clipped, svgElement("path", { class: "rim", d: graphic.rimPath }));
  svg.setAttribute("viewBox", graphic.viewBox);
  title.textContent = `${tap.accessibleLabel || tap.title || tap.tapName || tap.beverageName || `Tap ${tap.tapNumber}`} fill level`;
}

function updateGraphicFill(svg, tap, graphic) {
  const percentage = Math.max(0, Math.min(100, Number(tap.fillPercent) || 0));
  const liquidY = graphic.bottomY - ((graphic.bottomY - graphic.topY) * percentage) / 100;
  const height = graphic.bottomY - liquidY + 4;
  const color =
    safeColor(tap.displayColor) === "currentColor" ? "#D97706" : safeColor(tap.displayColor);
  const liquid = svg.querySelector(".beer-liquid-rect");
  const shadow = svg.querySelector(".beer-liquid-shadow");
  const foam = svg.querySelector(".beer-cloud-foam");
  for (const element of [liquid, shadow]) {
    if (!element) continue;
    element.setAttribute("y", String(liquidY));
    element.setAttribute("height", String(height));
  }
  liquid?.setAttribute("fill", color);
  if (foam) {
    foam.setAttribute("transform", `translate(0 ${liquidY})`);
    foam.setAttribute("data-base-y", String(liquidY));
    foam.style.display = percentage > 0 ? "" : "none";
  }
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
  const needsStructure = svg.dataset.graphicId !== graphic.id || !svg.querySelector(".glass");
  if (needsStructure) renderGraphicStructure(svg, tap, graphic, clipId);
  svg.dataset.graphicId = graphic.id;
  svg.dataset.graphicToken = graphic.token;
  updateGraphicFill(svg, tap, graphic);
}

function createGraphic(tap) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("tap-graphic");
  svg.setAttribute("role", "img");
  applyGraphic(svg, tap);
  return svg;
}

function createCard(tap) {
  const card = document.createElement("article");
  card.className = "tap-card";
  card.dataset.tapId = String(tap.id);
  const copy = document.createElement("div");
  copy.className = "tap-copy";
  copy.append(
    createTextElement("p", "tap-number", "tap-number"),
    createTextElement("h2", "tap-name"),
    createTextElement("p", "beverage-name", "beverage-name"),
    createTextElement("p", "style", "meta"),
    createTextElement("p", "abv", "meta"),
    createTextElement("p", "description", "description"),
    createTextElement("p", "forecast", "status"),
    createUnitTextElement("temperature", "temperature"),
  );
  if (typeof tap.storyPath === "string" && tap.storyPath.startsWith("/taps/")) {
    const storyLink = document.createElement("a");
    storyLink.className = "story-link";
    storyLink.href = tap.storyPath;
    storyLink.dataset.field = "story-link";
    storyLink.textContent = "Story";
    storyLink.setAttribute("aria-label", tap.accessibleLabel || `${tap.title || "Tap"} story`);
    copy.append(storyLink);
  }
  const visual = document.createElement("div");
  visual.className = "tap-visual";
  visual.append(createGraphic(tap), createUnitTextElement("volume", "volume"));
  card.append(copy, visual);
  return card;
}

function patchUnits(card) {
  const temperature = Number(card.dataset.temperatureC);
  const temperatureField = card.querySelector('[data-field="temperature"]');
  if (temperatureField) temperatureField.hidden = !Number.isFinite(temperature);
  if (Number.isFinite(temperature)) {
    text(temperatureField?.querySelector('[data-unit="metric"]'), `${temperature.toFixed(1)} °C`);
    text(
      temperatureField?.querySelector('[data-unit="us"]'),
      `${((temperature * 9) / 5 + 32).toFixed(1)} °F`,
    );
  }
  const remaining = Number(card.dataset.remainingVolumeMl);
  const capacity = Number(card.dataset.capacityMl);
  const volumeField = card.querySelector('[data-field="volume"]');
  const hasVolume = Number.isFinite(remaining) && Number.isFinite(capacity);
  if (volumeField) volumeField.hidden = !hasVolume;
  if (hasVolume) {
    text(
      volumeField?.querySelector('[data-unit="metric"]'),
      `${(remaining / 1000).toFixed(1)} L / ${(capacity / 1000).toFixed(1)} L`,
    );
    text(
      volumeField?.querySelector('[data-unit="us"]'),
      `${(remaining / 3785.411784).toFixed(1)} gal / ${(capacity / 3785.411784).toFixed(1)} gal`,
    );
  }
}

function patchTap(tap) {
  let card = grid.querySelector(`[data-tap-id="${CSS.escape(String(tap.id))}"]`);
  if (!card) {
    card = createCard(tap);
    grid.append(card);
  }
  card.dataset.tapNumber = String(tap.tapNumber);
  card.dataset.health = ["healthy", "degraded", "unknown"].includes(tap.health)
    ? tap.health
    : "unknown";
  if (typeof tap.temperatureC === "number") card.dataset.temperatureC = String(tap.temperatureC);
  else delete card.dataset.temperatureC;
  if (typeof tap.remainingVolumeMl === "number")
    card.dataset.remainingVolumeMl = String(tap.remainingVolumeMl);
  else delete card.dataset.remainingVolumeMl;
  if (typeof tap.capacityMl === "number") card.dataset.capacityMl = String(tap.capacityMl);
  else delete card.dataset.capacityMl;
  const percentage = Math.max(0, Math.min(100, Number(tap.fillPercent) || 0));
  card.dataset.fillPercent = String(percentage);
  text(card.querySelector('[data-field="tap-number"]'), `Tap ${tap.tapNumber}`);
  text(
    card.querySelector('[data-field="tap-name"]'),
    tap.title || tap.tapName || tap.beverageName || `Tap ${tap.tapNumber}`,
  );
  const beverageName = tap.beverageName || (tap.title === "Mystery Tap" ? null : "Unassigned");
  optionalText(card.querySelector('[data-field="beverage-name"]'), beverageName);
  optionalText(card.querySelector('[data-field="style"]'), tap.style);
  optionalText(
    card.querySelector('[data-field="abv"]'),
    typeof tap.abv === "number" ? `${tap.abv}% ABV` : null,
  );
  optionalText(card.querySelector('[data-field="description"]'), tap.description);
  const forecast = tap.waitingForMeasurement
    ? "Waiting for measurement"
    : typeof tap.servingsRemaining === "number" || typeof tap.daysRemaining === "number"
      ? [
          typeof tap.servingsRemaining === "number" ? `${tap.servingsRemaining} servings` : null,
          typeof tap.daysRemaining === "number" ? `${tap.daysRemaining} days` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Measurement unavailable";
  text(card.querySelector('[data-field="forecast"]'), forecast);
  const svg = card.querySelector(".tap-graphic");
  if (svg) {
    applyGraphic(svg, tap);
    text(
      svg.querySelector("title"),
      `${tap.accessibleLabel || tap.title || tap.tapName || tap.beverageName || `Tap ${tap.tapNumber}`} fill level`,
    );
  }
  const storyLink = card.querySelector('[data-field="story-link"]');
  if (storyLink) {
    if (typeof tap.storyPath === "string" && tap.storyPath.startsWith("/taps/")) {
      storyLink.hidden = false;
      storyLink.setAttribute("href", tap.storyPath);
      storyLink.setAttribute("aria-label", tap.accessibleLabel || `${tap.title || "Tap"} story`);
    } else {
      storyLink.remove();
    }
  } else if (typeof tap.storyPath === "string" && tap.storyPath.startsWith("/taps/")) {
    const link = document.createElement("a");
    link.className = "story-link";
    link.dataset.field = "story-link";
    link.href = tap.storyPath;
    link.textContent = "Story";
    link.setAttribute("aria-label", tap.accessibleLabel || `${tap.title || "Tap"} story`);
    card.querySelector(".tap-copy")?.append(link);
  }
  patchUnits(card);
  grid.append(
    ...[...grid.children].sort(
      (left, right) => Number(left.dataset.tapNumber) - Number(right.dataset.tapNumber),
    ),
  );
  return card;
}

function patchOnDeck(items) {
  const list = document.querySelector("[data-on-deck] ul");
  if (!list) return;
  const children = items.map((item) => {
    const element = document.createElement("li");
    element.dataset.fillId = String(item.fillId);
    const name = document.createElement("strong");
    text(name, item.name);
    element.append(name);
    if (item.style) {
      const style = document.createElement("span");
      text(style, item.style);
      element.append(" — ", style);
    }
    return element;
  });
  list.replaceChildren(...children);
}

function patchHeader(header) {
  text(document.querySelector(".public-header h1"), header.tapboardName);
  text(document.querySelector("[data-connectivity-label]"), header.connectivityLabel);
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
  text(document.querySelector(".public-header h1"), shared.tapboardName);
  document.title = shared.tapboardName;
  for (const name of [
    "theme",
    "font",
    "accent",
    "unitSystem",
    "showServingTemperature",
    "layoutMode",
  ]) {
    element.dataset[`shared${name[0].toUpperCase()}${name.slice(1)}`] = String(shared[name]);
  }
  applyPreferences(readPreferences());
}

function reconcile(dashboard) {
  patchSharedDisplay(dashboard.sharedDisplay);
  patchHeader(dashboard.header);
  const present = new Set(dashboard.taps.map((tap) => String(tap.id)));
  for (const tap of dashboard.taps) patchTap(tap);
  for (const card of grid.querySelectorAll("[data-tap-id]"))
    if (!present.has(card.dataset.tapId)) card.remove();
  patchOnDeck(dashboard.onDeck.items);
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

const queue = createDirtyQueue(refresh);
const reconnectDirty = new Set();
const RECONNECT_DIRTY_LIMIT = 64;
const RECONNECT_RETRY_MS = 1500;
let reconnectReconciling = false;
let reconnectDirtyOverflow = false;
let reconnectPromise;

grid?.addEventListener("click", (event) => {
  const target = event.target;
  if (target === null || typeof target !== "object" || !("closest" in target)) return;
  if (target.closest("a,button,input,select,textarea,summary")) return;
  const card = target.closest("[data-tap-id]");
  const storyLink = card?.querySelector('[data-field="story-link"]');
  if (storyLink?.tagName === "A" && storyLink.getAttribute("href")) storyLink.click();
});

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
      else if (name === "display.updated") queueDirty("display");
      else queueDirty("header");
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
applyPreferences(readPreferences());
updateRotation();
