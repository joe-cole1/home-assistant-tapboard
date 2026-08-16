import { apply, fields, read, reset, write } from "/assets/js/display-preferences.js";

const form = document.querySelector("[data-display-preferences]");
const status = document.querySelector("[data-display-preference-status]");

function labelText(name) {
  return (
    {
      theme: "Theme",
      font: "Font",
      accent: "Accent",
      unitSystem: "Unit system",
      showServingTemperature: "Serving temperature",
      layoutMode: "Layout",
    }[name] ?? name
  );
}

if (form) {
  const current = read();
  for (const [name, options] of Object.entries(fields)) {
    const label = document.createElement("label");
    const select = document.createElement("select");
    select.name = name;
    select.add(new Option("Inherit shared default", ""));
    if (options === "boolean") {
      select.add(new Option("Show", "true"));
      select.add(new Option("Hide", "false"));
    } else {
      for (const option of options) select.add(new Option(option.replaceAll("_", " "), option));
    }
    select.value = current[name] === undefined ? "" : String(current[name]);
    label.append(labelText(name), select);
    form.append(label);
  }
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save this display";
  form.append(save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const overrides = {};
    for (const [name, options] of Object.entries(fields)) {
      const value = data.get(name);
      if (value !== "") overrides[name] = options === "boolean" ? value === "true" : value;
    }
    const persisted = write(overrides);
    if (status)
      status.textContent = persisted
        ? "This display was saved."
        : "Preferences were applied, but browser storage was unavailable.";
  });
}

document.querySelector("[data-reset-preferences]")?.addEventListener("click", () => {
  reset();
  if (form) for (const select of form.querySelectorAll("select")) select.value = "";
  if (status) status.textContent = "This display now inherits all shared defaults.";
});
apply(read());
