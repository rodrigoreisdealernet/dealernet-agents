import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

/**
 * UX-capture fixture — turns the existing e2e journeys into a screenshot + axe
 * feed for the daily `ux-vision-reviewer` agent (see .github/workflows/visual-ux.yml
 * and .github/agents/ux-vision-reviewer.agent.md).
 *
 * It is a **pass-through unless `CAPTURE_UX` is set**, so importing it in a spec
 * changes nothing for the normal (hourly) e2e runs — capture only happens in the
 * dedicated daily visual run. A failed capture never fails the test.
 *
 * When active, at the END of every test that actually ran (not skipped), it writes,
 * into `UX_ARTIFACT_DIR` (default `<cwd>/visual-artifacts`):
 *   <test>__<breakpoint>.png        full-page screenshot of the journey's end state
 *   <test>__<breakpoint>.axe.json   axe-core WCAG 2.0/2.1 A/AA violations for that state
 * and appends one line to `manifest.jsonl` describing the capture so the reviewing
 * agent has structured per-test context (title, breakpoint, url, status, axe count).
 */

const CAPTURE = !!process.env.CAPTURE_UX;
const ARTIFACT_DIR = process.env.UX_ARTIFACT_DIR || join(process.cwd(), 'visual-artifacts');

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

// Kill animations/transitions and the blinking caret so the end-state screenshot
// is stable (not a pixel baseline — just less visual noise for the critique model).
const STABILIZE_CSS =
  '*,*::before,*::after{transition:none!important;animation:none!important;' +
  'scroll-behavior:auto!important;caret-color:transparent!important}';

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    if (!CAPTURE) {
      await use(page);
      return;
    }

    await page.addInitScript((css: string) => {
      const inject = () => {
        if (!document.head) {
          requestAnimationFrame(inject);
          return;
        }
        const style = document.createElement('style');
        style.setAttribute('data-ux-capture', '');
        style.innerHTML = css;
        document.head.appendChild(style);
      };
      inject();
    }, STABILIZE_CSS);

    await use(page);

    // Teardown: capture the journey's final state. Best-effort — never throw.
    if (testInfo.status === 'skipped') return;
    try {
      const breakpoint = slug(testInfo.project.name || 'default');
      const name = `${slug(testInfo.title)}__${breakpoint}`;
      mkdirSync(ARTIFACT_DIR, { recursive: true });

      try {
        await page.evaluate(() => (document as Document).fonts?.ready);
      } catch {
        // fonts API unavailable — proceed anyway.
      }

      const pngPath = join(ARTIFACT_DIR, `${name}.png`);
      await page.screenshot({ path: pngPath, fullPage: true, animations: 'disabled' });

      let violationCount: number | null = null;
      try {
        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        violationCount = axe.violations.length;
        writeFileSync(
          join(ARTIFACT_DIR, `${name}.axe.json`),
          JSON.stringify(
            {
              url: page.url(),
              violations: axe.violations.map((v) => ({
                id: v.id,
                impact: v.impact,
                help: v.help,
                helpUrl: v.helpUrl,
                nodes: v.nodes.length,
              })),
            },
            null,
            2,
          ),
        );
      } catch {
        // axe injection can fail on some states — screenshot alone is still useful.
      }

      appendFileSync(
        join(ARTIFACT_DIR, 'manifest.jsonl'),
        JSON.stringify({
          test: testInfo.title,
          file: testInfo.file ? testInfo.file.split('/').pop() : null,
          breakpoint,
          screenshot: `${name}.png`,
          axe: violationCount === null ? null : `${name}.axe.json`,
          axe_violations: violationCount,
          url: page.url(),
          status: testInfo.status,
        }) + '\n',
      );
    } catch {
      // Capture is non-essential telemetry — swallow everything.
    }
  },
});

export { expect };
export type { Page };
