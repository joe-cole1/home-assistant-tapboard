(() => {
  "use strict";
  const key = "tapboard.v2.display-preferences.v1";
  const fields = {
    theme: ["modern_dark", "warm_pub", "cyberpunk", "light_minimal"],
    font: ["system", "outfit", "inter", "roboto", "fredoka", "montserrat"],
    accent: ["amber", "sky", "rose", "cyan", "tan", "orange", "blue"],
    unitSystem: ["us", "metric"],
    showServingTemperature: "boolean",
    layoutMode: ["scroll", "rotation"],
  };
  try {
    const serialized = localStorage.getItem(key);
    if (serialized === null || serialized.length > 2048) return;
    const record = JSON.parse(serialized);
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.version !== 1
    )
      return;
    if (Object.keys(record).some((name) => name !== "version" && name !== "overrides")) return;
    const overrides = record.overrides;
    if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) return;
    for (const [name, value] of Object.entries(overrides)) {
      const contract = fields[name];
      if (
        contract === undefined ||
        (value !== null &&
          (Array.isArray(contract) ? !contract.includes(value) : typeof value !== "boolean"))
      )
        return;
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value !== null) document.documentElement.dataset[name] = String(value);
    }
  } catch {
    // Server-rendered defaults remain authoritative.
  }
})();
