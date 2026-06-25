import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Real-environment smoke E2E — drives the DEPLOYED app (E2E_BASE_URL), not a build.
 * Catches: app down, JS crash on a route, blank render, visible error boundaries,
 * Mixed-Content / HTTP Supabase calls, wrong API URL, RLS lockout, and blank data renders.
 * All tests here are GATING (failures block a deploy via e2e-dev.yml).
 *
 * Closes https://github.com/Volaris-AI/dia/issues/170
 */

const ROUTES: { path: string; name: string }[] = [
  { path: '/', name: 'Home' },
  { path: '/rental/orders', name: 'Rental Orders' },
  { path: '/rental/contracts', name: 'Contracts' },
  { path: '/rental/returns', name: 'Returns / Check-in' },
  { path: '/rental/availability', name: 'Asset Availability' },
  { path: '/branch/ops', name: 'Branch Operations' },
  { path: '/branch/counts', name: 'RapidCount Scheduling' },
  { path: '/analytics/fleet', name: 'Fleet Reporting' },
  { path: '/analytics/enterprise-financials', name: 'Enterprise Financial Reporting' },
  { path: '/field/mobile', name: 'Mobile Field' },
  { path: '/crm/customers', name: 'CRM Customer Profiles' },
  { path: '/enterprise/org-hierarchy', name: 'Org Hierarchy' },
];

const ERROR_TEXT = /something went wrong|application error|failed to load|unexpected error|cannot read propert/i;

// Data-bearing screens require authentication: the app enforces an auth gate and
// Supabase anon reads are locked down (#257), so an unauthenticated visit redirects
// to /login and no data renders. Smoke tests that assert on DATA must sign in first.
const AUTH_EMAIL = process.env.E2E_AUTH_EMAIL;
const AUTH_PASSWORD = process.env.E2E_AUTH_PASSWORD;
const E2E_SUPABASE_URL = process.env.E2E_SUPABASE_URL;
const E2E_SUPABASE_SERVICE_KEY = process.env.E2E_SUPABASE_SERVICE_KEY;
const ORDER_CONVERSION_TIMEOUT = 15_000;
const ORDER_CONVERSION_MAX_ORDERS_TO_SCAN = 20;
const ORDER_CONVERSION_NAVIGATION_TIMEOUT = 8_000;
const ORDER_TO_CONTRACT_ACTION_PATTERN = /convert(?:\s+order)?(?:\s+to)?\s+(?:a\s+)?(?:rental\s+)?contract|create\s+(?:a\s+)?(?:rental\s+)?contract/i;
const LIFECYCLE_CHECKOUT_DATE = '2026-07-11';
const LIFECYCLE_RETURN_DATE = '2026-07-12';
const HUMAN_READABLE_CUSTOMER_PATTERN = /Customer\s+(?!N\/A\b)(?!customer[-_])[^\n·]+/i;
const HUMAN_READABLE_INVOICE_PATTERN = /\b(?:Invoice\s+)?INV-[A-Z0-9-]{2,}\b/i;

interface CheckoutCandidate {
  contractId: string;
  lineId: string;
  assetId: string;
}

interface AvailableAssetCandidate {
  assetId: string;
}

interface OrderConversionCandidate {
  orderId: string;
  orderLabel: string;
  rentalType: string;
  category: string;
  customerName: string | null;
  lineCategory: string;
  lineQuantity: string;
  linePlannedStart: string;
  linePlannedEnd: string;
  lineJobSite: string;
}

async function signIn(page: Page): Promise<void> {
  // Login is a standalone page (no app chrome) — fill the form directly.
  await page.goto('/login');
  await page.getByTestId('login-email').fill(AUTH_EMAIL!);
  await page.getByTestId('login-password').fill(AUTH_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
}

function serviceRoleHeaders() {
  if (!E2E_SUPABASE_SERVICE_KEY) {
    throw new Error('E2E_SUPABASE_SERVICE_KEY is required for service-role tax-filing seed operations.');
  }
  return {
    apikey: E2E_SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + E2E_SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type RpcRequestPayload = {
  p_entity_type?: string;
  p_entity_id?: string;
  p_data?: Record<string, unknown>;
};

function parseRpcRequestPayload(requestBodyText: string): RpcRequestPayload | null {
  try {
    const parsed = JSON.parse(requestBodyText);
    return typeof parsed === 'object' && parsed !== null ? parsed as RpcRequestPayload : null;
  } catch {
    return null;
  }
}

function extractDocumentCustomerName(contextGridText: string): string | null {
  const customerBlock = contextGridText.match(
    /Customer\s*\n([\s\S]*?)(?:\n(?:Job Site|Reference|Status|Issued|Rental)\b|$)/i
  )?.[1];
  if (!customerBlock) {
    return null;
  }

  return customerBlock
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^(Customer|Job Site|Reference:|Status:|Issued:|Rental:)/i.test(line)) ?? null;
}

async function requireServiceRoleSeedContext(request: APIRequestContext) {
  const invoiceResponse = await request.get(
    `${E2E_SUPABASE_URL!}/rest/v1/entities?entity_type=eq.invoice&select=id,tenant_id&order=created_at.desc&limit=1`,
    { headers: serviceRoleHeaders() }
  );
  expect(invoiceResponse.ok(), 'service-role invoice lookup failed').toBe(true);
  const invoices = await invoiceResponse.json() as Array<{ id: string; tenant_id: string }>;
  expect(invoices.length, 'expected at least one existing invoice to seed tax filing e2e rows').toBeGreaterThan(0);
  return invoices[0];
}

async function selectComboboxOption(page: Page, label: string, optionText: string): Promise<void> {
  const combobox = page.getByRole('combobox', { name: label });
  await combobox.click();
  await page.getByRole('option', { name: optionText, exact: true }).click();
}

async function gotoAndCollectErrors(page: Page, path: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  const resp = await page.goto(path, { waitUntil: 'load' });
  expect(resp, `no response for ${path}`).not.toBeNull();
  expect(resp!.status(), `HTTP status for ${path}`).toBeLessThan(400);
  // let client-side render + initial data fetch settle
  await page.waitForTimeout(2500);
  return errors;
}

async function findEligibleCheckoutLine(page: Page): Promise<CheckoutCandidate> {
  await page.goto('/rental/contracts');
  await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();

  const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
  const contractCount = await viewActions.count();
  if (contractCount === 0) {
    test.skip(true, 'No contracts with a View action are available in this environment.');
  }

  const maxContractsToScan = Math.min(contractCount, 10);
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
      const status = lineText.match(/\b(checked_out|returned)\b/i)?.[1]?.toLowerCase();

      if (!lineId || !assetId || /^unassigned$/i.test(assetId)) continue;
      if (status === 'checked_out' || status === 'returned') continue;

      return { contractId, lineId, assetId };
    }
  }

  throw new Error('No eligible contract line found for checkout (requires non-checked-out line with an assigned asset).');
}

async function findCheckedOutReturnsLine(page: Page): Promise<CheckoutCandidate | null> {
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

async function findAvailableAssetForCategory(page: Page, categoryId: string): Promise<AvailableAssetCandidate> {
  const assetsResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'GET'
    && response.url().includes('/rest/v1/entities')
    && response.url().includes('entity_type=eq.asset')
    && !response.url().includes('entity_type=eq.asset_category')
  ));

  await page.goto('/entities/asset');
  await page.waitForLoadState('networkidle');

  const assetsResponse = await assetsResponsePromise;
  expect(assetsResponse.status(), 'asset list request should succeed when locating an available asset').toBeLessThan(400);

  const assets = await assetsResponse.json() as Array<{
    id: string;
    entity_versions?: Array<{
      is_current?: boolean;
      data?: {
        status?: string;
        asset_category_id?: string;
        category_id?: string;
      };
    }>;
  }>;

  for (const asset of assets) {
    const currentVersion = asset.entity_versions?.find((version) => version.is_current) ?? asset.entity_versions?.[0];
    const assetData = currentVersion?.data;
    const assetCategoryId = assetData?.asset_category_id?.trim() ?? assetData?.category_id?.trim() ?? '';
    const assetStatus = assetData?.status?.trim()?.toLowerCase() ?? '';
    if (assetCategoryId !== categoryId || assetStatus !== 'available') {
      continue;
    }

    return { assetId: asset.id };
  }

  test.skip(true, `No available asset found for converted order line category ${categoryId}.`);
  throw new Error('unreachable');
}

async function findEligibleOrderForConversion(page: Page): Promise<OrderConversionCandidate> {
  await page.goto('/rental/orders');
  await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();

  const viewButtons = page.getByRole('button', { name: 'View' });
  const orderCountFromButtons = await viewButtons.count();
  const viewActions = orderCountFromButtons > 0 ? viewButtons : page.getByRole('link', { name: 'View' });
  const orderCount = orderCountFromButtons > 0 ? orderCountFromButtons : await viewActions.count();
  if (orderCount === 0) {
    throw new Error('No rental orders with a View action are available to inspect for conversion.');
  }

  const maxOrdersToScan = Math.min(orderCount, ORDER_CONVERSION_MAX_ORDERS_TO_SCAN);
  for (let orderIndex = 0; orderIndex < maxOrdersToScan; orderIndex++) {
    if (orderIndex > 0) {
      await page.goto('/rental/orders');
      await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();
    }

    await viewActions.nth(orderIndex).click();
    try {
      await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/, { timeout: ORDER_CONVERSION_NAVIGATION_TIMEOUT });
    } catch {
      continue;
    }
    await page.waitForLoadState('networkidle');

    const orderId = page.url().match(/\/rental\/orders\/([^/?#]+)$/)?.[1]?.trim();
    if (!orderId) continue;

    const approvedStatusCount = await page.getByText(/^approved$/i).count();
    const convertActions = page
      .getByRole('button', { name: ORDER_TO_CONTRACT_ACTION_PATTERN })
      .or(page.getByRole('link', { name: ORDER_TO_CONTRACT_ACTION_PATTERN }));
    const convertActionCount = await convertActions.count();
    const visibleLineCount = await page.getByText(/^Line ID:/).count();
    if (approvedStatusCount === 0 || convertActionCount === 0 || visibleLineCount === 0) continue;

    const orderLabel = (await page.locator('main').getByRole('heading', { level: 1 }).first().innerText()).trim();
    const rentalType = (await page.getByText(/^(external|internal)$/i).first().innerText()).trim();
    const category = (await page.getByText(/^Category:/).first().innerText()).replace(/^Category:\s*/i, '').trim();
    const lineQtyLabel = page.getByText(/^Qty:/).first();
    if (!rentalType || !category || (await lineQtyLabel.count()) === 0) continue;

    const lineCard = page.locator('div.rounded-lg.border').filter({ has: lineQtyLabel }).first();
    const lineText = await lineCard.innerText();
    const lineCategory = lineText.split('\n')[0]?.trim() ?? '';
    const lineQuantity = lineText.match(/Qty:\s*([^·\n]+)/i)?.[1]?.trim() ?? '';
    const lineDateRange = lineText.match(/Qty:\s*[^\n·]+\s*·\s*([0-9-]+)\s+to\s+([0-9-]+)/i);
    const linePlannedStart = lineDateRange?.[1]?.trim() ?? '';
    const linePlannedEnd = lineDateRange?.[2]?.trim() ?? '';
    const lineJobSite = lineText.match(/Job Site:\s*([^\n·]+)/i)?.[1]?.trim() ?? 'N/A';
    if (!lineCategory || !lineQuantity || !linePlannedStart || !linePlannedEnd) continue;

    let customerName: string | null = null;
    const documentToggle = page.getByTestId('toggle-order-document');
    if ((await documentToggle.count()) > 0) {
      await documentToggle.click();
      await expect(page.getByTestId('commercial-document')).toBeVisible();
      customerName = extractDocumentCustomerName(await page.getByTestId('commercial-document-context-grid').innerText());
    }

    return {
      orderId,
      orderLabel,
      rentalType,
      category,
      customerName,
      lineCategory,
      lineQuantity,
      linePlannedStart,
      linePlannedEnd,
      lineJobSite,
    };
  }

  throw new Error('No approved rental order with an available order-to-contract conversion action and visible line context was found.');
}

test('app shell renders Dealernet branding in header and document title', async ({ page }) => {
  await gotoAndCollectErrors(page, '/');
  await expect(page).toHaveTitle(/Dealernet/);
  await expect(page.getByRole('heading', { name: 'Dealernet' })).toBeVisible();
  // old internal framework name must not appear anywhere in the rendered page
  await expect(page.locator('body')).not.toContainText('JSON UI Engine');
});

test('app shell loads and serves a document', async ({ page }) => {
  const errors = await gotoAndCollectErrors(page, '/');
  await expect(page).toHaveTitle(/.+/);
  const body = (await page.locator('body').innerText()).trim();
  expect(body.length, 'home rendered no text (blank app)').toBeGreaterThan(0);
  expect(errors, `uncaught errors on /: ${errors.join(' | ')}`).toEqual([]);
});

for (const r of ROUTES) {
  test(`route renders without crash: ${r.name} (${r.path})`, async ({ page }) => {
    const errors = await gotoAndCollectErrors(page, r.path);
    // page rendered meaningful content
    const body = (await page.locator('body').innerText()).trim();
    expect(body.length, `blank render on ${r.path}`).toBeGreaterThan(0);
    // no visible error boundary / crash text
    await expect(page.locator('body'), `error boundary visible on ${r.path}`).not.toContainText(ERROR_TEXT);
    // no uncaught JS errors
    expect(errors, `uncaught errors on ${r.path}: ${errors.join(' | ')}`).toEqual([]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA-LAYER GUARD
// These tests catch the whole class of "no data visible" deploys:
//   • Mixed-Content (HTTPS page calling HTTP Supabase → every request blocked)
//   • Wrong / missing VITE_SUPABASE_URL (requests go to localhost from the browser)
//   • RLS lockout (requests return 403/401 instead of data)
//   • Dev-server deploy (import.meta.env.DEV true, wrong runtime config)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supabase REST calls must use HTTPS and must not be blocked.
 * A mixed-content violation (http:// Supabase URL on an https:// app) silently
 * blocks every data request in the browser. This test is RED today and must
 * turn GREEN before a deploy is considered healthy.
 */
test('data-layer: Supabase rest/v1 calls use HTTPS and are not blocked', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated data-layer smoke.');
  // Authenticate first — anon reads are locked down, so data calls only fire for a signed-in user.
  await signIn(page);
  // Wait for any in-flight data requests triggered by the sign-in redirect (e.g.
  // v_home_dashboard_kpis) to settle before attaching the requestfailed listener.
  // Without this, the subsequent page.goto('/') can abort those in-flight requests
  // and the listener would capture them as spurious "blocked" events.
  await page.waitForLoadState('networkidle');

  const blockedUrls: string[] = [];
  const supabaseResponses: Array<{ url: string; status: number }> = [];

  // Attach listeners BEFORE navigation so no early requests are missed.
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('/rest/v1') || url.includes('/auth/v1') || url.includes('/storage/v1')) {
      blockedUrls.push(url);
    }
  });

  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('/rest/v1')) {
      supabaseResponses.push({ url, status: resp.status() });
    }
  });

  await page.goto('/', { waitUntil: 'load' });
  // Wait until all async data fetches (REST calls) have settled before asserting.
  // networkidle: no network connections for ≥500 ms — more reliable than a fixed delay.
  await page.waitForLoadState('networkidle');

  // At least one Supabase data call must have been made.
  expect(
    supabaseResponses.length + blockedUrls.length,
    'No Supabase rest/v1 requests observed — data layer not active or VITE_SUPABASE_URL is misconfigured'
  ).toBeGreaterThan(0);

  // No requests may have been blocked (mixed-content, DNS failure, network error).
  expect(blockedUrls, `Supabase requests were blocked (mixed-content or network error): ${blockedUrls.join(', ')}`).toEqual([]);

  for (const { url, status } of supabaseResponses) {
    // All Supabase API calls must use HTTPS; HTTP triggers Mixed-Content blocking.
    expect(url, `Supabase rest/v1 call uses HTTP (mixed-content violation): ${url}`).toMatch(/^https:\/\//);

    // Successful calls must return HTTP 200 (not 401/403/5xx).
    expect(status, `Supabase rest/v1 call returned ${status} (expected 200): ${url}`).toBe(200);
  }
});

/**
 * Dashboard KPI cards must render correctly and contain no unresolved template
 * expressions. A raw "{{...}}" token in the page means the template engine or
 * data pipeline failed. Missing KPI headings mean the component tree crashed.
 * At least one KPI numeric value must be visible and the "as_of" timestamp
 * must render as a human-readable date (e.g. "As of Jun 9, 9:15 PM") rather
 * than a raw ISO string or an unfilled template placeholder.
 */
test('dashboard: KPI cards render without unresolved template expressions', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated dashboard smoke.');
  await signIn(page);
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');

  const body = await page.locator('body').innerText();

  // Raw {{ }} in the rendered text means template evaluation failed.
  expect(
    body,
    'Dashboard contains unresolved template expressions ({{...}}) — template engine or data layer failed'
  ).not.toMatch(/\{\{.+?\}\}/);

  // The "As of" chip must render with a real human-readable timestamp produced by
  // formatDateTime. Use a locator expectation (auto-waits) so slow KPI fetches
  // don't cause flaky snapshots of the initial empty-render state.
  await expect(
    page.getByText(/^As of [A-Za-z]+ \d/),
    '"As of" KPI timestamp chip did not render — v_home_dashboard_kpis.as_of did not load'
  ).toBeVisible();

  // Known KPI card headings must be visible — their absence means the component tree crashed.
  await expect(page.getByText('Assets On Rent'), 'KPI card "Assets On Rent" not visible').toBeVisible();
  await expect(page.getByText('Overdue Returns', { exact: true }), 'KPI card "Overdue Returns" not visible').toBeVisible();
  await expect(page.getByText('Open Maintenance'), 'KPI card "Open Maintenance" not visible').toBeVisible();
  await expect(page.getByText('Period Revenue'), 'KPI card "Period Revenue" not visible').toBeVisible();

  // At least one KPI value element must contain a rendered number.
  // StatCard values render in <p className="tabular-nums"> elements. Even when
  // the database returns zero, the "|| 0" fallback still produces "0" — so any
  // digit here proves the template evaluated and the data-rendering chain is intact.
  const statCardValueTexts = await page.locator('p.tabular-nums').allInnerTexts();
  const numericKpiValues = statCardValueTexts.filter((t) => /^\$?\d/.test(t.trim()));
  expect(
    numericKpiValues.length,
    `No KPI numeric values found in stat-card elements — KPI data rendering failed. values seen: [${statCardValueTexts.join(', ')}]`
  ).toBeGreaterThan(0);

});

test('tax-filings: snapshot-backed rows generated via service-role seed render and export in app route', async ({ page, request }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated tax-filing smoke.');
  test.skip(!E2E_SUPABASE_URL, 'Set E2E_SUPABASE_URL to seed tax filing snapshots for this E2E.');
  test.skip(!E2E_SUPABASE_SERVICE_KEY, 'Set E2E_SUPABASE_SERVICE_KEY to seed tax filing snapshots for this E2E.');

  const eventId = `e2e-tax-filing-${randomUUID()}`;
  const jurisdictionCode = `US-E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
  const snapshotDate = '2026-06-15';
  const seededInvoice = await requireServiceRoleSeedContext(request);

  let seededSnapshotId: string | null = null;
  let seededJurisdictionId: string | null = null;
  let seededJurisdictionSnapshotId: string | null = null;

  try {
    const jurisdictionInsertResponse = await request.post(`${E2E_SUPABASE_URL!}/rest/v1/tax_jurisdictions`, {
      headers: serviceRoleHeaders(),
      data: [{
        jurisdiction_code: jurisdictionCode,
        jurisdiction_name: 'E2E Tax Filing Jurisdiction',
        country_code: 'US',
        level: 'city',
      }],
    });
    expect(jurisdictionInsertResponse.ok(), 'failed to insert e2e tax jurisdiction').toBe(true);
    const insertedJurisdictions = await jurisdictionInsertResponse.json() as Array<{ id: string }>;
    seededJurisdictionId = insertedJurisdictions[0]?.id ?? null;
    expect(seededJurisdictionId, 'inserted jurisdiction id missing').toBeTruthy();

    const snapshotInsertResponse = await request.post(`${E2E_SUPABASE_URL!}/rest/v1/invoice_tax_snapshots`, {
      headers: serviceRoleHeaders(),
      data: [{
        invoice_id: seededInvoice.id,
        tenant_id: seededInvoice.tenant_id,
        source_event_id: eventId,
        event_type: 'invoice_finalized',
        snapshot_effective_at: snapshotDate,
        determination_scope: 'billing_account',
      }],
    });
    expect(snapshotInsertResponse.ok(), 'failed to insert e2e tax snapshot').toBe(true);
    const insertedSnapshots = await snapshotInsertResponse.json() as Array<{ id: string }>;
    seededSnapshotId = insertedSnapshots[0]?.id ?? null;
    expect(seededSnapshotId, 'inserted tax snapshot id missing').toBeTruthy();

    const jurisdictionSnapshotInsertResponse = await request.post(`${E2E_SUPABASE_URL!}/rest/v1/invoice_tax_jurisdiction_snapshots`, {
      headers: serviceRoleHeaders(),
      data: [{
        invoice_tax_snapshot_id: seededSnapshotId,
        jurisdiction_id: seededJurisdictionId,
        jurisdiction_code: jurisdictionCode,
        tax_code: 'sales_tax',
        tax_rate: 0.0825,
        taxable_amount: 1000,
        exempt_amount: 0,
        collected_tax_amount: 82.5,
      }],
    });
    expect(jurisdictionSnapshotInsertResponse.ok(), 'failed to insert e2e jurisdiction snapshot').toBe(true);
    const insertedJurisdictionSnapshots = await jurisdictionSnapshotInsertResponse.json() as Array<{ id: string }>;
    seededJurisdictionSnapshotId = insertedJurisdictionSnapshots[0]?.id ?? null;
    expect(seededJurisdictionSnapshotId, 'inserted jurisdiction snapshot id missing').toBeTruthy();

    await signIn(page);

    const [summaryResponse, exportResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && response.url().includes('/rest/v1/v_invoice_tax_filing_period_jurisdiction_summary')
      )),
      page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && response.url().includes('/rest/v1/v_invoice_tax_filing_export_rows')
      )),
      page.goto('/analytics/tax-filings', { waitUntil: 'load' }),
    ]);

    expect(summaryResponse.ok(), 'tax filing summary query failed').toBe(true);
    expect(exportResponse.ok(), 'tax filing export query failed').toBe(true);

    const exportRows = await exportResponse.json() as Array<{ source_event_id?: string }>;
    expect(
      exportRows.some((row) => row.source_event_id === eventId),
      'seeded snapshot row missing from snapshot-backed filing export view'
    ).toBe(true);

    await page.getByLabel('Jurisdiction').fill(jurisdictionCode);
    await expect(page.getByText(eventId), 'seeded export row should render in tax filings route').toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Filing CSV' }).click(),
    ]);
    const downloadPath = await download.path();
    expect(downloadPath, 'expected CSV download artifact').toBeTruthy();
    const csvText = downloadPath ? await readFile(downloadPath, 'utf8') : '';
    expect(csvText).toContain(eventId);
    expect(csvText).toContain(jurisdictionCode);
  } finally {
    if (seededJurisdictionSnapshotId) {
      const deleteJurisdictionSnapshotResponse = await request.delete(
        `${E2E_SUPABASE_URL!}/rest/v1/invoice_tax_jurisdiction_snapshots?id=eq.${seededJurisdictionSnapshotId}`,
        { headers: serviceRoleHeaders() }
      );
      expect(deleteJurisdictionSnapshotResponse.ok(), 'failed to clean up e2e jurisdiction snapshot').toBe(true);
    }
    if (seededSnapshotId) {
      const deleteSnapshotResponse = await request.delete(
        `${E2E_SUPABASE_URL!}/rest/v1/invoice_tax_snapshots?id=eq.${seededSnapshotId}`,
        { headers: serviceRoleHeaders() }
      );
      expect(deleteSnapshotResponse.ok(), 'failed to clean up e2e tax snapshot').toBe(true);
    }
    if (seededJurisdictionId) {
      const deleteJurisdictionResponse = await request.delete(
        `${E2E_SUPABASE_URL!}/rest/v1/tax_jurisdictions?id=eq.${seededJurisdictionId}`,
        { headers: serviceRoleHeaders() }
      );
      expect(deleteJurisdictionResponse.ok(), 'failed to clean up e2e tax jurisdiction').toBe(true);
    }
  }
});

test('dispatch live ops: remains operator-useful with KPI context, backend filter narrowing, and actionable contract drill-downs', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated dispatch live smoke.');
  await signIn(page);

  let initialActiveRoutes: Array<{ contract_id?: string | null }> = [];
  let filteredActiveRoutes: Array<{ route_status?: string | null }> = [];

  const [initialRoutesResponse, efficiencyResponse] = await Promise.all([
    page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/v_dispatch_route_live')
      && response.url().includes('route_status=ilike.%25')
    )),
    page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/v_transport_efficiency_summary')
    )),
    page.goto('/dispatch/live', { waitUntil: 'load' }),
  ]);

  await page.waitForLoadState('networkidle');

  expect(initialRoutesResponse.ok(), 'initial dispatch live routes request should succeed').toBe(true);
  expect(efficiencyResponse.ok(), 'transport efficiency summary request should succeed').toBe(true);

  initialActiveRoutes = await initialRoutesResponse.json() as Array<{ contract_id?: string | null }>;
  const efficiencyRows = await efficiencyResponse.json() as Array<{ active_routes?: number | null }>;

  await expect(page.getByRole('heading', { name: 'Dispatch Live Operations' })).toBeVisible();
  await expect(page.getByText('Transport Efficiency Summary')).toBeVisible();
  await expect(page.getByText('Filter Routes')).toBeVisible();
  await expect(page.getByText('Live Route Progress')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Route Status' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Exception State' })).toBeVisible();
  await expect(page.getByLabel('Driver')).toBeVisible();
  await expect(page.getByLabel('Truck')).toBeVisible();
  await expect(page.getByLabel('Branch')).toBeVisible();

  const efficiencyCard = page.getByText('Transport Efficiency Summary').first().locator('../..');
  const efficiencyMetricVisible = await efficiencyCard.getByText('Active Routes').first().isVisible()
    || await efficiencyCard.getByText('Load Utilization').first().isVisible();
  const efficiencyErrorVisible = await page.getByText('Unable to load efficiency metrics').isVisible();
  expect(
    efficiencyMetricVisible || efficiencyErrorVisible,
    'dispatch live must show KPI context metrics or an explicit efficiency error state'
  ).toBe(true);
  expect(efficiencyRows.length, 'transport efficiency summary should return at least one summary row').toBeGreaterThan(0);

  const [filteredRoutesResponse] = await Promise.all([
    page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/v_dispatch_route_live')
      && response.url().includes('route_status=ilike.in_transit')
    )),
    selectComboboxOption(page, 'Route Status', 'In Transit'),
  ]);
  await page.waitForLoadState('networkidle');
  expect(filteredRoutesResponse.ok(), 'filtered dispatch live routes request should succeed').toBe(true);
  filteredActiveRoutes = await filteredRoutesResponse.json() as Array<{ route_status?: string | null }>;
  expect(
    filteredActiveRoutes.every((route) => route.route_status === 'in_transit'),
    'route status filter should narrow backend results to in_transit rows'
  ).toBe(true);

  if (initialActiveRoutes.some((route) => Boolean(route.contract_id))) {
    const contractLinks = page.getByRole('link', { name: 'View Contract' });
    await expect(contractLinks.first(), 'live route cards should expose contract drill-down links').toBeVisible();
    const href = await contractLinks.first().getAttribute('href');
    expect(href, 'View Contract link should include a contract detail route').toMatch(/^\/rental\/contracts\/[^/]+$/);
    await contractLinks.first().click();
    await expect(page).toHaveURL(/\/rental\/contracts\/[^/]+$/);
  } else {
    await expect(page.getByText('No active routes match the current filters.')).toBeVisible();
  }
});

/**
 * Rental Orders list page must render its full structure. When seed data
 * (issue #160) has been applied, at least one order row must be visible with
 * non-empty content.  Row-level assertions are gated on actual data presence
 * so they do not fail on a clean (pre-seed) database.
 */
test('rental-orders: list structure renders; ≥1 row when seed data is present', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated rental-orders smoke.');
  await signIn(page);

  const orderApiErrors: string[] = [];

  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('/rest/v1/entities')) {
      if (resp.status() !== 200) {
        orderApiErrors.push(`HTTP ${resp.status()}: ${url}`);
      }
    }
  });

  await page.goto('/rental/orders', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');

  const body = await page.locator('body').innerText();

  // Entities API must respond with 200.
  expect(
    orderApiErrors,
    `Rental orders data request failed: ${orderApiErrors.join(', ')}`
  ).toEqual([]);

  // No raw template expressions in the rendered page.
  expect(
    body,
    'Rental orders page contains unresolved template expressions — template engine or data layer failed'
  ).not.toMatch(/\{\{.+?\}\}/);

  // Page heading must be present.
  await expect(
    page.getByRole('heading', { name: 'Rental Orders' }),
    '"Rental Orders" heading not visible'
  ).toBeVisible();

  // Column header row always renders regardless of data.
  await expect(
    page.getByText('Status / Requester'),
    '"Status / Requester" column header not found — list structure is broken'
  ).toBeVisible();

  // An error alert visible here means Supabase returned an error for the entities query.
  await expect(
    page.getByText('Unable to load rental orders'),
    'Data error alert is visible on rental orders page — Supabase fetch failed'
  ).not.toBeVisible();

  // Row-level assertion: gated on data presence (seed data from issue #160).
  // "Requester:" label appears in every rendered order row.
  const requesterLabels = page.getByText(/^Requester:/);
  const rowCount = await requesterLabels.count();

  if (rowCount > 0) {
    // Data is present — assert at least one row with non-empty content.
    expect(rowCount, 'Rental orders: expected ≥1 visible order row').toBeGreaterThanOrEqual(1);
    const firstRowText = await requesterLabels.first().textContent();
    expect(
      firstRowText?.trim(),
      'First order row "Requester:" label is empty'
    ).toBeTruthy();
  } else {
    // No rows yet — acceptable pre-seed; the HTTPS+200 checks above guard against data blackout.
    // When seed data from issue #160 is applied, this branch should never execute in CI.
    console.warn(
      '[smoke] rental-orders: 0 order rows found — seed data not yet applied (see issue #160). ' +
        'HTTPS + HTTP 200 checks above guard against data blackout.'
    );
  }
});

/**
 * CRM customer list route must render its structure.  The detail route is always
 * exercised: when E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_KEY are present the
 * customer ID is resolved directly via the service-role API (deterministic); when
 * those vars are absent the first "View Profile" button is clicked, but the test
 * fails hard if no rows are present so the detail route is never silently skipped.
 *
 * Closes https://github.com/Volaris-AI/dia/issues/945 (live route coverage).
 */
test('crm-customers: list renders; detail route reachable from first customer row', async ({ page, request }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated CRM smoke.');
  await signIn(page);

  const crmApiErrors: string[] = [];

  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('/rest/v1/crm_customer_profile_current')) {
      if (resp.status() !== 200) {
        crmApiErrors.push(`HTTP ${resp.status()}: ${url}`);
      }
    }
  });

  await page.goto('/crm/customers', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');

  const body = await page.locator('body').innerText();

  // crm_customer_profile_current API must respond with 200.
  expect(
    crmApiErrors,
    `CRM customers data request failed: ${crmApiErrors.join(', ')}`
  ).toEqual([]);

  // No raw template expressions in the rendered page.
  expect(
    body,
    'CRM customers page contains unresolved template expressions — template engine or data layer failed'
  ).not.toMatch(/\{\{.+?\}\}/);

  // Page heading must be present.
  await expect(
    page.getByRole('heading', { name: 'Customer Profiles' }),
    '"Customer Profiles" heading not visible'
  ).toBeVisible();

  // No data error alert.
  await expect(
    page.getByText('Unable to load'),
    'Data error alert visible on CRM customers page — Supabase fetch failed'
  ).not.toBeVisible();

  // Detail-route coverage — always enforced.
  // When service-role credentials are available, resolve the customer ID directly
  // from the view (deterministic, no dependency on rendered rows).  Otherwise fall
  // back to clicking the first "View Profile" button; fail hard if no rows exist so
  // the detail route is never silently bypassed.
  if (E2E_SUPABASE_URL && E2E_SUPABASE_SERVICE_KEY) {
    const apiResp = await request.get(
      `${E2E_SUPABASE_URL}/rest/v1/crm_customer_profile_current?select=entity_id&limit=1`,
      {
        headers: {
          apikey: E2E_SUPABASE_SERVICE_KEY,
          Authorization: 'Bearer ' + E2E_SUPABASE_SERVICE_KEY,
        },
      }
    );
    expect(apiResp.ok(), 'service-role crm_customer_profile_current lookup failed').toBe(true);
    const rows = (await apiResp.json()) as Array<{ entity_id: string }>;
    const customerId = rows[0]?.entity_id;
    expect(
      customerId,
      'crm_customer_profile_current returned no rows — seed data required for CRM detail-route coverage'
    ).toBeTruthy();
    await page.goto(`/crm/customers/${customerId}`, { waitUntil: 'load' });
  } else {
    const viewProfileButtons = page.getByRole('button', { name: 'View Profile' });
    expect(
      await viewProfileButtons.count(),
      'No customer rows rendered and E2E_SUPABASE_SERVICE_KEY is not set — ' +
        'cannot exercise /crm/customers/:id. Provide seed data or set E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_KEY.'
    ).toBeGreaterThan(0);
    await viewProfileButtons.first().click();
  }

  await page.waitForLoadState('networkidle');

  // The URL must match the detail route pattern.
  await expect(page).toHaveURL(/\/crm\/customers\/[^/]+$/);

  const detailBody = await page.locator('body').innerText();

  // No raw template expressions on the detail page.
  expect(
    detailBody,
    'CRM customer detail page contains unresolved template expressions'
  ).not.toMatch(/\{\{.+?\}\}/);

  // No error boundary on the detail page.
  await expect(
    page.locator('body'),
    'Error boundary visible on CRM customer detail page'
  ).not.toContainText(ERROR_TEXT);
});

/**
 * Enterprise Financial Reporting route — validates the deployed screen survives
 * the real app/data path. Asserts on the page structure (heading, filter controls,
 * summary card) and confirms the Supabase view call returns HTTP 200 without JS
 * errors or a visible error boundary.
 */
test('enterprise-financials: route renders structure and data layer responds without error', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL/PASSWORD to run authenticated enterprise-financials smoke.');
  await signIn(page);

  const reportingApiErrors: string[] = [];

  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('/rest/v1/v_enterprise_financial_reporting_lines')) {
      if (resp.status() !== 200) {
        reportingApiErrors.push(`HTTP ${resp.status()}: ${url}`);
      }
    }
  });

  const errors = await gotoAndCollectErrors(page, '/analytics/enterprise-financials');
  await page.waitForLoadState('networkidle');

  // No uncaught JS errors.
  expect(errors, `uncaught errors on /analytics/enterprise-financials: ${errors.join(' | ')}`).toEqual([]);

  // No visible error boundary / crash text.
  await expect(
    page.locator('body'),
    'error boundary visible on /analytics/enterprise-financials'
  ).not.toContainText(ERROR_TEXT);

  // The data layer must not have returned an error status.
  expect(
    reportingApiErrors,
    `enterprise financial reporting data request failed: ${reportingApiErrors.join(', ')}`
  ).toEqual([]);

  // Page heading must be present.
  await expect(
    page.getByRole('heading', { name: 'Enterprise Financial Reporting' }),
    '"Enterprise Financial Reporting" heading not visible'
  ).toBeVisible();

  // The filter controls (scope level and period selectors) must be rendered.
  await expect(page.getByLabelText('Scope Level'), '"Scope Level" filter not visible').toBeVisible();
  await expect(page.getByLabelText('Period Start'), '"Period Start" filter not visible').toBeVisible();
  await expect(page.getByLabelText('Period End'), '"Period End" filter not visible').toBeVisible();

  // The consolidated summary card must be visible.
  await expect(
    page.getByTestId('enterprise-company-summary'),
    'consolidated company summary card not visible'
  ).toBeVisible();
});

/**
 * Inventory stock-item creation journey — gating regression.
 *
 * Promotes the happy-path create-to-persisted-item flow from non-gating
 * experience coverage to the durable smoke suite.  Failures here indicate
 * that the stock-item create RPC, list refresh, or detail route has broken.
 *
 * Closes https://github.com/Volaris-AI/dia/issues/1326
 */
test('inventory stock-item creation journey — guided form to persisted item context', async ({ page, request }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated inventory stock-item creation smoke.');
  await signIn(page);

  // --- Optionally resolve a branch and asset_category ID from the environment ---
  // When service-role credentials are available, fetch IDs deterministically so
  // the form is submitted with valid FK references.  Without them the form is
  // submitted with the fields left blank (which the RPC must tolerate).
  let branchId: string | undefined;
  let categoryId: string | undefined;

  if (E2E_SUPABASE_URL && E2E_SUPABASE_SERVICE_KEY) {
    const branchResp = await request.get(
      `${E2E_SUPABASE_URL}/rest/v1/entities?entity_type=eq.branch&select=id&limit=1`,
      { headers: serviceRoleHeaders() }
    );
    if (branchResp.ok()) {
      const branches = await branchResp.json() as Array<{ id: string }>;
      branchId = branches[0]?.id;
    }

    const categoryResp = await request.get(
      `${E2E_SUPABASE_URL}/rest/v1/entities?entity_type=eq.asset_category&select=id&limit=1`,
      { headers: serviceRoleHeaders() }
    );
    if (categoryResp.ok()) {
      const categories = await categoryResp.json() as Array<{ id: string }>;
      categoryId = categories[0]?.id;
    }
  }

  // --- Navigate to /inventory/items and assert the page loads correctly ---
  const stockItemsListRespPromise = page.waitForResponse((r) =>
    r.request().method() === 'GET' &&
    r.url().includes('/rest/v1/entities') &&
    r.url().includes('entity_type=eq.stock_item')
  );
  await page.goto('/inventory/items');
  await page.waitForLoadState('networkidle');
  const stockItemsListResp = await stockItemsListRespPromise;
  expect(
    stockItemsListResp.ok(),
    'entities list request for stock_item must succeed on /inventory/items load'
  ).toBe(true);

  await expect(
    page.getByRole('heading', { name: 'Stock Items' }),
    '/inventory/items must render the Stock Items heading'
  ).toBeVisible();

  await expect(
    page.getByRole('button', { name: 'New Stock Item' }),
    '/inventory/items must expose a "New Stock Item" action for write-capable operators'
  ).toBeVisible();

  // --- Open the creation form ---
  await page.getByRole('button', { name: 'New Stock Item' }).click();

  const createDialog = page.getByRole('dialog', { name: 'Create New Stock Item' });
  await expect(
    createDialog,
    'create modal must open after clicking New Stock Item'
  ).toBeVisible();

  // The modal must expose inventory-specific fields, not just the generic name/status fields.
  await expect(
    createDialog.getByLabel('Inventory Kind'),
    'create modal must include an Inventory Kind selector'
  ).toBeVisible();
  await expect(
    createDialog.getByLabel('Opening Quantity'),
    'create modal must include an Opening Quantity field'
  ).toBeVisible();
  await expect(
    createDialog.getByLabel('Branch ID'),
    'create modal must include a Branch ID input'
  ).toBeVisible();
  await expect(
    createDialog.getByLabel('Asset Category ID'),
    'create modal must include an Asset Category ID input'
  ).toBeVisible();

  // --- Fill the creation form ---
  const uniqueName = `E2E Stock Item ${Date.now()}`;

  await createDialog.getByLabel('Name').fill(uniqueName);
  await createDialog.getByLabel('Inventory Kind').selectOption('sale');
  await createDialog.getByLabel('Description').fill('Smoke test stock item');
  await createDialog.getByLabel('Opening Quantity').fill('25');

  if (branchId) {
    await createDialog.getByLabel('Branch ID').fill(branchId);
  }
  if (categoryId) {
    await createDialog.getByLabel('Asset Category ID').fill(categoryId);
  }

  // --- Submit and assert the create RPC fires and succeeds ---
  const createRpcRespPromise = page.waitForResponse((r) =>
    r.url().includes('/rest/v1/rpc/create_stock_item') &&
    r.request().method() === 'POST'
  );

  await createDialog.getByRole('button', { name: 'Create' }).click();

  const createRpcResp = await createRpcRespPromise;
  expect(
    createRpcResp.ok(),
    'create_stock_item RPC must return a success status — auth, wiring, and persistence must all pass'
  ).toBe(true);

  // Extract the entity_id so we can navigate to the detail URL deterministically.
  const createRpcBody = await createRpcResp.json() as Array<{
    entity_id: string;
    entity_version_id: string;
    version_number: number;
  }>;
  const createdEntityId = createRpcBody[0]?.entity_id;
  expect(
    createdEntityId,
    'create_stock_item RPC must return an entity_id in its response body'
  ).toBeTruthy();

  await page.waitForLoadState('networkidle');

  // The created item must appear in the list by name — no silent no-op.
  await expect(
    page.getByText(uniqueName).first(),
    'newly created stock item must appear in the list by name after the RPC succeeds and list refetches'
  ).toBeVisible({ timeout: 10_000 });

  // --- Navigate to the detail page and assert operator-facing context ---
  await page.goto(`/entities/stock_item/${createdEntityId}`);
  await page.waitForLoadState('networkidle');

  await expect(page).toHaveURL(/\/entities\/stock_item\/[^/]+$/, { timeout: 10_000 });

  // Primary heading must contain the item name.
  await expect(
    page.getByRole('heading', { level: 1 }),
    'stock item detail page must render the item name as the primary heading'
  ).toContainText(uniqueName, { timeout: 10_000 });

  // The details panel must surface the item name — not a blank confirmation.
  await expect(
    page.getByText(uniqueName).first(),
    'stock item detail must surface the name in the details panel'
  ).toBeVisible();

  // No error boundary should be visible on the detail page.
  await expect(
    page.locator('body'),
    'error boundary visible on stock item detail page'
  ).not.toContainText(ERROR_TEXT);

  // --- Reload: item context must survive navigation ---
  await page.reload();
  await page.waitForLoadState('networkidle');

  await expect(
    page.getByRole('heading', { level: 1 }),
    'stock item name must remain as primary heading after reload — context must not be lost'
  ).toContainText(uniqueName, { timeout: 10_000 });

  // --- Return to the list: persistence must survive the round-trip ---
  await page.goto('/inventory/items');
  await page.waitForLoadState('networkidle');

  await expect(
    page.getByText(uniqueName).first(),
    'created stock item must still appear in the list after list-to-detail-to-list round-trip'
  ).toBeVisible({ timeout: 10_000 });
});

/**
 * Returns queue check-in journey — gating regression.
 *
 * Promotes the row-scoped check-in handoff from non-gating experience coverage
 * into smoke to protect the operator path from checked-out queue row to
 * persisted post-check-in contract state.
 *
 * Closes https://github.com/Volaris-AI/dia/issues/1333
 */
test('returns queue row-scoped check-in handoff opens prefilled and persists after reload', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
  await signIn(page);

  let candidate = await findCheckedOutReturnsLine(page);
  if (!candidate) {
    const checkoutCandidate = await findEligibleCheckoutLine(page);
    await page.getByRole('button', { name: 'Check Out Line' }).click();
    const checkoutDialog = page.getByRole('dialog');
    await checkoutDialog.getByLabel('Contract Line ID').fill(checkoutCandidate.lineId);
    await checkoutDialog.getByLabel('Asset ID').fill(checkoutCandidate.assetId);
    await checkoutDialog.getByLabel('Actual Start Date').fill('2026-07-10');

    const checkoutWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes(`"p_entity_id":"${checkoutCandidate.lineId}"`)
        && body.includes('"status":"checked_out"');
    });

    await checkoutDialog.getByRole('button', { name: 'Confirm Checkout' }).click();
    const checkoutWriteResponse = await checkoutWrite;
    expect(checkoutWriteResponse.status(), 'checkout rpc should succeed when bootstrapping returns queue for check-in coverage').toBeLessThan(400);
    await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });

    candidate = checkoutCandidate;
  }

  await page.goto('/rental/returns');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Returns / Check-In' })).toBeVisible();

  const selectedLineCard = page
    .getByText(`Line ID: ${candidate.lineId}`)
    .first()
    .locator('xpath=..')
    .locator('xpath=..');
  await expect(selectedLineCard).toContainText(/checked_out/i);
  await expect(selectedLineCard).toContainText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`);
  await expect(selectedLineCard).toContainText(/Customer:/i);
  await expect(selectedLineCard).toContainText(/Job Site:/i);
  await expect(selectedLineCard).toContainText(/Category:/i);

  await selectedLineCard.getByRole('button', { name: 'Check In This Line' }).click();
  const checkInDialog = page.getByRole('dialog', { name: 'Check In Contract Line' });
  await expect(checkInDialog).toBeVisible();
  await expect(checkInDialog.getByLabel('Contract Line Entity ID')).toHaveCount(0);
  await expect(checkInDialog.getByLabel('Contract ID')).toHaveCount(0);
  await expect(checkInDialog.getByLabel('Asset ID')).toHaveCount(0);
  await expect(checkInDialog.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
  await expect(checkInDialog.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();

  await checkInDialog.getByLabel('Return Date').fill('2026-07-14');
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
      && body.includes('"inspection_type":"return"')
      && body.includes('"outcome":"pass"');
  });

  await checkInDialog.getByRole('button', { name: 'Confirm Check-In' }).click();
  const [checkInStatusResponse, inspectionWriteResponse] = await Promise.all([checkInStatusUpdate, inspectionWrite]);
  expect(checkInStatusResponse.status(), 'check-in status rpc should succeed').toBeLessThan(400);
  expect(inspectionWriteResponse.status(), 'return inspection rpc should succeed').toBeLessThan(400);
  await expect(checkInDialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(`Line ID: ${candidate.lineId}`)).not.toBeVisible({ timeout: 15_000 });

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Returns / Check-In' })).toBeVisible();
  await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toHaveCount(0);
  await expect(page.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toHaveCount(0);

  await page.goto(`/rental/contracts/${candidate.contractId}`);
  await page.waitForLoadState('networkidle');
  const returnedLineCard = page
    .getByText(`Line ID: ${candidate.lineId}`)
    .first()
    .locator('xpath=..')
    .locator('xpath=..');
  await expect(returnedLineCard).toContainText(/returned|inspection_hold/i);
  await expect(returnedLineCard).toContainText('Contract:');
  await expect(returnedLineCard).toContainText('Asset:');
  const returnedLineText = await returnedLineCard.innerText();
  const returnedContractContext = returnedLineText.match(/Contract:\s*([^\n]+)/)?.[1]?.trim();
  const returnedAssetContext = returnedLineText.match(/Asset:\s*([^\n]+)/)?.[1]?.trim();
  expect(returnedContractContext, 'returned line should keep operator-readable contract context').toBeTruthy();
  expect(returnedAssetContext, 'returned line should keep operator-readable asset context').toBeTruthy();

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  const reloadedLineCard = page
    .getByText(`Line ID: ${candidate.lineId}`)
    .first()
    .locator('xpath=..')
    .locator('xpath=..');
  await expect(reloadedLineCard).toContainText(/returned|inspection_hold/i);
  if (returnedContractContext) {
    await expect(reloadedLineCard).toContainText(`Contract: ${returnedContractContext}`);
  }
  if (returnedAssetContext) {
    await expect(reloadedLineCard).toContainText(`Asset: ${returnedAssetContext}`);
  }
});

/**
 * Rental order → contract conversion journey — gating regression.
 *
 * Promotes approved-order handoff into smoke so regression blocks deployment.
 *
 * Closes https://github.com/Volaris-AI/dia/issues/1582
 */
test('approved rental order converts into a linked rental contract that persists after reload and prevents duplicate conversion', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
  await signIn(page);

  const candidate = await findEligibleOrderForConversion(page);
  const contractCreate = page.waitForResponse((response) => {
    const body = parseRpcRequestPayload(response.request().postData() ?? '');
    return response.url().includes('/rpc/create_entity_with_version')
      && body?.p_entity_type === 'rental_contract'
      && body.p_data?.order_id === candidate.orderId;
  }, { timeout: ORDER_CONVERSION_TIMEOUT }).catch(() => null);
  const orderConvert = page.waitForResponse((response) => {
    const body = parseRpcRequestPayload(response.request().postData() ?? '');
    return response.url().includes('/rpc/rental_upsert_entity_current_state')
      && body?.p_entity_id === candidate.orderId
      && body.p_data?.status === 'converted';
  }, { timeout: ORDER_CONVERSION_TIMEOUT }).catch(() => null);

  const convertAction = page
    .getByRole('button', { name: ORDER_TO_CONTRACT_ACTION_PATTERN })
    .or(page.getByRole('link', { name: ORDER_TO_CONTRACT_ACTION_PATTERN }))
    .first();
  await convertAction.click();

  const visibleConfirmDialog = page.getByRole('dialog').first();
  if (await visibleConfirmDialog.isVisible().catch(() => false)) {
    const confirmActions = visibleConfirmDialog.getByRole('button', { name: /confirm|convert|create/i });
    if ((await confirmActions.count()) > 0) {
      await confirmActions.first().click();
    }
  }

  await page.waitForLoadState('networkidle');
  const [contractCreateResponse, orderConvertResponse] = await Promise.all([contractCreate, orderConvert]);
  expect(
    contractCreateResponse || orderConvertResponse,
    'conversion should surface at least one contract-create or order-status write response'
  ).not.toBeNull();
  if (contractCreateResponse) {
    expect(contractCreateResponse.status(), 'contract creation write should succeed').toBeLessThan(400);
  }
  if (orderConvertResponse) {
    expect(orderConvertResponse.status(), 'order status conversion write should succeed').toBeLessThan(400);
  }

  await page.goto(`/rental/orders/${candidate.orderId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/^converted$/i).first(), 'order detail should show converted status after contract creation').toBeVisible({ timeout: ORDER_CONVERSION_TIMEOUT });

  const contractLink = page.locator('a[href*="/rental/contracts/"]').first();
  await expect(contractLink, 'converted order should link to the resulting contract detail').toBeVisible({ timeout: ORDER_CONVERSION_TIMEOUT });
  const contractHref = await contractLink.getAttribute('href');
  expect(contractHref, 'contract link should target a contract detail route').toMatch(/\/rental\/contracts\/[^/?#]+$/);

  const contractId = contractHref?.match(/\/rental\/contracts\/([^/?#]+)/)?.[1]?.trim();
  expect(contractId, 'expected converted order to expose a contract detail id').toBeTruthy();

  await expect(page.locator('main')).toContainText(candidate.orderLabel);
  await contractLink.click();
  await expect(page).toHaveURL(new RegExp(`/rental/contracts/${escapeRegExp(contractId!)}$`));
  await page.waitForLoadState('networkidle');

  const orderField = page.locator('div')
    .filter({ has: page.getByText('Order ID').first() })
    .filter({ hasText: candidate.orderId })
    .first();
  await expect(orderField, 'contract detail should preserve the source order reference in a labeled field').toBeVisible();

  const rentalTypeField = page.locator('div')
    .filter({ has: page.getByText('Rental Type').first() })
    .filter({ hasText: new RegExp(escapeRegExp(candidate.rentalType), 'i') })
    .first();
  await expect(rentalTypeField, 'contract detail should preserve source rental-type context in a labeled field').toBeVisible();

  const categoryField = page.locator('div')
    .filter({ has: page.getByText('Category').first() })
    .filter({ hasText: new RegExp(escapeRegExp(candidate.category), 'i') })
    .first();
  await expect(categoryField, 'contract detail should preserve source category context in a labeled field').toBeVisible();

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await expect(page.locator('div').filter({ has: page.getByText('Order ID').first() }).filter({ hasText: candidate.orderId }).first()).toBeVisible();
  await expect(page.locator('div').filter({ has: page.getByText('Rental Type').first() }).filter({ hasText: new RegExp(escapeRegExp(candidate.rentalType), 'i') }).first()).toBeVisible();
  await expect(page.locator('div').filter({ has: page.getByText('Category').first() }).filter({ hasText: new RegExp(escapeRegExp(candidate.category), 'i') }).first()).toBeVisible();

  await page.goto(`/rental/orders/${candidate.orderId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/^converted$/i).first()).toBeVisible();
  await expect(page.locator(`a[href="/rental/contracts/${contractId}"]`).first()).toBeVisible();
  const enabledConvertButtonCount = await page
    .getByRole('button', { name: ORDER_TO_CONTRACT_ACTION_PATTERN })
    .and(page.locator(':not([disabled])'))
    .count();
  const convertLinkCount = await page.getByRole('link', { name: ORDER_TO_CONTRACT_ACTION_PATTERN }).count();
  expect(
    enabledConvertButtonCount + convertLinkCount,
    'converted order should no longer allow duplicate order-to-contract conversion actions'
  ).toBe(0);
});

test('completed rental lifecycle exposes operator-visible invoice after return and reload', async ({ page }) => {
  test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
  await signIn(page);

  const candidate = await findEligibleOrderForConversion(page);
  const contractCreate = page.waitForResponse((response) => {
    const body = parseRpcRequestPayload(response.request().postData() ?? '');
    return response.url().includes('/rpc/create_entity_with_version')
      && body?.p_entity_type === 'rental_contract'
      && body.p_data?.order_id === candidate.orderId;
  }, { timeout: ORDER_CONVERSION_TIMEOUT }).catch(() => null);
  const orderConvert = page.waitForResponse((response) => {
    const body = parseRpcRequestPayload(response.request().postData() ?? '');
    return response.url().includes('/rpc/rental_upsert_entity_current_state')
      && body?.p_entity_id === candidate.orderId
      && body.p_data?.status === 'converted';
  }, { timeout: ORDER_CONVERSION_TIMEOUT }).catch(() => null);

  await page.getByRole('button', { name: ORDER_TO_CONTRACT_ACTION_PATTERN })
    .or(page.getByRole('link', { name: ORDER_TO_CONTRACT_ACTION_PATTERN }))
    .first()
    .click();

  const visibleConfirmDialog = page.getByRole('dialog').first();
  if (await visibleConfirmDialog.isVisible().catch(() => false)) {
    const confirmActions = visibleConfirmDialog.getByRole('button', { name: /confirm|convert|create/i });
    if ((await confirmActions.count()) > 0) {
      await confirmActions.first().click();
    }
  }

  await page.waitForLoadState('networkidle');
  const [contractCreateResponse, orderConvertResponse] = await Promise.all([contractCreate, orderConvert]);
  expect(
    contractCreateResponse || orderConvertResponse,
    'conversion should surface at least one contract-create or order-status write response'
  ).not.toBeNull();
  if (contractCreateResponse) {
    expect(contractCreateResponse.status(), 'contract creation write should succeed').toBeLessThan(400);
  }
  if (orderConvertResponse) {
    expect(orderConvertResponse.status(), 'order status conversion write should succeed').toBeLessThan(400);
  }

  await page.goto(`/rental/orders/${candidate.orderId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(candidate.orderLabel);
  await expect(page.getByText(/^converted$/i).first()).toBeVisible({ timeout: ORDER_CONVERSION_TIMEOUT });
  await expect(page.getByText(candidate.lineCategory, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(`Qty: ${candidate.lineQuantity} · ${candidate.linePlannedStart} to ${candidate.linePlannedEnd}`)).toBeVisible();
  if (candidate.lineJobSite !== 'N/A') {
    await expect(page.getByText(`Job Site: ${candidate.lineJobSite}`, { exact: false })).toBeVisible();
  }

  const contractLink = page.locator('a[href*="/rental/contracts/"]').first();
  await expect(contractLink).toBeVisible({ timeout: ORDER_CONVERSION_TIMEOUT });
  const contractHref = await contractLink.getAttribute('href');
  expect(contractHref, 'contract link should target a contract detail route').toMatch(/\/rental\/contracts\/[^/?#]+$/);

  const contractId = contractHref?.match(/\/rental\/contracts\/([^/?#]+)/)?.[1]?.trim();
  expect(contractId, 'expected converted order to expose a contract detail id').toBeTruthy();

  await contractLink.click();
  await expect(page).toHaveURL(new RegExp(`/rental/contracts/${escapeRegExp(contractId!)}$`));
  await page.waitForLoadState('networkidle');

  const contractHeading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
  expect(contractHeading, 'contract detail heading should surface a human-readable contract identifier').not.toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  await expect(page.locator('div').filter({ has: page.getByText('Order ID').first() }).filter({ hasText: candidate.orderId }).first()).toBeVisible();
  await expect(page.locator('div').filter({ has: page.getByText('Rental Type').first() }).filter({ hasText: new RegExp(escapeRegExp(candidate.rentalType), 'i') }).first()).toBeVisible();
  await expect(page.locator('div').filter({ has: page.getByText('Category').first() }).filter({ hasText: new RegExp(escapeRegExp(candidate.category), 'i') }).first()).toBeVisible();
  await expect(page.getByText(`Planned return: ${candidate.linePlannedEnd}`, { exact: false }).first()).toBeVisible();

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(contractHeading);
  await expect(page.getByText(`Planned return: ${candidate.linePlannedEnd}`, { exact: false }).first()).toBeVisible();

  const availableAsset = await findAvailableAssetForCategory(page, candidate.lineCategory);

  await page.goto(`/rental/contracts/${contractId}`);
  await page.waitForLoadState('networkidle');

  const lineIdLabels = page.getByText(/^Line ID:/);
  let convertedLineId: string | null = null;
  let convertedLineCard = null;
  const lineCount = await lineIdLabels.count();
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const lineCard = page.locator('div.rounded-lg.border').filter({ has: lineIdLabels.nth(lineIndex) }).first();
    const lineText = await lineCard.innerText();
    const lineCategory = lineText.match(/Category:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
    const plannedReturn = lineText.match(/Planned return:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
    if (lineCategory !== candidate.lineCategory || plannedReturn !== candidate.linePlannedEnd) {
      continue;
    }
    convertedLineId = lineText.match(/Line ID:\s*([^\s]+)/)?.[1]?.trim() ?? null;
    convertedLineCard = lineCard;
    break;
  }

  expect(convertedLineId, 'expected the converted contract to retain line context from the source order').toBeTruthy();
  expect(convertedLineCard, 'expected a converted contract-line card with visible line context').not.toBeNull();

  await convertedLineCard!.getByRole('button', { name: 'Check Out' }).click();
  const checkoutDialog = page.getByRole('dialog', { name: /check out/i });
  await expect(checkoutDialog).toBeVisible();
  await expect(checkoutDialog.getByLabel('Contract Line ID')).toHaveValue(convertedLineId!);
  await expect(checkoutDialog).toContainText(new RegExp(escapeRegExp(contractHeading), 'i'));
  await checkoutDialog.getByLabel('Asset ID').fill(availableAsset.assetId);
  await checkoutDialog.getByLabel('Actual Start Date').fill(LIFECYCLE_CHECKOUT_DATE);

  const checkoutWrite = page.waitForResponse((response) => {
    const body = response.request().postData() ?? '';
    return response.url().includes('/rpc/rental_upsert_entity_current_state')
      && body.includes(`"p_entity_id":"${convertedLineId}"`)
      && body.includes('"status":"checked_out"');
  });

  await checkoutDialog.getByRole('button', { name: 'Confirm Checkout' }).click();
  expect((await checkoutWrite).status(), 'checkout rpc should succeed for the converted contract line').toBeLessThan(400);
  await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });
  await expect(convertedLineCard!).toContainText('checked_out');
  await expect(convertedLineCard!).toContainText(`Asset: ${availableAsset.assetId}`);

  await page.goto('/rental/returns');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(`Contract ${contractId} • Asset ${availableAsset.assetId}`)).toBeVisible();
  await expect(page.getByText(`Line ID: ${convertedLineId}`)).toBeVisible();

  const checkInQueueCard = page
    .getByText(`Line ID: ${convertedLineId}`)
    .first()
    .locator('xpath=..')
    .locator('xpath=..');
  await expect(checkInQueueCard).toContainText(/checked_out/i);
  if (candidate.customerName) {
    await expect(checkInQueueCard).toContainText(`Customer: ${candidate.customerName}`);
  } else {
    await expect(checkInQueueCard).toContainText(/Customer:/i);
  }

  await checkInQueueCard.getByRole('button', { name: 'Check In This Line' }).click();
  const checkInDialog = page.getByRole('dialog', { name: 'Check In Contract Line' });
  await expect(checkInDialog).toBeVisible();
  await expect(checkInDialog.getByLabel('Contract Line Entity ID')).toHaveCount(0);
  await expect(checkInDialog.getByLabel('Contract ID')).toHaveCount(0);
  await expect(checkInDialog.getByLabel('Asset ID')).toHaveCount(0);
  await expect(checkInDialog.getByText(`Contract ${contractId} • Asset ${availableAsset.assetId}`)).toBeVisible();
  await expect(checkInDialog.getByText(`Line ID: ${convertedLineId}`)).toBeVisible();
  await checkInDialog.getByLabel('Return Date').fill(LIFECYCLE_RETURN_DATE);
  await checkInDialog.getByLabel('Condition Outcome').click();
  await page.getByRole('option', { name: 'Pass' }).click();

  const checkInStatusUpdate = page.waitForResponse((response) => {
    const body = response.request().postData() ?? '';
    return response.url().includes('/rpc/rental_upsert_entity_current_state')
      && body.includes(`"p_entity_id":"${convertedLineId}"`)
      && body.includes('"status":"returned"');
  });
  const inspectionWrite = page.waitForResponse((response) => {
    const body = response.request().postData() ?? '';
    return response.url().includes('/rpc/create_entity_with_version')
      && body.includes(`"contract_line_id":"${convertedLineId}"`)
      && body.includes('"inspection_type":"return"')
      && body.includes('"outcome":"pass"');
  });

  await checkInDialog.getByRole('button', { name: 'Confirm Check-In' }).click();
  const [checkInStatusResponse, inspectionWriteResponse] = await Promise.all([checkInStatusUpdate, inspectionWrite]);
  expect(checkInStatusResponse.status(), 'check-in status rpc should succeed').toBeLessThan(400);
  expect(inspectionWriteResponse.status(), 'return inspection rpc should succeed').toBeLessThan(400);
  await expect(checkInDialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(`Line ID: ${convertedLineId}`)).toHaveCount(0);

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(`Line ID: ${convertedLineId}`)).toHaveCount(0);
  await expect(page.getByText(`Contract ${contractId} • Asset ${availableAsset.assetId}`)).toHaveCount(0);

  await page.goto(`/rental/contracts/${contractId}`);
  await page.waitForLoadState('networkidle');
  const returnedLineCard = page.locator('div.rounded-lg.border').filter({
    has: page.getByText(`Line ID: ${convertedLineId}`).first(),
  }).first();
  await expect(returnedLineCard).toContainText('returned');
  await expect(returnedLineCard).toContainText(`Asset: ${availableAsset.assetId}`);
  await expect(returnedLineCard).toContainText(`Category: ${candidate.lineCategory}`);
  await expect(returnedLineCard).toContainText(`Returned: ${LIFECYCLE_RETURN_DATE}`);
  await expect(returnedLineCard).toContainText('Invoice status:');

  const returnedLineText = await returnedLineCard.innerText();
  const contractContextLabel = returnedLineText.match(/Contract:\s*(.+?)(?:·\s*Customer:|\s*Customer:|\n|$)/s)?.[1]?.trim();
  const customerContextLabel = returnedLineText.match(/Customer:\s*([^\n·]+)/i)?.[1]?.trim();
  expect(contractContextLabel, 'returned line should keep a human-readable contract label').toBeTruthy();
  expect(contractContextLabel, 'returned line contract label should not be a raw UUID').not.toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
  expect(customerContextLabel, 'returned line should keep a human-readable customer label').toBeTruthy();
  if (candidate.customerName) {
    expect(customerContextLabel).toContain(candidate.customerName);
  }

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  const reloadedReturnedLineCard = page.locator('div.rounded-lg.border').filter({
    has: page.getByText(`Line ID: ${convertedLineId}`).first(),
  }).first();
  await expect(reloadedReturnedLineCard).toContainText('returned');
  await expect(reloadedReturnedLineCard).toContainText('Invoice status:');
  if (contractContextLabel) {
    await expect(reloadedReturnedLineCard).toContainText(`Contract: ${contractContextLabel}`);
  }
  if (customerContextLabel) {
    await expect(reloadedReturnedLineCard).toContainText(`Customer: ${customerContextLabel}`);
  }

  const invoiceCta = reloadedReturnedLineCard.getByRole('button', { name: 'View invoices for this contract' }).or(
    reloadedReturnedLineCard.getByRole('link', { name: 'View invoices for this contract' })
  ).first();
  await expect(invoiceCta).toBeVisible();
  await invoiceCta.click();
  await page.waitForURL('**/entities/invoice**');
  await page.waitForLoadState('networkidle');

  const invoiceUrl = page.url();
  const invoiceDetailUrlPattern = /\/entities\/invoice\/[^/?#]+$/;
  if (invoiceDetailUrlPattern.test(invoiceUrl)) {
    const invoiceHeading = page.locator('main').getByRole('heading', { level: 1 }).first();
    const invoiceHeadingText = (await invoiceHeading.innerText()).trim();
    expect(invoiceHeadingText, 'invoice detail should surface a human-readable invoice number').toMatch(HUMAN_READABLE_INVOICE_PATTERN);
    expect(invoiceHeadingText, 'invoice detail should not use a raw UUID as the primary label').not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const billingContextSection = page.getByText('Billing Context').locator('..');
    await expect(billingContextSection).toBeVisible();
    const billingContextText = await billingContextSection.innerText();
    expect(billingContextText).toContain(`Contract ${contractContextLabel}`);
    expect(billingContextText, 'billing context should surface a customer-facing label, not just a machine identifier').toMatch(
      HUMAN_READABLE_CUSTOMER_PATTERN
    );
    if (candidate.customerName) {
      expect(billingContextText).toContain(candidate.customerName);
    }

    const invoiceMainText = await page.locator('main').innerText();
    expect(invoiceMainText, 'invoice detail should surface a billing status after return').toMatch(
      /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
    );
    expect(invoiceMainText, 'invoice detail should surface a monetary amount after return').toMatch(
      /(?:\$\s*[0-9]+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?\s*(?:AUD|USD|EUR|GBP)|\btotal\b|\bamount\b)/i
    );

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main').getByRole('heading', { level: 1 }).first()).toHaveText(invoiceHeadingText);
    const reloadedInvoiceMainText = await page.locator('main').innerText();
    expect(reloadedInvoiceMainText, 'invoice status must persist after reload').toMatch(
      /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
    );
    expect(reloadedInvoiceMainText, 'invoice amount must persist after reload').toMatch(
      /(?:\$\s*[0-9]+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?\s*(?:AUD|USD|EUR|GBP)|\btotal\b|\bamount\b)/i
    );
    expect(reloadedInvoiceMainText, 'invoice contract context must persist after reload').toContain(`Contract ${contractContextLabel}`);
    if (candidate.customerName) {
      expect(reloadedInvoiceMainText, 'invoice customer context must persist after reload').toContain(candidate.customerName);
    }
  } else {
    expect(invoiceUrl, 'invoice list fallback should stay scoped to the converted contract').toContain(`/entities/invoice?contractId=${contractId}`);
    await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();
    await expect(page.getByText(`Filtered to contract ${contractId}`)).toBeVisible();
    const filteredListText = await page.locator('main').innerText();
    expect(filteredListText, 'filtered invoice list should include a human-readable invoice number').toMatch(HUMAN_READABLE_INVOICE_PATTERN);
    expect(filteredListText, 'filtered invoice list should include a billing status').toMatch(
      /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
    );
    expect(filteredListText, 'filtered invoice list should include a monetary amount').toMatch(
      /(?:\$\s*[0-9]+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?\s*(?:AUD|USD|EUR|GBP)|\btotal\b|\bamount\b)/i
    );
    expect(filteredListText, 'filtered invoice list should include customer context').toMatch(/Customer:/i);
    if (candidate.customerName) {
      expect(filteredListText).toContain(candidate.customerName);
    }

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const reloadedFilteredListText = await page.locator('main').innerText();
    expect(reloadedFilteredListText, 'invoice number must persist in filtered list after reload').toMatch(HUMAN_READABLE_INVOICE_PATTERN);
    expect(reloadedFilteredListText, 'invoice status must persist in filtered list after reload').toMatch(
      /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
    );
    expect(reloadedFilteredListText, 'invoice amount must persist in filtered list after reload').toMatch(
      /(?:\$\s*[0-9]+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?\s*(?:AUD|USD|EUR|GBP)|\btotal\b|\bamount\b)/i
    );
    expect(reloadedFilteredListText, 'invoice customer context must persist in filtered list after reload').toMatch(/Customer:/i);
    if (candidate.customerName) {
      expect(reloadedFilteredListText).toContain(candidate.customerName);
    }
  }
});
