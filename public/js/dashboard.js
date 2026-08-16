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

function createGraphic(tap) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("tap-graphic");
  svg.setAttribute("viewBox", "0 0 270 250");
  svg.setAttribute("role", "img");
  svg.dataset.graphicId = String(tap.graphicId || "pint_glass");

  const title = document.createElementNS(SVG_NS, "title");
  svg.append(title);
  const definitions = document.createElementNS(SVG_NS, "defs");
  const clip = document.createElementNS(SVG_NS, "clipPath");
  const clipId = `fill-clip-${tap.id}`;
  clip.setAttribute("id", clipId);
  const clipShape = document.createElementNS(SVG_NS, "path");
  clipShape.setAttribute("d", "M58 45h154l-18 180H76z");
  clip.append(clipShape);
  definitions.append(clip);
  svg.append(definitions);
  const glass = document.createElementNS(SVG_NS, "path");
  glass.classList.add("glass");
  glass.setAttribute("d", "M58 45h154l-18 180H76z");
  svg.append(glass);
  const liquid = document.createElementNS(SVG_NS, "rect");
  liquid.classList.add("liquid");
  liquid.dataset.field = "fill-graphic";
  liquid.setAttribute("x", "58");
  liquid.setAttribute("width", "154");
  liquid.setAttribute("clip-path", `url(#${clipId})`);
  svg.append(liquid);
  const rim = document.createElementNS(SVG_NS, "path");
  rim.classList.add("rim");
  rim.setAttribute("d", "M58 45h154");
  svg.append(rim);
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
    tap.tapName || tap.beverageName || `Tap ${tap.tapNumber}`,
  );
  text(card.querySelector('[data-field="beverage-name"]'), tap.beverageName || "Unassigned");
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
    svg.dataset.graphicId = String(tap.graphicId || "pint_glass");
    text(
      svg.querySelector("title"),
      `${tap.tapName || tap.beverageName || `Tap ${tap.tapNumber}`} fill level`,
    );
  }
  const liquid = card.querySelector(".liquid");
  if (liquid) {
    liquid.dataset.fillPercent = String(percentage);
    liquid.setAttribute("y", String(225 - percentage * 1.8));
    liquid.setAttribute("height", String(percentage * 1.8));
    liquid.setAttribute("fill", tap.displayColor || "currentColor");
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
