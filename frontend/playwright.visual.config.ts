import { defineConfig, devices } from '@playwright/test';

// Daily VISUAL/UX capture run. Drives the real deployed app (same target as the
// normal e2e) through the existing journey specs at multiple breakpoints, with the
// ux-capture fixture writing a screenshot + axe report per test. It asserts nothing
// new — failures here are the journeys' own, and capture is best-effort regardless.
//
// Invoked by .github/workflows/visual-ux.yml (and `npm run e2e:visual` locally) with
// CAPTURE_UX=1. The artifacts feed the ux-vision-reviewer agent.
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  // Capture the rich usability journeys. Add more specs here as their imports adopt
  // the ux-capture fixture.
  testMatch: ['experience.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,
  workers: 1, // serial — manifest.jsonl is appended to from the fixture teardown
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'off',
    screenshot: 'off', // the fixture owns screenshots
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
