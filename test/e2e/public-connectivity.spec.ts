/// <reference lib="dom" />

import { expect, test } from "@playwright/test";
import type { PublicHeaderView } from "../../src/features/dashboard/types.ts";
import type { AdminTapView } from "../../src/features/taps/types.ts";

test("SSE header refreshes show green Connected, yellow Partial, red Disconnected and recovery", async ({
  browser,
  page,
}) => {
  const adminContext = await browser.newContext({ javaScriptEnabled: false });
  const admin = await adminContext.newPage();
  let restoreTap: (() => Promise<void>) | undefined;
  try {
    await admin.goto("/admin/login");
    await admin.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
    await admin.getByRole("button", { name: "Sign in" }).click();
    await expect(admin).toHaveURL(/\/admin\/overview$/u);
    const csrfToken = await admin.locator('input[name="_csrf"]').first().inputValue();
    const tapsResponse = await admin.request.get("/api/admin/taps");
    expect(tapsResponse.ok()).toBe(true);
    const { taps } = (await tapsResponse.json()) as { readonly taps: readonly AdminTapView[] };
    const tap = taps.find((candidate) => candidate.enabled && !candidate.isRetired);
    if (tap === undefined) throw new Error("Expected an enabled fixture tap.");
    const updateTapName = async (name: string | null): Promise<void> => {
      const response = await admin.request.patch(`/api/admin/taps/${tap.id}`, {
        headers: { origin: new URL(admin.url()).origin, "x-csrf-token": csrfToken },
        data: { name },
      });
      expect(response.status()).toBe(200);
    };
    const headerResponse = await page.request.get("/api/public/dashboard/header");
    expect(headerResponse.ok()).toBe(true);
    let nextHeader = (await headerResponse.json()) as PublicHeaderView;
    // Mock only the public projection. A normal fixture mutation below emits
    // the real SSE event and exercises the dashboard's targeted refresh path.
    await page.route("**/api/public/dashboard/header", (route) =>
      route.fulfill({ json: nextHeader }),
    );
    const connected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/public/events" && response.status() === 200,
    );
    await page.goto("/");
    await connected;
    const header = page.locator(".public-header");
    const settings = header.getByRole("link", { name: "Settings", exact: true });
    const indicator = header.locator(".connectivity > span").first();
    const states = [
      ["healthy", "Connected", "rgb(34, 197, 94)"],
      ["degraded", "Partial", "rgb(245, 158, 11)"],
      ["disconnected", "Disconnected", "rgb(239, 68, 68)"],
      ["healthy", "Connected", "rgb(34, 197, 94)"],
    ] as const;
    restoreTap = () => updateTapName(tap.name);
    for (const [index, [connectivity, connectivityLabel, color]] of states.entries()) {
      nextHeader = { ...nextHeader, connectivity, connectivityLabel };
      const refreshed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/public/dashboard/header" &&
          response.status() === 200,
      );
      const tapRefreshed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/public/dashboard/taps/${tap.id}` &&
          response.status() === 200,
      );
      await updateTapName(`Connectivity fixture ${index}`);
      await Promise.all([refreshed, tapRefreshed]);
      await expect(header).toHaveAttribute("data-connectivity", connectivity);
      await expect(header.locator("[data-connectivity-label]")).toHaveText(connectivityLabel);
      await expect(indicator).toHaveCSS("background-color", color);
      await expect(settings).toBeVisible();
      await expect(settings).toHaveAttribute("href", "/admin/system");
      await expect(header.locator(".connectivity")).toHaveAttribute("href", "/admin");
    }
  } finally {
    try {
      await restoreTap?.();
    } finally {
      await adminContext.close();
    }
  }
});
