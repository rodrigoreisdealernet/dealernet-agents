import { test, expect, type Locator, type Page } from '@playwright/test';

const OPERATOR_EMAIL = process.env.E2E_MANAGER_EMAIL || process.env.E2E_AUTH_EMAIL;
const OPERATOR_PASSWORD = process.env.E2E_MANAGER_PASSWORD || process.env.E2E_AUTH_PASSWORD;

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(OPERATOR_EMAIL!);
  await page.getByTestId('login-password').fill(OPERATOR_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

async function selectComboboxOption(page: Page, label: string, optionText: string): Promise<void> {
  const combobox = page.getByRole('combobox', { name: label });
  await combobox.click();
  await page.getByRole('option', { name: optionText, exact: true }).click();
}

async function openFirstPendingFinding(page: Page): Promise<string> {
  await page.goto('/ops/findings');
  await page.waitForLoadState('networkidle');
  if ((await page.getByRole('link', { name: 'Open finding' }).count()) === 0) {
    test.skip(true, 'Ops findings not seeded in this environment yet');
  }

  await selectComboboxOption(page, 'Status', 'pending_approval');

  const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
  await expect(openFindingLinks.nth(1), 'expected at least two pending findings from seed').toBeVisible();
  await openFindingLinks.first().click();

  const findingHeading = page.locator('main').getByRole('heading', { level: 1 }).first();
  await expect(findingHeading).toBeVisible();
  return (await findingHeading.innerText()).trim();
}

async function waitForDispositionResponse(page: Page, expectedDecision: 'approve' | 'reject'): Promise<void> {
  const response = await page.waitForResponse((res) => {
    if (res.request().method() !== 'POST') {
      return false;
    }
    if (res.url().includes('/api/ops/findings/decision')) {
      try {
        const body = JSON.parse(res.request().postData() ?? '{}') as { decision?: string };
        return body.decision === expectedDecision;
      } catch {
        return false;
      }
    }
    return res.url().includes(`/api/ops/findings/`) && res.url().endsWith(`/${expectedDecision}`);
  });
  expect(response.status(), `${expectedDecision} endpoint should return accepted`).toBe(202);
}

async function expectFindingNotInPendingQueue(page: Page, findingType: string): Promise<void> {
  await page.goto('/ops/findings');
  await page.waitForLoadState('networkidle');
  await selectComboboxOption(page, 'Status', 'pending_approval');

  await expect.poll(async () => {
    return await page.getByRole('heading', { name: findingType }).count();
  }, {
    timeout: 20_000,
    message: `finding ${findingType} should leave the pending queue after disposition`,
  }).toBe(0);
}

async function expectAuditUpdates(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Open audit trail' }).click();
  await expect(page.getByRole('heading', { name: 'Ops Audit Trail' })).toBeVisible();

  await expect.poll(async () => {
    const payloadRows: Locator = page.getByText(/^Payload:/);
    const texts = await payloadRows.allInnerTexts();
    return texts.join(' ');
  }, {
    timeout: 30_000,
    message: 'expected approval audit payloads to include drafted adjustment and approval nodes',
  }).toContain('adjustment_drafted');

  await expect.poll(async () => {
    const payloadRows: Locator = page.getByText(/^Payload:/);
    const texts = await payloadRows.allInnerTexts();
    return texts.join(' ');
  }, {
    timeout: 30_000,
    message: 'expected approval audit payloads to include finding approval node',
  }).toContain('finding_approved');
}

test.describe('@smoke ops approve/reject flow', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!OPERATOR_EMAIL || !OPERATOR_PASSWORD, 'Set manager/admin E2E credentials to run ops approval smoke coverage.');
    await signIn(page);
  });

  test('approve one pending finding and reject another', async ({ page }) => {
    const findingToApprove = await openFirstPendingFinding(page);

    const approvePromise = waitForDispositionResponse(page, 'approve');
    await page.getByLabel('Approval note (optional)').fill('E2E approval coverage');
    await page.getByRole('button', { name: 'Approve' }).click();
    await approvePromise;

    await expect(page.getByText(/approved/i).first()).toBeVisible();
    await expectAuditUpdates(page);
    await expectFindingNotInPendingQueue(page, findingToApprove);

    const findingToReject = await openFirstPendingFinding(page);
    const rejectPromise = waitForDispositionResponse(page, 'reject');
    await page.getByLabel('Reject reason').fill('E2E reject coverage');
    await page.getByRole('button', { name: 'Reject' }).click();
    await rejectPromise;

    await expect(page.getByText(/rejected/i).first()).toBeVisible();
    await expectFindingNotInPendingQueue(page, findingToReject);
  });
});
