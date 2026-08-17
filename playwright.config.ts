import { defineConfig, devices } from "@playwright/test";

const e2ePort = process.env.TAPBOARD_E2E_PORT ?? "4176";
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: process.env.TAPBOARD_E2E_OUTPUT_DIR ?? "test-results",
  expect: { timeout: 8_000 },
  use: {
    baseURL: e2eOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  ...(process.env.TAPBOARD_E2E_EXTERNAL_SERVER === "1"
    ? {}
    : {
        webServer: {
          command: "node test/e2e/server.ts",
          url: `${e2eOrigin}/healthz`,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});
