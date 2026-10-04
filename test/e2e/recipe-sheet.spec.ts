/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import type { PublicStoryView } from "../../src/features/story/types.ts";

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

// This test operates only the disposable Playwright database, including its Simulation copy.
test("guests can read a responsive recipe sheet with units, print layout and independent Mystery reveals", async ({
  page: admin,
  browser,
}) => {
  test.setTimeout(90000);
  await admin.goto("/admin/login");
  await admin.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await expect(admin).toHaveURL(/\/admin\/overview/u);
  await admin.goto("/admin/system");
  const toggle = admin.getByRole("switch", { name: "Enable simulation" });
  const wasSimulation = (await toggle.getAttribute("aria-checked")) === "true";
  if (!wasSimulation) await toggle.click();
  const dashboard = (await (await admin.request.get("/api/public/dashboard")).json()) as {
    taps: { id: string; title: string; storyPath: string | null }[];
  };
  const tap = dashboard.taps.find((row) => row.title === "Oktoberfest")!;
  expect(tap?.storyPath).toBeTruthy();
  const guest = await browser.newContext();
  const page = await guest.newPage();
  const api = `/api/public/taps/${tap.id}/story`;
  const source = ((await (await page.request.get(api)).json()) as PublicStoryView).recipes!
    .sources[0]!.sheet!;
  expect(source.summary.abv).toBe(6.3);
  expect(source.measurements.og).toBe(1.05);
  try {
    for (const theme of ["modern_dark", "light_minimal"]) {
      for (const unitSystem of ["metric", "us"]) {
        await page.goto(tap.storyPath!);
        await page.evaluate(
          ({ theme, unitSystem }) =>
            localStorage.setItem(
              "tapboard.v2.simulation.display-preferences.v1",
              JSON.stringify({ version: 1, overrides: { theme, unitSystem } }),
            ),
          { theme, unitSystem },
        );
        for (const width of [320, 390, 768, 1280]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(tap.storyPath!);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("html")).toHaveAttribute("data-unit-system", unitSystem);
          const sheet = page.locator("[data-recipe-sheet]").first();
          await expect(sheet).toBeVisible();
          await expect(page.getByRole("link", { name: "View recipe", exact: true })).toBeVisible();
          await expect(page.locator(".story-operations")).toHaveCount(0);
          await expect(
            sheet.getByRole("region", { name: "Fermentables", exact: true }).locator("li"),
          ).toHaveCount(4);
          const hops = sheet.getByRole("region", { name: "Hops", exact: true });
          await expect(hops.locator("li")).toHaveCount(4);
          expect(await hops.locator(".recipe-sheet-detail").allTextContents()).toEqual([
            expect.stringContaining("15 min"),
            expect.stringContaining("10 min"),
            expect.stringContaining("1 min"),
            expect.stringContaining("1 min"),
          ]);
          await expect(
            sheet.getByRole("region", { name: "Recipe targets", exact: true }),
          ).toContainText("6.3%");
          await expect(
            sheet.getByRole("region", { name: "Recorded measurements", exact: true }),
          ).toContainText("1.050");
          await expect(
            sheet.getByRole("region", { name: "Fermentation profile", exact: true }).locator("li"),
          ).toHaveCount(6);
          await expect(
            sheet.getByRole("region", { name: "Water profile", exact: true }),
          ).toContainText("mg/L");
          await expect(
            sheet
              .getByRole("region", { name: "Fermentation profile", exact: true })
              .locator("li")
              .nth(1),
          ).toContainText(/1 day\b/u);
          const grain = sheet.getByRole("region", { name: "Fermentables", exact: true });
          await expect(
            grain.locator(`.recipe-sheet-amount [data-unit="${unitSystem}"]`).first(),
          ).toBeVisible();
          await expect(
            grain
              .locator(
                `.recipe-sheet-amount [data-unit="${unitSystem === "us" ? "metric" : "us"}"]`,
              )
              .first(),
          ).toBeHidden();
          const positions = await sheet.locator(".recipe-sheet-column").evaluateAll((columns) =>
            columns.map((column) => ({
              x: column.getBoundingClientRect().x,
              y: column.getBoundingClientRect().y,
            })),
          );
          expect(positions[0]!.x < positions[1]!.x).toBe(width > 672);
          await noOverflow(page);
        }
      }
    }
    await page.emulateMedia({ media: "print" });
    const sheet = page.locator("[data-recipe-sheet]").first();
    expect(await sheet.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      "rgb(255, 255, 255)",
    );
    const columns = await sheet
      .locator(".recipe-sheet-column")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
    expect(columns[0]!).toBeLessThan(columns[1]!);
    await expect(page.locator(".story-flavor")).toBeHidden();
    await expect(page.locator(".story-navigation")).toBeHidden();
    await expect(page.locator(".workspace-banner")).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    const noJs = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 1000 },
    });
    try {
      const staticPage = await noJs.newPage();
      await staticPage.goto(tap.storyPath!);
      await expect(staticPage.locator("[data-recipe-sheet]")).toHaveCount(1);
      await expect(
        staticPage.getByRole("region", { name: "Mash profile", exact: true }),
      ).toBeVisible();
      await noOverflow(staticPage);
    } finally {
      await noJs.close();
    }

    await admin.goto(`/admin/taps/${tap.id}`);
    await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
    await admin.getByLabel("Enable Mystery Tap").check();
    await admin.getByRole("checkbox", { name: "Recipe", exact: true }).check();
    await admin.getByRole("button", { name: "Save Mystery settings", exact: true }).click();
    await expect(page.locator("[data-recipe-sheet] h3")).toHaveText("Mystery Tap");
    const redacted = (await (await page.request.get(api)).json()) as PublicStoryView;
    expect(redacted.title).toBe("Mystery Tap");
    expect(redacted.presentation.style).toBeNull();
    const hidden = redacted.recipes!.sources[0]!.sheet!;
    expect(hidden.summary.og).toBeNull();
    expect(hidden.summary.fg).toBeNull();
    expect(hidden.summary.abv).toBeNull();
    expect(hidden.summary.ibu).toBeNull();
    expect(hidden.summary.colorSrm).toBeNull();
    expect(hidden.summary.method).toBeNull();
    expect(hidden.measurements.og).toBeNull();
    await expect(page.locator("[data-recipe-sheet] h3")).toHaveText("Mystery Tap");
    await expect(
      page.getByRole("region", { name: "Recipe targets", exact: true }),
    ).not.toContainText("6.3%");
    await expect(page.locator("[data-recipe-sheet]")).not.toContainText("Oktoberfest");
    await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
    await admin.getByRole("checkbox", { name: "ABV", exact: true }).check();
    await admin.getByRole("button", { name: "Save Mystery settings", exact: true }).click();
    await expect(page.getByRole("region", { name: "Recipe targets", exact: true })).toContainText(
      "6.3%",
    );
    const revealed = (await (await page.request.get(api)).json()) as PublicStoryView;
    expect(revealed.recipes!.sources[0]!.sheet!.summary.og).toBeNull();
    await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
    await admin.getByRole("checkbox", { name: "Recipe", exact: true }).uncheck();
    await admin.getByRole("button", { name: "Save Mystery settings", exact: true }).click();
    await expect(page.locator("[data-recipe-sheet]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "View recipe", exact: true })).toHaveCount(0);
  } finally {
    await admin.goto(`/admin/taps/${tap.id}`);
    await admin.getByText("Mystery Tap reveal fields", { exact: true }).click();
    await admin.getByLabel("Enable Mystery Tap").uncheck();
    await admin.getByRole("checkbox", { name: "Recipe", exact: true }).uncheck();
    await admin.getByRole("checkbox", { name: "ABV", exact: true }).uncheck();
    await admin.getByRole("button", { name: "Save Mystery settings", exact: true }).click();
    if (!wasSimulation) {
      await admin.goto("/admin/simulator");
      await admin.getByRole("button", { name: "Exit simulation", exact: true }).click();
    }
    await guest.close();
  }
});
