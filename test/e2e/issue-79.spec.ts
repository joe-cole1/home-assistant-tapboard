/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";

const ENDPOINT_SENTINEL = "https://issue-79-private.invalid/webhook-secret";
const TOKEN_SENTINEL = "ISSUE_79_PRIVATE_HA_TOKEN";
const HEADER_SENTINEL = "ISSUE_79_PRIVATE_HEADER_SECRET";

async function login(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.getByRole("textbox", { name: "Admin PIN" }).fill("1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/admin\/overview$/u);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
}

test("Issue 79 outbound Admin forms are SSR-safe, disabled by default in setup, and responsive", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await login(page);

  await page.goto("/admin/integrations");
  await expect(page.getByRole("link", { name: /Open outbound delivery/u })).toBeVisible();
  await page.getByRole("link", { name: /Open outbound delivery/u }).click();
  await expect(page).toHaveURL(/\/admin\/integrations\/outbound$/u);

  await page.goto("/admin/integrations/outbound/new?transport=home_assistant");
  await page.getByLabel("Friendly name").fill("Issue 79 disabled Home Assistant");
  await page.getByLabel("Base URL").fill("http://home-assistant.lan:8123");
  await page.getByLabel("Token").fill(TOKEN_SENTINEL);
  const subscriptions = page.locator('input[type="checkbox"][name^="subscription_"]');
  await expect(subscriptions).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) await expect(subscriptions.nth(index)).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Required destination/u })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /^Enabled/u }).uncheck();
  await page.getByRole("button", { name: "Create outbound destination" }).click();
  await expect(page).toHaveURL(/\/admin\/integrations\/outbound\?notice=/u);
  expect(await page.content()).not.toContain(TOKEN_SENTINEL);

  await page.goto("/admin/integrations/outbound/new?transport=webhook");
  await page.getByLabel("Friendly name").fill("Issue 79 disabled Discord webhook");
  await page.getByLabel("Endpoint").fill(ENDPOINT_SENTINEL);
  await page.getByLabel("Payload format").selectOption("discord");
  await page.locator('input[name="static_header_0_name"]').fill("X-Issue-79");
  await page.locator('input[name="static_header_0_value"]').fill("tapboard");
  await page.locator('input[name="secret_header_0_name"]').fill("X-Webhook-Secret");
  await page.locator('input[name="secret_header_0_slot"]').fill("issue-79-secret");
  await page.locator('input[name="secret_header_0_value"]').fill(HEADER_SENTINEL);
  await expect(page.getByRole("checkbox", { name: /^Required destination/u })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /^Enabled/u }).uncheck();
  await page.getByRole("button", { name: "Create outbound destination" }).click();
  await expect(page).toHaveURL(/\/admin\/integrations\/outbound\?notice=/u);
  const listHtml = await page.content();
  expect(listHtml).not.toContain(ENDPOINT_SENTINEL);
  expect(listHtml).not.toContain(HEADER_SENTINEL);

  await page.getByRole("link", { name: "Issue 79 disabled Discord webhook" }).click();
  await expect(page).toHaveURL(/\/admin\/integrations\/outbound\/[^/]+$/u);
  await expect(page.getByText("Discord webhook JSON")).toHaveCount(1);
  const detailHtml = await page.content();
  expect(detailHtml).not.toContain(ENDPOINT_SENTINEL);
  expect(detailHtml).not.toContain(HEADER_SENTINEL);
  expect(detailHtml).not.toContain(TOKEN_SENTINEL);
  await expect(page.getByRole("heading", { name: "Delivery history" })).toBeVisible();

  for (const width of [390, 800, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await assertNoHorizontalOverflow(page);
  }
  await context.close();
});
