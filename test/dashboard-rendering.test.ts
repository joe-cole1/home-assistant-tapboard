import assert from "node:assert/strict";
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
    description: id === 3 ? hostile : null,
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
    },
    header: {
      tapboardName: hostile,
      connectivity: "healthy",
      connectivityLabel: "Tapboard is connected.",
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
  assert.match(html, /Unassigned/);
  assert.match(html, /On deck/iu);
  assert.match(html, /<\/strong> — <span>Porter<\/span>/u);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
  assert.doesNotMatch(html, /onmouseover="alert\(2\)"/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /IBU: N\/A/u);
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
});
