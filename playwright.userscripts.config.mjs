import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts/userscripts/e2e",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/userscripts-e2e",
  use: {
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
