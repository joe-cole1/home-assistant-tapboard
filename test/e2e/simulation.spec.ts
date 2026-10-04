/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type { SimulationStatus } from "../../src/features/simulation/ui-types.ts";
import type { PublicDashboardView } from "../../src/features/dashboard/types.ts";

test("simulation workspace: actual live pour, pause, persistent exit/reentry, reset and mobile layout", async ({
  page,
  context,
}) => {
  test.setTimeout(65_000);
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(page).toHaveURL(/\/admin\/overview/u);
  await page.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { theme: "warm_pub" } }),
    );
    localStorage.setItem(
      "tapboard.v2.simulation.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { theme: "cyberpunk" } }),
    );
  });
  await page.goto("/admin/system");
  await page.getByRole("switch", { name: "Enable simulation" }).click();
  await expect(page).toHaveURL(/\/admin\/simulator/u);
  await expect(page.locator("[data-simulation-sensor]")).toHaveCount(5);
  const sensor = page.locator("[data-simulation-sensor]").first();
  await expect(sensor.locator("[data-sensor-status-label]")).toHaveText("Ready", {
    timeout: 10_000,
  });
  const noise = sensor.getByRole("switch", { name: "Reading noise for tap 1" });
  await expect(noise).toHaveText("Noise off");
  await noise.click();
  await expect(noise).toHaveAttribute("aria-checked", "true");
  await expect(noise).toHaveText("Noise on");
  await noise.click();
  await expect(noise).toHaveAttribute("aria-checked", "false");
  const initial = (await (
    await context.request.get("/api/admin/simulation")
  ).json()) as SimulationStatus;
  const first = initial.sensors[0]!;
  const display = await context.newPage();
  await display.goto("/");
  await expect(display.locator(".workspace-banner")).toContainText("SIMULATION");
  await expect(display.locator("html")).toHaveAttribute("data-theme", "cyberpunk");
  const before = (await (
    await context.request.get("/api/public/dashboard")
  ).json()) as PublicDashboardView;
  expect(before.taps.map((tap) => tap.beverageName)).toEqual([
    "Oktoberfest",
    "Saison",
    "Porter",
    "IPA",
    "Bourbon Barrel Stout",
  ]);
  expect(before.onDeck.items.map((fill) => fill.name)).toEqual(["Hefeweizen", "Spiced Lager"]);
  const barrelStory = before.taps[4]!.storyPath;
  if (!barrelStory) throw new Error("Missing history sample Story.");
  const story = await context.newPage();
  await story.goto(barrelStory);
  await expect(story.locator("[data-sensory-axis]")).toHaveCount(8);
  await expect(story.getByText("Bourbon barrel-aged", { exact: true })).toBeVisible();
  await story.close();
  await sensor.getByRole("button", { name: "Pour 12 US fl oz from tap 1", exact: true }).click();
  await expect(sensor.locator("[data-sensor-status-label]")).toHaveText("Pouring");
  await expect
    .poll(
      async () => {
        const state = (await (
          await context.request.get("/api/admin/simulation")
        ).json()) as SimulationStatus;
        return state.sensors[0]!.remainingMl;
      },
      { timeout: 12_000 },
    )
    .toBeCloseTo(first.remainingMl - 12 * 29.5735295625, 2);
  await expect(sensor.locator("[data-sensor-status-label]")).toHaveText("Ready", {
    timeout: 20_000,
  });
  const after = (await (
    await context.request.get("/api/public/dashboard")
  ).json()) as PublicDashboardView;
  const beforeVolume = before.taps.find((tap) => tap.id === first.tapId)!.remainingVolumeMl!;
  const afterVolume = after.taps.find((tap) => tap.id === first.tapId)!.remainingVolumeMl!;
  expect(beforeVolume - afterVolume).toBeCloseTo(12 * 29.5735295625, 0);
  await display.bringToFront();
  await expect
    .poll(async () =>
      Number(
        await display
          .locator(`[data-tap-id="${first.tapId}"]`)
          .getAttribute("data-remaining-volume-ml"),
      ),
    )
    .toBeCloseTo(first.remainingMl - 12 * 29.5735295625, 0);
  await page.bringToFront();
  // Sample inventory uses the ordinary Keg Room workflow.
  await page.goto("/admin/keg-room");
  await expect(page.getByRole("heading", { name: "Keg Room", exact: true })).toBeVisible();
  await page.goto("/admin/simulator");
  await page
    .locator("[data-simulation-sensor]")
    .first()
    .getByRole("button", { name: "Pause sensor" })
    .click();
  await expect(
    page.locator("[data-simulation-sensor]").first().getByRole("button", { name: "Bring online" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("simulator-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-admin-sidebar]")).not.toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath("simulator-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Exit simulation" }).click();
  await expect(page).toHaveURL(/\/admin\/system/u);
  await display.bringToFront();
  await expect(display.locator(".workspace-banner")).toHaveCount(0, { timeout: 8000 });
  await expect(display.locator("html")).toHaveAttribute("data-theme", "warm_pub");
  await page.bringToFront();
  await page.getByRole("switch", { name: "Enable simulation" }).click();
  await expect(page).toHaveURL(/\/admin\/simulator/u);
  const resumed = (await (
    await context.request.get("/api/admin/simulation")
  ).json()) as SimulationStatus;
  expect(resumed.sensors[0]!.tapId).toBe(first.tapId);
  expect(resumed.sensors[0]!.online).toBe(false);
  expect(resumed.sensors[0]!.remainingMl).toBeCloseTo(first.remainingMl - 12 * 29.5735295625, 2);
  await page
    .getByRole("checkbox", { name: "I want to replace my simulation and its history." })
    .check();
  await page.getByRole("button", { name: "Reset simulation", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("reset");
  const reset = (await (
    await context.request.get("/api/admin/simulation")
  ).json()) as SimulationStatus;
  expect(reset.sensors[0]!.tapId).not.toBe(first.tapId);
  expect(reset.sensors[0]!.online).toBe(true);
  await page.getByRole("button", { name: "Exit simulation" }).click();
  await display.close();
});

test("simulation controls work with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.goto("/admin/system");
    const toggle = page.getByRole("switch", { name: "Enable simulation" });
    if ((await toggle.getAttribute("aria-checked")) === "true") {
      await toggle.click();
      await page.getByRole("switch", { name: "Enable simulation" }).click();
    } else await toggle.click();
    await expect(page.getByRole("heading", { name: "Simulator", exact: true })).toBeVisible();
    const sensor = page.locator("[data-simulation-sensor]").first();
    await sensor.getByRole("button", { name: "Pause sensor" }).click();
    await expect(
      page
        .locator("[data-simulation-sensor]")
        .first()
        .getByRole("button", { name: "Bring online" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Exit simulation" }).click();
    await expect(page).toHaveURL(/\/admin\/system/u);
  } finally {
    await context.close();
  }
});

for (const javaScriptEnabled of [true, false]) {
  test(`public simulation layout fits desktop and tablet with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, async ({
    page,
    browser,
  }) => {
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
    await expect(page).toHaveURL(/\/admin\/overview/u);
    await page.goto("/admin/system");
    await page.getByRole("switch", { name: "Enable simulation" }).click();
    await expect(page).toHaveURL(/\/admin\/simulator/u);
    const displayContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      javaScriptEnabled,
    });
    try {
      const display = await displayContext.newPage();
      for (const viewport of [
        { width: 800, height: 900 },
        { width: 1280, height: 720 },
        { width: 1911, height: 910 },
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 },
      ]) {
        await display.setViewportSize(viewport);
        await display.goto("/");
        await expect(display.locator(".workspace-banner")).toContainText("SIMULATION");
        await expect(display.locator(".tap-grid > .tap-card")).toHaveCount(5);
        const layout = await display.evaluate(() => {
          const bounds = (selector: string) => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
          };
          return {
            banner: bounds(".workspace-banner"),
            header: bounds(".public-header"),
            main: bounds("main[data-dashboard]"),
            grid: bounds(".tap-grid"),
            onDeck: bounds(".on-deck"),
            cards: [...document.querySelectorAll(".tap-grid > .tap-card")].map((card) => {
              const rect = card.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
            }),
            scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            scrollHeight: Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
            ),
          };
        });
        const label = `${viewport.width}x${viewport.height}`;
        expect(layout.banner.top, label).toBeGreaterThanOrEqual(0);
        expect(layout.banner.bottom, label).toBeLessThanOrEqual(layout.header.top + 1);
        expect(layout.header.bottom, label).toBeLessThanOrEqual(layout.main.top + 1);
        expect(layout.header.bottom, label).toBeLessThanOrEqual(layout.grid.top + 1);
        expect(layout.onDeck.top, label).toBeGreaterThanOrEqual(0);
        expect(layout.onDeck.bottom, label).toBeLessThanOrEqual(viewport.height + 1);
        expect(layout.onDeck.left, label).toBeGreaterThanOrEqual(0);
        expect(layout.onDeck.right, label).toBeLessThanOrEqual(viewport.width + 1);
        for (const card of layout.cards) {
          expect(card.top, label).toBeGreaterThanOrEqual(layout.header.bottom - 1);
          expect(card.bottom, label).toBeLessThanOrEqual(layout.onDeck.top + 1);
          expect(card.left, label).toBeGreaterThanOrEqual(0);
          expect(card.right, label).toBeLessThanOrEqual(viewport.width + 1);
        }
        expect(layout.scrollWidth, label).toBeLessThanOrEqual(viewport.width);
        expect(layout.scrollHeight, label).toBeLessThanOrEqual(viewport.height);
        if (javaScriptEnabled && viewport.width === 1911) {
          await display.screenshot({
            path: test.info().outputPath("simulation-dashboard-fixed.png"),
            animations: "disabled",
          });
        }
      }
    } finally {
      await displayContext.close();
      await page.goto("/admin/simulator");
      await page.getByRole("button", { name: "Exit simulation" }).click();
      await expect(page).toHaveURL(/\/admin\/system/u);
    }
  });
}
