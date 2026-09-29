import {
  apply,
  fields,
  read,
  reset,
  syncStylesheet,
  validateOverrides,
  write,
} from "/assets/js/display-preferences.js";

const form = document.querySelector("[data-display-preferences]");
const status = document.querySelector("[data-display-preference-status]");
const sharedForm = document.querySelector("[data-shared-display-form]");
const preview = document.querySelector("[data-display-preview], .display-preview");
const labels = {
  theme: "Theme",
  font: "Font",
  accent: "Accent",
  unitSystem: "Unit system",
  showServingTemperature: "Serving temperature",
  layoutMode: "Layout",
};
const humanize = (value) =>
  value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());

function setStatus(message) {
  if (status) status.textContent = message;
}

function accentHex(value) {
  const named = {
    amber: "#fbc02d",
    sky: "#38bdf8",
    rose: "#fb7185",
    cyan: "#00f0ff",
    tan: "#c5a880",
    orange: "#d97706",
    blue: "#2563eb",
  };
  return /^#[0-9a-f]{6}$/u.test(value) ? value : (named[value] ?? "#fbc02d");
}

function addAccentPicker(target, name, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "display-accent-picker";
  const text = document.createElement("input");
  text.type = "text";
  text.name = name;
  text.value = value;
  text.pattern = "#[0-9a-f]{6}|amber|sky|rose|cyan|tan|orange|blue";
  text.maxLength = 7;
  text.autocomplete = "off";
  text.dataset.accentValue = "true";
  const color = document.createElement("input");
  color.type = "color";
  color.value = accentHex(value);
  color.title = "Choose a custom accent color";
  color.setAttribute("aria-label", "Custom accent color");
  color.dataset.accentColor = "true";
  const swatches = document.createElement("div");
  swatches.className = "display-accent-swatches";
  for (const option of fields.accent) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `display-accent-swatch display-accent-swatch--${option}`;
    button.dataset.accentPreset = option;
    button.title = humanize(option);
    button.setAttribute("aria-label", humanize(option));
    button.addEventListener("click", () => {
      text.value = option;
      color.value = accentHex(option);
      text.dispatchEvent(new Event("change", { bubbles: true }));
    });
    swatches.append(button);
  }
  color.addEventListener("input", () => {
    text.value = color.value.toLowerCase();
    text.dispatchEvent(new Event("change", { bubbles: true }));
  });
  text.addEventListener("change", () => {
    const valueNow = text.value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/u.test(valueNow) || fields.accent.includes(valueNow))
      color.value = accentHex(valueNow);
  });
  wrapper.append(text, color, swatches);
  target.append(wrapper);
}

function syncPreviewFromForm() {
  if (!(sharedForm instanceof HTMLFormElement)) return;
  const data = new FormData(sharedForm);
  const values = {
    theme: String(data.get("theme") ?? "modern_dark"),
    accent: String(data.get("accent") ?? "amber"),
    font: "all",
  };
  if (preview instanceof HTMLElement) {
    preview.dataset.previewTheme = values.theme;
    preview.dataset.previewAccent = values.accent;
    preview.dataset.previewFont = String(data.get("font") ?? "system");
  }
  syncStylesheet(values);
}

if (sharedForm instanceof HTMLFormElement) {
  const accent = sharedForm.querySelector('[name="accent"]');
  const color = sharedForm.querySelector("[data-accent-color]");
  if (accent instanceof HTMLInputElement && color instanceof HTMLInputElement) {
    color.value = accentHex(accent.value);
    for (const button of sharedForm.querySelectorAll("[data-accent-preset]")) {
      button.addEventListener("click", () => {
        const value = button.getAttribute("data-accent-preset") ?? "amber";
        accent.value = value;
        color.value = accentHex(value);
        syncPreviewFromForm();
      });
    }
  }
  sharedForm.addEventListener("input", syncPreviewFromForm);
  sharedForm.addEventListener("change", syncPreviewFromForm);
  syncPreviewFromForm();
}

function readFormOverrides() {
  if (!(form instanceof HTMLFormElement)) return {};
  const data = new FormData(form);
  const overrides = {};
  for (const [name, contract] of Object.entries(fields)) {
    if (contract === "boolean") {
      const control = form.querySelector(`[name="${name}"]`);
      if (control instanceof HTMLInputElement && !control.indeterminate)
        overrides[name] = control.checked;
      continue;
    }
    const value = data.get(name);
    if (value === null || value === "") continue;
    overrides[name] = contract === "boolean" ? value === "true" : String(value);
  }
  return overrides;
}

function commitLocal() {
  const overrides = readFormOverrides();
  if (validateOverrides(overrides) === undefined) {
    setStatus("Accent must be a named accent or lowercase #rrggbb.");
    return;
  }
  const persisted = write(overrides);
  setStatus(
    persisted
      ? "This display saved locally."
      : "Applied for this visit; browser storage is unavailable.",
  );
}

if (form instanceof HTMLFormElement) {
  const current = read();
  for (const [name, contract] of Object.entries(fields)) {
    const label = document.createElement("label");
    label.textContent = labels[name] ?? name;
    if (name === "accent") {
      addAccentPicker(label, name, current[name] ?? "");
    } else if (contract === "boolean") {
      const switchLabel = document.createElement("span");
      switchLabel.className = "switch-control";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = name;
      checkbox.value = "true";
      checkbox.checked = current[name] === true;
      checkbox.indeterminate = current[name] === undefined;
      checkbox.dataset.inherit = "true";
      switchLabel.append(checkbox, document.createElement("span"));
      label.append(switchLabel);
      checkbox.addEventListener("change", () => {
        checkbox.indeterminate = false;
        commitLocal();
      });
    } else {
      const select = document.createElement("select");
      select.name = name;
      select.add(new Option("Inherit shared default", ""));
      for (const option of contract) select.add(new Option(humanize(option), option));
      select.value = current[name] === undefined ? "" : String(current[name]);
      label.append(select);
      select.addEventListener("change", commitLocal);
    }
    form.append(label);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    commitLocal();
  });
  form.querySelector('[name="accent"]')?.addEventListener("change", commitLocal);
}

document.querySelector("[data-reset-preferences]")?.addEventListener("click", () => {
  reset();
  if (form instanceof HTMLFormElement) {
    for (const control of form.querySelectorAll("select")) control.value = "";
    for (const control of form.querySelectorAll('input[type="checkbox"]')) {
      control.checked = false;
      control.indeterminate = true;
    }
    const accent = form.querySelector('[name="accent"]');
    if (accent instanceof HTMLInputElement) accent.value = "";
  }
  setStatus("This display now inherits all shared defaults.");
});

const metricNames = {
  abv: ["showAbv", "ABV"],
  ibu: ["showIbu", "IBU"],
  og: ["showOg", "OG"],
  fg: ["showFg", "FG"],
  srm: ["showSrm", "SRM"],
};

function metricEnabled(control) {
  if (control instanceof HTMLInputElement) return control.checked;
  if (!(control instanceof HTMLElement) || control.tagName !== "SELECT") return false;
  if (control.value === "show") return true;
  if (control.value === "hide") return false;
  return control.dataset.inheritedValue === "true";
}

function syncTapCardPreview() {
  const card = document.querySelector(
    "[data-display-preview] .tap-card, .display-preview .tap-card",
  );
  if (!(card instanceof HTMLElement)) return;
  const metricForm =
    document.querySelector('form[action="/admin/display/tap-card"]') ??
    document.querySelector('form[action$="/display"]');
  const styleLine = card.querySelector('[data-field="style-line"]');
  const metrics = card.querySelector('[data-field="metrics"]');
  if (metricForm instanceof HTMLFormElement) {
    const abvControl = metricForm.querySelector('[name="showAbv"]');
    const abv = metricEnabled(abvControl) ? card.dataset.previewMetricAbv : undefined;
    if (styleLine instanceof HTMLElement) {
      styleLine.textContent = [abv, styleLine.dataset.previewStyle].filter(Boolean).join(" · ");
      styleLine.hidden = styleLine.textContent === "";
    }
    if (metrics instanceof HTMLElement) {
      const rows = [];
      for (const key of ["ibu", "og", "fg", "srm"]) {
        const [name, label] = metricNames[key];
        const value = card.dataset[`previewMetric${key[0].toUpperCase()}${key.slice(1)}`];
        if (!value || !metricEnabled(metricForm.querySelector(`[name="${name}"]`))) continue;
        const row = document.createElement("div");
        row.dataset.metricKey = key;
        const term = document.createElement("dt");
        term.textContent = label;
        const detail = document.createElement("dd");
        detail.textContent = value;
        row.append(term, detail);
        rows.push(row);
      }
      metrics.replaceChildren(...rows);
      metrics.hidden = rows.length === 0;
    }
  }
  const shared = document.querySelector("[data-shared-display-form]");
  const remaining =
    metricForm instanceof HTMLFormElement
      ? metricForm.querySelector('[name="remainingMode"]')
      : null;
  const unit = shared?.querySelector('[name="unitSystem"]');
  const previewUnit =
    unit instanceof HTMLElement &&
    unit.tagName === "SELECT" &&
    ["us", "metric"].includes(unit.value)
      ? unit.value
      : preview instanceof HTMLElement
        ? preview.dataset.previewUnitSystem
        : undefined;
  const temperatureToggle = shared?.querySelector('[name="showServingTemperature"]');
  const previewShowsTemperature =
    temperatureToggle instanceof HTMLInputElement
      ? temperatureToggle.checked
      : preview instanceof HTMLElement
        ? preview.dataset.previewShowServingTemperature !== "false"
        : true;
  if (preview instanceof HTMLElement) {
    if (previewUnit === "us" || previewUnit === "metric")
      preview.dataset.previewUnitSystem = previewUnit;
    preview.dataset.previewShowServingTemperature = String(previewShowsTemperature);
  }
  const mode =
    remaining instanceof HTMLElement && remaining.tagName === "SELECT" ? remaining.value : null;
  const readout = card.querySelector('[data-field="remaining-readout"]');
  if (mode && readout) {
    const remainingMl = Number(card.dataset.remainingVolumeMl);
    const capacityMl = Number(card.dataset.capacityMl);
    const servings = Number(card.dataset.servingsRemaining);
    const percent = Number(card.dataset.fillPercent);
    const waiting = card.dataset.waitingForMeasurement === "true";
    if (waiting) readout.textContent = "Waiting for measurement";
    else if (mode === "percent" && Number.isFinite(percent))
      readout.textContent = `${Math.round(percent)}% remaining`;
    else if (mode === "pints" && Number.isFinite(remainingMl))
      readout.textContent = `${(remainingMl / 473.176473).toFixed(1)} pints remaining`;
    else if (mode === "pours" && Number.isFinite(servings))
      readout.textContent = `${Math.max(0, Math.floor(servings))} pours remaining`;
    else if (mode === "volume" && Number.isFinite(remainingMl) && Number.isFinite(capacityMl)) {
      const metric = previewUnit === "metric";
      const divisor = metric ? 1000 : 3785.411784;
      const suffix = metric ? " L" : " gal";
      readout.textContent = `${(remainingMl / divisor).toFixed(1)}${suffix} / ${(capacityMl / divisor).toFixed(1)}${suffix}`;
    } else readout.textContent = "Measurement unavailable";
  }
  const temperature = card.querySelector('[data-field="temperature"]');
  if (temperature instanceof HTMLElement) {
    const hasTemperature = Number.isFinite(Number(card.dataset.temperatureC));
    temperature.hidden = !hasTemperature || !previewShowsTemperature;
  }
}

for (const previewForm of document.querySelectorAll(
  'form[action="/admin/display/tap-card"], form[action$="/display"], [data-shared-display-form]',
)) {
  previewForm.addEventListener("input", syncTapCardPreview);
  previewForm.addEventListener("change", syncTapCardPreview);
}
document.addEventListener("tapboard:autosave-values-applied", () => {
  syncPreviewFromForm();
  syncTapCardPreview();
});
syncTapCardPreview();

if (form instanceof HTMLFormElement && !(preview instanceof HTMLElement)) apply(read());
