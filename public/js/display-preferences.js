export const KEY = "tapboard.v2.display-preferences.v1";
export const fields = Object.freeze({
  theme: Object.freeze(["modern_dark", "warm_pub", "cyberpunk", "light_minimal"]),
  font: Object.freeze([
    "system",
    "outfit",
    "inter",
    "roboto",
    "fredoka",
    "montserrat",
    "barlow_condensed",
    "bree_serif",
    "bungee",
    "rye",
    "special_elite",
  ]),
  accent: Object.freeze(["amber", "sky", "rose", "cyan", "tan", "orange", "blue"]),
  unitSystem: Object.freeze(["us", "metric"]),
  showServingTemperature: "boolean",
  layoutMode: Object.freeze(["scroll", "rotation"]),
});

const CUSTOM_ACCENT = /^#[0-9a-f]{6}$/u;

function validFieldValue(name, contract, candidate) {
  if (name === "accent")
    return (
      typeof candidate === "string" &&
      (contract.includes(candidate) || CUSTOM_ACCENT.test(candidate))
    );
  if (Array.isArray(contract)) return contract.includes(candidate);
  return contract === "boolean" && typeof candidate === "boolean";
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateOverrides(value) {
  if (!isPlainRecord(value)) return undefined;
  const result = {};
  for (const [key, candidate] of Object.entries(value)) {
    const contract = fields[key];
    if (contract === undefined) return undefined;
    if (candidate === null) continue;
    if (!validFieldValue(key, contract, candidate)) return undefined;
    result[key] = candidate;
  }
  return result;
}

export function read() {
  try {
    const serialized = localStorage.getItem(KEY);
    if (serialized === null || serialized.length > 2048) return {};
    const record = JSON.parse(serialized);
    if (
      !isPlainRecord(record) ||
      record.version !== 1 ||
      Object.keys(record).some((key) => key !== "version" && key !== "overrides")
    )
      return {};
    return validateOverrides(record.overrides) ?? {};
  } catch {
    return {};
  }
}

function sharedDatasetKey(key) {
  return `shared${key[0].toUpperCase()}${key.slice(1)}`;
}

export function stylesheetHref(values = {}) {
  const existing = document.querySelector("[data-display-stylesheet]");
  let existingParams;
  if (existing instanceof HTMLLinkElement) {
    try {
      existingParams = new URL(existing.href, document.baseURI).searchParams;
    } catch {
      existingParams = undefined;
    }
  }
  const readValue = (name) => {
    const candidate =
      values[name] ??
      document.documentElement.dataset[name] ??
      document.documentElement.dataset[sharedDatasetKey(name)];
    if (typeof candidate === "string") return candidate;
    return existingParams?.get(name) ?? "";
  };
  const theme = readValue("theme");
  const accent = readValue("accent");
  const font = readValue("font");
  if (!theme || !accent || !font) return undefined;
  return `/assets/css/display.css?v=1&theme=${encodeURIComponent(theme)}&accent=${encodeURIComponent(accent)}&font=${encodeURIComponent(font)}`;
}

export function syncStylesheet(values = {}) {
  const link = document.querySelector("[data-display-stylesheet]");
  const href = stylesheetHref(values);
  if (
    link instanceof HTMLLinkElement &&
    href !== undefined &&
    link.href !== new URL(href, document.baseURI).href
  ) {
    link.href = href;
  }
}

export function apply(overrides = read()) {
  const valid = validateOverrides(overrides) ?? {};
  for (const key of Object.keys(fields)) {
    const inherited = document.documentElement.dataset[sharedDatasetKey(key)];
    const value = Object.hasOwn(valid, key) ? valid[key] : inherited;
    if (value === undefined) delete document.documentElement.dataset[key];
    else document.documentElement.dataset[key] = String(value);
  }
  syncStylesheet(valid);
  document.dispatchEvent(new CustomEvent("tapboard:display-preferences", { detail: valid }));
}

export function write(overrides) {
  const valid = validateOverrides(overrides);
  if (valid === undefined) return false;
  const serialized = JSON.stringify({ version: 1, overrides: valid });
  if (serialized.length > 2048) return false;
  let persisted = false;
  try {
    localStorage.setItem(KEY, serialized);
    persisted = true;
  } catch {
    // A denied or full storage area must not break the display.
  }
  apply(valid);
  return persisted;
}

export function reset() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Shared defaults remain available when storage is denied.
  }
  apply({});
}

window.addEventListener("storage", (event) => {
  if (event.key === KEY) apply(read());
});
