import { test, expect, type Page } from '@playwright/test';

const AUTH_EMAIL = process.env.E2E_AUTH_EMAIL;
const AUTH_PASSWORD = process.env.E2E_AUTH_PASSWORD;
const READONLY_EMAIL = process.env.E2E_READONLY_EMAIL;
const READONLY_PASSWORD = process.env.E2E_READONLY_PASSWORD;
const FIELD_OPERATOR_EMAIL = process.env.E2E_FIELD_OPERATOR_EMAIL || process.env.E2E_OPERATOR_EMAIL;
const FIELD_OPERATOR_PASSWORD = process.env.E2E_FIELD_OPERATOR_PASSWORD || process.env.E2E_OPERATOR_PASSWORD;
const MAX_CONTRACTS_TO_SCAN = 25;
const PORTAL_FINANCIALS_MIN_OUTSTANDING_FOR_PARTIAL_PAYMENT = 0.02;
const PORTAL_FINANCIALS_PAYMENT_MARGIN = 0.01;
const PORTAL_FINANCIALS_PREFERRED_PARTIAL_PAYMENT_AMOUNT = 1;
const PORTAL_FINANCIALS_PAYMENT_UPDATE_TIMEOUT = 15_000;
const PORTAL_FINANCIALS_VISIBLE_AMOUNT_PATTERN = /((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.\d{2})/;
const AVAILABILITY_NEXT_ACTION_NAME = /create|new|order|contract|reserve|transfer|return|maintenance/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function signIn(page: Page, email: string, password: string) {
  // Login is a standalone page (no app chrome) — fill the form directly.
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

async function openCreateOrderModal(page: Page) {
  await page.goto('/rental/orders');
  await page.getByRole('button', { name: 'New Rental Order' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function openEntityDetailFromList(
  page: Page,
  entityType: string,
  detailField: string | RegExp
) {
  const listPath = `/entities/${entityType}`;
  const detailPathPattern = new RegExp(`/entities/${entityType}/[^/]+$`);

  await page.goto(listPath);
  await page.waitForLoadState('networkidle');

  const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
  const viewActionCount = await viewActions.count();
  expect(viewActionCount, `${entityType} list should expose at least one View action`).toBeGreaterThan(0);

  let openedDetail = false;
  let lastUrl = page.url();

  for (let actionIndex = 0; actionIndex < viewActionCount; actionIndex += 1) {
    if (actionIndex > 0) {
      await page.goto(listPath);
      await page.waitForLoadState('networkidle');
    }

    const viewAction = page
      .getByRole('link', { name: 'View' })
      .or(page.getByRole('button', { name: 'View' }))
      .nth(actionIndex);

    const href = await viewAction.getAttribute('href');
    if (href) {
      const destinationPath = new URL(href, page.url()).pathname;
      if (!detailPathPattern.test(destinationPath)) {
        continue;
      }
    }

    await viewAction.click();

    try {
      await expect(page).toHaveURL(detailPathPattern, { timeout: 10_000 });
      openedDetail = true;
      break;
    } catch {
      lastUrl = page.url();
    }
  }

  expect(
    openedDetail,
    `Expected a View action on ${entityType} list to open a detail page, but last URL was ${lastUrl}`
  ).toBe(true);
  await page.waitForLoadState('networkidle');

  await expect(page.getByRole('link', { name: 'Back to list' })).toBeVisible();
  await expect(page.locator('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByText(detailField)).toBeVisible();
  await expect(page.getByText('Version History')).toBeVisible();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function chooseFirstOption(combo: ReturnType<Page['getByRole']>) {
  await combo.click();
  const firstOption = combo.page().getByRole('option').first();
  await expect(firstOption).toBeVisible();
  await firstOption.click();
}

async function openFieldMobile(page: Page) {
  await page.goto('/field/mobile', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Field Task Queue', { exact: true })).toBeVisible();
}

interface CheckoutCandidate {
  contractId: string;
  lineId: string;
  assetId: string;
  categoryId: string;
}

interface ReturnQueueCandidate {
  contractId: string;
  lineId: string;
  assetId: string;
}

interface AvailabilityRowCounts {
  available: number;
  unavailable: number;
  total: number;
}

interface AvailabilitySnapshot {
  byLabel: Map<string, AvailabilityRowCounts>;
  byKey: Map<string, { label: string; counts: AvailabilityRowCounts }>;
}

interface AvailabilityApiRow {
  branch_id: string;
  branch_name: string;
  asset_category_id: string;
  asset_category_name: string;
  total_assets: number;
  available_assets: number;
  unavailable_assets: number;
}

interface InventoryCalendarApiRow {
  entity_id: string;
  name: string;
  identifier: string | null;
  branch_id: string | null;
  branch_name: string | null;
  asset_category_id: string | null;
  asset_category_name: string | null;
  operational_status: string;
  maintenance_due_status: string;
  is_available: boolean;
  conflict_reason: string | null;
}

function inventoryCalendarStatusLabel(row: InventoryCalendarApiRow): string {
  if (row.is_available) return 'Available';
  switch (row.conflict_reason) {
    case 'on_rent':
      return 'On Rent';
    case 'inspection_hold':
      return 'Inspection Hold';
    case 'maintenance':
      return 'In Maintenance';
    case 'transfer':
      return 'On Transfer';
    case 'retired':
      return 'Retired';
    case 'lost':
      return 'Lost';
    case 'conflicting_assignment':
      return 'Conflicting Assignment';
    default:
      return 'Unavailable';
  }
}

function inventoryCalendarMaintenanceLabel(row: InventoryCalendarApiRow): string | null {
  if (row.maintenance_due_status === 'overdue') return 'Maint. Overdue';
  if (row.maintenance_due_status === 'due') return 'Maint. Due';
  return null;
}

async function findEligibleCheckoutLine(page: Page): Promise<CheckoutCandidate> {
  await page.goto('/rental/contracts');
  await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();

  const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
  const contractCount = await viewActions.count();
  if (contractCount === 0) {
    test.skip(true, 'No contracts with a View action are available in this environment.');
  }

  const maxContractsToScan = Math.min(contractCount, MAX_CONTRACTS_TO_SCAN);
  for (let contractIndex = 0; contractIndex < maxContractsToScan; contractIndex++) {
    if (contractIndex > 0) {
      await page.goto('/rental/contracts');
      await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();
    }

    await viewActions.nth(contractIndex).click();
    await expect(page).toHaveURL(/\/rental\/contracts\/[^/]+$/);
    await page.waitForLoadState('networkidle');

    const contractId = page.url().split('/').at(-1);
    if (!contractId) continue;

    const lineIdLabels = page.getByText(/^Line ID:/);
    const lineCount = await lineIdLabels.count();
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const lineDetails = lineIdLabels
        .nth(lineIndex)
        .locator('xpath=..')
        .locator('xpath=..');
      const lineText = await lineDetails.innerText();

      const lineId = lineText.match(/Line ID:\s*([^\s]+)/)?.[1]?.trim();
      const assetId = lineText.match(/Asset:\s*([^·\n]+)/)?.[1]?.trim();
      const categoryId = lineText.match(/Category:\s*([^·\n]+)/)?.[1]?.trim();
      const status = lineText.match(/\b(checked_out|returned)\b/i)?.[1]?.toLowerCase();

      if (!lineId || !assetId || !categoryId || /^unassigned$/i.test(assetId)) continue;
      if (status === 'checked_out' || status === 'returned') continue;

      return { contractId, lineId, assetId, categoryId };
    }
  }

  throw new Error('No eligible contract line found for checkout (requires non-checked-out line with an assigned asset).');
}

async function findCheckedOutReturnsLine(page: Page): Promise<ReturnQueueCandidate | null> {
  await page.goto('/rental/returns');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Returns / Check-In' })).toBeVisible();

  const lineIdLabels = page.getByText(/^Line ID:/);
  const lineCount = await lineIdLabels.count();
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const lineDetails = lineIdLabels
      .nth(lineIndex)
      .locator('xpath=..')
      .locator('xpath=..');
    const lineText = await lineDetails.innerText();

    const lineId = lineText.match(/Line ID:\s*([^\s]+)/)?.[1]?.trim();
    const contractAssetMatch = lineText.match(/Contract\s+([^\s•]+)\s*•\s*Asset\s+([^\s\n]+)/);
    const status = lineText.match(/\bchecked_out\b/i);

    if (!lineId || !contractAssetMatch || !status) continue;

    return {
      contractId: contractAssetMatch[1].trim(),
      assetId: contractAssetMatch[2].trim(),
      lineId,
    };
  }

  return null;
}

function parseAvailabilitySnapshotRow(rowText: string): [string, AvailabilityRowCounts] | null {
  const label = rowText.split('\n')[0]?.trim();
  if (!label || !label.includes(' • ')) return null;

  const available = rowText.match(/(\d+)\s+available\b/i)?.[1];
  const unavailableAndTotal = rowText.match(/(\d+)\s+unavailable\s*\/\s*(\d+)\s+total\b/i);
  if (!available || !unavailableAndTotal) return null;

  return [
    label,
    {
      available: Number.parseInt(available, 10),
      unavailable: Number.parseInt(unavailableAndTotal[1], 10),
      total: Number.parseInt(unavailableAndTotal[2], 10),
    },
  ];
}

function availabilityRowKey(branchId: string, categoryId: string): string {
  return `${branchId}::${categoryId}`;
}

interface OrderLineCandidate {
  categoryId: string;
  jobSiteId: string;
}

/**
 * Finds a seeded rental_order_line that carries both category_id and job_site_id by
 * querying the Supabase REST API directly from the browser context.  Navigates to the
 * corresponding order detail page and returns the identifiers.
 *
 * This avoids the previous UI-scan approach which used MAX_CONTRACTS_TO_SCAN (25) rows
 * of the order list: after many test runs without a seed reset, 25+ test-created empty
 * orders accumulate at the top (newest first) and crowd out the seeded qualifying orders.
 *
 * Throws if no qualifying line is found so the calling test fails with a clear message
 * rather than proceeding with fake identifiers.
 */
async function findOrderWithLines(page: Page): Promise<OrderLineCandidate> {
  // Ensure we are on a page where the app has initialised so the auth session
  // and runtime config are available in the browser context.
  await page.goto('/rental/orders');
  await page.waitForLoadState('networkidle');

  // Query entities with entity_type=eq.rental_order_line and embed the current
  // entity_versions via PostgREST resource embedding (!inner join).  Scoping on the
  // entities table is type-safe: no other entity type can match, even if future types
  // gain the same JSON keys.  Bypasses the UI order list entirely.
  const candidate = await page.evaluate(async (): Promise<{
    orderId: string;
    categoryId: string;
    jobSiteId: string;
  } | null> => {
    type RuntimeConfig = { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string };
    const cfg = (window as unknown as { __WYNNE_RUNTIME_CONFIG__?: RuntimeConfig }).__WYNNE_RUNTIME_CONFIG__;
    const supabaseUrl = cfg?.VITE_SUPABASE_URL;
    const anonKey = cfg?.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return null;

    // Supabase auth SDK stores the session in localStorage under a key that ends
    // with "-auth-token".
    const sessionKey = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'));
    if (!sessionKey) return null;
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const session = JSON.parse(raw) as { access_token?: string };
    const accessToken = session?.access_token;
    if (!accessToken) return null;

    // Query entities scoped to rental_order_line and embed the current version.
    // Built manually to preserve the PostgREST JSONB operator (->>);
    // URLSearchParams would percent-encode the > characters.
    const qs = [
      'entity_type=eq.rental_order_line',
      'select=source_record_id,entity_versions!inner(data)',
      'entity_versions.is_current=eq.true',
      'entity_versions.data->>order_id=not.is.null',
      'limit=200',
    ].join('&');

    const resp = await fetch(`${supabaseUrl}/rest/v1/entities?${qs}`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) return null;

    const rows = await resp.json() as Array<{
      source_record_id?: string;
      entity_versions: Array<{ data?: { category_id?: string; job_site_id?: string; order_id?: string } }>;
    }>;
    const hasRequiredFields = (row: {
      entity_versions: Array<{ data?: { category_id?: string; job_site_id?: string; order_id?: string } }>;
    }): boolean => {
      const data = row.entity_versions?.[0]?.data;
      return !!data?.order_id?.trim() && !!data?.category_id?.trim() && !!data?.job_site_id?.trim();
    };

    const seeded = rows.find(
      (row) => row.source_record_id?.startsWith('demo-ops-rental-order-line-') && hasRequiredFields(row)
    );
    const fallback = rows.find(hasRequiredFields);
    const selected = seeded ?? fallback;
    const d = selected?.entity_versions?.[0]?.data;
    if (!d?.category_id?.trim() || !d?.job_site_id?.trim() || !d?.order_id?.trim()) return null;
    return { orderId: d.order_id, categoryId: d.category_id, jobSiteId: d.job_site_id };
  });

  if (!candidate) {
    throw new Error(
      'No rental order found with an existing line carrying both category_id and job_site_id. ' +
      'Ensure the dev environment seed has populated rental_order_lines with these fields.'
    );
  }

  await page.goto(`/rental/orders/${candidate.orderId}`);
  await page.waitForLoadState('networkidle');
  return { categoryId: candidate.categoryId, jobSiteId: candidate.jobSiteId };
}

async function getAssetBranchId(page: Page, assetId: string): Promise<string> {
  const [assetResponse] = await Promise.all([
    page.waitForResponse((response) => (
      response.url().includes('/rest/v1/entity_current_with_versions')
      && response.request().method() === 'GET'
      && response.url().includes('entity_type=eq.asset')
      && response.url().includes(`id=eq.${assetId}`)
    )),
    page.goto(`/entities/asset/${assetId}`),
  ]);
  await page.waitForLoadState('networkidle');
  const assetRows = await assetResponse.json() as Array<{
    entity_versions?: Array<{ data?: { branch_id?: string } }>;
  }>;
  const assetData = assetRows[0]?.entity_versions?.[0]?.data;
  if (!assetData) {
    throw new Error(`Missing entity data for asset ${assetId}`);
  }
  const branchId = assetData.branch_id?.trim();
  if (!branchId) {
    throw new Error(`Missing branch_id for asset ${assetId}`);
  }
  return branchId;
}

async function captureAvailabilitySnapshot(page: Page): Promise<AvailabilitySnapshot> {
  const [availabilityResponse] = await Promise.all([
    page.waitForResponse((response) => (
      response.url().includes('/rest/v1/rental_asset_availability_current')
      && response.request().method() === 'GET'
    )),
    page.goto('/rental/availability'),
  ]);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Branch Availability Lookup' })).toBeVisible();
  expect(availabilityResponse.ok(), 'availability API request should succeed').toBe(true);
  const availabilityRows = (await availabilityResponse.json()) as AvailabilityApiRow[];
  expect(availabilityRows.length, 'expected API availability rows').toBeGreaterThan(0);

  const cards = page.locator('.border.rounded-lg.p-4');
  const cardCount = await cards.count();
  expect(cardCount, 'expected at least one availability row').toBeGreaterThan(0);

  const byLabel = new Map<string, AvailabilityRowCounts>();
  for (let index = 0; index < cardCount; index++) {
    const parsed = parseAvailabilitySnapshotRow(await cards.nth(index).innerText());
    if (parsed) byLabel.set(parsed[0], parsed[1]);
  }

  expect(byLabel.size, 'expected at least one parseable availability row').toBeGreaterThan(0);

  const byKey = new Map<string, { label: string; counts: AvailabilityRowCounts }>();
  for (const row of availabilityRows) {
    const label = `${row.branch_name} • ${row.asset_category_name}`;
    byKey.set(availabilityRowKey(row.branch_id, row.asset_category_id), {
      label,
      counts: {
        available: row.available_assets,
        unavailable: row.unavailable_assets,
        total: row.total_assets,
      },
    });
  }

  return { byLabel, byKey };
}

test.describe('auth and access-control journeys', () => {
  test('unauthenticated users are redirected to a standalone login page', async ({ page }) => {
    await page.goto('/entities/billing_account');
    await expect(page).toHaveURL(/\/login$/);
    // A real login form is presented...
    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    // ...and the app chrome (sidebar/header nav) is NOT shown (#305).
    await expect(page.getByRole('navigation')).toHaveCount(0);
  });

  test('sign in persists across reload and sign out works', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run auth sign-in E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.reload();
    await expect(page.getByTestId('sign-out-button')).toBeVisible();
    await page.getByTestId('sign-out-button').click();
    await expect(page).toHaveURL(/\/login$/);
    // Post #305 the standalone /login route exposes the form directly
    // (login-email/login-submit); the legacy `sign-in-button` dialog trigger
    // is no longer rendered there.
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  test('authenticated user can create an order and still see list data after refresh', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    const writeStatuses: number[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/rpc/create_entity_with_version')) {
        writeStatuses.push(response.status());
      }
    });

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/rental/orders');
    await page.waitForLoadState('networkidle');
    const beforeCount = await page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' })).count();

    await openCreateOrderModal(page);
    const dialog = page.getByRole('dialog');
    const combos = dialog.getByRole('combobox');

    await chooseFirstOption(combos.nth(0)); // requester
    await chooseFirstOption(combos.nth(1)); // rental type
    await chooseFirstOption(combos.nth(2)); // asset category
    await dialog.getByLabel('Quantity').fill('1');
    await dialog.getByLabel('Planned Start').fill('2026-06-10');
    await dialog.getByLabel('Planned End').fill('2026-06-11');
    await chooseFirstOption(combos.nth(3)); // job site
    await chooseFirstOption(combos.nth(4)); // rate type

    await dialog.getByRole('button', { name: 'Create Order' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('Order creation blocked')).not.toBeVisible();
    expect(writeStatuses.some((status) => status < 400), `write status codes: ${writeStatuses.join(', ')}`).toBe(true);

    await page.reload();
    await page.waitForLoadState('networkidle');
    // After refresh the list must read back order rows. Assert presence (and that it
    // didn't shrink) rather than a strict +1, which is brittle under pagination/ordering.
    const afterCount = await page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' })).count();
    expect(afterCount, 'rental orders should be visible after refresh').toBeGreaterThan(0);
    expect(afterCount, 'order list should not shrink after a successful create').toBeGreaterThanOrEqual(beforeCount);
  });

  test('write-capable user can add an order line from the detail page and it persists after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Navigate to an order that already has seeded rental_order_lines so we can source
    // real category and job-site identifiers.  The helper throws if no qualifying order is
    // found, preventing the test from proceeding with fake IDs.
    // findOrderWithLines leaves the browser on the chosen order detail page.
    const { categoryId, jobSiteId } = await findOrderWithLines(page);

    // Record the current count of visible order-line rows.
    const linesBefore = await page.locator('.p-4.border.rounded-lg').count();

    // Open the Add Line modal.
    await page.getByRole('button', { name: 'Add Line' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Fill every field in the modal form.
    await dialog.getByLabel('Asset Category ID').fill(categoryId);
    await dialog.getByLabel('Quantity').fill('1');
    await dialog.getByLabel('Planned Start').fill('2026-08-01');
    await dialog.getByLabel('Planned End').fill('2026-08-31');
    await dialog.getByLabel('Job Site ID').fill(jobSiteId);

    // Rate Type is a Radix-UI Select; open the trigger then choose Daily.
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Daily' }).click();

    // Await the create_entity_with_version RPC for the new rental_order_line.
    const addLineWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"p_entity_type":"rental_order_line"');
    });

    await dialog.getByRole('button', { name: 'Add Line' }).click();
    const addLineResponse = await addLineWrite;
    expect(addLineResponse.status(), 'add-line RPC should succeed').toBeLessThan(400);

    // Modal must close after a successful write.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The new line must appear on the detail page immediately (before any manual reload).
    await page.waitForLoadState('networkidle');
    const linesAfter = await page.locator('.p-4.border.rounded-lg').count();
    expect(linesAfter, 'a new order line should appear on the detail page immediately').toBeGreaterThan(linesBefore);
    await expect(
      page.getByText('Qty: 1 · 2026-08-01 to 2026-08-31'),
      'new line planned dates must be visible on the detail page'
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText('pending').first(),
      'new line should carry pending status'
    ).toBeVisible();

    // Reload and assert the write persisted through the current-state read path.
    await page.reload();
    await page.waitForLoadState('networkidle');
    const linesAfterReload = await page.locator('.p-4.border.rounded-lg').count();
    expect(linesAfterReload, 'added line should persist after page reload').toBeGreaterThanOrEqual(linesAfter);
    await expect(
      page.getByText('Qty: 1 · 2026-08-01 to 2026-08-31'),
      'persisted line must still be visible after reload'
    ).toBeVisible({ timeout: 15_000 });

    // Optionally confirm the order remains navigable from the list after the mutation.
    await page.goto('/rental/orders');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' })).first(),
      'rental orders list should remain navigable after the add-line mutation'
    ).toBeVisible();
  });

  test('write-capable user can add an order line from an availability row and it persists after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/rental/orders');
    await page.waitForLoadState('networkidle');

    const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
    const orderCount = await viewActions.count();
    expect(orderCount, 'expected at least one rental order with a View action').toBeGreaterThan(0);
    await viewActions.first().click();
    await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/);

    const [availabilityResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.url().includes('/rest/v1/rental_asset_availability_current')
        && response.request().method() === 'GET'
      )),
      page.reload({ waitUntil: 'load' }),
    ]);
    await page.waitForLoadState('networkidle');
    expect(availabilityResponse.ok(), 'availability API request should succeed on rental order detail').toBe(true);
    const availabilityRows = await availabilityResponse.json() as AvailabilityApiRow[];
    const addItemButtons = page.getByRole('button', { name: '+ Add Item' });
    const addItemCount = await addItemButtons.count();
    expect(addItemCount, 'expected at least one availability row with an add-line action').toBeGreaterThan(0);

    let selectedButton: ReturnType<typeof addItemButtons.nth> | null = null;
    for (let buttonIndex = 0; buttonIndex < addItemCount; buttonIndex++) {
      const button = addItemButtons.nth(buttonIndex);
      if (await button.isDisabled()) continue;
      selectedButton = button;
      break;
    }
    expect(selectedButton, 'expected at least one enabled + Add Item button from an availability row').not.toBeNull();
    await selectedButton!.click();

    const addLineDialog = page.getByRole('dialog');
    await expect(addLineDialog).toBeVisible();
    const selectedCategoryId = await addLineDialog.getByLabel('Asset Category ID').inputValue();
    expect(selectedCategoryId, 'availability-row category prefill should not be empty').not.toEqual('');
    const availabilityCategoryIds = new Set(availabilityRows.map((row) => row.asset_category_id));
    expect(
      availabilityCategoryIds.has(selectedCategoryId),
      'availability-row selection should prefill a category present in the availability API response'
    ).toBe(true);

    const plannedStart = '2026-11-15';
    const plannedEnd = '2026-11-16';

    await addLineDialog.getByLabel('Quantity').fill('1');
    await addLineDialog.getByLabel('Planned Start').fill(plannedStart);
    await addLineDialog.getByLabel('Planned End').fill(plannedEnd);
    await addLineDialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Daily' }).click();

    const addLineWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"p_entity_type":"rental_order_line"')
        && body.includes(`"category_id":"${selectedCategoryId}"`)
        && body.includes(`"planned_start":"${plannedStart}"`)
        && body.includes(`"planned_end":"${plannedEnd}"`);
    });

    await addLineDialog.getByRole('button', { name: 'Add Line' }).click();
    const addLineWriteResponse = await addLineWrite;
    expect(addLineWriteResponse.status(), 'add-line write from availability row should succeed').toBeLessThan(400);
    await expect(addLineDialog).toBeHidden({ timeout: 15_000 });

    const orderLinesCard = page.getByText('Order Lines').first().locator('../..');
    await expect(
      orderLinesCard.getByText(`Qty: 1 · ${plannedStart} to ${plannedEnd}`),
      'new order line should appear on order detail after submit'
    ).toBeVisible({ timeout: 15_000 });
    await expect(orderLinesCard.getByText(selectedCategoryId)).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      orderLinesCard.getByText(`Qty: 1 · ${plannedStart} to ${plannedEnd}`),
      'new order line should persist after page reload'
    ).toBeVisible({ timeout: 15_000 });
    await expect(orderLinesCard.getByText(selectedCategoryId)).toBeVisible();
  });

  test('write-capable user can create a customer from entity list and read it after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    const uniqueName = `E2E Customer ${Date.now()}`;
    const uniqueCustomerType = `enterprise-${Date.now()}`;

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/entities/customer');
    await page.waitForLoadState('networkidle');

    const beforeCount = await page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' })).count();
    expect(await page.getByText(uniqueName).count(), 'precondition: unique customer name should not exist yet').toBe(0);

    await page.getByRole('button', { name: 'New Customer' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill(uniqueName);
    await dialog.getByLabel('Customer Type').fill(uniqueCustomerType);

    const createWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"p_entity_type":"customer"')
        && body.includes(`"name":"${uniqueName}"`)
        && body.includes(`"customer_type":"${uniqueCustomerType}"`);
    });

    await dialog.getByRole('button', { name: 'Create' }).click();
    const createWriteResponse = await createWrite;
    expect(createWriteResponse.status(), 'customer create rpc should succeed').toBeLessThan(400);
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const createdRow = page.locator('.border.rounded-lg.p-4').filter({ hasText: uniqueName }).first();
    await expect(createdRow, 'created customer row should appear in list immediately').toBeVisible({ timeout: 15_000 });
    await expect(createdRow.getByText(`Customer Type: ${uniqueCustomerType}`)).toBeVisible();

    const afterCreateCount = await page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' })).count();
    expect(afterCreateCount, 'customer list should not shrink after a successful create').toBeGreaterThanOrEqual(beforeCount);

    await page.reload();
    await page.waitForLoadState('networkidle');

    const persistedRow = page.locator('.border.rounded-lg.p-4').filter({ hasText: uniqueName }).first();
    await expect(persistedRow, 'created customer row should still be visible after reload').toBeVisible({ timeout: 15_000 });
    await expect(persistedRow.getByText(`Customer Type: ${uniqueCustomerType}`)).toBeVisible();

    const persistedViewAction = persistedRow
      .getByRole('link', { name: 'View' })
      .or(persistedRow.getByRole('button', { name: 'View' }))
      .first();
    await persistedViewAction.click();
    await expect(page).toHaveURL(/\/entities\/customer\/[^/]+$/);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1, name: uniqueName })).toBeVisible();
    await expect(page.getByText('Customer Type')).toBeVisible();
    await expect(page.getByText(uniqueCustomerType)).toBeVisible();
  });

  test('portal financials partial payment persists after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    const formattedAmountFragment = (amount: number) => escapeRegExp(amount.toFixed(2));
    const parseVisibleAmount = (text: string): number | null => {
      const match = text.match(PORTAL_FINANCIALS_VISIBLE_AMOUNT_PATTERN);
      return match ? Number(match[1].replaceAll(',', '')) : null;
    };
    const readVisibleInvoice = async (invoiceId: string) => {
      const invoiceCard = page.getByTestId(`portal-invoice-${invoiceId}`);
      const invoiceText = await invoiceCard.innerText();
      const outstandingText = invoiceText.match(/Outstanding:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
      const outstandingAmount = parseVisibleAmount(outstandingText);
      return { invoiceCard, outstandingText, outstandingAmount };
    };
    const findOpenInvoice = async () => {
      const invoiceCards = page.locator('[data-testid^="portal-invoice-"]');
      const invoiceCount = await invoiceCards.count();

      for (let index = 0; index < invoiceCount; index += 1) {
        const invoiceCard = invoiceCards.nth(index);
        const invoiceId = (await invoiceCard.getAttribute('data-testid'))?.replace('portal-invoice-', '') ?? '';
        const invoiceText = await invoiceCard.innerText();
        const invoiceNumber = invoiceText.match(/\bINV-\w+\b/i)?.[0] ?? '';
        const outstandingText = invoiceText.match(/Outstanding:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
        const outstandingAmount = parseVisibleAmount(outstandingText);
        if (
          invoiceId
          && invoiceNumber
          && typeof outstandingAmount === 'number'
          && outstandingAmount > PORTAL_FINANCIALS_MIN_OUTSTANDING_FOR_PARTIAL_PAYMENT
        ) {
          return { invoiceId, invoiceCard, invoiceNumber, outstandingText, outstandingAmount };
        }
      }

      return null;
    };

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/rental/portal-financials');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { name: /Customer Portal.*Invoices.*Payments/i }).or(
        page.getByText(/Customer Portal.*Invoices.*Payments/i).first()
      )
    ).toBeVisible();

    const invoiceSelection = await findOpenInvoice();
    if (!invoiceSelection) {
      test.skip(true, 'No open invoice with visible invoice-number and outstanding-balance context is available in current environment.');
      return;
    }

    const { invoiceId, invoiceNumber, outstandingText, outstandingAmount } = invoiceSelection;
    const validPaymentAmount =
      outstandingAmount > PORTAL_FINANCIALS_PREFERRED_PARTIAL_PAYMENT_AMOUNT
        ? PORTAL_FINANCIALS_PREFERRED_PARTIAL_PAYMENT_AMOUNT
        : Number((outstandingAmount - PORTAL_FINANCIALS_PAYMENT_MARGIN).toFixed(2));
    expect(validPaymentAmount, 'selected invoice must support a positive partial-payment amount').toBeGreaterThan(0);
    expect(validPaymentAmount, 'selected invoice must support a partial payment that leaves a remaining balance').toBeLessThan(outstandingAmount);

    const invoiceSelect = page.getByLabel('Invoice');
    const paymentMethodSelect = page.getByLabel('Payment Method');
    const amountInput = page.getByLabel('Amount');
    const payInvoiceButton = page.getByRole('button', { name: /Pay Invoice/i });

    await invoiceSelect.selectOption({ label: `${invoiceNumber} · ${outstandingText}` });
    await paymentMethodSelect.selectOption('ach');
    await amountInput.fill(validPaymentAmount.toFixed(2));

    const paymentWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"p_entity_type":"payment"')
        && body.includes(`"invoice_id":"${invoiceId}"`);
    });

    await payInvoiceButton.click();
    const paymentWriteResponse = await paymentWrite;
    expect(paymentWriteResponse.status(), 'payment create rpc should succeed').toBeLessThan(400);

    await expect(page.getByText('Payment recorded')).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Payment recorded via ACH for .*${formattedAmountFragment(validPaymentAmount)}`, 'i'))
    ).toBeVisible();

    let updatedOutstandingText = '';
    await expect
      .poll(async () => {
        updatedOutstandingText = (await readVisibleInvoice(invoiceId)).outstandingText;
        return updatedOutstandingText;
      }, {
        timeout: PORTAL_FINANCIALS_PAYMENT_UPDATE_TIMEOUT,
        message: `expected invoice ${invoiceNumber} to show a new outstanding balance after payment`,
      })
      .not.toBe(outstandingText);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadedInvoice = await readVisibleInvoice(invoiceId);
    await expect(reloadedInvoice.invoiceCard).toBeVisible();
    await expect(reloadedInvoice.invoiceCard).toContainText(invoiceNumber);
    await expect(reloadedInvoice.invoiceCard).toContainText(/Customer:/i);
    await expect(reloadedInvoice.invoiceCard).toContainText(/Billing Account:/i);

    const reloadedOutstandingAmount = reloadedInvoice.outstandingAmount;
    if (reloadedOutstandingAmount === null) {
      throw new Error(`Reloaded invoice ${invoiceNumber} does not expose a parseable outstanding amount.`);
    }
    expect(reloadedOutstandingAmount, 'invoice outstanding amount should decrease after persisted partial payment').toBeLessThan(outstandingAmount);
  });

  test('@entity-drilldown authenticated user can open polished entity detail pages from View across core entity types', async ({ page }) => {
    test.skip(
      !AUTH_EMAIL || !AUTH_PASSWORD,
      'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated entity detail E2E.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const cases: Array<{ entityType: string; detailField: string | RegExp }> = [
      { entityType: 'branch', detailField: 'Branch Details' },
      { entityType: 'customer', detailField: 'Customer Type' },
      { entityType: 'asset', detailField: 'Asset Category' },
      { entityType: 'asset_category', detailField: 'Default Rate Type' },
      { entityType: 'job_site', detailField: 'Address' },
      { entityType: 'invoice', detailField: 'Billing Context' },
    ];

    for (const { entityType, detailField } of cases) {
      await openEntityDetailFromList(page, entityType, detailField);
    }
  });

  test('read-only account cannot create orders and sees a clear permission message', async ({ page }) => {
    test.skip(
      !READONLY_EMAIL || !READONLY_PASSWORD,
      'Set E2E_READONLY_EMAIL and E2E_READONLY_PASSWORD to run role-boundary E2E.'
    );

    await signIn(page, READONLY_EMAIL!, READONLY_PASSWORD!);
    await openCreateOrderModal(page);
    await page.getByRole('button', { name: 'Create Order' }).click();

    await expect(page.getByText('Order creation blocked')).toBeVisible();
    await expect(page.getByText(/write access to create rental orders/i)).toBeVisible();
  });

  test('field operator can access the mobile field queue', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD or E2E_OPERATOR_EMAIL/PASSWORD to run field-mobile auth E2E.'
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await openFieldMobile(page);
  });

  test('availability lookup reflects checkout and return lifecycle for the same branch/category row', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const candidate = await findEligibleCheckoutLine(page);
    const branchId = await getAssetBranchId(page, candidate.assetId);
    const beforeAvailability = await captureAvailabilitySnapshot(page);
    const expectedRow = beforeAvailability.byKey.get(availabilityRowKey(branchId, candidate.categoryId));
    expect(expectedRow, `expected availability row for branch ${branchId} and category ${candidate.categoryId}`).toBeDefined();
    const checkoutRowLabel = expectedRow!.label;
    const checkoutRowBeforeCounts = beforeAvailability.byLabel.get(checkoutRowLabel);
    expect(checkoutRowBeforeCounts, `expected baseline counts for ${checkoutRowLabel}`).toBeDefined();
    expect(checkoutRowLabel).toContain(' • ');

    await page.goto(`/rental/contracts/${candidate.contractId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();

    await page.getByRole('button', { name: 'Check Out Line' }).click();
    const checkoutDialog = page.getByRole('dialog');
    await checkoutDialog.getByLabel('Contract Line ID').fill(candidate.lineId);
    await checkoutDialog.getByLabel('Asset ID').fill(candidate.assetId);
    await checkoutDialog.getByLabel('Actual Start Date').fill('2026-07-05');

    const checkoutWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes(`"p_entity_id":"${candidate.lineId}"`)
        && body.includes('"status":"checked_out"');
    });

    await checkoutDialog.getByRole('button', { name: 'Confirm Checkout' }).click();
    const checkoutWriteResponse = await checkoutWrite;
    expect(checkoutWriteResponse.status(), 'checkout rpc should succeed').toBeLessThan(400);
    await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });

    let checkoutRowAfterCounts: AvailabilityRowCounts | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const afterCheckout = await captureAvailabilitySnapshot(page);
      const afterCounts = afterCheckout.byLabel.get(checkoutRowLabel);
      if (
        afterCounts
        && checkoutRowBeforeCounts
        && afterCounts.total === checkoutRowBeforeCounts.total
        && afterCounts.available === checkoutRowBeforeCounts.available - 1
        && afterCounts.unavailable === checkoutRowBeforeCounts.unavailable + 1
      ) {
        checkoutRowAfterCounts = afterCounts;
        break;
      }
      await page.waitForTimeout(2_000);
    }

    expect(checkoutRowAfterCounts, `expected post-checkout counts for ${checkoutRowLabel}`).toBeDefined();
    if (!checkoutRowAfterCounts || !checkoutRowBeforeCounts) {
      throw new Error(`Missing checkout availability counts for ${checkoutRowLabel}`);
    }
    expect(checkoutRowAfterCounts.total).toBe(checkoutRowBeforeCounts.total);
    expect(checkoutRowAfterCounts.available).toBe(checkoutRowBeforeCounts.available - 1);
    expect(checkoutRowAfterCounts.unavailable).toBe(checkoutRowBeforeCounts.unavailable + 1);

    await page.goto('/rental/returns');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Check In Contract Line' }).click();
    const checkInDialog = page.getByRole('dialog');
    await checkInDialog.getByLabel('Contract Line Entity ID').fill(candidate.lineId);
    await checkInDialog.getByLabel('Contract ID').fill(candidate.contractId);
    await checkInDialog.getByLabel('Asset ID').fill(candidate.assetId);
    await checkInDialog.getByLabel('Return Date').fill('2026-07-06');

    const checkInStatusUpdate = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes(`"p_entity_id":"${candidate.lineId}"`)
        && body.includes('"status":"returned"');
    });
    const inspectionWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes(`"contract_line_id":"${candidate.lineId}"`)
        && body.includes('"inspection_type":"return"')
        && body.includes('"outcome":"pass"');
    });

    await checkInDialog.getByRole('button', { name: 'Confirm Check-In' }).click();
    const [checkInStatusResponse, inspectionWriteResponse] = await Promise.all([checkInStatusUpdate, inspectionWrite]);
    expect(checkInStatusResponse.status(), 'check-in status rpc should succeed').toBeLessThan(400);
    expect(inspectionWriteResponse.status(), 'return inspection rpc should succeed').toBeLessThan(400);
    await expect(checkInDialog).toBeHidden({ timeout: 15_000 });

    let restoredCounts: AvailabilityRowCounts | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const afterReturn = await captureAvailabilitySnapshot(page);
      const rowCounts = afterReturn.byLabel.get(checkoutRowLabel);
      if (
        rowCounts
        && checkoutRowBeforeCounts
        && rowCounts.available === checkoutRowBeforeCounts.available
        && rowCounts.unavailable === checkoutRowBeforeCounts.unavailable
        && rowCounts.total === checkoutRowBeforeCounts.total
      ) {
        restoredCounts = rowCounts;
        break;
      }
      await page.waitForTimeout(2_000);
    }

    expect(
      restoredCounts,
      `expected ${checkoutRowLabel} availability row to restore after return/check-in lifecycle`
    ).toBeDefined();
  });

  test('authenticated user can check in a returned line with pass outcome and see available state after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    let candidate = await findCheckedOutReturnsLine(page);
    if (!candidate) {
      candidate = await findEligibleCheckoutLine(page);

      await page.getByRole('button', { name: 'Check Out Line' }).click();
      const checkoutDialog = page.getByRole('dialog');
      await checkoutDialog.getByLabel('Contract Line ID').fill(candidate.lineId);
      await checkoutDialog.getByLabel('Asset ID').fill(candidate.assetId);
      await checkoutDialog.getByLabel('Actual Start Date').fill('2026-07-05');

      const checkoutWrite = page.waitForResponse((response) => {
        const body = response.request().postData() ?? '';
        return response.url().includes('/rpc/rental_upsert_entity_current_state')
          && body.includes(`"p_entity_id":"${candidate.lineId}"`)
          && body.includes('"status":"checked_out"');
      });

      await checkoutDialog.getByRole('button', { name: 'Confirm Checkout' }).click();
      const checkoutWriteResponse = await checkoutWrite;
      expect(checkoutWriteResponse.status(), 'checkout rpc should succeed when setting up return pass-path state').toBeLessThan(400);
      await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });
    }

    await page.goto('/rental/returns');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();

    await page.getByRole('button', { name: 'Check In Contract Line' }).click();
    const checkInDialog = page.getByRole('dialog');
    await checkInDialog.getByLabel('Contract Line Entity ID').fill(candidate.lineId);
    await checkInDialog.getByLabel('Contract ID').fill(candidate.contractId);
    await checkInDialog.getByLabel('Asset ID').fill(candidate.assetId);
    await checkInDialog.getByLabel('Return Date').fill('2026-07-06');
    await checkInDialog.getByLabel('Condition Outcome').click();
    await page.getByRole('option', { name: 'Pass' }).click();

    const checkInStatusUpdate = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes(`"p_entity_id":"${candidate.lineId}"`)
        && body.includes('"status":"returned"');
    });

    const inspectionWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes(`"contract_line_id":"${candidate.lineId}"`)
        && body.includes('"inspection_type":"return"');
    });

    await checkInDialog.getByRole('button', { name: 'Confirm Check-In' }).click();
    const [checkInStatusResponse, inspectionWriteResponse] = await Promise.all([checkInStatusUpdate, inspectionWrite]);
    expect(checkInStatusResponse.status(), 'check-in status rpc should succeed').toBeLessThan(400);
    expect(inspectionWriteResponse.status(), 'return inspection rpc should succeed').toBeLessThan(400);

    const inspectionWriteBody = inspectionWriteResponse.request().postData() ?? '';
    expect(inspectionWriteBody).toContain('"outcome":"pass"');
    expect(inspectionWriteBody).toContain('"resulting_asset_status":"available"');

    await expect(checkInDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).not.toBeVisible({ timeout: 15_000 });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Returns / Check-In' })).toBeVisible();
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toHaveCount(0);
    await expect(page.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toHaveCount(0);
    const inspectionHoldPanel = page.locator('div').filter({
      has: page.getByRole('heading', { name: 'Inspection Hold Status' }),
      hasText: 'Current assets already blocked on inspection hold.',
    }).first();
    await expect(inspectionHoldPanel).not.toContainText(candidate.assetId);
  });

  test('ops dashboard drill-down: KPI and audit links persist after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run ops dashboard drill-down E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/ops');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Operations Dashboard' }).first()).toBeVisible();

    // Items awaiting review KPI card must expose a link to /ops/findings.
    // The link is labelled "Open audit history" in the dashboard JSON and targets /ops/findings.
    const pendingApprovalsCard = page.getByText('Items awaiting review').first().locator('../..');
    await expect(pendingApprovalsCard).toBeVisible();
    const findingsLinks = await pendingApprovalsCard.getByRole('link', { name: /open audit history/i }).all();
    expect(
      findingsLinks.length,
      'Items awaiting review KPI card should expose an "Open audit history" link to /ops/findings'
    ).toBeGreaterThan(0);
    const findingsHrefs = await Promise.all(findingsLinks.map((l) => l.getAttribute('href')));
    expect(
      findingsHrefs.some((h) => h?.includes('/ops/findings')),
      'Items awaiting review "Open audit history" link should target /ops/findings'
    ).toBe(true);

    // Follow a View audit trail link from Recent audit activity into /ops/audit/:entityId
    const recentActivityCard = page.getByText('Recent audit activity').first().locator('../..');
    const auditLinks = await recentActivityCard.getByRole('link', { name: /view audit trail/i }).all();
    if (auditLinks.length === 0) {
      test.skip(true, 'No recent audit activity in this environment; skipping audit drill-down assertions.');
      return;
    }
    const firstAuditLink = auditLinks[0];
    const auditHref = await firstAuditLink.getAttribute('href');
    expect(
      auditHref?.includes('/ops/audit/'),
      'View audit trail link should target /ops/audit/:entityId'
    ).toBe(true);

    await firstAuditLink.click();
    await expect(page).toHaveURL(/\/ops\/audit\/[^/]+$/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Reload and verify the audit trail URL, heading, and event context persist
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/ops\/audit\/[^/]+$/);
    await expect(page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();

    // The page must render readable context after reload — not a blank page or unrecoverable error
    const bodyText = await page.locator('body').innerText();
    expect(
      /audit trail|loading audit|no audit events|review history/i.test(bodyText),
      'Audit trail page should render readable context after reload'
    ).toBe(true);

    // When audit events are present verify the human-readable fields survived the reload:
    // event label, entity name/type · MM/DD/YYYY timestamp, and Actor context are all shown.
    if (/Actor:/i.test(bodyText)) {
      // entity name/type and formatted date (MM/DD/YYYY, HH:MM) are rendered as "name · date"
      expect(bodyText, 'audit event should show entity context in "name · MM/DD/YYYY" format').toMatch(
        /\S.+\s·\s\d{2}\/\d{2}\/\d{4}/
      );
      expect(bodyText, 'audit event should show Actor context').toMatch(/Actor:/i);
    }

    // Operator is not left at a dead end: the description beneath the heading confirms
    // the page purpose and gives them readable triage context to act from
    await expect(page.getByText(/review history/i).first()).toBeVisible();
  });

  test('inventory calendar operator journey: scoped blocker handoff persists after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run the inventory calendar operator journey.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const initialCalendarResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/rest/v1/rpc/fleet_get_availability_calendar')
      && response.request().method() === 'POST'
    ));

    await page.goto('/inventory/calendar');
    const initialCalendarResponse = await initialCalendarResponsePromise;
    await page.waitForLoadState('networkidle');

    expect(initialCalendarResponse.ok(), 'fleet availability calendar RPC should succeed on initial load').toBe(true);
    await expect(page.getByRole('heading', { name: 'Fleet Availability Calendar' })).toBeVisible();

    const selectedStart = await page.getByLabel('Start date').inputValue();
    const selectedEnd = await page.getByLabel('End date').inputValue();
    expect(selectedStart, 'calendar should expose a real selected start date').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(selectedEnd, 'calendar should expose a real selected end date').toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const initialCalendarRows = await initialCalendarResponse.json() as InventoryCalendarApiRow[];
    const assetWithBranchAndCategory = initialCalendarRows.find((row) => (
      row.branch_id
      && row.branch_name
      && row.asset_category_id
      && row.asset_category_name
      && (!row.is_available || row.maintenance_due_status !== 'none')
    )) ?? initialCalendarRows.find((row) => (
      row.branch_id
      && row.branch_name
      && row.asset_category_id
      && row.asset_category_name
    ));

    test.skip(!assetWithBranchAndCategory, 'No inventory-calendar row with branch/category context is currently available on deployed dev.');
    if (!assetWithBranchAndCategory) return;

    await page.getByLabel('Branch').selectOption({ label: assetWithBranchAndCategory.branch_name! });
    await page.getByLabel('Category').selectOption({ label: assetWithBranchAndCategory.asset_category_name! });

    const filteredCalendarResponsePromise = page.waitForResponse((response) => {
      if (
        !response.url().includes('/rest/v1/rpc/fleet_get_availability_calendar')
        || response.request().method() !== 'POST'
      ) {
        return false;
      }
      try {
        const body = JSON.parse(response.request().postData() ?? '{}') as {
          p_start_date?: string;
          p_end_date?: string;
          p_branch_id?: string;
          p_category_id?: string;
        };
        return body.p_start_date === selectedStart
          && body.p_end_date === selectedEnd
          && body.p_branch_id === assetWithBranchAndCategory.branch_id
          && body.p_category_id === assetWithBranchAndCategory.asset_category_id;
      } catch {
        return false;
      }
    });

    await page.getByRole('button', { name: 'Apply' }).click();
    const filteredCalendarResponse = await filteredCalendarResponsePromise;
    await page.waitForLoadState('networkidle');

    expect(filteredCalendarResponse.ok(), 'scoped fleet calendar RPC should succeed after Apply').toBe(true);
    const filteredCalendarRows = await filteredCalendarResponse.json() as InventoryCalendarApiRow[];
    const filteredMatch = filteredCalendarRows.find((row) => row.entity_id === assetWithBranchAndCategory.entity_id)
      ?? filteredCalendarRows.find((row) => (
        row.name === assetWithBranchAndCategory.name
        && row.branch_id === assetWithBranchAndCategory.branch_id
        && row.asset_category_id === assetWithBranchAndCategory.asset_category_id
      ));
    expect(
      filteredMatch,
      `calendar should keep asset "${assetWithBranchAndCategory.name}" visible after applying branch/category scope`
    ).toBeDefined();

    await expect(
      page.getByText(assetWithBranchAndCategory.branch_name!, { exact: false }).first(),
      `calendar should keep the human-readable branch "${assetWithBranchAndCategory.branch_name}" visible`
    ).toBeVisible();
    await expect(
      page.getByText(assetWithBranchAndCategory.asset_category_name!, { exact: false }).first(),
      `calendar should keep the human-readable category "${assetWithBranchAndCategory.asset_category_name}" visible`
    ).toBeVisible();

    const assetRow = page.getByText(assetWithBranchAndCategory.name, { exact: true }).locator('..').locator('..');
    await expect(assetRow, `calendar should render scoped asset row "${assetWithBranchAndCategory.name}"`).toBeVisible();
    await expect(
      assetRow.getByText(inventoryCalendarStatusLabel(filteredMatch!)),
      `calendar should surface an operator-readable availability/blocker badge for "${assetWithBranchAndCategory.name}"`
    ).toBeVisible();

    const maintenanceLabel = inventoryCalendarMaintenanceLabel(filteredMatch!);
    if (maintenanceLabel) {
      await expect(
        assetRow.getByText(maintenanceLabel),
        `calendar should surface maintenance context "${maintenanceLabel}" for "${assetWithBranchAndCategory.name}"`
      ).toBeVisible();
    }

    const nextActionLinks = assetRow.getByRole('link', { name: AVAILABILITY_NEXT_ACTION_NAME });
    const nextActionButtons = assetRow.getByRole('button', { name: AVAILABILITY_NEXT_ACTION_NAME });
    const nextActionCount = await nextActionLinks.count() + await nextActionButtons.count();
    expect(
      nextActionCount,
      `calendar asset row "${assetWithBranchAndCategory.name}" should expose a next-step action that carries the selected date and scope forward`
    ).toBeGreaterThan(0);

    const expectNextStepUrlContext = (currentUrl: string, stage: string) => {
      const url = new URL(currentUrl);
      expect(url.searchParams.get('branch_id'), `${stage} should keep branch scope in the URL`).toBe(assetWithBranchAndCategory.branch_id);
      expect(url.searchParams.get('category_id'), `${stage} should keep category scope in the URL`).toBe(assetWithBranchAndCategory.asset_category_id);
      expect(
        url.searchParams.get('start_date') ?? url.searchParams.get('planned_start'),
        `${stage} should keep the selected start date in the URL`
      ).toBe(selectedStart);
      expect(
        url.searchParams.get('end_date') ?? url.searchParams.get('planned_end'),
        `${stage} should keep the selected end date in the URL`
      ).toBe(selectedEnd);
    };

    if (await nextActionLinks.count()) {
      const nextActionLink = nextActionLinks.first();
      const nextActionHref = await nextActionLink.getAttribute('href');
      expect(nextActionHref, 'calendar next-step action should be a real navigation target').toBeTruthy();
      const nextActionUrl = new URL(nextActionHref!, page.url());
      expectNextStepUrlContext(nextActionUrl.href, 'calendar next-step action');
      await nextActionLink.click();
    } else {
      await nextActionButtons.first().click();
    }

    await page.waitForLoadState('networkidle');
    expectNextStepUrlContext(page.url(), 'next-step navigation');

    const destinationUrl = new URL(page.url());
    const assetIdParam = destinationUrl.searchParams.get('asset_id')
      ?? destinationUrl.searchParams.get('entity_id')
      ?? destinationUrl.pathname.split('/').at(-1);
    const bodyTextBeforeReload = await page.locator('body').innerText();
    expect(
      bodyTextBeforeReload,
      'destination screen should show the operator-readable asset name, not degrade to raw-ID-first context'
    ).toContain(assetWithBranchAndCategory.name);
    expect(
      bodyTextBeforeReload,
      'destination screen should show the operator-readable branch name before reload'
    ).toContain(assetWithBranchAndCategory.branch_name!);

    // UUID-first rendering check: the asset/entity ID should not appear as the primary label
    if (assetIdParam && UUID_PATTERN.test(assetIdParam)) {
      const assetNameIndex = bodyTextBeforeReload.indexOf(assetWithBranchAndCategory.name);
      const assetIdIndex = bodyTextBeforeReload.indexOf(assetIdParam);
      expect(
        assetNameIndex !== -1 && (assetIdIndex === -1 || assetNameIndex < assetIdIndex),
        'destination screen should surface the asset name before any raw UUID in the visible content'
      ).toBe(true);
    }

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    expectNextStepUrlContext(page.url(), 'next-step reload');

    const bodyTextAfterReload = await page.locator('body').innerText();
    expect(
      bodyTextAfterReload,
      'destination screen should still show the operator-readable asset name after reload'
    ).toContain(assetWithBranchAndCategory.name);
    expect(
      bodyTextAfterReload,
      'destination screen should still show the operator-readable branch name after reload'
    ).toContain(assetWithBranchAndCategory.branch_name!);
    expect(
      bodyTextAfterReload,
      'destination screen should still show the operator-readable category name after reload'
    ).toContain(assetWithBranchAndCategory.asset_category_name!);
  });
});
