import { test, expect, type Page } from '@playwright/test';

const OPERATOR_EMAIL = process.env.E2E_MANAGER_EMAIL || process.env.E2E_AUTH_EMAIL;
const OPERATOR_PASSWORD = process.env.E2E_MANAGER_PASSWORD || process.env.E2E_AUTH_PASSWORD;

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(OPERATOR_EMAIL!);
  await page.getByTestId('login-password').fill(OPERATOR_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

test.describe('@smoke ops findings console', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!OPERATOR_EMAIL || !OPERATOR_PASSWORD, 'Set manager/admin E2E credentials to run ops findings smoke coverage.');
    await signIn(page);
  });

  test('/ops dashboard loads seeded business workflow cards and KPI cards', async ({ page }) => {
    await page.goto('/ops');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Operations Dashboard' })).toBeVisible();
    await expect(page.getByText('Items awaiting review', { exact: true })).toBeVisible();
    const recoverableRevenueCard = page
      .locator('div.rounded-lg.border.bg-card.text-card-foreground.shadow-sm')
      .filter({ has: page.getByText('Revenue opportunities', { exact: true }) });
    await expect(recoverableRevenueCard).toHaveCount(1);
    await expect(recoverableRevenueCard).toBeVisible();
    const recoverableRevenueValue = recoverableRevenueCard.getByRole('heading', { level: 2 });
    await expect(recoverableRevenueValue).toHaveText(/\$5,020(?:\.00)?/);
    await expect(page.getByText('Approved this cycle')).toBeVisible();
    await expect(page.getByText('Audit events (24h)')).toBeVisible();

    const pageBody = await page.locator('body').innerText();
    expect(pageBody).toMatch(/\$\s?4,420(?:\.00)?/);
    await expect(page.getByText('Business workflows')).toBeVisible();
    await expect(page.getByText('Revenue Recognition')).toBeVisible();
  });

  test('/ops/findings lists seeded findings sorted by dollar impact', async ({ page }) => {
    await page.goto('/ops/findings');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Audit History' })).toBeVisible();
    if ((await page.getByRole('link', { name: 'Open finding' }).count()) === 0) {
      test.skip(true, 'Ops findings not seeded in this environment yet');
    }

    const body = await page.locator('body').innerText();
    const deltas = Array.from(body.matchAll(/Delta:\s*\$([0-9,]+(?:\.\d+)?)/g)).map((match) =>
      Number(match[1].replaceAll(',', ''))
    );

    expect(deltas.length, 'expected seeded findings with visible delta values').toBeGreaterThanOrEqual(5);

    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i - 1], `findings are not sorted descending by delta at index ${i}`).toBeGreaterThanOrEqual(deltas[i]);
    }
  });

  test('finding detail renders evidence, rationale, and expected-vs-billed', async ({ page }) => {
    await page.goto('/ops/findings');
    await page.waitForLoadState('networkidle');

    const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
    if ((await openFindingLinks.count()) === 0) {
      test.skip(true, 'Ops findings not seeded in this environment yet');
    }
    await expect(openFindingLinks.first()).toBeVisible();
    await openFindingLinks.first().click();

    await expect(page).toHaveURL(/\/ops\/findings\/[0-9a-f-]+/i);
    await expect(page.getByText('Expected')).toBeVisible();
    await expect(page.getByText('Billed')).toBeVisible();
    await expect(page.getByText('Evidence checklist')).toBeVisible();
    await expect(page.getByText('Rationale & confidence')).toBeVisible();

    await expect(page.getByText(/^Amount:\s*\$/).first()).toBeVisible();
    await expect(page.getByText(/^Rate type:/).first()).toBeVisible();
    await expect(page.getByText(/^☑\s/).first()).toBeVisible();
  });
});
