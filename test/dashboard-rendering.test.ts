import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { PublicDashboardView, PublicTapCardView } from "../src/features/dashboard/types.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";

const hostile = '<script>alert(1)</script>" onmouseover="alert(2)';

function tap(id: number, enabled = true): PublicTapCardView & { readonly enabled?: boolean } {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    tapNumber: id,
    tapName: id === 1 ? hostile : `Tap ${id}`,
    graphicId: "pint_glass",
    displayColor: "#D97706",
    beverageName: id === 2 ? null : `Beverage ${id}`,
    style: id % 2 === 0 ? null : "Pale Ale",
    abv: id % 2 === 0 ? null : 5.2,
    metrics: id % 2 === 0 ? [] : [{ key: "abv", label: "ABV", value: "5.2%" }],
    description: id === 3 ? hostile : null,
    storyPath: id === 1 ? `/taps/${id}/story` : null,
    ...(id === 1 ? { accessibleLabel: `Tap ${id}, Beverage ${id}` } : {}),
    ...(id === 2 ? { accessibleLabel: `Tap ${id}, Empty Tap` } : {}),
    fillId: null,
    fillPercent: id * 10,
    remainingVolumeMl: id === 2 ? null : 10_000,
    capacityMl: id === 2 ? null : 19_000,
    servingsRemaining: id === 2 ? null : 28,
    daysRemaining: null,
    temperatureC: id === 2 ? null : 4,
    waitingForMeasurement: id === 2,
    health: "healthy",
    enabled,
  };
}

function dashboard(): PublicDashboardView {
  return {
    sharedDisplay: {
      revision: 1,
      tapboardName: hostile,
      theme: "modern_dark",
      font: "system",
      accent: "amber",
      unitSystem: "us",
      showServingTemperature: true,
      layoutMode: "scroll",
      remainingMode: "percent",
    },
    header: {
      tapboardName: hostile,
      connectivity: "healthy",
      connectivityLabel: "Connected",
    },
    taps: [tap(6), tap(1), tap(4), tap(2), tap(5), tap(3)].sort(
      (left, right) => left.tapNumber - right.tapNumber,
    ),
    onDeck: { items: [{ fillId: tap(9).id, name: hostile, style: "Porter" }] },
    ssePath: "/api/public/events",
  };
}

void test("public SSR is complete, ordered, null-safe, and escapes hostile text", () => {
  const html = createRenderer().render("/public/dashboard", { ...dashboard() });
  assert.match(html, /<!doctype html>/);
  assert.equal((html.match(/class="tap-card"/gu) ?? []).length, 6);
  assert.ok(html.indexOf('data-tap-number="1"') < html.indexOf('data-tap-number="6"'));
  assert.match(html, /Empty Tap/);
  assert.match(html, /href="\/taps\/1\/story"/u);
  assert.match(html, /data-tap-number="2"[^>]*aria-label="Tap 2, Empty Tap"/u);
  assert.match(html, /data-fill-percent="10"/u);
  assert.match(html, /data-remaining-volume-ml="10000"/u);
  assert.match(html, /data-capacity-ml="19000"/u);
  assert.match(html, /data-servings-remaining="28"/u);
  assert.match(html, /data-waiting-for-measurement="false"/u);
  assert.match(html, /data-waiting-for-measurement="true"/u);
  assert.doesNotMatch(html, /data-(?:remaining-volume-ml|capacity-ml|servings-remaining)="0"/u);
  assert.match(html, /class="public-brand" href="\/"/u);
  assert.equal((html.match(/class="tap-badges"/gu) ?? []).length, 6);
  assert.equal((html.match(/class="beer-bubble"/gu) ?? []).length, 144);
  assert.match(html, /data-field="forecast-servings"/u);
  assert.match(html, /data-field="forecast-days"/u);
  assert.match(html, /On Deck:/u);
  assert.match(html, /data-on-deck-toggle/gu);
  assert.match(html, /<\/strong> — <span>Porter<\/span>/u);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
  assert.doesNotMatch(html, /onmouseover="alert\(2\)"/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /IBU: N\/A/u);
  assert.doesNotMatch(html, /Story/u);
});

void test("public dashboard DTO contains no privileged integration or telemetry shape", () => {
  const serialized = JSON.stringify(dashboard());
  for (const forbidden of [
    "apiKey",
    "secret",
    "sessionId",
    "actorId",
    "sourceId",
    "measurementId",
    "rawPayload",
    "maintenanceNotes",
    "brewfatherSnapshot",
    "mystery",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

void test("live Mystery patches refresh the SVG accessible name from the incoming public DTO", async () => {
  const source = await readFile(new URL("../public/js/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function patchTap(tap)");
  const end = source.indexOf("const pourTimers", start);
  assert.ok(start >= 0 && end > start);
  const patch = source.slice(start, end);
  const labelStart = source.indexOf("function publicTapLabel");
  const labelEnd = source.indexOf("function isStoryCard", labelStart);
  assert.ok(labelStart >= 0 && labelEnd > labelStart);
  const labelHelper = source.slice(labelStart, labelEnd);

  assert.match(
    labelHelper,
    /return tap\.accessibleLabel \|\| tap\.title \|\| tap\.beverageName \|\| `Tap \$\{tap\.tapNumber\}`;/u,
  );
  assert.doesNotMatch(labelHelper, /tap\.(?:id|tapName)/u);
  assert.match(patch, /const graphicLabel = `\$\{publicTapLabel\(tap\)\} fill level`;/u);
  assert.match(
    patch,
    /applyGraphic\(svg, tap\);\s*svg\.setAttribute\("aria-label", graphicLabel\);\s*text\(svg\.querySelector\("title"\), graphicLabel\);/u,
  );
  assert.doesNotMatch(patch, /svg\.getAttribute\("aria-label"\)/u);
});

void test("live header patches preserve the public brand while updating nested connectivity text", async () => {
  const source = await readFile(new URL("../public/js/dashboard.js", import.meta.url), "utf8");
  const start = source.indexOf("function patchHeader(header)");
  const end = source.indexOf("function patchSharedDisplay", start);
  assert.ok(start >= 0 && end > start);
  const patch = source.slice(start, end);

  assert.match(
    patch,
    /text\(document\.querySelector\("\.public-brand"\), header\.tapboardName\);/u,
  );
  assert.match(
    patch,
    /text\(\s*document\.querySelector\("\.public-header \[data-connectivity-label\]"\),\s*header\.connectivityLabel,?\s*\);/u,
  );
  assert.doesNotMatch(patch, /querySelector\("\[data-connectivity-label\]"\)/u);
  assert.doesNotMatch(patch, /replaceChildren|innerHTML/u);
});

void test("Admin shell exposes all independently reachable navigation seams", () => {
  const html = createRenderer().render("/admin/overview", {
    page: { title: "Overview", path: "/admin/overview", csrfToken: "safe" },
    navItems: [
      "overview",
      "integrations",
      "beverages",
      "kegs",
      "fills",
      "taps",
      "tap-wars",
      "display",
      "system",
    ].map((name) => ({ label: name, href: `/admin/${name}` })),
    metrics: [],
    taps: [],
    health: [],
    connectivity: { state: "healthy", label: "Connected" },
    integrations: {
      telemetryConfigured: 0,
      brewfatherConfigured: false,
      brewfatherEnabled: false,
      brewfatherApiKeyConfigured: false,
      brewfatherLinkedBeverages: 0,
    },
  });
  for (const route of [
    "overview",
    "integrations",
    "beverages",
    "kegs",
    "fills",
    "taps",
    "tap-wars",
    "display",
    "system",
  ]) {
    assert.match(html, new RegExp(`href="/admin/${route}"`, "u"));
  }
  assert.match(html, /aria-current="page"/u);
  assert.match(html, /Skip to content/u);
  assert.match(html, /Connectivity and integrations/u);
  assert.match(html, /Health summary/u);
});
