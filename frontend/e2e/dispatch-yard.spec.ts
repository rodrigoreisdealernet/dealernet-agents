import { test, expect, type Page } from '@playwright/test';

/**
 * Gating E2E coverage for the Live Yard View board (/dispatch/yard).
 *
 * Validates:
 *   - All four operational lanes render with operator-readable counts and
 *     correct empty/populated state messaging.
 *   - Display mode switches (TV, Mobile) keep board data and work-item context
 *     coherent.
 *   - Lane Open links hand off to human-readable detail pages that survive reload.
 *   - The 15-second auto-refresh cycle never clobbers independently-set filter
 *     controls (deterministically verified via page.clock.fastForward).
 *
 * All tests skip cleanly when credentials are not configured so the suite never
 * blocks CI runs in environments that do not seed the required demo data.
 *
 * Credentials:
 *   E2E_AUTH_EMAIL / E2E_AUTH_PASSWORD  — any authenticated user for /dispatch/yard
 */

const AUTH_EMAIL = process.env.E2E_AUTH_EMAIL;
const AUTH_PASSWORD = process.env.E2E_AUTH_PASSWORD;

const YARD_LANE_DEFS = [
  { key: 'going_out', title: 'Going Out', emptyMessage: 'No outbound yard work in the selected window.' },
  { key: 'coming_in', title: 'Coming In', emptyMessage: 'No inbound returns match the current filters.' },
  { key: 'needs_review', title: 'Needs Review', emptyMessage: 'No assets currently need review.' },
  { key: 'maintenance', title: 'Maintenance', emptyMessage: 'No assets currently in maintenance.' },
] as const;

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(AUTH_EMAIL!);
  await page.getByTestId('login-password').fill(AUTH_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

test.describe('dispatch/yard — Live Yard View board', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !AUTH_EMAIL || !AUTH_PASSWORD,
      'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run Live Yard View checks.'
    );
    await signIn(page);
  });

  test('all four lanes render with operator-readable counts and correct empty/populated state', async ({ page }) => {
    await page.goto('/dispatch/yard', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Live Yard View' }),
      'Live Yard View heading must be visible after navigating to /dispatch/yard'
    ).toBeVisible();

    await expect(
      page.getByText(/Auto-updates every 15 seconds/i),
      'auto-refresh indicator must be visible so operators know the board is live'
    ).toBeVisible();

    for (const lane of YARD_LANE_DEFS) {
      const laneEl = page.getByTestId(`yard-lane-${lane.key}`);
      await expect(laneEl, `${lane.title} lane must be visible on the board`).toBeVisible();
      await expect(laneEl, `${lane.title} lane heading must be present`).toContainText(lane.title);

      const countEl = page.getByTestId(`yard-lane-count-${lane.key}`);
      await expect(countEl, `${lane.title} lane count element must be visible`).toBeVisible();
      const countText = (await countEl.innerText()).trim();
      expect(
        /^\d+$/.test(countText),
        `${lane.title} lane count must be a non-negative integer, got "${countText}"`
      ).toBe(true);

      const itemCount = parseInt(countText, 10);
      if (itemCount === 0) {
        await expect(
          laneEl.getByText(lane.emptyMessage),
          `${lane.title} lane must show its explicit empty-state message when count is 0`
        ).toBeVisible();
      } else {
        await expect(
          laneEl.getByText(lane.emptyMessage),
          `${lane.title} lane must not show the empty-state message when count is ${itemCount}`
        ).not.toBeVisible();
      }
    }
  });

  test('display mode switches keep work-item context coherent across TV and Mobile modes', async ({ page }) => {
    await page.goto('/dispatch/yard', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Live Yard View' })).toBeVisible();

    // Capture the title of the first visible work item to verify it survives mode switches.
    const firstOpenLink = page.getByRole('link', { name: 'Open' }).first();
    let anchorItemTitle: string | null = null;
    if (await firstOpenLink.isVisible()) {
      const itemCard = page.getByTestId('yard-item-card').filter({ has: firstOpenLink });
      const titleText = (await itemCard.locator('p').first().innerText()).trim();
      if (titleText) anchorItemTitle = titleText;
    }

    // Switch to TV mode and verify board data persists.
    await page.getByRole('button', { name: 'TV' }).click();
    await expect(
      page.getByRole('button', { name: 'TV' }),
      'TV display mode button must indicate it is active via aria-pressed="true"'
    ).toHaveAttribute('aria-pressed', 'true');
    if (anchorItemTitle) {
      await expect(
        page.getByText(anchorItemTitle),
        `anchor work item "${anchorItemTitle}" must remain visible after switching to TV mode`
      ).toBeVisible();
    }
    await expect(
      page.getByTestId('yard-lane-going_out'),
      'Going Out lane must remain visible after switching to TV mode'
    ).toBeVisible();

    // Switch to Mobile mode and verify all lanes and board data persist.
    await page.getByRole('button', { name: 'Mobile' }).click();
    await expect(
      page.getByRole('button', { name: 'Mobile' }),
      'Mobile display mode button must indicate it is active via aria-pressed="true"'
    ).toHaveAttribute('aria-pressed', 'true');
    if (anchorItemTitle) {
      await expect(
        page.getByText(anchorItemTitle),
        `anchor work item "${anchorItemTitle}" must remain visible after switching to Mobile mode`
      ).toBeVisible();
    }

    for (const lane of YARD_LANE_DEFS) {
      await expect(
        page.getByTestId(`yard-lane-${lane.key}`),
        `yard-lane-${lane.key} must still be visible after switching to Mobile mode`
      ).toBeVisible();
    }
  });

  test('lane Open link handoff navigates to a human-readable detail page that survives reload', async ({ page }) => {
    await page.goto('/dispatch/yard', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Live Yard View' })).toBeVisible();

    const openLinks = page.getByRole('link', { name: 'Open' });
    const openLinkCount = await openLinks.count();
    expect(
      openLinkCount,
      'The dev board must have at least one work item with an Open link when credentials are configured. ' +
      'Verify that the demo seed data is applied (rental orders, contracts, or assets with active yard activity ' +
      'must be present in the database so this journey can be exercised).'
    ).toBeGreaterThan(0);

    const firstOpenLink = openLinks.first();
    const itemCard = page.getByTestId('yard-item-card').filter({ has: firstOpenLink });
    const itemTitle = (await itemCard.locator('p').first().innerText()).trim();

    expect(
      itemTitle,
      'work item title must be human-readable before following the Open link — a bare UUID is not operator-readable'
    ).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    await firstOpenLink.click();
    await expect(
      page,
      'Open link must navigate to a rental order, contract, or asset detail route'
    ).toHaveURL(/\/(rental\/orders|rental\/contracts|entities\/asset)\//);
    await page.waitForLoadState('networkidle');

    const detailHeading = page.getByRole('heading', { level: 1 }).first();
    await expect(
      detailHeading,
      'detail page heading must be visible immediately after following the lane Open link'
    ).toBeVisible({ timeout: 10_000 });

    const headingText = (await detailHeading.innerText()).trim();
    expect(
      headingText,
      'detail page heading must be human-readable — a bare UUID must not be the primary operator-facing identifier'
    ).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      detailHeading,
      'detail page heading must remain visible after reload'
    ).toBeVisible({ timeout: 10_000 });

    const headingTextAfterReload = (await detailHeading.innerText()).trim();
    expect(
      headingTextAfterReload,
      'detail page heading must remain human-readable after reload'
    ).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(
      headingTextAfterReload,
      'detail page heading must not change after reload — work-item context must be durable across the reload boundary'
    ).toBe(headingText);
  });

  test('auto-refresh board data cycle does not clobber independently-set filter controls', async ({ page }) => {
    // Install a fake clock before navigating so the component's setInterval
    // is registered against the fake timer. Network requests are not affected;
    // this only controls setTimeout/setInterval/Date, letting us advance time
    // deterministically past the 15-second refresh boundary without waiting.
    await page.clock.install();

    await page.goto('/dispatch/yard', { waitUntil: 'load' });
    // Wait for the initial board data fetch (triggered on mount) to complete.
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Live Yard View' })).toBeVisible();

    const locationSelect = page.locator('#yard-location-filter');
    const timeWindowSelect = page.locator('#yard-time-window-filter');

    await expect(locationSelect, 'location filter select must be present').toBeVisible();
    await expect(timeWindowSelect, 'time window filter select must be present').toBeVisible();

    // Apply the "Next 7 days" time-window filter.
    await timeWindowSelect.selectOption({ value: '7d' });
    await expect(timeWindowSelect, 'time window must show "Next 7 days" after selection').toHaveValue('7d');

    // Apply a location filter if branch options are seeded in this environment.
    const locationOptionEls = await locationSelect.locator('option').all();
    let appliedLocationValue = '';
    if (locationOptionEls.length > 1) {
      appliedLocationValue = (await locationOptionEls[1]?.getAttribute('value')) ?? '';
      if (appliedLocationValue) {
        await locationSelect.selectOption({ value: appliedLocationValue });
        await expect(locationSelect).toHaveValue(appliedLocationValue);
      }
    }

    // Advance the fake clock 16 seconds past the 15-second refresh boundary.
    // This deterministically fires the setInterval callback, which invokes
    // refreshBoard() and makes real Supabase fetch calls to update board data.
    await page.clock.fastForward(16_000);
    // Wait for the async refreshBoard network calls to settle.
    await page.waitForLoadState('networkidle');

    // Filter controls must be unaffected by the board data refresh cycle.
    // This is the core invariant: refreshBoard must not clobber independent filter state.
    await expect(
      timeWindowSelect,
      'time window filter must still show "Next 7 days" after a board auto-refresh cycle — refreshBoard must not touch independent filter state'
    ).toHaveValue('7d');
    if (appliedLocationValue) {
      await expect(
        locationSelect,
        'location filter must still show the selected location after a board auto-refresh cycle'
      ).toHaveValue(appliedLocationValue);
    }

    // Board structure must remain intact after the refresh — all four lanes present and
    // each count is still a valid non-negative integer, confirming the board respects
    // the applied filter scope rather than regressing to an error or blank state.
    for (const lane of YARD_LANE_DEFS) {
      await expect(
        page.getByTestId(`yard-lane-${lane.key}`),
        `${lane.key} lane must still be visible after the board auto-refresh cycle with filters applied`
      ).toBeVisible();
      const countEl = page.getByTestId(`yard-lane-count-${lane.key}`);
      await expect(countEl, `${lane.key} lane count element must still be visible after refresh`).toBeVisible();
      const countText = (await countEl.innerText()).trim();
      expect(
        /^\d+$/.test(countText),
        `${lane.key} lane count must still be a non-negative integer after refresh, got "${countText}"`
      ).toBe(true);
    }
  });
});
