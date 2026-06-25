import { test, expect, type Page } from '@playwright/test';

const FIELD_OPERATOR_EMAIL = process.env.E2E_FIELD_OPERATOR_EMAIL || process.env.E2E_AUTH_EMAIL;
const FIELD_OPERATOR_PASSWORD = process.env.E2E_FIELD_OPERATOR_PASSWORD || process.env.E2E_AUTH_PASSWORD;
const CATEGORY_CHECKLIST_ASSERTIONS = [
  { pattern: /excavat/i, key: 'track_condition', prompt: 'Tracks in serviceable condition (no cracks, missing pads)' },
  { pattern: /forklift|lift truck|reach truck/i, key: 'fork_blades', prompt: 'Fork blades straight with no visible cracks' },
  { pattern: /crane|hoist/i, key: 'wire_rope', prompt: 'Wire rope in serviceable condition (no kinks, breaks)' },
  { pattern: /aerial|awp|boom lift|scissor lift|mewp/i, key: 'platform_condition', prompt: 'Platform/basket in undamaged condition' },
  { pattern: /compressor/i, key: 'compressor_oil', prompt: 'Compressor oil level within range' },
  { pattern: /generator/i, key: 'output_voltage', prompt: 'Output voltage correct at no load' },
  { pattern: /telehandler|telescopic handler/i, key: 'forks_attachment', prompt: 'Forks / attachment in serviceable condition' },
  { pattern: /skid.?steer|compact track loader|ctl/i, key: 'chain_tension', prompt: 'Drive chain / track tension correct' },
] as const;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fillConfirmLoadDetails(page: Page) {
  const timestamp = new Date().toISOString().slice(0, 16);
  await page.getByLabel('Assigned driver').fill(`E2E Driver ${Date.now()}`);
  await page.getByLabel('Assigned truck').fill(`TRK-${Date.now()}`);
  await page.getByLabel('Departure timestamp').fill(timestamp);
  await page.getByLabel('Driver signature').fill(`E2E Driver Signature ${Date.now()}`);
}

interface FieldTaskContext {
  assetName: string;
  contractLabel: string;
  customerName: string;
  jobSiteName: string;
}

const AMBIGUOUS_SCAN_STOPWORDS = new Set([
  'delivery',
  'checkout',
  'pickup',
  'return',
  'inspection',
  'contract',
  'customer',
  'asset',
  'site',
  'task',
]);

function readLabeledValue(text: string, label: string): string {
  return text.replace(new RegExp(`^${escapeRegExp(label)}\\s*`), '').trim();
}

async function readSelectedTaskContext(page: Page): Promise<FieldTaskContext> {
  await expect(page.getByRole('heading', { name: 'Task context' })).toBeVisible();

  const assetText = await page.locator('p').filter({ hasText: /^Asset:/ }).first().innerText();
  const contractText = await page.locator('p').filter({ hasText: /^Contract:/ }).first().innerText();
  const customerText = await page.locator('p').filter({ hasText: /^Customer:/ }).first().innerText();
  const jobSiteText = await page.locator('p').filter({ hasText: /^Job site:/ }).first().innerText();

  return {
    assetName: readLabeledValue(assetText, 'Asset:'),
    contractLabel: readLabeledValue(contractText, 'Contract:'),
    customerName: readLabeledValue(customerText, 'Customer:'),
    jobSiteName: readLabeledValue(jobSiteText, 'Job site:'),
  };
}

async function collectTaskContexts(page: Page, workflowLabel: RegExp): Promise<FieldTaskContext[]> {
  const taskButtons = page.getByRole('button', { name: workflowLabel });
  const taskCount = await taskButtons.count();
  const contexts: FieldTaskContext[] = [];

  for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
    await taskButtons.nth(taskIndex).click();
    contexts.push(await readSelectedTaskContext(page));
  }

  return contexts;
}

function tokenizeQuickScanCandidates(...values: string[]): string[] {
  return values.flatMap((value) =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !/^\d+$/.test(token) && !AMBIGUOUS_SCAN_STOPWORDS.has(token))
  );
}

function findAmbiguousQuickScanToken(tasks: FieldTaskContext[]): string | null {
  const tokenMatches = new Map<string, Set<string>>();

  for (const task of tasks) {
    const taskId = `${task.contractLabel}::${task.assetName}`;
    for (const token of new Set(tokenizeQuickScanCandidates(task.assetName, task.contractLabel))) {
      if (!tokenMatches.has(token)) {
        tokenMatches.set(token, new Set());
      }
      tokenMatches.get(token)!.add(taskId);
    }
  }

  const ambiguousTokens = Array.from(tokenMatches.entries())
    .filter(([, matches]) => matches.size > 1)
    .sort((left, right) => right[1].size - left[1].size || right[0].length - left[0].length);

  return ambiguousTokens[0]?.[0] ?? null;
}

async function findTaskButtonByAssetName(page: Page, assetName: string) {
  const taskButtons = page.getByRole('button', { name: /^(Delivery \/ Checkout|Pickup \/ Return|Inspection)/i });
  const taskCount = await taskButtons.count();
  for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
    const taskButton = taskButtons.nth(taskIndex);
    if ((await taskButton.innerText()).includes(assetName)) {
      return taskButton;
    }
  }
  return null;
}

test.describe('field mobile workflows', () => {
  test('queue query is scoped to assigned field operator', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run field-mobile E2E.'
    );

    const queueRequestUrls: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('/rest/v1/v_rental_contract_line_current')) {
        queueRequestUrls.push(url);
      }
    });

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/mobile', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Field Task Queue' })).toBeVisible();
    expect(queueRequestUrls.length, 'field queue should request contract lines').toBeGreaterThan(0);
    expect(
      queueRequestUrls.some((url) =>
        /or=.*(field_operator_id|assigned_operator_id|assigned_to|operator_id|created_by)/.test(url)
      ),
      `expected field-operator assignment filter in queue request URL: ${queueRequestUrls.join('\n')}`
    ).toBe(true);
  });

  test('checkout transition persists On rent status after refresh', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run field-mobile E2E.'
    );

    const writeStatuses: number[] = [];
    page.on('response', (response) => {
      if (
        response.url().includes('/rpc/rental_upsert_entity_current_state') &&
        response.request().method() === 'POST'
      ) {
        writeStatuses.push(response.status());
      }
    });

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/mobile', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const checkoutTask = page.getByRole('button', { name: /Delivery \/ Checkout/i }).first();
    if ((await checkoutTask.count()) === 0) {
      test.skip(true, 'No checkout task available for this field operator in current environment.');
    }

    await checkoutTask.click();
    const assetText = (await page.getByText(/^Asset:/).first().innerText()).replace(/^Asset:\s*/, '').trim();

    await page.getByLabel('Customer/operator signature').fill(`E2E Checkout ${Date.now()}`);
    await fillConfirmLoadDetails(page);
    await page.getByRole('button', { name: 'Complete checkout' }).click();
    await expect(page.getByText(/checkout completed/i)).toBeVisible({ timeout: 20_000 });
    expect(writeStatuses.some((status) => status < 400), `write status codes: ${writeStatuses.join(', ')}`).toBe(true);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('button', { name: new RegExp(`Delivery \\/ Checkout[\\s\\S]*${escapeRegExp(assetText)}`) })
    ).toHaveCount(0);
    const returnTask = page.getByRole('button', {
      name: new RegExp(`Pickup \\/ Return[\\s\\S]*${escapeRegExp(assetText)}`, 'i'),
    });
    await expect(returnTask).toHaveCount(1, { timeout: 20_000 });
    await returnTask.click();
    await expect(page.getByText('Asset: On rent')).toBeVisible();
  });

  test('quick checkout scan resolves pending work, shows context, and persists after reload', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run field-mobile E2E.'
    );

    const writeStatuses: number[] = [];
    page.on('response', (response) => {
      if (
        response.url().includes('/rpc/rental_upsert_entity_current_state') &&
        response.request().method() === 'POST'
      ) {
        writeStatuses.push(response.status());
      }
    });

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/mobile', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const checkoutTasks = await collectTaskContexts(page, /^Delivery \/ Checkout/i);
    if (checkoutTasks.length === 0) {
      test.skip(true, 'No checkout task available for this field operator in current environment.');
      return;
    }

    const quickCheckoutTask = checkoutTasks[0];

    await page.getByLabel('Scan or enter asset identifier').fill(quickCheckoutTask.contractLabel);
    await page.getByRole('button', { name: 'Find task' }).click();

    const quickPanel = page.getByTestId('quick-order-panel');
    await expect(quickPanel).toBeVisible();
    await expect(quickPanel).toContainText(quickCheckoutTask.assetName);
    await expect(quickPanel).toContainText(quickCheckoutTask.customerName);
    await expect(quickPanel).toContainText(quickCheckoutTask.jobSiteName);
    await expect(quickPanel).toContainText(`Contract: ${quickCheckoutTask.contractLabel}`);

    await fillConfirmLoadDetails(page);
    await page.getByLabel('Customer/operator signature').fill(`E2E Quick Checkout ${Date.now()}`);
    await page.getByRole('button', { name: 'Quick checkout' }).click();

    await expect(page.getByTestId('quick-checkout-status')).toContainText(
      `Quick checkout completed for ${quickCheckoutTask.assetName}.`,
      { timeout: 20_000 }
    );
    expect(writeStatuses.some((status) => status < 400), `write status codes: ${writeStatuses.join(', ')}`).toBe(true);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await page.getByLabel('Scan or enter asset identifier').fill(quickCheckoutTask.contractLabel);
    await page.getByRole('button', { name: 'Find task' }).click();

    await expect(
      page.getByText('No pending checkout task found for this asset. Check the task queue below.')
    ).toBeVisible();
    await expect(page.getByTestId('quick-order-panel')).toHaveCount(0);

    const returnTask = page.getByRole('button', {
      name: new RegExp(`Pickup \\/ Return[\\s\\S]*${escapeRegExp(quickCheckoutTask.assetName)}`, 'i'),
    });
    await expect(returnTask).toHaveCount(1, { timeout: 20_000 });
    await returnTask.click();
    await expect(page.getByText('Asset: On rent')).toBeVisible();
  });

  test('ambiguous quick checkout scan asks for refinement without mutating task state', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run field-mobile E2E.'
    );

    const writeStatuses: number[] = [];
    page.on('response', (response) => {
      if (
        response.url().includes('/rpc/rental_upsert_entity_current_state') &&
        response.request().method() === 'POST'
      ) {
        writeStatuses.push(response.status());
      }
    });

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/mobile', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const checkoutTasks = await collectTaskContexts(page, /^Delivery \/ Checkout/i);
    if (checkoutTasks.length < 2) {
      test.skip(true, 'Need at least two checkout tasks to validate ambiguous scan handling.');
      return;
    }

    const ambiguousToken = findAmbiguousQuickScanToken(checkoutTasks);
    if (!ambiguousToken) {
      test.skip(true, 'No shared checkout scan token was available in this environment.');
      return;
    }

    const matchingContractLabels = checkoutTasks
      .filter(
        (task) =>
          task.assetName.toLowerCase().includes(ambiguousToken) || task.contractLabel.toLowerCase().includes(ambiguousToken)
      )
      .map((task) => task.contractLabel)
      .sort();

    await page.getByLabel('Scan or enter asset identifier').fill(ambiguousToken);
    await page.getByRole('button', { name: 'Find task' }).click();

    await expect(
      page.getByText('Multiple checkout tasks match this input. Enter a more specific value to identify the asset.')
    ).toBeVisible();
    await expect(page.getByTestId('quick-order-panel')).toHaveCount(0);
    expect(writeStatuses).toHaveLength(0);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const checkoutContractsAfterReload = (await collectTaskContexts(page, /^Delivery \/ Checkout/i))
      .map((task) => task.contractLabel)
      .sort();
    expect(checkoutContractsAfterReload).toEqual(expect.arrayContaining(matchingContractLabels));
  });

  test('category-specific checklist context survives reload for the same task', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run field-mobile E2E.'
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/mobile', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Field Task Queue' })).toBeVisible();

    const taskButtons = page.getByRole('button', { name: /^(Delivery \/ Checkout|Pickup \/ Return|Inspection)/i });
    const taskCount = await taskButtons.count();

    let matchedChecklistAssertion:
      | (typeof CATEGORY_CHECKLIST_ASSERTIONS)[number]
      | null = null;
    let matchedChecklistDescription = '';
    let matchedAssetName = '';

    for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
      await taskButtons.nth(taskIndex).click();
      await expect(page.getByText('Inspection checklist')).toBeVisible();

      const checklistDescriptions = page.getByText(/^(Pickup|Return) checklist(?: — .+)?$/);
      if ((await checklistDescriptions.count()) === 0) {
        continue;
      }
      const description = (await checklistDescriptions.first().innerText()).trim();
      const checklistAssertion =
        CATEGORY_CHECKLIST_ASSERTIONS.find((candidate) => candidate.pattern.test(description)) ?? null;
      if (!checklistAssertion) {
        continue;
      }

      await expect(page.getByText(checklistAssertion.prompt)).toBeVisible();
      matchedChecklistAssertion = checklistAssertion;
      matchedChecklistDescription = description;
      matchedAssetName = (await page.getByText(/^Asset:/).first().innerText()).replace(/^Asset:\s*/, '').trim();
      break;
    }

    if (!matchedChecklistAssertion) {
      test.skip(true, 'No category-mapped field task was available in this environment.');
      return;
    }

    const note = `E2E checklist reload ${Date.now()}`;
    await page.getByLabel(`${matchedChecklistAssertion.key} fail`).click();
    await page.getByLabel(`Note for ${matchedChecklistAssertion.key}`).fill(note);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reopenedTask = await findTaskButtonByAssetName(page, matchedAssetName);
    if (!reopenedTask) {
      throw new Error(`Unable to re-open field task for asset ${matchedAssetName} after reload.`);
    }
    await reopenedTask.click();

    await expect(page.getByText(matchedChecklistDescription)).toBeVisible();
    await expect(page.getByText(matchedChecklistAssertion.prompt)).toBeVisible();
    await expect(page.getByLabel(`Note for ${matchedChecklistAssertion.key}`)).toHaveValue(note);
  });
});
