import { defineConfig, devices } from '@playwright/test';

// E2E runs against a REAL running environment (dev by default), not a build.
// Set E2E_BASE_URL to the deployed frontend URL (e.g. the dia-dev LoadBalancer).
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // Real-env flakiness guard: retry transient network hiccups, but a real
  // failure still fails (retries are bounded).
  retries: 2,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
