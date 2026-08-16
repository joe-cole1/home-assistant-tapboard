import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://127.0.0.1:4176",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  ...(process.env.TAPBOARD_E2E_EXTERNAL_SERVER === "1"
    ? {}
    : {
        webServer: {
          command: "node test/e2e/server.ts",
          url: "http://127.0.0.1:4176/healthz",
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
