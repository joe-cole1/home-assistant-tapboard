/// <reference lib="dom" />
import { readFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
}
test("flavor guidance renders eight accessible rows with compact phone bars", async ({ page }) => {
  const dashboard = (await (await page.request.get("/api/public/dashboard")).json()) as {
    taps: { tapNumber: number; storyPath: string | null }[];
  };
  const story = dashboard.taps.find((tap) => tap.tapNumber === 1)?.storyPath;
  if (!story) throw new Error("Missing normal fixture Story.");
  for (const width of [320, 360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(story);
    await expect(page.getByRole("heading", { name: "Flavor profile", exact: true })).toBeVisible();
    await expect(page.locator("[data-sensory-axis]")).toHaveCount(8);
    const widths = await page
      .locator(".sensory-bar-fill")
      .evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("width"))));
    expect(widths.every((value) => value >= 0 && value <= 100)).toBe(true);
    await noOverflow(page);
    if (width < 768) await expect(page.locator(".sensory-radar-figure")).toBeHidden();
  }
  await page.locator(".flavor-disclosure summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".flavor-disclosure")).toHaveAttribute("open", "");
});
test("isolated corpus preview displays privacy-safe fixture guidance and captures representative layouts", async ({
  browser,
}) => {
  test.setTimeout(120000);
  test.skip(
    process.env.TAPBOARD_FLAVOR_PREVIEW !== "1",
    "Requires the explicit isolated offline preview server.",
  );
  const manifest = JSON.parse(
    readFileSync("/tmp/tapboard-sensory-preview/manifest.json", "utf8"),
  ) as {
    taps: { label: string; caseId: string; tapId: string; beverageId: string; storyPath: string }[];
  };
  mkdirSync("/tmp/tapboard-sensory-preview/screenshots", { recursive: true });
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  for (const theme of ["modern_dark", "light_minimal"]) {
    await page.goto("/");
    await page.evaluate(
      (theme) =>
        localStorage.setItem(
          "tapboard.v2.display-preferences.v1",
          JSON.stringify({ version: 1, overrides: { theme } }),
        ),
      theme,
    );
    for (const tap of manifest.taps.slice(0, 7))
      for (const width of [320, 360, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(tap.storyPath);
        await expect(page.locator("[data-sensory-axis]")).toHaveCount(8);
        await noOverflow(page);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (width < 768) await expect(page.locator(".sensory-radar-figure")).toBeHidden();
        if (width === 390 || width === 1280)
          await page.screenshot({
            path: `/tmp/tapboard-sensory-preview/screenshots/${tap.caseId}-${theme}-${width}.png`,
            fullPage: true,
          });
      }
  }
  const incomplete = manifest.taps[6]!;
  await page.goto(incomplete.storyPath);
  await expect(page.locator(".sensory-radar-figure")).toHaveCount(0);
  await expect(page.locator(".sensory-row--unknown")).not.toHaveCount(0);
  const barrel = manifest.taps[5]!;
  await page.goto(barrel.storyPath);
  await expect(page.locator(".flavor-process-tags")).toContainText("Bourbon barrel-aged");
  await expect(page.locator(".flavor-process-tags")).not.toContainText(/days|years/u);
  const hidden = manifest.taps[7]!;
  await page.goto(hidden.storyPath);
  await expect(page.locator("[data-sensory-axis]")).toHaveCount(0);
  await expect(page.locator(".flavor-notes,.flavor-process-tags,.flavor-disclosure")).toHaveCount(
    0,
  );
  const sensoryOnly = manifest.taps[8]!;
  await page.goto(sensoryOnly.storyPath);
  await expect(page.locator("[data-sensory-axis]")).toHaveCount(8);
  await expect(page.locator(".flavor-process-tags")).toHaveCount(0);
  const json = await (await page.request.get(`/api/public/taps/${sensoryOnly.tapId}/story`)).text();
  expect(json).not.toContain("sourcePath");
  expect(json).not.toContain("evidenceReferences");
  expect(json).not.toContain("Bourbon barrel-aged");
  await page.goto(manifest.taps[0]!.storyPath);
  await page.locator(".flavor-disclosure summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".flavor-disclosure")).toHaveAttribute("open", "");
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  await noOverflow(page);
  await page.screenshot({
    path: "/tmp/tapboard-sensory-preview/screenshots/text-zoom-200.png",
    fullPage: true,
  });
  await page.goto(`/admin/beverages/${manifest.taps[0]!.beverageId}`);
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(page).toHaveURL(/\/admin\/overview$/u);
  await page.goto(`/admin/beverages/${manifest.taps[0]!.beverageId}`);
  await page.getByText("Edit sensory overrides", { exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Malt character", exact: true })).toHaveCount(
    1,
  );
  await page.getByText("Why these estimates?", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Selected brewing inputs" })).toBeVisible();
  await page.screenshot({
    path: "/tmp/tapboard-sensory-preview/screenshots/admin-diagnostics.png",
    fullPage: true,
  });
  const apiPath = `/api/public/taps/${manifest.taps[0]!.tapId}/story`;
  const before = (await (await page.request.get(apiPath)).json()) as {
    sensory: Record<string, { value: number | null }>;
  };
  await page.getByRole("spinbutton", { name: "Body", exact: true }).fill("8");
  await page.getByRole("button", { name: "Save sensory overrides", exact: true }).click();
  await page.getByText("Edit sensory overrides", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Malt character", exact: true }).fill("0");
  await page.getByRole("button", { name: "Save sensory overrides", exact: true }).click();
  const manual = (await (await page.request.get(apiPath)).json()) as {
    sensory: Record<string, { value: number | null }>;
  };
  expect(manual.sensory.malt?.value).toBe(0);
  expect(manual.sensory.body?.value).toBe(4);
  for (const axis of ["hops", "bitterness", "sweetness", "roast", "tartness", "alcohol"])
    expect(manual.sensory[axis]?.value).toBe(before.sensory[axis]?.value);
  await page.getByText("Edit sensory overrides", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Malt character", exact: true }).fill("");
  await page.getByRole("button", { name: "Save sensory overrides", exact: true }).click();
  const cleared = (await (await page.request.get(apiPath)).json()) as {
    sensory: Record<string, { value: number | null }>;
  };
  expect(cleared.sensory.malt?.value).toBe(before.sensory.malt?.value);
  expect(cleared.sensory.body?.value).toBe(4);
  await page.getByText("Edit sensory overrides", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Body", exact: true }).fill("");
  await page.getByRole("button", { name: "Save sensory overrides", exact: true }).click();
  const noJsContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 900 },
  });
  const noJsPage = await noJsContext.newPage();
  await noJsPage.goto(manifest.taps[0]!.storyPath);
  await expect(noJsPage.locator("[data-sensory-axis]")).toHaveCount(8);
  await noOverflow(noJsPage);
  await noJsPage.screenshot({
    path: "/tmp/tapboard-sensory-preview/screenshots/B064-nojs-390.png",
    fullPage: true,
  });
  await noJsContext.close();
  await context.close();
});
