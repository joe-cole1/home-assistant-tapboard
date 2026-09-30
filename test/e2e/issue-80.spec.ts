/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

const SETTING_FIELDS = [
  "fallbackFg",
  "servingSizeMl",
  "activityDays",
  "rawSeconds",
  "receiptSeconds",
  "reconnectSeconds",
  "outboxDays",
] as const;
type SavedSettings = Record<(typeof SETTING_FIELDS)[number], string>;

async function login(page: Page): Promise<void> {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function readSettings(page: Page): Promise<SavedSettings> {
  const values = {} as SavedSettings;
  for (const field of SETTING_FIELDS) {
    values[field] = await page.locator(`input[name="${field}"]`).inputValue();
  }
  return values;
}

async function restoreSettings(page: Page, original: SavedSettings): Promise<void> {
  await page.goto("/admin/system");
  if (new URL(page.url()).pathname === "/admin/login") {
    await login(page);
    await page.goto("/admin/system");
  }
  await page.locator('input[name="fallbackFg"]').fill(original.fallbackFg);
  await page.locator('input[name="servingSizeMl"]').fill(original.servingSizeMl);
  await page.getByRole("button", { name: "Save calculation defaults" }).click();
  await expect(page.getByRole("status")).toContainText("Calculation defaults saved.");
  for (const field of SETTING_FIELDS.slice(2)) {
    await page.locator(`input[name="${field}"]`).fill(original[field]);
  }
  await page.getByRole("button", { name: "Save retention settings" }).click();
  await expect(page.getByRole("status")).toContainText("Retention settings saved.");
  expect(await readSettings(page)).toEqual(original);
}

test("Issue 80 System supports no-JS save, Activity filtering, selected/self revoke and private mobile layout", async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const selectedContext = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const selectedPage = await selectedContext.newPage();
  let original: SavedSettings | undefined;
  let restoreNeeded = false;
  try {
    await login(page);
    await page.goto("/admin/system");
    const simulation = page.getByRole("switch", { name: "Enable simulation" });
    if ((await simulation.getAttribute("aria-checked")) === "true") {
      await simulation.click();
      await expect(page).toHaveURL(/\/admin\/system/u);
    }
    await expect(page.getByRole("heading", { name: "System", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
    original = await readSettings(page);

    await login(selectedPage);
    await selectedPage.goto("/admin/system");
    const selectedArticle = selectedPage.locator(".system-session").filter({
      has: selectedPage.getByRole("heading", { name: "This session", exact: true }),
    });
    const selectedAction = await selectedArticle.locator("form").getAttribute("action");
    expect(selectedAction).toMatch(/^\/admin\/system\/sessions\/[0-9a-f-]{36}\/revoke$/u);

    await page.goto("/admin/system");
    // Keep gravity unchanged so shared serving fixtures retain their telemetry epochs.
    const servingSize = original.servingSizeMl === "360" ? "375" : "360";
    restoreNeeded = true;
    await page.getByLabel("Default serving size (mL)").fill(servingSize);
    await page.getByRole("button", { name: "Save calculation defaults" }).click();
    await expect(page.getByRole("status")).toContainText("Calculation defaults saved.");
    await expect(page.getByLabel("Default serving size (mL)")).toHaveValue(servingSize);
    await expect(page.getByLabel("Fallback final gravity")).toHaveValue(original.fallbackFg);

    const activityDays = String(
      Number(original.activityDays) < 3650
        ? Number(original.activityDays) + 1
        : Number(original.activityDays) - 1,
    );
    await page.getByLabel("Activity Log (days)").fill(activityDays);
    await page.getByRole("button", { name: "Save retention settings" }).click();
    await expect(page.getByRole("status")).toContainText("Retention settings saved.");
    await expect(page.getByLabel("Activity Log (days)")).toHaveValue(activityDays);

    await page.getByLabel("Activity category").selectOption("admin");
    await page.getByRole("button", { name: "Filter Activity Log" }).click();
    await expect(page).toHaveURL(/\/admin\/system\?category=admin#activity$/u);
    const rows = page.locator("#activity tbody tr");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(50);
    for (const row of await rows.all()) await expect(row.locator("td").nth(1)).toHaveText("Admin");

    const html = await page.content();
    for (const privateValue of [
      "PRIVATE_MAINTENANCE_NOTE",
      "PRIVATE_DISABLED_NOTE",
      "PRIVATE_RETIRED_NOTE",
      "PRIVATE_BREWFATHER_USER",
      "PRIVATE_BREWFATHER_API_KEY",
      "LIVE_MYSTERY_SECRET_77",
      "ISSUE_79_PRIVATE_HA_TOKEN",
      "ISSUE_79_PRIVATE_HEADER_SECRET",
      "https://issue-79-private.invalid/webhook-secret",
    ]) {
      expect(html).not.toContain(privateValue);
    }
    const currentCookies = await context.cookies();
    const selectedCookies = await selectedContext.cookies();
    const currentToken = currentCookies.find((cookie) => cookie.name === "tapboard_admin_session");
    const selectedToken = selectedCookies.find(
      (cookie) => cookie.name === "tapboard_admin_session",
    );
    const selectedCsrf = selectedCookies.find((cookie) => cookie.name === "tapboard_admin_csrf");
    expect(currentToken).toBeDefined();
    expect(selectedToken).toBeDefined();
    expect(selectedCsrf).toBeDefined();
    expect(html).not.toContain(currentToken!.value);
    expect(html).not.toContain(selectedToken!.value);
    expect(html).not.toContain(selectedCsrf!.value);
    expect(html).not.toMatch(/session_digest|csrf_digest|details_json/u);

    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      if (width === 390 || width === 1280) {
        await page.screenshot({
          path: test.info().outputPath(`system-${width}.png`),
          fullPage: true,
        });
      }
    }

    const selectedForm = page.locator(`form[action="${selectedAction!}"]`);
    await selectedForm.getByRole("checkbox", { name: "Confirm revocation", exact: true }).check();
    await selectedForm.getByRole("button", { name: "Revoke session", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Session revoked.");
    await selectedPage.goto("/admin/system");
    await expect(selectedPage).toHaveURL(/\/admin\/login$/u);
    await expect(page.getByRole("heading", { name: "System", exact: true })).toBeVisible();

    await restoreSettings(page, original);
    restoreNeeded = false;
    const currentArticle = page.locator(".system-session").filter({
      has: page.getByRole("heading", { name: "This session", exact: true }),
    });
    await currentArticle
      .getByRole("checkbox", { name: "Confirm revocation of this session" })
      .check();
    await currentArticle.getByRole("button", { name: "Revoke this session", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/login\?notice=/u);
    await page.goto("/admin/system");
    await expect(page).toHaveURL(/\/admin\/login$/u);
  } finally {
    try {
      if (restoreNeeded && original !== undefined) await restoreSettings(page, original);
    } finally {
      await Promise.all([context.close(), selectedContext.close()]);
    }
  }
});
