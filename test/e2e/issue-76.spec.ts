/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await page.getByLabel("Admin PIN").fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

test("authoritative SSR works without JavaScript and keeps private APIs protected", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Tapboard/u);
  await expect(page.locator("header")).toHaveCount(1);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("footer")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Tapboard");
  await expect(
    page.getByRole("link", { name: /Tapboard is connected|Connectivity needs attention/u }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to dashboard" })).toBeFocused();
  await expect(page.locator("[data-tap-id]")).toHaveCount(6);
  await expect(page.getByText("Disabled fixture")).toHaveCount(0);
  await expect(page.getByText("E2E Pale Ale")).toBeVisible();
  await expect(page.getByText("PRIVATE_MAINTENANCE_NOTE")).toHaveCount(0);
  await expect(page.getByText("PRIVATE_BREWFATHER_API_KEY")).toHaveCount(0);
  const numbers = await page
    .locator("[data-tap-number]")
    .evaluateAll((cards) => cards.map((card) => Number((card as HTMLElement).dataset.tapNumber)));
  expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
  const api = await page.request.get("/api/admin/taps");
  expect(api.status()).toBe(401);
  const apiBody = (await api.json()) as { readonly error: { readonly code: string } };
  expect(apiBody.error.code).toBe("auth.unauthorized");
  const publicProjection = JSON.stringify(
    await (await page.request.get("/api/public/dashboard")).json(),
  );
  for (const forbidden of [
    "PRIVATE_MAINTENANCE_NOTE",
    "PRIVATE_BREWFATHER_USER",
    "PRIVATE_BREWFATHER_API_KEY",
    "Private fixture source",
    "Private machine key",
  ]) {
    expect(publicProjection).not.toContain(forbidden);
  }
  const privateTapResponses = await Promise.all(
    [
      "00000000-0000-4000-8000-000000000008",
      "00000000-0000-4000-8000-000000000009",
      "00000000-0000-4000-8000-000000000099",
      "not-a-tap-id",
    ].map((id) => page.request.get(`/api/public/dashboard/taps/${id}`)),
  );
  expect(privateTapResponses.map((privateResponse) => privateResponse.status())).toEqual([
    404, 404, 404, 404,
  ]);
  const privateTapBodies = await Promise.all(
    privateTapResponses.map((privateResponse) => privateResponse.text()),
  );
  expect(new Set(privateTapBodies)).toEqual(
    new Set(['{"error":{"code":"tap.not_public","message":"Tap not found."}}']),
  );
  await context.close();
});

test("Admin login, navigation, and a normal HTTP mutation work without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await login(page);
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
    await page.goto(`/admin/${route}`);
    await expect(page.locator('nav[aria-label="Admin"] a[aria-current="page"]')).toHaveAttribute(
      "href",
      `/admin/${route}`,
    );
    await expect(page.locator("main h1")).toBeVisible();
  }
  await page.goto("/admin/integrations");
  await expect(page.getByText("PRIVATE_BREWFATHER_API_KEY")).toHaveCount(0);
  await expect(page.getByText("PRIVATE_BREWFATHER_USER")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("tbk_");
  await page.goto("/admin/taps");
  const firstTap = page
    .locator(".resource-card")
    .filter({ has: page.getByRole("heading", { name: /Tap 1/u }) });
  await firstTap.getByText("Edit", { exact: true }).click();
  await firstTap.getByLabel("Name").fill("Normal form Tap");
  await firstTap.getByRole("button", { name: "Update Tap" }).click();
  await expect(page.getByRole("heading", { name: /Normal form Tap/u })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/admin\/login\?notice=/u);
  await page.goto("/admin/overview");
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await context.close();
});

test("targeted updates preserve the graphic node and On Deck updates do not rebuild the grid", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const publicPage = await context.newPage();
  await publicPage.goto("/");
  await publicPage.locator('[data-tap-number="1"] .tap-graphic').evaluate((node) => {
    (window as unknown as { savedGraphic: Element }).savedGraphic = node;
  });
  await publicPage.locator("[data-tap-grid]").evaluate((node) => {
    (window as unknown as { savedGrid: Element }).savedGrid = node;
  });

  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/taps");
  const card = admin
    .locator(".resource-card")
    .filter({ has: admin.getByRole("heading", { name: /Tap 1/u }) });
  await card.getByText("Edit", { exact: true }).click();
  await card.getByLabel("Name").fill("Live renamed Tap");
  await card.getByRole("button", { name: "Update Tap" }).click();

  await expect(publicPage.locator('[data-tap-number="1"] [data-field="tap-name"]')).toHaveText(
    "Live renamed Tap",
  );
  expect(
    await publicPage.evaluate(
      () =>
        (window as unknown as { savedGraphic: Element }).savedGraphic ===
        document.querySelector('[data-tap-number="1"] .tap-graphic'),
    ),
  ).toBe(true);
  expect(
    await publicPage.evaluate(
      () =>
        (window as unknown as { savedGrid: Element }).savedGrid ===
        document.querySelector("[data-tap-grid]"),
    ),
  ).toBe(true);
  await admin.goto("/admin/fills");
  const fillRow = admin.locator("tbody tr").filter({ hasText: "E2E Pale Ale" });
  await fillRow.getByRole("button", { name: "Remove from On Deck" }).click();
  await expect(publicPage.locator("[data-on-deck]")).not.toContainText("E2E Pale Ale");
  expect(
    await publicPage.evaluate(
      () =>
        (window as unknown as { savedGrid: Element }).savedGrid ===
        document.querySelector("[data-tap-grid]"),
    ),
  ).toBe(true);

  await publicPage.locator(".public-header").evaluate((node) => {
    (window as unknown as { savedHeader: Element }).savedHeader = node;
  });
  const headerRefresh = publicPage.waitForRequest((request) =>
    request.url().endsWith("/api/public/dashboard/header"),
  );
  await admin.goto("/admin/integrations");
  await admin.getByLabel("User ID").fill("PRIVATE_UPDATED_USER");
  await admin.getByLabel("Enabled").selectOption("false");
  await admin.getByRole("button", { name: "Save Brewfather configuration" }).click();
  await headerRefresh;
  expect(
    await publicPage.evaluate(
      () =>
        (window as unknown as { savedHeader: Element }).savedHeader ===
        document.querySelector(".public-header"),
    ),
  ).toBe(true);
  expect(
    await publicPage.evaluate(
      () =>
        (window as unknown as { savedGrid: Element }).savedGrid ===
        document.querySelector("[data-tap-grid]"),
    ),
  ).toBe(true);
  await context.close();
});

test("a missed event is reconciled from the authoritative dashboard on reconnect", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const publicPage = await context.newPage();
  await publicPage.route("**/api/public/events", (route) => route.abort());
  await publicPage.goto("/");
  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/taps");
  const card = admin
    .locator(".resource-card")
    .filter({ has: admin.getByRole("heading", { name: /Tap 2/u }) });
  await card.getByText("Edit", { exact: true }).click();
  await card.getByLabel("Name").fill("Reconciled Tap");
  await card.getByRole("button", { name: "Update Tap" }).click();
  await publicPage.unroute("**/api/public/events");
  await expect(publicPage.locator('[data-tap-number="2"] [data-field="tap-name"]')).toHaveText(
    "Reconciled Tap",
    { timeout: 10_000 },
  );
  await context.close();
});

test("local display preferences are prepaint, strict, persistent, resettable, and cross-tab", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (location.origin === "http://127.0.0.1:4176") {
      localStorage.setItem(
        "tapboard.v2.display-preferences.v1",
        JSON.stringify({ version: 1, overrides: { theme: "warm_pub", layoutMode: "scroll" } }),
      );
      requestAnimationFrame(() => {
        (window as unknown as { firstFrameTheme: string | undefined }).firstFrameTheme =
          document.documentElement.dataset.theme;
      });
    }
  });
  const first = await context.newPage();
  await first.route("**/assets/js/dashboard.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await first.goto("/", { waitUntil: "commit" });
  await expect
    .poll(() =>
      first.evaluate(() => (window as unknown as { firstFrameTheme?: string }).firstFrameTheme),
    )
    .toBe("warm_pub");
  await expect(first.locator("html")).toHaveAttribute("data-theme", "warm_pub");
  await first.reload();
  await expect(first.locator("html")).toHaveAttribute("data-theme", "warm_pub");

  const second = await context.newPage();
  await second.goto("/");
  await first.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { theme: "cyberpunk", accent: "blue" } }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "tapboard.v2.display-preferences.v1" }),
    );
  });
  await expect(second.locator("html")).toHaveAttribute("data-theme", "cyberpunk");
  await expect(second.locator("html")).toHaveAttribute("data-accent", "blue");
  await first.evaluate(() => {
    localStorage.removeItem("tapboard.v2.display-preferences.v1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "tapboard.v2.display-preferences.v1" }),
    );
  });
  await expect(second.locator("html")).toHaveAttribute("data-theme", "modern_dark");

  await first.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { theme: null, accent: "blue" } }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "tapboard.v2.display-preferences.v1" }),
    );
  });
  await expect(first.locator("html")).toHaveAttribute("data-theme", "modern_dark");
  await expect(first.locator("html")).toHaveAttribute("data-accent", "blue");

  await context.close();

  const malformedContext = await browser.newContext();
  await malformedContext.addInitScript(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      '{"version":1,"overrides":{"theme":"removed_theme"},"unknown":true}',
    );
  });
  const malformed = await malformedContext.newPage();
  await malformed.goto("/");
  await expect(malformed.locator("html")).toHaveAttribute("data-theme", "modern_dark");
  await malformedContext.close();
});

test("shared changes update inherited fields but retain explicit local overrides", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const display = await context.newPage();
  await display.goto("/");
  await display.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { theme: "warm_pub" } }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "tapboard.v2.display-preferences.v1" }),
    );
  });
  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/display");
  await admin.getByLabel("Tapboard name").fill("Shared renamed Tapboard");
  await admin.getByLabel("Theme").first().selectOption("cyberpunk");
  await admin.getByLabel("Accent").first().selectOption("blue");
  await admin.getByRole("button", { name: "Save shared defaults" }).click();
  await expect(display.locator("html")).toHaveAttribute("data-theme", "warm_pub");
  await expect(display.locator("html")).toHaveAttribute("data-accent", "blue");
  await expect(display.locator(".public-header h1")).toHaveText("Shared renamed Tapboard");
  await expect(display).toHaveTitle("Shared renamed Tapboard");
  await context.close();
});

test("six cards remain collision-free at supported display sizes and more than six stay available", async ({
  page,
}) => {
  for (const viewport of [
    { width: 800, height: 900 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator("[data-tap-id]")).toHaveCount(6);
    const geometry = await page.evaluate(() => ({
      overflow: document.body.scrollWidth - document.documentElement.clientWidth,
      cards: [...document.querySelectorAll(".tap-card")].map((card) => {
        const copy = card.querySelector(".tap-copy")!.getBoundingClientRect();
        const visual = card.querySelector(".tap-visual")!.getBoundingClientRect();
        const graphic = card.querySelector(".tap-graphic")!.getBoundingClientRect();
        const volume = card.querySelector('[data-field="volume"]')!.getBoundingClientRect();
        return {
          separated:
            copy.right <= visual.left + 1 ||
            visual.right <= copy.left + 1 ||
            copy.bottom <= visual.top + 1,
          graphicClear: graphic.bottom <= volume.top + 1 || volume.height === 0,
        };
      }),
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.cards.every((card) => card.separated && card.graphicClear)).toBe(true);
  }
  await login(page);
  await page.goto("/admin/taps");
  const create = page.getByRole("heading", { name: "Add Tap" }).locator("..");
  await create.getByLabel("Number").fill("7");
  await create.getByLabel("Name").fill("Seventh Tap");
  await create.getByRole("button", { name: "Create Tap" }).click();
  await page.goto("/");
  await expect(page.locator("[data-tap-id]")).toHaveCount(7);
  await page.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { layoutMode: "rotation" } }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "tapboard.v2.display-preferences.v1" }),
    );
  });
  await expect(page.locator("[data-tap-id]:visible")).toHaveCount(6);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent("tapboard:display-preferences")),
  );
  await expect(page.locator("[data-tap-id]:visible")).toHaveCount(7);
});
