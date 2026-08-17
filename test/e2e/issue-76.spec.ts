/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from "@playwright/test";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function openTapNameForm(page: Page, waitForAutosave = true): Promise<Locator> {
  await page.getByText("Edit tap name", { exact: true }).click();
  const form = page.locator("form.tap-safe-name-form");
  if (waitForAutosave) {
    await expect(form).toHaveAttribute("data-autosave-initialized", "true");
  }
  return form;
}

async function saveTapName(
  page: Page,
  name: string,
  options: { readonly waitForAutosave?: boolean } = {},
): Promise<void> {
  const waitForAutosave = options.waitForAutosave ?? true;
  const form = await openTapNameForm(page, waitForAutosave);
  await form.getByLabel("Tap name").fill(name);
  await form.getByRole("button", { name: "Save name" }).click();
  if (waitForAutosave) {
    await expect(form.locator("[data-autosave-status]")).toHaveText("Saved");
  }
}

async function saveSharedTapboardName(page: Page, name: string): Promise<void> {
  await page.goto("/admin/display/shared");
  const form = page.locator("form[data-shared-display-form]");
  await form.getByLabel("Tapboard name").fill(name);
  await form.getByRole("button", { name: "Apply shared defaults" }).click();
  await expect(page).toHaveURL(/\/admin\/display\/shared\?notice=/u);
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
  await expect(page.getByRole("link", { name: /Connected|Degraded/u })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
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
  for (const [route, activeHref] of [
    ["overview", "/admin/overview"],
    ["integrations", "/admin/integrations"],
    ["beverages", "/admin/beverages"],
    ["kegs", "/admin/keg-room"],
    ["fills", "/admin/keg-room"],
    ["taps", "/admin/taps"],
    ["tap-wars", "/admin/tap-wars"],
    ["display", "/admin/display"],
    ["system", "/admin/system"],
  ] as const) {
    await page.goto(route === "kegs" ? "/admin/kegs" : `/admin/${route}`);
    await expect(page.locator('nav[aria-label="Admin"] a[aria-current="page"]')).toHaveAttribute(
      "href",
      activeHref,
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
  await firstTap.getByRole("link", { name: "Open Tap detail" }).click();
  await saveTapName(page, "Normal form Tap", { waitForAutosave: false });
  await expect(page.getByRole("heading", { name: /Normal form Tap/u })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/admin\/login\?notice=/u);
  await page.goto("/admin/overview");
  await expect(page).toHaveURL(/\/admin\/login$/u);
  await context.close();
});

test("mobile Admin navigation is modal while open and Beverage rows have a safe full-row click target", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);

  const sidebar = page.locator("[data-admin-sidebar]");
  await expect(sidebar).toHaveJSProperty("inert", true);
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");

  await page.getByRole("button", { name: "Menu" }).click();
  await expect(sidebar).toHaveJSProperty("inert", false);
  await expect(sidebar).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("main")).toHaveJSProperty("inert", true);
  await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "System", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveJSProperty("inert", true);
  await expect(page.locator("main")).toHaveJSProperty("inert", false);

  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto("/admin/beverages");
  const firstRow = page.locator(".beverage-list__row").first();
  const destination = await firstRow.getAttribute("data-row-href");
  expect(destination).not.toBeNull();
  await firstRow.locator("td").last().click();
  await expect(page).toHaveURL(new RegExp(`${destination!.replaceAll("/", "\\/")}$`, "u"));
  await context.close();
});

test("targeted updates preserve the graphic node and On Deck updates do not rebuild the grid", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const publicPage = await context.newPage();
  await publicPage.goto("/");
  await expect(publicPage.locator(".public-brand")).toHaveAttribute("href", "/");
  await expect(publicPage.locator('[data-tap-number="1"] .beer-bubble')).toHaveCount(24);
  await expect(
    publicPage.locator('[data-tap-number="1"] [data-field="forecast-servings"]'),
  ).toBeVisible();
  await expect(
    publicPage.locator('[data-tap-number="1"] [data-field="forecast-days"]'),
  ).toBeVisible();
  await expect(publicPage.locator("[data-on-deck-toggle]")).toHaveText("Pause");
  const publicTap1 = publicPage.locator('[data-tap-number="1"]');
  const tap1Id = await publicTap1.getAttribute("data-tap-id");
  expect(tap1Id).not.toBeNull();
  await publicPage.locator('[data-tap-number="1"] .tap-graphic').evaluate((node) => {
    (window as unknown as { savedGraphic: Element }).savedGraphic = node;
  });
  await publicPage.locator("[data-tap-grid]").evaluate((node) => {
    (window as unknown as { savedGrid: Element }).savedGrid = node;
  });
  const publicTitle = await publicPage
    .locator('[data-tap-number="1"] [data-field="tap-name"]')
    .textContent();

  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/taps");
  const card = admin.locator(`article.tap-list-card[data-tap-id="${tap1Id!}"]`);
  await expect(card).toHaveCount(1);
  await card.getByRole("link", { name: "Open Tap detail" }).click();
  const tapNameForm = await openTapNameForm(admin);
  const targetedRefresh = publicPage.waitForRequest((request) =>
    request.url().endsWith(`/api/public/dashboard/taps/${tap1Id}`),
  );
  await tapNameForm.getByLabel("Tap name").fill("Live renamed Tap");
  await tapNameForm.getByRole("button", { name: "Save name" }).click();
  const targetedRequest = await targetedRefresh;
  expect(targetedRequest.url().endsWith(`/api/public/dashboard/taps/${tap1Id}`)).toBe(true);
  await expect(tapNameForm.locator("[data-autosave-status]")).toHaveText("Saved");

  await expect(publicPage.locator('[data-tap-number="1"] [data-field="tap-name"]')).toHaveText(
    publicTitle!,
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
  await admin.goto("/admin/keg-room");
  const fillCard = admin.locator(".resource-card").filter({ hasText: "E2E Pale Ale" });
  await expect(fillCard).toHaveCount(1);
  const removeFromOnDeck = fillCard.getByRole("button", { name: "Remove from On Deck" });
  if ((await removeFromOnDeck.count()) > 0) {
    await removeFromOnDeck.click();
  } else {
    const fillId = await fillCard.getAttribute("data-fill-id");
    expect(fillId).not.toBeNull();
    const csrfToken = await admin.locator('input[name="_csrf"]').first().inputValue();
    const response = await admin.request.post(
      `/admin/fills/${encodeURIComponent(fillId!)}/remove-on-deck`,
      {
        form: { _csrf: csrfToken },
        headers: { Origin: new URL(admin.url()).origin },
      },
    );
    expect(response.ok()).toBe(true);
  }
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
  await admin.goto("/admin/integrations/brewfather");
  await admin.getByText("Connection settings", { exact: true }).click();
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

test("six public cards fill the viewport band without clipping at supported wall sizes", async ({
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
    await expect(page.locator(".tap-card")).toHaveCount(6);
    const geometry = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".public-header");
      const grid = document.querySelector<HTMLElement>("[data-tap-grid]");
      const onDeck = document.querySelector<HTMLElement>("[data-on-deck]");
      if (!header || !grid || !onDeck) throw new Error("Expected dashboard layout landmarks.");
      const headerBounds = header.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      const onDeckBounds = onDeck.getBoundingClientRect();
      const cards = [...document.querySelectorAll<HTMLElement>(".tap-card")].map((card) => {
        const cardBounds = card.getBoundingClientRect();
        const descendants = [
          card.querySelector<HTMLElement>(".tap-copy"),
          card.querySelector<HTMLElement>(".tap-visual"),
          card.querySelector<HTMLElement>(".tap-graphic"),
          card.querySelector<HTMLElement>('[data-field="forecast"]'),
        ].filter((element): element is HTMLElement => element !== null);
        return {
          top: cardBounds.top,
          bottom: cardBounds.bottom,
          right: cardBounds.right,
          left: cardBounds.left,
          contentClipped:
            card.scrollHeight > card.clientHeight + 1 || card.scrollWidth > card.clientWidth + 1,
          descendantOutside: descendants.some((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.top < cardBounds.top - 1 ||
              bounds.bottom > cardBounds.bottom + 1 ||
              bounds.left < cardBounds.left - 1 ||
              bounds.right > cardBounds.right + 1
            );
          }),
        };
      });
      const availableBottom = Math.min(gridBounds.bottom, onDeckBounds.top - 1);
      return {
        documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
        headerBeforeGrid: headerBounds.bottom <= gridBounds.top + 1,
        onDeckInsideViewport:
          onDeckBounds.top >= -1 &&
          onDeckBounds.bottom <= window.innerHeight + 1 &&
          onDeckBounds.left >= -1 &&
          onDeckBounds.right <= window.innerWidth + 1,
        gridTop: gridBounds.top,
        gridBottom: gridBounds.bottom,
        availableBottom,
        bottomCardBottom: Math.max(...cards.map((card) => card.bottom)),
        cards,
      };
    });
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    expect(geometry.headerBeforeGrid).toBe(true);
    expect(geometry.onDeckInsideViewport).toBe(true);
    expect(geometry.bottomCardBottom).toBeGreaterThanOrEqual(geometry.availableBottom - 24);
    expect(geometry.bottomCardBottom).toBeLessThanOrEqual(geometry.availableBottom + 2);
    expect(geometry.cards.every((card) => !card.contentClipped && !card.descendantOutside)).toBe(
      true,
    );
  }
});

test("narrow mobile keeps natural scrolling and leaves the last card above fixed On Deck", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".tap-card")).toHaveCount(6);
  const initial = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  expect(initial.documentHeight).toBeGreaterThan(initial.viewportHeight);

  const last = page.locator(".tap-card").last();
  await last.scrollIntoViewIfNeeded();
  await last.evaluate((card) => card.scrollIntoView({ block: "center", inline: "nearest" }));
  const reachability = await last.evaluate((card) => {
    const onDeck = document.querySelector<HTMLElement>("[data-on-deck]");
    if (!onDeck) throw new Error("Expected fixed On Deck.");
    const cardBounds = card.getBoundingClientRect();
    const onDeckBounds = onDeck.getBoundingClientRect();
    return {
      cardTop: cardBounds.top,
      cardBottom: cardBounds.bottom,
      footerTop: onDeckBounds.top,
      footerBottom: onDeckBounds.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(reachability.cardTop).toBeGreaterThanOrEqual(-1);
  expect(reachability.cardBottom).toBeLessThanOrEqual(reachability.footerTop - 2);
  expect(reachability.footerBottom).toBeLessThanOrEqual(reachability.viewportHeight + 1);
});

test("light theme renders semantic vessel contours with a light computed fill", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { theme: "light_minimal" } }),
    );
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light_minimal");
  const styles = await page.evaluate(() => {
    const contour = document.querySelector<SVGPathElement>('[data-glass-contour="true"]');
    if (!contour) throw new Error("Expected a semantic glass contour path.");
    const values =
      getComputedStyle(contour)
        .fill.match(/[\d.]+/gu)
        ?.map(Number) ?? [];
    const rgb = values.slice(0, 3).map((value) => (value <= 1 ? value * 255 : value));
    return { average: rgb.reduce((sum, value) => sum + value, 0) / rgb.length };
  });
  expect(styles.average).toBeGreaterThan(80);
});

test("On Deck overflow can pause and resume while the control remains focused", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/");
  await page.locator("[data-on-deck-list]").evaluate((list) => {
    const item = list.querySelector("li");
    if (!item) throw new Error("Expected an On Deck fixture item.");
    for (let index = 0; index < 18; index += 1) list.append(item.cloneNode(true));
    window.dispatchEvent(new Event("resize"));
  });
  const viewport = page.locator("[data-on-deck-viewport]");
  const toggle = page.locator("[data-on-deck-toggle]");
  await expect(toggle).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);

  await toggle.click();
  await expect(toggle).toHaveText("Resume");
  const pausedAt = await viewport.evaluate((node) => node.scrollLeft);
  await page.waitForTimeout(300);
  expect(await viewport.evaluate((node) => node.scrollLeft)).toBe(pausedAt);

  await toggle.click();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveText("Pause");
  await expect.poll(() => viewport.evaluate((node) => node.scrollLeft)).toBeGreaterThan(pausedAt);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle).toBeHidden();
});

test("a missed event is reconciled from the authoritative dashboard on reconnect", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const publicPage = await context.newPage();
  await publicPage.route("**/api/public/events", (route) => route.abort());
  await publicPage.goto("/");
  await expect(publicPage.locator('[data-tap-number="2"] [data-field="tap-name"]')).toHaveText(
    "Empty Tap",
  );
  const publicBrand = publicPage.locator(".public-brand");
  const originalSharedName = (await publicBrand.textContent())?.trim();
  expect(originalSharedName).toBeTruthy();
  const publicTap2 = publicPage.locator('[data-tap-number="2"]');
  await publicTap2.evaluate((node) => {
    (window as unknown as { reconnectCard: Element }).reconnectCard = node;
    (window as unknown as { reconnectGraphic: Element }).reconnectGraphic =
      node.querySelector(".tap-graphic")!;
  });
  const admin = await context.newPage();
  await login(admin);
  await saveSharedTapboardName(admin, "Reconnect Stale Tapboard");
  let interceptedReconnectSnapshot = false;
  let reconnectSnapshotAttempts = 0;
  await publicPage.route("**/api/public/dashboard", async (route) => {
    reconnectSnapshotAttempts += 1;
    if (reconnectSnapshotAttempts === 1) {
      await route.abort("failed");
      return;
    }
    if (interceptedReconnectSnapshot) {
      await route.continue();
      return;
    }
    interceptedReconnectSnapshot = true;
    const snapshot = await route.fetch();
    await saveSharedTapboardName(admin, "Reconnect Handoff Tapboard");
    await route.fulfill({ response: snapshot });
  });
  await publicPage.unroute("**/api/public/events");
  await expect.poll(() => interceptedReconnectSnapshot, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => reconnectSnapshotAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await expect(publicBrand).toHaveText("Reconnect Handoff Tapboard", { timeout: 10_000 });
  expect(
    await publicPage.evaluate(
      () =>
        (window as unknown as { reconnectCard: Element }).reconnectCard ===
          document.querySelector('[data-tap-number="2"]') &&
        (window as unknown as { reconnectGraphic: Element }).reconnectGraphic ===
          document.querySelector('[data-tap-number="2"] .tap-graphic'),
    ),
  ).toBe(true);
  await publicPage.unroute("**/api/public/dashboard");
  await saveSharedTapboardName(admin, originalSharedName!);
  await context.close();
});

test("local display preferences are prepaint, strict, persistent, resettable, and cross-tab", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (location.hostname === "127.0.0.1") {
      localStorage.setItem(
        "tapboard.v2.display-preferences.v1",
        JSON.stringify({
          version: 1,
          overrides: { theme: "warm_pub", layoutMode: "scroll", unitSystem: "metric" },
        }),
      );
      requestAnimationFrame(() => {
        const remaining = document.querySelector(
          '[data-tap-number="1"] [data-field="remaining-readout"]',
        );
        const temperature = document.querySelector(
          '[data-tap-number="1"] [data-field="temperature"]',
        );
        (
          window as unknown as {
            firstFrameTheme: string | undefined;
            firstFrameUnits: readonly [string, string, string, string] | undefined;
          }
        ).firstFrameTheme = document.documentElement.dataset.theme;
        (
          window as unknown as {
            firstFrameUnits: readonly [string, string, string, string] | undefined;
          }
        ).firstFrameUnits = [
          remaining!.textContent,
          temperature!.querySelector('[data-unit="metric"]')!.textContent,
          getComputedStyle(temperature!.querySelector('[data-unit="metric"]')!).display,
          getComputedStyle(temperature!.querySelector('[data-unit="us"]')!).display,
        ];
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
  await expect
    .poll(() =>
      first.evaluate(
        () =>
          (
            window as unknown as {
              firstFrameUnits?: readonly [string, string, string, string];
            }
          ).firstFrameUnits,
      ),
    )
    .toEqual(["63% remaining", "4.0 °C", "inline", "none"]);
  await expect(first.locator("html")).toHaveAttribute("data-theme", "warm_pub");
  await expect(first.locator("html")).toHaveAttribute("data-unit-system", "metric");
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
  await admin.goto("/admin/display/shared");
  await admin.getByLabel("Tapboard name").fill("Shared renamed Tapboard");
  await admin.getByLabel("Theme").first().selectOption("cyberpunk");
  await admin.locator('input[name="accent"]').fill("blue");
  await admin.getByRole("button", { name: "Apply shared defaults" }).click();
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
        const remaining = card
          .querySelector('[data-field="remaining-readout"]')!
          .getBoundingClientRect();
        return {
          separated:
            copy.right <= visual.left + 1 ||
            visual.right <= copy.left + 1 ||
            copy.bottom <= visual.top + 1,
          graphicClear: graphic.bottom <= remaining.top + 1 || remaining.height === 0,
        };
      }),
    }));
    expect(geometry.overflow).toBeLessThanOrEqual(0);
    expect(geometry.cards.every((card) => card.separated && card.graphicClear)).toBe(true);
  }
  await login(page);
  await page.goto("/admin/taps");
  await page.getByRole("link", { name: "Add Tap" }).click();
  await expect(page).toHaveURL(/\/admin\/taps\/new$/u);
  await page.getByLabel("Tap number").fill("7");
  await page.getByLabel("Name").fill("Seventh Tap");
  await page.getByRole("button", { name: "Create Tap" }).click();
  await page.goto("/");
  await expect(page.locator("[data-tap-id]")).toHaveCount(7);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  const scrollState = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>("[data-tap-grid]");
    const seventh = document.querySelector<HTMLElement>('[data-tap-number="7"]');
    if (!grid || !seventh) throw new Error("Expected the seven-card scroll fixture.");
    return {
      overflowY: getComputedStyle(grid).overflowY,
      canScroll: grid.scrollHeight > grid.clientHeight,
      seventhBelowViewport:
        seventh.getBoundingClientRect().bottom > grid.getBoundingClientRect().bottom,
    };
  });
  expect(scrollState.overflowY).toBe("auto");
  expect(scrollState.canScroll).toBe(true);
  expect(scrollState.seventhBelowViewport).toBe(true);
  await page
    .locator('[data-tap-number="7"]')
    .evaluate((card) => card.scrollIntoView({ block: "nearest" }));
  const seventhReachability = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>("[data-tap-grid]");
    const seventh = document.querySelector<HTMLElement>('[data-tap-number="7"]');
    if (!grid || !seventh) throw new Error("Expected the seven-card scroll fixture.");
    const gridBounds = grid.getBoundingClientRect();
    const cardBounds = seventh.getBoundingClientRect();
    return {
      scrollTop: grid.scrollTop,
      reachable: cardBounds.top >= gridBounds.top && cardBounds.bottom <= gridBounds.bottom,
    };
  });
  expect(seventhReachability.scrollTop).toBeGreaterThan(0);
  expect(seventhReachability.reachable).toBe(true);
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
