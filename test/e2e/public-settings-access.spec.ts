/// <reference lib="dom" />

import { expect, test as base } from "@playwright/test";
import type { PublicDashboardView } from "../../src/features/dashboard/types.ts";

interface TapVisibility {
  readonly tapIds: readonly string[];
  readonly setEnabled: (tapId: string, enabled: boolean) => Promise<void>;
}

const test = base.extend<{ tapVisibility: TapVisibility }>({
  tapVisibility: async ({ browser }, use) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const admin = await context.newPage();
    try {
      await admin.goto("/admin/login");
      await admin.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
      await admin.getByRole("button", { name: "Sign in" }).click();
      await expect(admin).toHaveURL(/\/admin\/overview$/u);
      const csrfToken = await admin.locator('input[name="_csrf"]').first().inputValue();
      const response = await admin.request.get("/api/public/dashboard");
      expect(response.ok()).toBe(true);
      const dashboard = (await response.json()) as PublicDashboardView;
      const tapIds = dashboard.taps.map((tap) => tap.id);
      expect(tapIds.length).toBeGreaterThan(0);
      const changed = new Set<string>();
      const update = async (tapId: string, enabled: boolean): Promise<void> => {
        const updated = await admin.request.patch(`/api/admin/taps/${tapId}`, {
          headers: { origin: new URL(admin.url()).origin, "x-csrf-token": csrfToken },
          data: { enabled },
        });
        expect(updated.status()).toBe(200);
      };
      try {
        await use({
          tapIds,
          setEnabled: async (tapId, enabled) => {
            // Every captured public tap was enabled before this test. Record it
            // before the request so a partial failure still gets restored.
            changed.add(tapId);
            await update(tapId, enabled);
          },
        });
      } finally {
        const failures: unknown[] = [];
        for (const tapId of changed) {
          try {
            await update(tapId, true);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(failures, "Could not restore fixture taps.");
      }
    } finally {
      await context.close();
    }
  },
});

test("mobile Settings reaches PIN, System and simulation controls from an empty dashboard without JavaScript", async ({
  browser,
  tapVisibility,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const settings = page
      .locator(".public-header")
      .getByRole("link", { name: "Settings", exact: true });
    const emptyState = page.locator("[data-dashboard-empty]");
    await expect(settings).toBeVisible();
    await expect(settings).toBeInViewport();
    await expect(settings).toHaveAttribute("href", "/admin/system");
    await expect(page.locator("[data-tap-grid] > [data-tap-id]")).toHaveCount(
      tapVisibility.tapIds.length,
    );
    await expect(emptyState).toBeHidden();

    for (const tapId of tapVisibility.tapIds) await tapVisibility.setEnabled(tapId, false);
    await page.reload();
    await expect(page.locator("[data-tap-grid] > [data-tap-id]")).toHaveCount(0);
    await expect(emptyState).toBeVisible();
    await expect(
      emptyState.getByRole("heading", { name: "No taps to display", exact: true }),
    ).toBeVisible();
    await expect(emptyState).toContainText("Admin");
    await expect(page.locator(".connectivity")).toContainText("Disconnected");
    await expect(page.locator(".public-header")).toHaveAttribute(
      "data-connectivity",
      "disconnected",
    );
    await expect(settings).toBeVisible();
    await expect(settings).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await settings.click();
    await expect(page).toHaveURL(/\/admin\/login$/u);
    await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin\/overview$/u);
    await page
      .getByRole("navigation", { name: "Admin", exact: true })
      .getByRole("link", { name: "System", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/system$/u);
    await expect(page.getByRole("switch", { name: "Enable simulation" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable simulation" })).toBeEnabled();

    await page.goto("/");
    await settings.click();
    await expect(page).toHaveURL(/\/admin\/system$/u);
  } finally {
    await context.close();
  }
});

test("live empty guidance follows the last tap disappearing and first tap returning", async ({
  page,
  tapVisibility,
}) => {
  const connected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/public/events" && response.status() === 200,
  );
  await page.goto("/");
  await connected;
  const cards = page.locator("[data-tap-grid] > [data-tap-id]");
  const emptyState = page.locator("[data-dashboard-empty]");
  const settings = page
    .locator(".public-header")
    .getByRole("link", { name: "Settings", exact: true });
  await expect(cards).toHaveCount(tapVisibility.tapIds.length);
  await expect(emptyState).toBeHidden();
  const [lastTap, ...others] = tapVisibility.tapIds;
  expect(lastTap).toBeDefined();
  for (const tapId of others) await tapVisibility.setEnabled(tapId, false);
  await expect(cards).toHaveCount(1);
  await expect(emptyState).toBeHidden();

  await tapVisibility.setEnabled(lastTap!, false);
  await expect(cards).toHaveCount(0);
  await expect(emptyState).toBeVisible();
  await expect(settings).toBeVisible();

  await tapVisibility.setEnabled(lastTap!, true);
  await expect(cards).toHaveCount(1);
  await expect(emptyState).toBeHidden();
  await expect(cards.first()).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("href", "/admin/system");
});

test("reconnect reveals empty guidance after tap removals missed by the public display", async ({
  page,
  tapVisibility,
}) => {
  await page.route("**/api/public/events", (route) => route.abort());
  await page.goto("/");
  const cards = page.locator("[data-tap-grid] > [data-tap-id]");
  const emptyState = page.locator("[data-dashboard-empty]");
  await expect(cards).toHaveCount(tapVisibility.tapIds.length);
  await expect(emptyState).toBeHidden();
  for (const tapId of tapVisibility.tapIds) await tapVisibility.setEnabled(tapId, false);
  await expect(cards).toHaveCount(tapVisibility.tapIds.length);

  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/public/dashboard" && response.status() === 200,
  );
  await page.unroute("**/api/public/events");
  await refreshed;
  await expect(cards).toHaveCount(0);
  await expect(emptyState).toBeVisible();
  await expect(
    page.locator(".public-header").getByRole("link", { name: "Settings", exact: true }),
  ).toBeVisible();
});
