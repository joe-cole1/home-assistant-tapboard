import assert from "node:assert/strict";
import test from "node:test";

import {
  contrastRatio,
  displayFontFiles,
  displayStylesheetHref,
  generateDisplayStylesheet,
  resolveDisplayPaletteRoles,
  validateStylesheetParams,
} from "../src/features/display/palette.ts";
import {
  DISPLAY_ACCENTS,
  DISPLAY_THEMES,
  type DisplayFont,
} from "../src/features/display/types.ts";

void test("display stylesheet params accept only bounded themes, accents, and preview fonts", () => {
  assert.deepEqual(validateStylesheetParams("light_minimal", "#abcdef", "all"), {
    theme: "light_minimal",
    accent: "#abcdef",
    font: "all",
  });
  assert.equal(validateStylesheetParams("light_minimal", "#ABCDEF", "system"), undefined);
  assert.equal(validateStylesheetParams("unknown", "amber", "system"), undefined);
  assert.equal(validateStylesheetParams("light_minimal", "amber", "comic-sans"), undefined);
  assert.equal(
    displayStylesheetHref("light_minimal", "#abcdef", "system"),
    "/assets/css/display.css?v=1&theme=light_minimal&accent=%23abcdef&font=system",
  );
});

void test("display stylesheet output is deterministic, same-origin, and font-selective", () => {
  const selected = generateDisplayStylesheet("modern_dark", "#777777", "outfit");
  const selectedAgain = generateDisplayStylesheet("modern_dark", "#777777", "outfit");
  assert.equal(selected.css, selectedAgain.css);
  assert.equal(selected.etag, selectedAgain.etag);
  assert.match(selected.css, /@font-face/u);
  assert.match(selected.css, /assets\/fonts\/outfit-[0-9a-f]+\.woff2/u);
  for (const font of Object.keys(displayFontFiles).filter((font) => font !== "outfit")) {
    assert.doesNotMatch(selected.css, new RegExp(`assets/fonts/${font}-`, "u"));
  }
  assert.doesNotMatch(selected.css, /https?:/u);
  assert.match(selected.css, /--on-accent:/u);
  assert.match(selected.css, /--accent-readable:#[0-9a-f]{6}/u);
  assert.doesNotMatch(selected.css, /color-mix\(/u);
  assert.ok(contrastRatio("#777777", "#ffffff") >= 3 || contrastRatio("#777777", "#000000") >= 3);

  const all = generateDisplayStylesheet("light_minimal", "amber", "all");
  for (const font of Object.keys(displayFontFiles)) {
    assert.match(all.css, new RegExp(`assets/fonts/${font}-[0-9a-f]+\\.woff2`, "u"));
    assert.ok(all.css.includes(`data-preview-font="${font}"`));
  }

  for (const font of Object.keys(displayFontFiles) as Array<Exclude<DisplayFont, "system">>) {
    const css = generateDisplayStylesheet("modern_dark", "amber", font).css;
    assert.match(css, new RegExp(`assets/fonts/${font}-[0-9a-f]+\\.woff2`, "u"));
    for (const other of Object.keys(displayFontFiles).filter((candidate) => candidate !== font)) {
      assert.doesNotMatch(css, new RegExp(`assets/fonts/${other}-`, "u"));
    }
  }

  assert.match(
    generateDisplayStylesheet("modern_dark", "amber", "bungee").css,
    /font-weight:400;/u,
  );
});

void test("all theme accent combinations receive concrete accessible palette roles", () => {
  const accents = [...DISPLAY_ACCENTS, "#000000", "#ffffff", "#808080", "#fbc02d"] as const;
  const surfaces: Record<string, readonly [string, string]> = {
    modern_dark: ["#0b0f19", "#111827"],
    warm_pub: ["#1c0a00", "#2d1204"],
    cyberpunk: ["#0d0221", "#19053b"],
    light_minimal: ["#f8fafc", "#ffffff"],
  };
  for (const theme of DISPLAY_THEMES) {
    for (const accent of accents) {
      const roles = resolveDisplayPaletteRoles(theme, accent);
      assert.ok(contrastRatio(roles.onAccent, roles.accent) >= 4.5, `${theme}/${accent} on-accent`);
      assert.ok(
        contrastRatio(roles.onAccentHover, roles.accentHover) >= 4.5,
        `${theme}/${accent} hover text`,
      );
      assert.notEqual(roles.accentHover, roles.accent, `${theme}/${accent} hover shift`);
      for (const surface of surfaces[theme]!) {
        assert.ok(
          contrastRatio(roles.accentReadable, surface) >= 4.5,
          `${theme}/${accent} readable`,
        );
        assert.ok(contrastRatio(roles.accentStrong, surface) >= 3, `${theme}/${accent} strong`);
        assert.ok(contrastRatio(roles.accentHover, surface) >= 3, `${theme}/${accent} hover`);
      }
      const css = generateDisplayStylesheet(theme, accent, "system").css;
      assert.doesNotMatch(css, /color-mix\(/u);
      assert.match(css, /--accent-hover:#[0-9a-f]{6}/u);
    }
  }
});

void test("theme body, muted, and secondary roles are readable on both surfaces", () => {
  const surfaces: Record<string, readonly [string, string]> = {
    modern_dark: ["#0b0f19", "#111827"],
    warm_pub: ["#1c0a00", "#2d1204"],
    cyberpunk: ["#0d0221", "#19053b"],
    light_minimal: ["#f8fafc", "#ffffff"],
  };
  const variable = (css: string, name: string): string => {
    const match = css.match(new RegExp(`${name}:([^;}]*)`, "u"));
    assert.ok(match?.[1], `missing ${name}`);
    return match[1].trim();
  };
  for (const theme of DISPLAY_THEMES) {
    const css = generateDisplayStylesheet(theme, "amber", "system").css;
    for (const name of ["--text", "--muted", "--secondary"]) {
      const color = variable(css, name);
      for (const surface of surfaces[theme]!) {
        assert.ok(contrastRatio(color, surface) >= 4.5, `${theme}/${name} against ${surface}`);
      }
    }
  }
  assert.match(generateDisplayStylesheet("cyberpunk", "amber", "system").css, /--muted:#c52cff/u);
});
