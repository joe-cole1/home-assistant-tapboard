/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

const MYSTERY_SECRET = "MYSTERY_SECRET_DO_NOT_LEAK_77";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.getByLabel("Admin PIN").fill("1234");
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
  expect(storyHtml).toContain("Fill Glass");

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
  const normalStoryLink = normalCard.locator('[data-field="story-link"]');
  await expect(normalStoryLink).toHaveAttribute("href", normalStoryPath);
  await normalStoryLink.click();
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
  expect(normalStoryHtml).not.toContain("Pale <malt>");
  expect(normalStoryHtml).not.toContain("<safe-note>");
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
  const tapNumber = await mysteryCard.locator('[data-field="tap-number"]').textContent();
  expect(tapNumber).toMatch(/^Tap \d+$/u);
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
  const normalAdminCard = admin.getByRole("heading", { name: /^Tap 1\s/u }).locator("..");
  await normalAdminCard.getByText("Mystery Tap visibility").click();
  await normalAdminCard.getByLabel("Enable Mystery Tap").check();
  await normalAdminCard.getByRole("button", { name: "Save Mystery settings" }).click();
  await expect(admin).toHaveURL(/\/admin\/taps\?notice=/u);
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
  await expect(normalCard.locator('[data-field="tap-name"]')).toHaveText("Mystery Tap");
  const redactedNormal = await normalCard.evaluate((node) => ({
    text: node.textContent ?? "",
    attributes: [node, ...node.querySelectorAll("*")].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => /^(aria-|title$|data-)/u.test(attribute.name))
        .map((attribute) => `${attribute.name}=${attribute.value}`),
    ),
    storyLabel: node.querySelector('[data-field="story-link"]')?.getAttribute("aria-label") ?? null,
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

  const adminCard = admin
    .getByRole("heading", { name: new RegExp(`^${tapNumber}\\s`, "u") })
    .locator("..");
  await adminCard.getByText("Mystery Tap visibility").click();
  await adminCard.getByLabel("Style").check();
  await adminCard.getByRole("button", { name: "Save Mystery settings" }).click();
  await expect(admin).toHaveURL(/\/admin\/taps\?notice=/u);
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
  await page.evaluate(() => {
    (window as unknown as { issue77Sse?: { source: EventSource } }).issue77Sse?.source.close();
  });
  await context.close();
});
