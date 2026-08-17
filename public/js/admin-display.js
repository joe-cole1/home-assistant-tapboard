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
const preview = document.querySelector("[data-display-preview]");
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

apply(read());
