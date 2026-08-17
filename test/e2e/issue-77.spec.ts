/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

const MYSTERY_SECRET = "MYSTERY_SECRET_DO_NOT_LEAK_77";
const LIVE_MYSTERY_SECRET = "LIVE_MYSTERY_SECRET_77";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

test("Brew Story SSR and JSON redact an active Mystery Tap without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const dashboard = (await (await page.request.get("/api/public/dashboard")).json()) as {
    readonly taps: readonly {
      readonly id: string;
      readonly tapNumber: number;
      readonly title?: string;
      readonly storyPath?: string | null;
    }[];
  };
  const mystery = dashboard.taps.find((tap) => tap.title === "Mystery Tap");
  const normal = dashboard.taps.find((tap) => tap.tapNumber === 1);
  const storyPath = mystery?.storyPath;
  const normalStoryPath = normal?.storyPath;
  if (
    mystery === undefined ||
    normal === undefined ||
    typeof storyPath !== "string" ||
    typeof normalStoryPath !== "string" ||
    !/^\/taps\/[^/]+\/story$/u.test(storyPath) ||
    !/^\/taps\/[^/]+\/story$/u.test(normalStoryPath)
  ) {
    throw new Error("Expected assigned Mystery and normal Story paths.");
  }
  const publicPaths = [
    "/",
    "/api/public/dashboard",
    `/api/public/dashboard/taps/${mystery.id}`,
    "/api/public/taps",
    storyPath,
    `/api/public/taps/${mystery.id}/story`,
  ];
  const publicResponses = await Promise.all(publicPaths.map((path) => page.request.get(path)));
  const publicBodies = await Promise.all(publicResponses.map((response) => response.text()));
  for (const [index, body] of publicBodies.entries()) {
    expect(publicResponses[index]?.status()).toBe(200);
    expect(body).not.toContain(MYSTERY_SECRET);
    if (publicPaths[index]?.startsWith("/api/")) {
      expect(JSON.stringify(JSON.parse(body))).not.toContain(MYSTERY_SECRET);
    }
  }
  const storyHtml = publicBodies[4]!;
  expect(storyHtml).toContain("Mystery Tap");
  expect(storyHtml).not.toContain("Measured fixture beer");
  expect(storyHtml).not.toContain("Pale Ale");
  expect(storyHtml).toContain("← Back");
  expect(storyHtml).toContain("Sensory profile");
  expect(storyHtml).toContain("Recipe");
  expect(storyHtml).not.toContain('id="story-fill"');
  expect(storyHtml).not.toContain('id="story-history"');
  expect(storyHtml).not.toContain('data-field="volume"');

  const storyJson = (await (
    await page.request.get(`/api/public/taps/${mystery.id}/story`)
  ).json()) as {
    readonly title: string;
    readonly presentation: {
      readonly beverageName: string | null;
      readonly style: string | null;
      readonly abv: number | null;
    };
    readonly vessel: {
      readonly graphicId: string;
      readonly graphic: { readonly id: string; readonly token: string };
    };
  };
  expect(storyJson.title).toBe("Mystery Tap");
  expect(storyJson.presentation).toMatchObject({ beverageName: null, style: null, abv: null });
  expect(storyJson.vessel.graphicId).toBe(storyJson.vessel.graphic.id);
  expect(storyJson.vessel.graphic.token).toBe(
    `vessel/${storyJson.vessel.graphic.id.replace(/_/gu, "-")}`,
  );

  await page.goto("/");
  const normalCard = page.locator(`[data-tap-number="${normal.tapNumber}"]`);
  await expect(normalCard).toHaveAttribute("href", normalStoryPath);
  await normalCard.click();
  await expect(page).toHaveURL(/\/taps\/[^/]+\/story$/u);
  await expect(page.getByRole("heading", { name: "Custom recipe" })).toBeVisible();
  await expect(page.getByText("Pale <malt>", { exact: false })).toBeVisible();
  await expect(page.getByText("Mash & hold", { exact: false })).toBeVisible();
  await expect(page.getByText("safe & measured", { exact: false })).toBeVisible();
  await expect(page.getByText("step <note>", { exact: false })).toBeVisible();
  const normalStoryHtml = await (await page.request.get(normalStoryPath)).text();
  expect(normalStoryHtml).toContain("Bounded fixture recipe &lt;safe-note&gt;");
  expect(normalStoryHtml).toContain("Pale &lt;malt&gt;");
  expect(normalStoryHtml).toContain("safe &amp; measured");
  expect(normalStoryHtml).toContain("Mash &amp; hold");
  expect(normalStoryHtml).toContain("step &lt;note&gt;");
  if (typeof normal.title !== "string") throw new Error("Expected the normal Tap title.");
  expect(normalStoryHtml).toContain(`Tap ${normal.tapNumber} · ${normal.title}`);
  expect(normalStoryHtml).not.toContain("Fixture Tap 1");
  expect(normalStoryHtml).not.toContain('id="story-fill"');
  expect(normalStoryHtml).not.toContain('id="story-history"');
  expect(normalStoryHtml).not.toContain("Pale <malt>");
  expect(normalStoryHtml).not.toContain("<safe-note>");
  await context.close();
});

test("Brew Story follows shared and local display preferences", async ({ browser }) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin);
  const page = await context.newPage();
  await page.goto("/");
  const normalCard = page.locator('[data-tap-number="1"]');
  await normalCard.click();
  await expect(page).toHaveURL(/\/taps\/[^/]+\/story$/u);
  await expect(page.getByRole("heading", { name: "Current fill" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fill history" })).toBeVisible();

  const volume = page.locator('[data-field="volume"]');
  const historyVolume = page.locator('[data-field="history-volume"]');
  const temperature = page.locator('[data-field="temperature"]');
  await expect(page.locator("html")).toHaveAttribute("data-unit-system", "us");
  await expect(volume.locator('[data-unit="us"]')).toBeVisible();
  await expect(volume.locator('[data-unit="metric"]')).toBeHidden();
  await expect(historyVolume).toHaveCount(1);
  await expect(historyVolume.locator('[data-unit="us"]')).toBeVisible();
  await expect(historyVolume.locator('[data-unit="us"]')).toContainText("0.1 gal");
  await expect(historyVolume.locator('[data-unit="metric"]')).toBeHidden();
  await expect(temperature).toBeHidden();

  await page.evaluate(() => {
    localStorage.setItem(
      "tapboard.v2.display-preferences.v1",
      JSON.stringify({ version: 1, overrides: { unitSystem: "metric" } }),
    );
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-unit-system", "metric");
  await expect(volume.locator('[data-unit="metric"]')).toBeVisible();
  await expect(volume.locator('[data-unit="us"]')).toBeHidden();
  await expect(historyVolume.locator('[data-unit="metric"]')).toBeVisible();
  await expect(historyVolume.locator('[data-unit="metric"]')).toContainText("0.5 L");
  await expect(historyVolume.locator('[data-unit="us"]')).toBeHidden();
  await expect(temperature).toBeHidden();

  await admin.goto("/admin/display/shared");
  const sharedTemperature = admin.locator(
    'form[action="/admin/display/shared"] input[name="showServingTemperature"]',
  );
  await sharedTemperature.check();
  await admin.getByRole("button", { name: "Apply shared defaults" }).click();
  await expect(admin).toHaveURL(/\/admin\/display\/shared\?notice=/u);
  await expect(page.locator("html")).toHaveAttribute("data-show-serving-temperature", "true");
  await expect(temperature).toBeVisible();
  await expect(temperature.locator('[data-unit="metric"]')).toBeVisible();
  await expect(temperature.locator('[data-unit="us"]')).toBeHidden();

  await admin.goto("/admin/display/shared");
  await sharedTemperature.uncheck();
  await admin.getByRole("button", { name: "Apply shared defaults" }).click();
  await expect(admin).toHaveURL(/\/admin\/display\/shared\?notice=/u);
  await expect(page.locator("html")).toHaveAttribute("data-show-serving-temperature", "false");
  await expect(temperature).toBeHidden();

  await page.evaluate(() => localStorage.removeItem("tapboard.v2.display-preferences.v1"));
  await admin.close();
  await context.close();
});

test("Admin long-press previews a pour without mutating the public Fill state", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("[data-dashboard]")).toHaveAttribute(
    "data-admin-pour-preview",
    "false",
  );

  const admin = await context.newPage();
  await login(admin);
  await page.reload();
  await expect(page.locator("[data-dashboard]")).toHaveAttribute("data-admin-pour-preview", "true");

  const card = page.locator('[data-tap-number="1"]');
  const graphic = card.locator(".tap-graphic");
  const initialFill = await card.getAttribute("data-fill-percent");
  const box = await graphic.boundingBox();
  if (box === null) throw new Error("Expected a visible Fill Glass.");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await expect(card).toHaveClass(/is-pour-preview/u);
  await expect(card.locator("[data-pour-preview-status]")).toHaveText("Now pouring");
  await expect(card.locator("[data-pour-preview-status]")).toBeVisible();
  await page.mouse.up();

  await expect(page).toHaveURL(/\/$/u);
  await expect(card).toHaveAttribute("data-fill-percent", initialFill ?? "");
  await expect(card).not.toHaveClass(/is-pour-preview/u, { timeout: 4_000 });

  const nonStoryCard = page
    .locator('article.tap-card:not(:has([data-field="story-link"]))')
    .first();
  await expect(nonStoryCard).toBeVisible();
  const nonStoryGraphic = nonStoryCard.locator(".tap-graphic");
  const nonStoryInitialFill = await nonStoryCard.getAttribute("data-fill-percent");
  const nonStoryBox = await nonStoryGraphic.boundingBox();
  if (nonStoryBox === null) throw new Error("Expected a visible non-story Fill Glass.");
  await page.mouse.move(
    nonStoryBox.x + nonStoryBox.width / 2,
    nonStoryBox.y + nonStoryBox.height / 2,
  );
  await page.mouse.down();
  await page.waitForTimeout(700);
  await expect(nonStoryCard).toHaveClass(/is-pour-preview/u);
  await expect(nonStoryCard.locator("[data-pour-preview-status]")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(nonStoryCard.locator("[data-pour-preview-status]")).toBeVisible();
  await page.mouse.up();
  expect(await nonStoryCard.getAttribute("data-fill-percent")).toBe(nonStoryInitialFill);
  await expect(nonStoryCard).not.toHaveClass(/is-pour-preview/u, { timeout: 4_000 });
  await admin.close();
  await context.close();
});

test("authenticated article-card updates preserve pour-preview controls and do not mutate Fill state", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const admin = await context.newPage();
  await page.goto("/");
  await login(admin);
  await page.reload();
  await expect(page.locator("[data-dashboard]")).toHaveAttribute("data-admin-pour-preview", "true");

  const article = page.locator('article.tap-card:not(:has([data-field="story-link"]))').first();
  await expect(article).toBeVisible();
  const tapId = await article.getAttribute("data-tap-id");
  expect(tapId).toBeTruthy();
  const initialFill = await article.getAttribute("data-fill-percent");
  await expect(article).toHaveAttribute("data-admin-pour-preview", "true");
  await expect(article).toHaveAttribute("tabindex", "0");
  await expect(article).toHaveAttribute("aria-keyshortcuts", "Shift+Space");
  await expect(article.locator("[data-pour-preview-status]")).toHaveAttribute(
    "aria-live",
    "polite",
  );

  await admin.goto("/admin/taps");
  const adminRow = admin.locator(`tr[data-tap-id="${tapId}"]`);
  await adminRow.getByRole("link", { name: "Open", exact: true }).click();
  await admin.getByText("Edit tap name", { exact: true }).click();
  const nameForm = admin.locator('form.tap-safe-name-form[data-autosave="blur"]');
  await expect(nameForm).toHaveAttribute("data-autosave-initialized", "true");
  await admin.getByLabel("Tap name").fill("Dynamic article preview tap");
  const publicTapRefresh = page.waitForRequest(
    (request) =>
      request.method() === "GET" &&
      new URL(request.url()).pathname === `/api/public/dashboard/taps/${tapId}`,
  );
  await admin.getByRole("button", { name: "Save name" }).click();
  await publicTapRefresh;
  await expect(nameForm.locator("[data-autosave-status]")).toHaveText("Saved");
  await expect(article.locator('[data-field="tap-name"]')).toHaveText("Empty Tap");
  await expect(article).toHaveAttribute("data-admin-pour-preview", "true");
  await expect(article).toHaveAttribute("tabindex", "0");
  await expect(article).toHaveAttribute("aria-keyshortcuts", "Shift+Space");
  await expect(article.locator("[data-pour-preview-status]")).toHaveAttribute(
    "aria-live",
    "polite",
  );

  let publicPostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST") publicPostCount += 1;
  });
  await article.focus();
  await page.keyboard.press("Shift+Space");
  await expect(article).toHaveClass(/is-pour-preview/u);
  await expect(article.locator("[data-pour-preview-status]")).toBeVisible();
  expect(await article.getAttribute("data-fill-percent")).toBe(initialFill);

  const graphic = article.locator(".tap-graphic");
  const box = await graphic.boundingBox();
  if (box === null) throw new Error("Expected a visible article-card Fill Glass.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await expect(article).toHaveClass(/is-pour-preview/u);
  await page.mouse.up();
  expect(await article.getAttribute("data-fill-percent")).toBe(initialFill);
  expect(publicPostCount).toBe(0);
  await expect(article).not.toHaveClass(/is-pour-preview/u, { timeout: 4_000 });
  await admin.close();
  await context.close();
});

test("Brew Story ignores ordinary telemetry reloads but reconciles Mystery updates", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/integrations");
  const csrfToken = await admin.locator('input[name="_csrf"]').first().inputValue();
  const sourcesResponse = await admin.request.get("/api/admin/telemetry/sources");
  expect(sourcesResponse.status()).toBe(200);
  const sourcesPayload = (await sourcesResponse.json()) as {
    readonly sources: readonly { readonly id: string; readonly name: string }[];
  };
  const source = sourcesPayload.sources.find((item) => item.name === "Private fixture source");
  expect(source).toBeDefined();
  const rotateResponse = await admin.request.post(
    `/api/admin/telemetry/sources/${source!.id}/rotate`,
    {
      headers: { origin: new URL(admin.url()).origin, "x-csrf-token": csrfToken },
      data: { label: "Issue 77 Story live fixture" },
    },
  );
  expect(rotateResponse.status()).toBe(200);
  const rotatePayload = (await rotateResponse.json()) as { readonly replacementToken: string };
  expect(rotatePayload.replacementToken).toMatch(/^tbk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/u);

  const storyPage = await context.newPage();
  await storyPage.goto("/");
  const normalCard = storyPage.locator('[data-tap-number="1"]');
  const normalTapId = await normalCard.getAttribute("data-tap-id");
  expect(normalTapId).toBeTruthy();
  await normalCard.click();
  await expect(storyPage).toHaveURL(/\/taps\/[^/]+\/story$/u);
  await expect(storyPage.locator("main")).toContainText(LIVE_MYSTERY_SECRET);

  let navigations = 0;
  storyPage.on("framenavigated", (frame) => {
    if (frame === storyPage.mainFrame()) navigations += 1;
  });

  const measuredAt = Date.now();
  for (let index = 0; index < 3; index += 1) {
    const response = await storyPage.request.post("/api/v1/telemetry/taps/1", {
      headers: {
        authorization: `Bearer ${rotatePayload.replacementToken}`,
        "content-type": "application/json",
      },
      data: {
        client_sample_id: `story-live-${index}`,
        measured_at: new Date(measuredAt + index * 1_000).toISOString(),
        measurement: { kind: "remaining_volume", value: 12_000 - index, unit: "ml" },
        temperature: { value: 4, unit: "c" },
      },
    });
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "accepted",
      duplicate: false,
    });
  }
  await storyPage.waitForTimeout(500);
  expect(navigations).toBe(0);

  await admin.goto("/admin/taps");
  const normalAdminRow = admin.locator(`tr[data-tap-id="${normalTapId}"]`);
  await normalAdminRow.getByRole("link", { name: "Open", exact: true }).click();
  await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
  await admin.getByLabel("Enable Mystery Tap").check();
  await admin.getByRole("button", { name: "Save Mystery settings" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/taps/${normalTapId}\\?notice=`));

  await expect(storyPage.getByRole("heading", { name: "Mystery Tap" })).toBeVisible();
  expect(navigations).toBeGreaterThan(0);
  const redactedStory = await storyPage.locator("main").textContent();
  expect(redactedStory).not.toContain(LIVE_MYSTERY_SECRET);

  await admin.goto("/admin/taps");
  const cleanupRow = admin.locator(`tr[data-tap-id="${normalTapId}"]`);
  await cleanupRow.getByRole("link", { name: "Open", exact: true }).click();
  await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
  await admin.getByLabel("Enable Mystery Tap").uncheck();
  await admin.getByRole("button", { name: "Save Mystery settings" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/taps/${normalTapId}\\?notice=`));
  await context.close();
});

test("Custom recipe JSON editor round-trips losslessly without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await login(page);
  await page.goto("/admin/beverages");

  const beverageRow = page.locator("tbody tr").filter({ hasText: "Measured fixture beer" });
  await beverageRow.getByRole("link", { name: /Measured fixture beer/u }).click();
  await page.getByText("Edit recipe data", { exact: true }).click();
  const recipeField = page.locator('textarea[name="recipeJson"]');
  const before = await recipeField.inputValue();
  expect(before).toContain("|");
  expect(before).toContain("\n");
  expect(before).toContain("&");
  expect(before).toContain("<");
  expect(before).toContain("二");
  const beforeRecipe = JSON.parse(before) as unknown;

  await page.getByRole("button", { name: "Save custom recipe" }).click();
  await expect(page).toHaveURL(/\/admin\/beverages\/[^/?]+\?notice=/u);
  const after = await page.locator('textarea[name="recipeJson"]').inputValue();
  expect(JSON.parse(after) as unknown).toEqual(beforeRecipe);
  await context.close();
});

test("Mystery redaction, reveal, finite graphics, and stable roots", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");

  const mysteryCard = page.locator("[data-tap-id]").filter({ hasText: "Mystery Tap" });
  await expect(mysteryCard).toHaveCount(1);
  const storyId = await mysteryCard.getAttribute("data-tap-id");
  expect(storyId).toBeTruthy();
  const normalTapId = await page.locator('[data-tap-number="1"]').getAttribute("data-tap-id");
  expect(normalTapId).toBeTruthy();
  const storyPage = await context.newPage();
  await storyPage.goto(`/taps/${normalTapId}/story`);
  await expect(storyPage.locator("main")).toContainText(LIVE_MYSTERY_SECRET);
  await expect(storyPage.locator("main")).toContainText("Measured fixture beer");
  await expect(storyPage.locator("main")).toContainText("Pale Ale");
  const graphic = page.locator(`[data-tap-id="${storyId}"] .tap-graphic`);
  await graphic.evaluate((node) => {
    (window as unknown as { savedGraphic?: Element }).savedGraphic = node;
  });

  const normalCard = page.locator('[data-tap-number="1"]');
  await expect(normalCard).toContainText("Measured fixture beer");
  await normalCard.evaluate((node) => {
    const graphic = node.querySelector(".tap-graphic");
    if (graphic === null) throw new Error("Expected the normal card to include a graphic.");
    (window as unknown as { savedNormalCard?: Element }).savedNormalCard = node;
    (window as unknown as { savedNormalGraphic?: Element }).savedNormalGraphic = graphic;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const source = new EventSource("/api/public/events");
        const state = { source, frames: [] as string[] };
        (window as unknown as { issue77Sse?: typeof state }).issue77Sse = state;
        source.addEventListener("tap.updated", (event) => {
          state.frames.push((event as MessageEvent<string>).data);
        });
        source.addEventListener("open", () => resolve(), { once: true });
        source.addEventListener("error", () => reject(new Error("Public SSE did not open.")), {
          once: true,
        });
      }),
  );
  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/taps");
  const normalAdminRow = admin.locator(`tr[data-tap-id="${normalTapId}"]`);
  await normalAdminRow.getByRole("link", { name: "Open", exact: true }).click();
  await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
  await admin.getByLabel("Enable Mystery Tap").check();
  await admin.getByRole("button", { name: "Save Mystery settings" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/taps/${normalTapId}\\?notice=`));
  const findMysteryFrame = async (): Promise<string | null> =>
    page.evaluate(
      (tapId) =>
        (window as unknown as { issue77Sse?: { frames: string[] } }).issue77Sse?.frames.find(
          (frame) => {
            try {
              const parsed: unknown = JSON.parse(frame);
              return (
                typeof parsed === "object" &&
                parsed !== null &&
                (parsed as Record<string, unknown>).tapId === tapId
              );
            } catch {
              return false;
            }
          },
        ) ?? null,
      normalTapId,
    );
  await expect.poll(findMysteryFrame, { timeout: 8_000 }).not.toBeNull();
  const mysteryFrame = await findMysteryFrame();
  expect(mysteryFrame).not.toBeNull();
  expect(mysteryFrame).not.toContain(MYSTERY_SECRET);
  expect(JSON.parse(mysteryFrame!)).toEqual({ tapId: normalTapId });
  await expect(storyPage.getByRole("heading", { name: "Mystery Tap" })).toBeVisible();
  const redactedStory = await storyPage.locator("main").evaluate((node) => ({
    text: node.textContent ?? "",
    attributes: [node, ...node.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => /^(aria-|title$|data-)/u.test(attribute.name))
        .map((attribute) => `${attribute.name}=${attribute.value}`),
    ),
  }));
  expect(redactedStory.text).not.toContain(LIVE_MYSTERY_SECRET);
  expect(redactedStory.text).not.toContain("Measured fixture beer");
  expect(redactedStory.text).not.toContain("Pale Ale");
  expect(redactedStory.text).not.toContain(MYSTERY_SECRET);
  expect(redactedStory.attributes.join(" ")).not.toContain(LIVE_MYSTERY_SECRET);
  expect(redactedStory.attributes.join(" ")).not.toContain("Measured fixture beer");
  expect(redactedStory.attributes.join(" ")).not.toContain("Pale Ale");
  expect(redactedStory.attributes.join(" ")).not.toContain(MYSTERY_SECRET);
  for (const selector of ["#story-recipes", "#story-sensory", "#story-history"]) {
    const sectionText = await storyPage.locator(selector).allTextContents();
    expect(sectionText.join(" ")).not.toContain(LIVE_MYSTERY_SECRET);
    expect(sectionText.join(" ")).not.toContain(MYSTERY_SECRET);
  }
  await expect(normalCard.locator('[data-field="tap-name"]')).toHaveText("Mystery Tap");
  const redactedNormal = await normalCard.evaluate((node) => ({
    text: node.textContent ?? "",
    attributes: [node, ...node.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => /^(aria-|title$|data-)/u.test(attribute.name))
        .map((attribute) => `${attribute.name}=${attribute.value}`),
    ),
    storyLabel: node.getAttribute("aria-label"),
    svgTitle: node.querySelector(".tap-graphic title")?.textContent ?? null,
  }));
  expect(redactedNormal.text).not.toContain("Measured fixture beer");
  expect(redactedNormal.text).not.toContain(MYSTERY_SECRET);
  expect(redactedNormal.attributes.join(" ")).not.toContain("Measured fixture beer");
  expect(redactedNormal.attributes.join(" ")).not.toContain(MYSTERY_SECRET);
  expect(redactedNormal.svgTitle).not.toContain(MYSTERY_SECRET);
  expect(redactedNormal.storyLabel).toBe("Tap 1, Mystery Tap");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { savedNormalCard?: Element }).savedNormalCard ===
          document.querySelector('[data-tap-number="1"]') &&
        (window as unknown as { savedNormalGraphic?: Element }).savedNormalGraphic ===
          document.querySelector('[data-tap-number="1"] .tap-graphic'),
    ),
  ).toBe(true);

  const graphicData = await graphic.evaluate((node) => ({
    id: node.getAttribute("data-graphic-id"),
    token: node.getAttribute("data-graphic-token"),
    paths: [...node.querySelectorAll("path")].map((path) => path.getAttribute("d")),
  }));
  expect(graphicData.token).toBe(`vessel/${graphicData.id?.replace(/_/gu, "-")}`);
  expect(graphicData.paths.every((path) => typeof path === "string" && !path.includes("<"))).toBe(
    true,
  );
  expect(await graphic.evaluate((node) => node.innerHTML.includes("<script"))).toBe(false);

  await admin.goto("/admin/taps");
  const adminRow = admin.locator(`tr[data-tap-id="${storyId}"]`);
  await adminRow.getByRole("link", { name: "Open", exact: true }).click();
  await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
  await admin.getByLabel("Style").check();
  await admin.getByRole("button", { name: "Save Mystery settings" }).click();
  await expect(admin).toHaveURL(new RegExp(`/admin/taps/${storyId}\\?notice=`));
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/public/taps/${storyId}/story`);
      const json = (await response.json()) as {
        readonly presentation: { readonly style: string | null };
      };
      return json.presentation.style;
    })
    .toBe(`${MYSTERY_SECRET} style`);
  expect(
    await page.evaluate(
      (id) =>
        (window as unknown as { savedGraphic?: Element }).savedGraphic ===
        document.querySelector(`[data-tap-id="${id}"] .tap-graphic`),
      storyId,
    ),
  ).toBe(true);
  await storyPage.close();
  await page.evaluate(() => {
    (window as unknown as { issue77Sse?: { source: EventSource } }).issue77Sse?.source.close();
  });
  await context.close();
});

test("Fill Glass live updates use distinct v1 contours and preserve the root SVG", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  const normalCard = page.locator('[data-tap-number="1"]');
  await normalCard.locator(".tap-graphic").evaluate((node) => {
    (window as unknown as { savedFillGraphic?: Element }).savedFillGraphic = node;
  });
  const admin = await context.newPage();
  await login(admin);
  await admin.goto("/admin/beverages");
  const measuredRow = admin.locator("tbody tr").filter({ hasText: "Measured fixture beer" });
  const beverageLink = measuredRow.getByRole("link", { name: /Measured fixture beer/u });
  const beverageHref = await beverageLink.getAttribute("href");
  expect(beverageHref).toMatch(/^\/admin\/beverages\/[^/]+$/u);
  await beverageLink.click();
  await admin.getByText("Edit presentation", { exact: true }).click();
  const presentationForm = admin.locator('form[action$="/update"][data-autosave="blur"]');
  await expect(presentationForm).toHaveAttribute("data-autosave-initialized", "true");
  const picker = admin.locator(".fill-glass-picker");
  await picker.locator("summary").click();
  const mugRadio = picker.locator('input[type="radio"][value="mug"]');
  await expect(mugRadio).not.toBeChecked();
  const autosaveRequest = admin.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `${beverageHref}/update` &&
      request.headers()["x-tapboard-enhancement"] === "autosave",
  );
  await mugRadio.check();
  await autosaveRequest;
  await expect(presentationForm.locator("[data-autosave-status]")).toHaveText("Saved");
  await expect(normalCard.locator(".tap-graphic")).toHaveAttribute("data-graphic-id", "mug");
  await expect(normalCard.locator(".tap-graphic .glass")).toHaveAttribute(
    "d",
    "M 48 50 H 112 A 8 8 0 0 1 120 58 V 212 A 8 8 0 0 1 112 220 H 48 A 8 8 0 0 1 40 212 V 58 A 8 8 0 0 1 48 50 Z",
  );
  await expect(normalCard.locator(".beer-bubble")).toHaveCount(24);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(normalCard.locator(".beer-bubbles")).toHaveCSS("display", "none");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { savedFillGraphic?: Element }).savedFillGraphic ===
        document.querySelector('[data-tap-number="1"] .tap-graphic'),
    ),
  ).toBe(true);
  await context.close();
});
