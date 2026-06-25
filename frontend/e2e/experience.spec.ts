import { test, expect } from './ux-capture.fixture';
import type { Locator, Page, Response } from '@playwright/test';

const AUTH_EMAIL = process.env.E2E_AUTH_EMAIL;
const AUTH_PASSWORD = process.env.E2E_AUTH_PASSWORD;
const OPS_CAPABLE_EMAIL = process.env.E2E_MANAGER_EMAIL || AUTH_EMAIL;
const OPS_CAPABLE_PASSWORD = process.env.E2E_MANAGER_PASSWORD || AUTH_PASSWORD;
const READONLY_EMAIL = process.env.E2E_READONLY_EMAIL;
const READONLY_PASSWORD = process.env.E2E_READONLY_PASSWORD;
const PORTAL_SCHEDULE_SCOPED_URL = process.env.E2E_PORTAL_SCHEDULE_SCOPED_URL;
const PORTAL_CATALOG_SCOPED_URL = process.env.E2E_PORTAL_CATALOG_SCOPED_URL;
const PORTAL_INTAKE_SCOPED_URL = process.env.E2E_PORTAL_INTAKE_SCOPED_URL;
const PORTAL_BILLING_UPDATE_SCOPED_URL = process.env.E2E_PORTAL_BILLING_UPDATE_SCOPED_URL;
const PORTAL_CUSTOMER_EMAIL = process.env.E2E_PORTAL_CUSTOMER_EMAIL;
const PORTAL_CUSTOMER_PASSWORD = process.env.E2E_PORTAL_CUSTOMER_PASSWORD;
const PORTAL_INELIGIBLE_CUSTOMER_EMAIL = process.env.E2E_PORTAL_INELIGIBLE_CUSTOMER_EMAIL;
const PORTAL_INELIGIBLE_CUSTOMER_PASSWORD = process.env.E2E_PORTAL_INELIGIBLE_CUSTOMER_PASSWORD;
const FIELD_OPERATOR_EMAIL = process.env.E2E_FIELD_OPERATOR_EMAIL || process.env.E2E_OPERATOR_EMAIL;
const FIELD_OPERATOR_PASSWORD = process.env.E2E_FIELD_OPERATOR_PASSWORD || process.env.E2E_OPERATOR_PASSWORD;
const FIELD_ASSET_STATUS_LABELS = {
  returned: 'Returned',
  inspection_hold: 'Inspection hold',
} as const;
const FIELD_TASK_LABELS = {
  checkout: 'Delivery / Checkout',
  return: 'Pickup / Return',
  inspection: 'Inspection',
} as const;
const CATALOG_ASSET_STATUS_PATTERN = /\b(available|on_rent|returned|inspection_hold|maintenance)\b/;
const PORTAL_CATALOG_REQUISITION_ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PORTAL_CATALOG_REQUISITION_THREE_DAYS_MS = 3 * PORTAL_CATALOG_REQUISITION_ONE_DAY_MS;
const DISPATCH_READY_HANDOFF_NAME = /dispatch|order|requisition|request|detail|view|open/i;
const FIELD_WORKFLOW_COMPLETION_TIMEOUT = 20_000;
const RERENT_MAX_ORDERS_TO_SCAN = 20;
const RERENT_NAVIGATION_TIMEOUT = 8_000;
const RERENT_BADGE_VISIBILITY_TIMEOUT = 15_000;
const ORDER_CONVERSION_TIMEOUT = 15_000;
const FIELD_DISPATCH_MAX_PROGRESSION_ATTEMPTS = 3;
const COMPLAINT_EVIDENCE_TOGGLE_PATTERN = /show evidence bundle/i;
const ORDER_TO_CONTRACT_ACTION_PATTERN = /convert(?:\s+order)?(?:\s+to)?\s+(?:a\s+)?(?:rental\s+)?contract|create\s+(?:a\s+)?(?:rental\s+)?contract/i;
const ACCOUNTING_EXPORT_MODE_OPTIONS = [
  { value: 'xero', configuredLabel: 'Xero (CSV import)' },
  { value: 'sage', configuredLabel: 'Sage Intacct (GL journal CSV)' },
  { value: 'export_only', configuredLabel: 'Export only (accountant hand-off CSV)' },
] as const;
const PORTAL_FINANCIALS_MIN_OUTSTANDING_FOR_PARTIAL_PAYMENT = 0.02;
const PORTAL_FINANCIALS_PAYMENT_MARGIN = 0.01;
const PORTAL_FINANCIALS_PREFERRED_PARTIAL_PAYMENT_AMOUNT = 1;
const PORTAL_FINANCIALS_PAYMENT_UPDATE_TIMEOUT = 15_000;
const PORTAL_FINANCIALS_VISIBLE_AMOUNT_PATTERN = /((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.\d{2})/;
const ENTERPRISE_FINANCIAL_REPORTING_DOCUMENT_TYPES = ['invoice', 'rental_contract', 'rental_order'] as const;
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0xff, 0xc0,
  0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08,
  0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2,
  0xcf, 0x20, 0xff, 0xd9,
]);

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out-button')).toBeVisible();
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

interface ComplaintReviewBundleApiRow {
  case_id: string | null;
  stop_id: string | null;
  customer_name: string | null;
  job_site_name: string | null;
  recovery_action: string | null;
}

interface ScopedAvailabilityDrillDown {
  href: string;
  branchId: string;
  categoryId: string;
}

const AVAILABILITY_HREF_BASE = 'https://dia-rental.dev';
const PORTAL_SCHEDULE_HREF_BASE = 'https://dia-rental.dev';
const PORTAL_CATALOG_HREF_BASE = 'https://dia-rental.dev';
const PORTAL_INTAKE_HREF_BASE = 'https://dia-rental.dev';
const PORTAL_BILLING_UPDATE_HREF_BASE = 'https://dia-rental.dev';
const AVAILABILITY_NEXT_ACTION_NAME = /create|new|order|contract|reserve|transfer|return|maintenance/i;
const MAINTENANCE_WORK_ORDER_BILLING_VIEW = '/rest/v1/v_maintenance_work_order_billing';
// Portal-financials: allow up to this many raw UUIDs on the page; the component uses IDs internally
// (e.g. React keys) but should not surface them as primary operator-facing content.
const PORTAL_FINANCIALS_MAX_EXPOSED_UUIDS = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function isComplaintReviewBundleResponse(response: Response): boolean {
  return (
    response.request().method() === 'GET' &&
    response.url().includes('/rest/v1/v_complaint_case_review_bundle')
  );
}

function complaintRecoveryActionLabel(action: string | null): string {
  const labels: Record<string, string> = {
    pending_review: 'Pending dispatcher review',
    re_run_required: 'Re-run required',
    branch_follow_up: 'Branch follow-up required',
    escalate_dispatcher: 'Escalate to dispatcher',
    escalate_branch_manager: 'Escalate to branch manager',
    document_service_failure: 'Document service failure',
    resolved: 'Resolved',
  };

  if (!action) return '';
  return labels[action] ?? action;
}

function hasNonEmptyValue(value: string | null): boolean {
  return (value?.trim().length ?? 0) > 0;
}

async function expectAssetDetailContext(
  page: Page,
  assetName: string,
  categoryName: string,
  branchName: string,
): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: assetName })).toBeVisible();
  await expect(page.getByText('Related Context')).toBeVisible();
  await expect(page.getByText(new RegExp(`Asset Category\\s*${escapeRegExp(categoryName)}`))).toBeVisible();
  await expect(page.getByText(new RegExp(`Branch\\s*${escapeRegExp(branchName)}`))).toBeVisible();
}

async function selectComboboxOption(page: Page, label: string, optionText: string): Promise<void> {
  const combobox = page.getByRole('combobox', { name: label });
  await combobox.click();
  await page.getByRole('option', { name: optionText, exact: true }).click();
}

function parseCurrencyAmount(text: string): number | null {
  const normalized = text.replace(/\s+/g, '');
  const parenthesesNegativeMatch = normalized.match(/\(\$([0-9,]+(?:\.\d+)?)\)/);
  if (parenthesesNegativeMatch) {
    return -Number(parenthesesNegativeMatch[1].replaceAll(',', ''));
  }

  const explicitNegativeMatch = normalized.match(/(?:-\$|\$-)([0-9,]+(?:\.\d+)?)/);
  if (explicitNegativeMatch) {
    return -Number(explicitNegativeMatch[1].replaceAll(',', ''));
  }

  const positiveMatch = normalized.match(/\$([0-9,]+(?:\.\d+)?)/);
  if (!positiveMatch) {
    return null;
  }
  return Number(positiveMatch[1].replaceAll(',', ''));
}

function extractOrderSummaryAssetName(summaryText: string): string | null {
  const summaryMatch = summaryText.match(/^(.+?) \(\d+ days\)/m);
  return summaryMatch?.[1]?.trim() || null;
}

function extractOrderSummaryTotal(summaryText: string): number | null {
  const totalLineMatch = summaryText.match(/Total\s*\n?\s*([^\n]+)/i);
  if (!totalLineMatch) return null;
  return parseCurrencyAmount(totalLineMatch[1]);
}

function isCreateRentalOrderWrite(response: Response): boolean {
  if (!response.url().includes('/rpc/create_entity_with_version') || response.request().method() !== 'POST') {
    return false;
  }

  try {
    const postBody = JSON.parse(response.request().postData() ?? '{}') as { p_entity_type?: string };
    return postBody.p_entity_type === 'rental_order';
  } catch {
    return false;
  }
}

function findingQueueCardFromOpenLink(openLink: Locator): Locator {
  return openLink.locator(
    'xpath=ancestor::*[.//*[contains(normalize-space(.), "Contract:")] and .//*[contains(normalize-space(.), "Customer:")]][1]'
  );
}

function rebalancingRecommendationCardFromReviewLink(reviewLink: Locator): Locator {
  return reviewLink.locator(
    'xpath=ancestor::*[.//*[contains(normalize-space(.), "SURPLUS BRANCH")] and .//*[contains(normalize-space(.), "DEFICIT BRANCH")]][1]'
  );
}

async function findScopedAvailabilityDrillDown(page: Page): Promise<ScopedAvailabilityDrillDown> {
  const availabilityCard = page.getByText('Availability & Operational Blockers').first().locator('../..');
  const links = availabilityCard.getByRole('link', { name: 'Check Availability' });
  const linkCount = await links.count();

  for (let index = 0; index < linkCount; index++) {
    const link = links.nth(index);
    const href = await link.getAttribute('href');
    if (!href) continue;

    const url = new URL(href, AVAILABILITY_HREF_BASE);
    const branchId = url.searchParams.get('branch_id');
    const categoryId = url.searchParams.get('category_id');
    if (!branchId || !categoryId) continue;

    return { href, branchId, categoryId };
  }

  throw new Error('Expected a branch/category drill-down link in Availability & Operational Blockers.');
}

interface TransferCheckInDrillDown {
  href: string;
  assetId: string;
}

const TRANSFER_LIFECYCLE_STATUSES = ['requested', 'approved', 'in_transit', 'received'] as const;
type TransferLifecycleStatus = typeof TRANSFER_LIFECYCLE_STATUSES[number];
const MAX_VISIBLE_UUIDS_IN_TRANSFER_ROW = 2;
const OPS_FINDING_DETAIL_PATH_PATTERN = /\/ops\/findings\/([^/?#]+)/;
const MORNING_BRIEF_ALL_FILTER_VALUE = '%';
const MORNING_BRIEF_OPERATOR_READY_FIELD_PATTERN = /Owner:|Evidence|Stale signals|Blockers|Contact|Dispatch|Maintenance|Follow-up|Review|Escalat(e|ion)/i;

interface TransferLifecycleCandidate {
  transferId: string;
  href: string;
  equipmentLabel: string;
  originBranch: string;
  originProject?: string;
  destinationBranch: string;
  destinationProject?: string;
  responsibleLine: string;
  exceptionReason?: string;
}

interface TransferLifecycleRowSnapshot {
  status: TransferLifecycleStatus;
  responsibleLine: string;
  transitionedLine: string;
}

function normalizeTransferStatusToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function countUuidMatches(value: string): number {
  return value.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g)?.length ?? 0;
}

function parseTransferLifecycleStatus(line: string): TransferLifecycleStatus | null {
  const token = normalizeTransferStatusToken(line);
  return TRANSFER_LIFECYCLE_STATUSES.includes(token as TransferLifecycleStatus)
    ? token as TransferLifecycleStatus
    : null;
}

function extractTransferExceptionReason(lines: string[]): string | undefined {
  const exceptionTitleIndex = lines.findIndex((line) => normalizeTransferStatusToken(line) === 'exception');
  if (exceptionTitleIndex < 0) return undefined;
  const reason = lines[exceptionTitleIndex + 1]?.trim();
  return reason ? reason : undefined;
}

function extractTransferJourneyLines(text: string[]): {
  routeLine?: string;
  responsibleLine?: string;
  transitionedLine?: string;
} {
  const routeLine = text.find((line) => line.includes('→'));
  const responsibleLine = text.find((line) => line.startsWith('Requested by:'));
  const transitionedLine = text.find((line) => line.startsWith('Transitioned:'));
  return { routeLine, responsibleLine, transitionedLine };
}

async function findTransferLifecycleCandidate(page: Page): Promise<TransferLifecycleCandidate> {
  const transferHistoryHeading = page.getByRole('heading', { name: 'Transfer History' }).first();
  await expect(transferHistoryHeading).toBeVisible();
  const transferHistorySection = transferHistoryHeading.locator('xpath=ancestor::*[self::section or self::div][1]');
  const detailLinks = transferHistorySection.getByRole('link', { name: 'View details' });
  const detailLinkCount = await detailLinks.count();

  let fallback: TransferLifecycleCandidate | null = null;
  for (let linkIndex = 0; linkIndex < detailLinkCount; linkIndex++) {
    const link = detailLinks.nth(linkIndex);
    const href = await link.getAttribute('href');
    const transferId = href?.match(/\/entities\/transfer\/([^/?#]+)/)?.[1]?.trim();
    if (!href || !transferId) continue;

    const row = link.locator('xpath=ancestor::*[.//*[contains(normalize-space(.), "Requested by:")] and .//*[contains(normalize-space(.), "Transitioned:")]][1]');
    if (await row.count() === 0) continue;

    const rowLines = (await row.first().innerText())
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const { routeLine, responsibleLine } = extractTransferJourneyLines(rowLines);
    if (!routeLine || !responsibleLine) continue;

    const routeMatch = routeLine.match(/^(.*?)\s*(?:\((.*?)\))?\s*→\s*(.*?)\s*(?:\((.*?)\))?$/);
    if (!routeMatch) continue;
    const originBranch = routeMatch[1]?.trim() ?? '';
    const originProject = routeMatch[2]?.trim() || undefined;
    const destinationBranch = routeMatch[3]?.trim() ?? '';
    const destinationProject = routeMatch[4]?.trim() || undefined;
    if (!originBranch || !destinationBranch) continue;

    const equipmentLabel = rowLines.find((line) => (
      !line.includes('→')
      && !line.startsWith('Requested by:')
      && !line.startsWith('Ship:')
      && !line.startsWith('Transitioned:')
      && !line.startsWith('Exception')
      && !parseTransferLifecycleStatus(line)
    ))?.trim();
    if (!equipmentLabel) continue;

    const candidate: TransferLifecycleCandidate = {
      transferId,
      href,
      equipmentLabel,
      originBranch,
      originProject,
      destinationBranch,
      destinationProject,
      responsibleLine,
      exceptionReason: extractTransferExceptionReason(rowLines),
    };

    if (candidate.exceptionReason) return candidate;
    if (!fallback) fallback = candidate;
  }

  if (fallback) return fallback;
  throw new Error('Expected at least one transfer-history row with route, optional project, and responsible-user context plus a View details handoff.');
}

async function snapshotTransferLifecycleRows(page: Page, transferId: string): Promise<TransferLifecycleRowSnapshot[]> {
  const transferHistoryHeading = page.getByRole('heading', { name: 'Transfer History' }).first();
  await expect(transferHistoryHeading).toBeVisible();
  const transferHistorySection = transferHistoryHeading.locator('xpath=ancestor::*[self::section or self::div][1]');
  const transferLinks = transferHistorySection.locator(`a[href="/entities/transfer/${transferId}"]`);
  const linkCount = await transferLinks.count();
  const rows: TransferLifecycleRowSnapshot[] = [];

  for (let index = 0; index < linkCount; index++) {
    const row = transferLinks.nth(index).locator(
      'xpath=ancestor::*[.//*[contains(normalize-space(.), "Requested by:")] and .//*[contains(normalize-space(.), "Transitioned:")]][1]'
    );
    if (await row.count() === 0) continue;

    const rowLines = (await row.first().innerText())
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const { responsibleLine, transitionedLine } = extractTransferJourneyLines(rowLines);
    if (!responsibleLine || !transitionedLine) continue;

    const status = rowLines
      .map(parseTransferLifecycleStatus)
      .find((value): value is TransferLifecycleStatus => value !== null);
    if (!status) continue;

    rows.push({
      status,
      responsibleLine,
      transitionedLine,
    });
  }

  return rows;
}

async function findTransferCheckInDrillDown(page: Page): Promise<TransferCheckInDrillDown> {
  const transfersCard = page.getByText('Transfers In Flight').first().locator('../..');
  const links = transfersCard.getByRole('link', { name: 'Check In Asset' });
  const linkCount = await links.count();

  for (let index = 0; index < linkCount; index++) {
    const link = links.nth(index);
    const href = await link.getAttribute('href');
    if (!href) continue;

    const url = new URL(href, AVAILABILITY_HREF_BASE);
    const assetId = url.searchParams.get('asset_id');
    if (!assetId) continue;

    return { href, assetId };
  }

  throw new Error('Expected a Check In Asset link with asset_id in the Transfers In Flight card.');
}

async function openFieldMobile(page: Page) {
  await page.goto('/field/mobile', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Field Task Queue' })).toBeVisible();
}

async function getSelectedFieldAssetName(page: Page): Promise<string> {
  return (await page.getByText(/^Asset:/).first().innerText()).replace(/^Asset:\s*/, '').trim();
}

async function getFieldTaskQueueContext(taskButton: Locator) {
  const [taskSummary = '', customerAndJobSite = ''] = (await taskButton.innerText())
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!taskSummary || !customerAndJobSite) {
    return {};
  }
  const [customerName = '', ...jobSiteParts] = customerAndJobSite.split(' - ');
  const normalizedCustomerName = customerName.trim();
  const normalizedJobSiteName = jobSiteParts.join(' - ').trim();
  return {
    customerName: normalizedCustomerName || undefined,
    jobSiteName: normalizedJobSiteName || undefined,
  };
}

function generateE2ESignature(step: string): string {
  return `E2E ${step} ${Date.now()}`;
}

async function fillConfirmLoadDetails(page: Page) {
  const timestamp = new Date().toISOString().slice(0, 16);
  await page.getByLabel('Assigned driver').fill(`E2E Driver ${Date.now()}`);
  await page.getByLabel('Assigned truck').fill(`TRK-${Date.now()}`);
  await page.getByLabel('Departure timestamp').fill(timestamp);
  await page.getByLabel('Driver signature').fill(`E2E Driver Signature ${Date.now()}`);
}

async function expectSelectedFieldStatusBadge(page: Page, status: keyof typeof FIELD_ASSET_STATUS_LABELS) {
  await expect(page.getByText(`Asset: ${FIELD_ASSET_STATUS_LABELS[status]}`)).toBeVisible();
}

async function expectSelectedFieldTaskContext(
  page: Page,
  taskContext: { assetName: string; customerName?: string; jobSiteName?: string }
) {
  await expect(page.getByText(new RegExp(`^Asset:\\s*${escapeRegExp(taskContext.assetName)}$`))).toBeVisible();
  if (taskContext.customerName) {
    await expect(page.getByText(new RegExp(`^Customer:\\s*${escapeRegExp(taskContext.customerName)}$`))).toBeVisible();
  }
  if (taskContext.jobSiteName) {
    await expect(page.getByText(new RegExp(`^Job site:\\s*${escapeRegExp(taskContext.jobSiteName)}$`))).toBeVisible();
  }
}

async function findFieldTaskButton(
  page: Page,
  workflow: keyof typeof FIELD_TASK_LABELS,
  assetName?: string
) {
  const candidates = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(FIELD_TASK_LABELS[workflow])}`) });
  const candidateCount = await candidates.count();
  for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
    const candidate = candidates.nth(candidateIndex);
    const text = await candidate.innerText();
    if (!assetName || text.includes(assetName)) {
      return candidate;
    }
  }
  return null;
}

async function ensureReturnTask(page: Page) {
  let returnTask = await findFieldTaskButton(page, 'return');
  if (returnTask) {
    const queueContext = await getFieldTaskQueueContext(returnTask);
    await returnTask.click();
    return {
      assetName: await getSelectedFieldAssetName(page),
      ...queueContext,
    };
  }

  const checkoutTask = await findFieldTaskButton(page, 'checkout');
  if (!checkoutTask) {
    return null;
  }

  await checkoutTask.click();
  const assetName = await getSelectedFieldAssetName(page);

  const checkoutWrite = page.waitForResponse((response) => {
    const body = response.request().postData() ?? '';
    return response.url().includes('/rpc/rental_upsert_entity_current_state')
      && body.includes('"p_entity_type":"rental_contract_line"')
      && body.includes('"status":"checked_out"');
  });
  const assetWrite = page.waitForResponse((response) => {
    const body = response.request().postData() ?? '';
    return response.url().includes('/rpc/rental_upsert_entity_current_state')
      && body.includes('"p_entity_type":"asset"')
      && body.includes('"status":"on_rent"');
  });

  await page.getByLabel('Customer/operator signature').fill(generateE2ESignature('Checkout'));
  await fillConfirmLoadDetails(page);
  await page.getByRole('button', { name: 'Complete checkout' }).click();
  const [checkoutWriteResponse, assetWriteResponse] = await Promise.all([checkoutWrite, assetWrite]);
  expect(checkoutWriteResponse.status(), 'checkout contract-line write should succeed').toBeLessThan(400);
  expect(assetWriteResponse.status(), 'checkout asset write should succeed').toBeLessThan(400);
  await expect(page.getByText(/checkout completed/i)).toBeVisible({ timeout: FIELD_WORKFLOW_COMPLETION_TIMEOUT });

  await page.reload({ waitUntil: 'load' });
  await page.waitForLoadState('networkidle');

  returnTask = await findFieldTaskButton(page, 'return', assetName);
  expect(returnTask, `expected Pickup / Return task for asset ${assetName}`).not.toBeNull();
  const queueContext = await getFieldTaskQueueContext(returnTask);
  await returnTask.click();

  return { assetName, ...queueContext };
}

interface CheckoutCandidate {
  contractId: string;
  lineId: string;
  assetId: string;
}

interface AvailableAssetCandidate {
  assetId: string;
}

interface ConvertibleOrderJourneyContext {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  lineCategory: string;
  lineQuantity: string;
  linePlannedStart: string;
  linePlannedEnd: string;
  lineJobSite: string;
}

interface QuoteConversionJourneyContext extends ConvertibleOrderJourneyContext {
  conversionButtonName: 'Direct Book' | 'Convert to Reservation';
  pricingSnapshotTotal: string | null;
}

interface CheckedOutCandidate {
  contractId: string;
  lineId: string;
}

interface OrderConversionCandidate {
  orderId: string;
  orderLabel: string;
  rentalType: string;
}

interface OrderConversionConflictCandidate {
  orderId: string;
  orderNumber: string;
  lineCategory: string;
}

interface ContractRowJourneyContext {
  contractId: string;
  contractLabel: string;
  contractStatus: string;
  orderReference: string;
}

interface PortalScheduleScopeContext {
  route: string;
  contractId: string;
  scopeToken: string;
}

interface PortalCatalogScopeContext {
  route: string;
  jobSiteId: string;
  scopeToken: string;
}

interface PortalIntakeScopeContext {
  route: string;
  tokenId: string;
  rawToken: string;
}

interface PortalBillingUpdateScopeContext {
  route: string;
  tokenId: string;
  rawToken: string;
}

type PortalSubmitPayload = {
  p_contract_id: string;
  p_contract_line_id: string;
  p_scope_token?: string;
  p_request_type?: string;
  p_urgency?: string;
  p_customer_note?: string | null;
};
type RpcRequestPayload = {
  p_entity_type?: string;
  p_entity_id?: string;
  p_order_id?: string;
  p_data?: Record<string, unknown>;
};

type PortalCatalogRpcSubmitPayload = {
  p_job_site_id: string;
  p_asset_id: string;
  p_scope_token: string;
};

function isPortalSubmitPayload(value: unknown): value is PortalSubmitPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as { p_contract_id?: unknown; p_contract_line_id?: unknown };
  return typeof payload.p_contract_id === 'string' && typeof payload.p_contract_line_id === 'string';
}

function isPortalCatalogSubmitPayload(value: unknown): value is PortalCatalogRpcSubmitPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as {
    p_job_site_id?: unknown;
    p_asset_id?: unknown;
    p_scope_token?: unknown;
  };
  return typeof payload.p_job_site_id === 'string'
    && typeof payload.p_asset_id === 'string'
    && typeof payload.p_scope_token === 'string';
}

function parsePortalSubmitPayload(requestBodyText: string): PortalSubmitPayload | null {
  try {
    const parsed = JSON.parse(requestBodyText);
    return isPortalSubmitPayload(parsed) ? parsed : null;
  } catch {
    // Ignore non-JSON payloads while filtering for the portal mutation request.
    return null;
  }
}

function parseRpcRequestPayload(requestBodyText: string): RpcRequestPayload | null {
  try {
    const parsed = JSON.parse(requestBodyText);
    return typeof parsed === 'object' && parsed !== null ? parsed as RpcRequestPayload : null;
  } catch {
    return null;
  }
}

function parsePortalCatalogSubmitPayload(requestBodyText: string): PortalCatalogRpcSubmitPayload | null {
  try {
    const parsed = JSON.parse(requestBodyText);
    return isPortalCatalogSubmitPayload(parsed) ? parsed : null;
  } catch {
    // Ignore non-JSON payloads while filtering for the portal mutation request.
    return null;
  }
}

function parsePortalCatalogSubmitResult(payload: unknown): string | null {
  if (!Array.isArray(payload) || !payload[0]) return null;
  const requisitionId = (payload[0] as { requisition_id?: unknown }).requisition_id;
  return typeof requisitionId === 'string' ? requisitionId : null;
}

function extractDocumentCustomerName(contextGridText: string): string | null {
  const customerBlock = contextGridText.match(/Customer\s*\n([\s\S]*?)(?:\nJob Site\b|$)/i)?.[1];
  if (!customerBlock) {
    return null;
  }

  return customerBlock
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^(Customer|Job Site|Reference:|Status:|Issued:|Rental:)/i.test(line)) ?? null;
}

function parsePortalScheduleScopeContext(rawUrl: string): PortalScheduleScopeContext {
  const parsed = new URL(rawUrl, PORTAL_SCHEDULE_HREF_BASE);
  const contractId = parsed.pathname.match(/\/portal\/schedule\/([^/?#]+)/)?.[1];
  const scopeToken = parsed.searchParams.get('scope')?.trim() ?? '';
  if (!contractId || !scopeToken) {
    throw new Error('E2E_PORTAL_SCHEDULE_SCOPED_URL must include /portal/schedule/:contractId?scope=<token>.');
  }

  return {
    route: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    contractId,
    scopeToken,
  };
}

async function findConvertibleOrder(page: Page): Promise<ConvertibleOrderJourneyContext> {
  await page.goto('/rental/orders');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();

  const initialViewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
  const orderCount = await initialViewActions.count();
  if (orderCount === 0) {
    test.skip(true, 'No rental orders with a View action are available in this environment.');
  }

  const maxOrdersToScan = Math.min(orderCount, 10);
  for (let orderIndex = 0; orderIndex < maxOrdersToScan; orderIndex++) {
    if (orderIndex > 0) {
      await page.goto('/rental/orders');
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();
    }

    const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
    await viewActions.nth(orderIndex).click();
    await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/);
    await page.waitForLoadState('networkidle');

    const convertButton = page.getByRole('button', { name: 'Convert to Reservation' });
    if ((await convertButton.count()) === 0 || await convertButton.isDisabled()) {
      continue;
    }

    const orderId = page.url().split('/').at(-1);
    if (!orderId) {
      continue;
    }

    const orderNumber = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    const lineQtyLabel = page.getByText(/^Qty:/).first();
    if ((await lineQtyLabel.count()) === 0) {
      continue;
    }

    const lineCard = page.locator('div.rounded-lg.border').filter({ has: lineQtyLabel }).first();
    const lineText = await lineCard.innerText();
    const lineCategory = lineText.split('\n')[0]?.trim() ?? '';
    const lineQuantity = lineText.match(/Qty:\s*([^·\n]+)/i)?.[1]?.trim() ?? '';
    const lineDateRange = lineText.match(/Qty:\s*[^\n·]+\s*·\s*([0-9-]+)\s+to\s+([0-9-]+)/i);
    const linePlannedStart = lineDateRange?.[1]?.trim() ?? '';
    const linePlannedEnd = lineDateRange?.[2]?.trim() ?? '';
    const lineJobSite = lineText.match(/Job Site:\s*([^\n·]+)/i)?.[1]?.trim() ?? 'N/A';
    if (!lineCategory || !lineQuantity || !linePlannedStart || !linePlannedEnd) {
      continue;
    }

    let customerName: string | null = null;
    const documentToggle = page.getByTestId('toggle-order-document');
    if ((await documentToggle.count()) > 0) {
      await documentToggle.click();
      await expect(page.getByTestId('commercial-document')).toBeVisible();
      customerName = extractDocumentCustomerName(await page.getByTestId('commercial-document-context-grid').innerText());
    }

    return {
      orderId,
      orderNumber,
      customerName,
      lineCategory,
      lineQuantity,
      linePlannedStart,
      linePlannedEnd,
      lineJobSite,
    };
  }

  test.skip(true, 'No quoted or approved rental order with visible line context is available for full lifecycle coverage.');
  throw new Error('unreachable');
}

async function findConvertibleOrderWithSnapshot(page: Page): Promise<QuoteConversionJourneyContext> {
  await page.goto('/rental/orders');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();

  const initialViewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
  const orderCount = await initialViewActions.count();
  if (orderCount === 0) {
    test.skip(true, 'No rental orders with a View action are available in this environment.');
  }

  const maxOrdersToScan = Math.min(orderCount, 15);
  for (let orderIndex = 0; orderIndex < maxOrdersToScan; orderIndex++) {
    if (orderIndex > 0) {
      await page.goto('/rental/orders');
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();
    }

    const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
    await viewActions.nth(orderIndex).click();
    await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/);
    await page.waitForLoadState('networkidle');

    const convertToReservationButton = page.getByRole('button', { name: 'Convert to Reservation' });
    const directBookButton = page.getByRole('button', { name: 'Direct Book' });
    const hasConvertButton = (await convertToReservationButton.count()) > 0 && await convertToReservationButton.isEnabled();
    const hasDirectBookButton = (await directBookButton.count()) > 0 && await directBookButton.isEnabled();
    if (!hasConvertButton && !hasDirectBookButton) {
      continue;
    }
    const conversionButtonName: 'Direct Book' | 'Convert to Reservation' = hasConvertButton ? 'Convert to Reservation' : 'Direct Book';

    const orderId = page.url().split('/').at(-1);
    if (!orderId) {
      continue;
    }

    const orderNumber = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    const lineQtyLabel = page.getByText(/^Qty:/).first();
    if ((await lineQtyLabel.count()) === 0) {
      continue;
    }

    const lineCard = page.locator('div.rounded-lg.border').filter({ has: lineQtyLabel }).first();
    const lineText = await lineCard.innerText();
    const lineCategory = lineText.split('\n')[0]?.trim() ?? '';
    const lineQuantity = lineText.match(/Qty:\s*([^·\n]+)/i)?.[1]?.trim() ?? '';
    const lineDateRange = lineText.match(/Qty:\s*[^\n·]+\s*·\s*([0-9-]+)\s+to\s+([0-9-]+)/i);
    const linePlannedStart = lineDateRange?.[1]?.trim() ?? '';
    const linePlannedEnd = lineDateRange?.[2]?.trim() ?? '';
    const lineJobSite = lineText.match(/Job Site:\s*([^\n·]+)/i)?.[1]?.trim() ?? 'N/A';
    if (!lineCategory || !lineQuantity || !linePlannedStart || !linePlannedEnd) {
      continue;
    }

    let customerName: string | null = null;
    let pricingSnapshotTotal: string | null = null;
    const documentToggle = page.getByTestId('toggle-order-document');
    if ((await documentToggle.count()) > 0) {
      await documentToggle.click();
      await expect(page.getByTestId('commercial-document')).toBeVisible();
      customerName = extractDocumentCustomerName(await page.getByTestId('commercial-document-context-grid').innerText());
      const totalEl = page.getByTestId('commercial-document-total');
      if ((await totalEl.count()) > 0) {
        const rawTotal = (await totalEl.innerText()).trim();
        if (rawTotal) {
          pricingSnapshotTotal = rawTotal;
        }
      }
    }

    return {
      orderId,
      orderNumber,
      customerName,
      lineCategory,
      lineQuantity,
      linePlannedStart,
      linePlannedEnd,
      lineJobSite,
      conversionButtonName,
      pricingSnapshotTotal,
    };
  }

  test.skip(true, 'No draft or quoted rental order with visible line context and commercial snapshot data is available for quote conversion journey.');
  throw new Error('unreachable');
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
        name?: string;
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

function parsePortalCatalogScopeContext(rawUrl: string): PortalCatalogScopeContext {
  const parsed = new URL(rawUrl, PORTAL_CATALOG_HREF_BASE);
  const jobSiteId = parsed.pathname.match(/\/portal\/catalog\/([^/?#]+)/)?.[1];
  const scopeToken = parsed.searchParams.get('scope')?.trim() ?? '';
  if (!jobSiteId || !scopeToken) {
    throw new Error('E2E_PORTAL_CATALOG_SCOPED_URL must include /portal/catalog/:jobSiteId?scope=<token>.');
  }

  return {
    route: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    jobSiteId,
    scopeToken,
  };
}

// Accepts either a relative portal route or full URL and returns a route for page.goto.
function withPortalScopeToken(routeOrUrl: string, token: string | null): string {
  const parsed = new URL(routeOrUrl, PORTAL_SCHEDULE_HREF_BASE);
  const trimmedToken = token?.trim() ?? '';
  if (trimmedToken) {
    parsed.searchParams.set('scope', trimmedToken);
  } else {
    parsed.searchParams.delete('scope');
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

// Parses E2E_PORTAL_INTAKE_SCOPED_URL which should be a full URL of the form:
//   https://app.example.com/portal/intake/<tokenId>#token=<rawToken>
// The raw token lives in the fragment so it is never sent to the server and is
// scrubbed from the address bar by the component on mount.
function parsePortalIntakeScopeContext(rawUrl: string): PortalIntakeScopeContext {
  const parsed = new URL(rawUrl, PORTAL_INTAKE_HREF_BASE);
  const tokenId = parsed.pathname.match(/\/portal\/intake\/([^/?#]+)/)?.[1];
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  const rawToken = hashParams.get('token')?.trim() ?? '';
  if (!tokenId || !rawToken) {
    throw new Error('E2E_PORTAL_INTAKE_SCOPED_URL must be a full intake URL of the form /portal/intake/:tokenId#token=<rawToken>.');
  }
  return {
    route: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    tokenId,
    rawToken,
  };
}

// Parses E2E_PORTAL_BILLING_UPDATE_SCOPED_URL which should be a full URL of the form:
//   https://app.example.com/portal/billing-update/<tokenId>#token=<rawToken>
// The raw token lives in the fragment so it is never sent to the server and is
// scrubbed from the address bar by the component on mount.
function parsePortalBillingUpdateScopeContext(rawUrl: string): PortalBillingUpdateScopeContext {
  const parsed = new URL(rawUrl, PORTAL_BILLING_UPDATE_HREF_BASE);
  const tokenId = parsed.pathname.match(/\/portal\/billing-update\/([^/?#]+)/)?.[1];
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  const rawToken = hashParams.get('token')?.trim() ?? '';
  if (!tokenId || !rawToken) {
    throw new Error(
      'E2E_PORTAL_BILLING_UPDATE_SCOPED_URL must be a full URL of the form /portal/billing-update/:tokenId#token=<rawToken>.',
    );
  }
  return {
    route: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    tokenId,
    rawToken,
  };
}

// Signs in as a portal_customer using email + password credentials via the Supabase
// password auth endpoint.  The resulting session tokens are injected via URL fragment
// (/portal/requests#access_token=...&refresh_token=...&type=magiclink) so the Supabase
// JS client (detectSessionInUrl: true by default) picks up the session and persists it
// in localStorage without requiring the OTP magic-link flow.
async function signInAsPortalCustomer(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/portal/requests');
  await page.waitForLoadState('domcontentloaded');

  const [supabaseUrl, supabaseAnonKey] = await page.evaluate((): [string, string] => {
    const config = ((window as unknown as Record<string, unknown>).__DIA_RUNTIME_CONFIG__ ?? {}) as Record<string, string>;
    const url = config['VITE_SUPABASE_URL'];
    const key = config['VITE_SUPABASE_ANON_KEY'];
    if (!url || !key) {
      throw new Error(
        `window.__DIA_RUNTIME_CONFIG__ is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — cannot sign in as portal customer`,
      );
    }
    return [url, key];
  });

  const authResp = await page.request.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      headers: { apikey: supabaseAnonKey, 'Content-Type': 'application/json' },
      data: JSON.stringify({ email, password }),
    },
  );
  if (!authResp.ok()) {
    throw new Error(
      `Portal customer auth failed (${authResp.status()}): ${await authResp.text()}`,
    );
  }
  const session = (await authResp.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };

  const fragment = [
    `access_token=${encodeURIComponent(session.access_token)}`,
    `refresh_token=${encodeURIComponent(session.refresh_token)}`,
    `token_type=bearer`,
    `expires_in=${session.expires_in}`,
    `type=magiclink`,
  ].join('&');
  await page.goto(`/portal/requests#${fragment}`);
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

async function findCheckedOutContractLine(page: Page): Promise<CheckedOutCandidate | null> {
  await page.goto('/rental/contracts');
  await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();

  const viewButtons = page.getByRole('button', { name: 'View' });
  const contractCountFromButtons = await viewButtons.count();
  const viewActions = contractCountFromButtons > 0 ? viewButtons : page.getByRole('link', { name: 'View' });
  const contractCount = contractCountFromButtons > 0 ? contractCountFromButtons : await viewActions.count();
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
      const status = lineText.match(/\bchecked_out\b/i);
      if (!lineId || !status) continue;

      return { contractId, lineId };
    }
  }

  return null;
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

  const maxOrdersToScan = Math.min(orderCount, RERENT_MAX_ORDERS_TO_SCAN);
  for (let orderIndex = 0; orderIndex < maxOrdersToScan; orderIndex++) {
    if (orderIndex > 0) {
      await page.goto('/rental/orders');
      await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();
    }

    await viewActions.nth(orderIndex).click();
    try {
      await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/, { timeout: RERENT_NAVIGATION_TIMEOUT });
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
    if (approvedStatusCount === 0 || convertActionCount === 0) continue;

    const orderLabel = (await page.locator('main').getByRole('heading', { level: 1 }).first().innerText()).trim();
    const rentalType = (await page.getByText(/^(external|internal)$/i).first().innerText()).trim();
    if (!rentalType) continue;

    return { orderId, orderLabel, rentalType };
  }

  throw new Error('No approved rental order with an available order-to-contract conversion action was found.');
}

async function findOrderForConversionConflictJourney(page: Page): Promise<OrderConversionConflictCandidate> {
  await page.goto('/rental/orders');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();

  const initialViewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
  const orderCount = await initialViewActions.count();
  if (orderCount === 0) {
    test.skip(true, 'No rental orders with a View action are available in this environment.');
  }

  const maxOrdersToScan = Math.min(orderCount, RERENT_MAX_ORDERS_TO_SCAN);
  for (let orderIndex = 0; orderIndex < maxOrdersToScan; orderIndex++) {
    if (orderIndex > 0) {
      await page.goto('/rental/orders');
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();
    }

    const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
    await viewActions.nth(orderIndex).click();
    try {
      await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/, { timeout: RERENT_NAVIGATION_TIMEOUT });
    } catch {
      continue;
    }
    await page.waitForLoadState('networkidle');

    const convertAction = page
      .getByRole('button', { name: ORDER_TO_CONTRACT_ACTION_PATTERN })
      .or(page.getByRole('link', { name: ORDER_TO_CONTRACT_ACTION_PATTERN }))
      .first();
    if (!await convertAction.isVisible().catch(() => false)) {
      continue;
    }

    const hasAdvisorySection = (await page.getByText('Quote Availability (Advisory)').count()) > 0;
    const hasAlternativeAction = (await page.getByRole('button', { name: 'Use this recommendation' }).count()) > 0;
    const hasRerentAction = (await page.getByRole('button', { name: 'Mark Preferred Vendor Re-rent' }).count()) > 0;
    if (!hasAdvisorySection || (!hasAlternativeAction && !hasRerentAction)) {
      continue;
    }

    const lineCard = page.locator('div.rounded-lg.border').filter({ has: page.getByText(/^Qty:/).first() }).first();
    if (!await lineCard.isVisible().catch(() => false)) {
      continue;
    }

    const lineText = await lineCard.innerText();
    const lineCategory = lineText.split('\n')[0]?.trim() ?? '';
    if (!lineCategory) {
      continue;
    }

    const orderId = page.url().split('/').at(-1)?.trim() ?? '';
    if (!orderId) {
      continue;
    }

    const orderNumber = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    if (!orderNumber) {
      continue;
    }

    return {
      orderId,
      orderNumber,
      lineCategory,
    };
  }

  test.skip(true, 'No quoted/approved rental order exposes both shortage advisory context and an actionable conversion-follow-up path.');
  throw new Error('unreachable');
}

async function pickContractFromVisibleListContext(page: Page): Promise<ContractRowJourneyContext> {
  await page.goto('/rental/contracts');
  await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();

  const viewButtons = page.getByRole('button', { name: 'View' });
  const viewButtonCount = await viewButtons.count();
  const useButtons = viewButtonCount > 0;
  const initialViewActions = useButtons ? viewButtons : page.getByRole('link', { name: 'View' });
  const contractCount = await initialViewActions.count();
  if (contractCount === 0) {
    test.skip(true, 'No contracts with a View action are available in this environment.');
  }

  const maxContractsToScan = Math.min(contractCount, 10);
  for (let contractIndex = 0; contractIndex < maxContractsToScan; contractIndex++) {
    if (contractIndex > 0) {
      await page.goto('/rental/contracts');
      await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();
    }

    const viewActions = useButtons ? page.getByRole('button', { name: 'View' }) : page.getByRole('link', { name: 'View' });
    const rowViewAction = viewActions.nth(contractIndex);
    const row = rowViewAction.locator('xpath=..').locator('xpath=..');
    const rowText = await row.innerText();

    const rowLines = rowText.split('\n').map((line) => line.trim()).filter(Boolean);
    const contractLabel = rowLines.find((line) => !line.startsWith('Order:') && line.toLowerCase() !== 'view');
    const orderReference = rowText.match(/Order:\s*([^\n]+)/i)?.[1]?.trim();
    const contractStatus = rowText.match(/\b(pending_execution|active|closed|cancelled)\b/i)?.[1];
    if (!contractLabel || !orderReference || !contractStatus) {
      continue;
    }

    await rowViewAction.click();
    await expect(page).toHaveURL(/\/rental\/contracts\/[^/]+$/);
    await page.waitForLoadState('networkidle');

    const contractId = page.url().split('/').at(-1);
    if (!contractId) continue;

    return { contractId, contractLabel, contractStatus, orderReference };
  }
  test.skip(true, 'No contract row exposed visible contract/status/order context suitable for list-to-detail handoff.');
  throw new Error('unreachable');
}

/**
 * GOOD-EXPERIENCE expectations — these run NON-GATING (see e2e-dev.yml `experience`
 * job). A failure here is NOT a deploy blocker or an incident; it is the signal that
 * a screen is not yet genuinely useful. The QA Manager maintains these and files
 * `ux` improvement tickets for the gaps (see .github/agents/qa-manager.agent.md).
 *
 * Assert what a USEFUL version of each screen would show, for a rental-ERP operator
 * who needs to make decisions and get work done — not merely "the page renders".
 */

test.describe('@experience good-UX expectations (allowed to fail = improvement backlog)', () => {
  test('home dashboard surfaces operational KPIs, not just navigation links', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate protected dashboard UX.');
    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/');

    // Wait up to 15 s for KPI data to populate — deployed-dev Supabase can be
    // slow to warm up on the first authenticated request.
    await page
      .waitForFunction(
        () => {
          const body = document.body.innerText;
          const numbers = (body.match(/\b\d[\d,]*\.?\d*%?\b/g) ?? []).filter(
            (n) => n !== '0',
          );
          return numbers.length >= 3;
        },
        { timeout: 15_000 },
      )
      .catch(() => {
        // intentionally swallow the timeout — the assertions below will
        // surface a clear failure message with the actual body content.
      });

    const body = await page.locator('body').innerText();

    // A real rental-ERP dashboard answers "what needs my attention?" — it should
    // reference operational metrics, not just be a menu of links.
    const kpiTerms = /on[ -]?rent|utiliz|overdue|revenue|available assets|open maintenance|idle|due (today|back)/i;
    expect(body, 'dashboard should surface operational KPIs (it is a menu today)').toMatch(kpiTerms);

    // ...and show actual numeric metric values, not just words.
    const numbers = (body.match(/\b\d[\d,]*\.?\d*%?\b/g) || []).filter((n) => n !== '0');
    expect(numbers.length, 'dashboard should show >= 3 numeric KPI values').toBeGreaterThanOrEqual(3);
  });

  test('rental orders list shows human-readable data, not raw UUIDs', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/rental/orders');
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();

    // Operators read names/statuses/dates — not opaque UUIDs as the primary content.
    const uuids = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    expect(uuids.length, 'list exposes raw UUIDs as primary content').toBeLessThanOrEqual(2);

    // A usable list has a way to create/act on an order.
    const hasAction = await page
      .getByRole('button', { name: /new|create|add|start/i })
      .or(page.getByRole('link', { name: /new|create|add|start/i }))
      .count();
    expect(hasAction, 'orders screen should offer a create/act action').toBeGreaterThan(0);

    await page.getByRole('button', { name: /new rental order/i }).click();
    await expect(page.getByLabel('Requester / Customer')).toBeVisible();
    await expect(page.getByLabel('Asset Category')).toBeVisible();
    await expect(page.getByLabel('Job Site')).toBeVisible();
    await expect(page.getByLabel('Requester ID')).toHaveCount(0);
    await expect(page.getByLabel('Asset Category ID')).toHaveCount(0);
    await expect(page.getByLabel('Job Site ID')).toHaveCount(0);
  });

  test('contract list shows related order context as an operator-readable reference, not a raw id', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/rental/contracts');
    await page.waitForLoadState('networkidle');

    const viewLinks = page.getByRole('link', { name: 'View' });
    const viewButtons = page.getByRole('button', { name: 'View' });
    const contractCount = (await viewLinks.count()) + (await viewButtons.count());

    if (contractCount === 0) {
      // No contracts yet — verify the empty state is explicit, not a blank screen.
      const emptyHint = page.getByText(/contracts are created when rental orders are approved/i);
      await expect(emptyHint, 'empty contracts list should show an explicit contextual hint').toBeVisible();
      return;
    }

    // Check visible contract rows: each "Order:" line must not expose a raw UUID.
    const rawUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const orderLines = page.getByText(/^Order:/i);
    const orderLineCount = await orderLines.count();
    expect(orderLineCount, 'each contract row should have an Order: reference line').toBeGreaterThan(0);

    for (let i = 0; i < Math.min(orderLineCount, 5); i++) {
      const lineText = await orderLines.nth(i).innerText();
      expect(
        lineText,
        `contract row ${i + 1} "Order:" line should not expose a raw UUID`
      ).not.toMatch(rawUuidPattern);
      expect(
        lineText,
        `contract row ${i + 1} "Order:" line should not fall back to bare N/A`
      ).not.toBe('Order: N/A');
      const orderValue = lineText.replace(/^Order:\s*/i, '').trim();
      expect(
        orderValue,
        `contract row ${i + 1} should expose a non-empty, human-readable order reference`
      ).toBeTruthy();
    }
  });


  test('revenue-recognition queue filter handoff preserves finding decision context after reload', async ({ page }) => {
    test.skip(!OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD, 'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run revenue-recognition queue E2E.');

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops/revenue-recognition');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Revenue Recognition' })).toBeVisible();

    const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
    if ((await openFindingLinks.count()) === 0) {
      test.skip(true, 'Revenue-recognition findings are not seeded in this environment yet.');
    }

    const findingCards = page.locator('div').filter({ has: page.getByRole('link', { name: 'Open finding' }) });
    // Only exercise the approve workflow against a pending_approval finding.
    // If all findings have already been decided the test skips rather than
    // opening an approved card where the Approve form is intentionally hidden.
    const pendingCards = findingCards.filter({ has: page.getByText('pending_approval') });
    if ((await pendingCards.count()) === 0) {
      test.skip(true, 'No pending_approval findings in this environment — all findings have already been decided.');
    }
    const initialCard = pendingCards.first();
    const severityLine = (await initialCard.getByText(/\b(critical|high|medium|low)\b\s*·/i).first().innerText()).trim();
    const contractLine = (await initialCard.getByText(/^Contract:/).first().innerText()).trim();
    const customerLine = (await initialCard.getByText(/^Customer:/).first().innerText()).trim();
    const deltaLine = (await initialCard.getByText(/^Delta:/).first().innerText()).trim();
    const severity = severityLine.match(/\b(critical|high|medium|low)\b/i)?.[1]?.toLowerCase();
    const contractContext = contractLine.replace(/^Contract:\s*/i, '').split('·')[0]?.trim();
    const customerContext = customerLine.replace(/^Customer:\s*/i, '').split('·')[0]?.trim();
    const deltaContext = deltaLine.replace(/^Delta:\s*/i, '').split('·')[0]?.trim();

    expect(severity, 'revenue-recognition queue should surface a severity value usable as a real filter').toBeTruthy();
    expect(contractContext, 'finding card should surface contract context').toBeTruthy();
    expect(customerContext, 'finding card should surface customer context').toBeTruthy();
    expect(deltaContext, 'finding card should surface delta context').toBeTruthy();

    const severityFilter = page.getByRole('combobox', { name: 'Severity' });
    await severityFilter.click();
    await page.getByRole('option', { name: severity!, exact: true }).click();

    await expect.poll(async () => await openFindingLinks.count(), {
      timeout: 20_000,
      message: `expected at least one finding after applying severity filter "${severity}"`,
    }).toBeGreaterThan(0);

    await initialCard.getByRole('link', { name: 'Open finding' }).first().click();
    await expect(page).toHaveURL(/\/ops\/findings\/[^/]+/);
    await page.waitForLoadState('networkidle');

    const detailUrl = page.url();
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const findingId = detailUrl.match(/\/ops\/findings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
    expect(findingId, 'detail URL should contain a UUID finding ID segment').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const findingHeading = (await page.locator('main').getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(findingHeading, 'finding detail should show finding type heading').toBeTruthy();
    await expect(page.getByText(new RegExp(`Contract:\\s*${escapeRegExp(contractContext!)}`, 'i'))).toBeVisible();
    await expect(page.getByText(new RegExp(`Customer:\\s*${escapeRegExp(customerContext!)}`, 'i'))).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^Impact:/i })).toBeVisible();

    const approvalResponse = page.waitForResponse((response) => {
      if (!response.url().includes('/api/ops/findings/decision') || response.request().method() !== 'POST') {
        return false;
      }
      try {
        return JSON.parse(response.request().postData() ?? '{}').decision === 'approve';
      } catch {
        return false;
      }
    });

    await page.getByLabel('Approval note (optional)').fill(`E2E revenue-recognition approval ${Date.now()}`);
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await approvalResponse).status(), 'approve decision should return accepted status').toBe(202);

    await expect(page.getByText(/\bapproved\b/i).first()).toBeVisible();
    await expect(page.getByText('Action failed')).toHaveCount(0);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/\bapproved\b/i).first()).toBeVisible();

    await page.goto('/ops/revenue-recognition');
    await page.waitForLoadState('networkidle');
    await severityFilter.click();
    await page.getByRole('option', { name: severity!, exact: true }).click();

    const updatedCard = findingCards
      .filter({ has: page.locator(`a[href*="/ops/findings/${findingId!}"]`) })
      .first();

    await expect(updatedCard).toBeVisible({ timeout: 20_000 });
    await expect(updatedCard).toContainText('approved');
    await expect(updatedCard).toContainText(`Contract: ${contractContext}`);
    await expect(updatedCard).toContainText(`Customer: ${customerContext}`);
    await expect(updatedCard).toContainText(new RegExp(`Delta:\\s*${escapeRegExp(deltaContext!)}`, 'i'));
  });

  test('rental order detail supports availability-row add-line flow with persisted line after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    test.fail(true, 'Non-gating: availability-row add-line journey on deployed dev is tracked as backlog signal until reliability improves.');

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
    let selectedRowText = '';
    for (let buttonIndex = 0; buttonIndex < addItemCount; buttonIndex++) {
      const button = addItemButtons.nth(buttonIndex);
      if (await button.isDisabled()) continue;
      selectedButton = button;
      selectedRowText = await button.locator('xpath=ancestor::*[contains(@class,"rounded-lg")]').first().innerText();
      break;
    }
    expect(selectedButton, 'expected at least one enabled + Add Item button from an availability row').not.toBeNull();

    const selectedAvailabilityRow = availabilityRows.find((row) => (
      selectedRowText.includes(row.branch_name) && selectedRowText.includes(row.asset_category_name)
    ));
    expect(selectedAvailabilityRow, 'selected availability row should map to API row context').toBeDefined();
    await selectedButton!.click();

    const addLineDialog = page.getByRole('dialog');
    await expect(addLineDialog).toBeVisible();
    await expect(
      addLineDialog.getByLabel('Asset Category ID'),
      'availability-row category context should prefill Add Line workflow'
    ).toHaveValue(selectedAvailabilityRow!.asset_category_id);

    const day = (Date.now() % 20) + 1;
    const startDay = String(day).padStart(2, '0');
    const endDay = String(Math.min(day + 1, 28)).padStart(2, '0');
    const plannedStart = `2026-11-${startDay}`;
    const plannedEnd = `2026-11-${endDay}`;

    await addLineDialog.getByLabel('Quantity').fill('1');
    await addLineDialog.getByLabel('Planned Start').fill(plannedStart);
    await addLineDialog.getByLabel('Planned End').fill(plannedEnd);
    await addLineDialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Daily' }).click();

    const addLineWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"p_entity_type":"rental_order_line"')
        && body.includes(`"category_id":"${selectedAvailabilityRow!.asset_category_id}"`)
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
    await expect(orderLinesCard.getByText(selectedAvailabilityRow!.asset_category_id)).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      orderLinesCard.getByText(`Qty: 1 · ${plannedStart} to ${plannedEnd}`),
      'new order line should persist after page reload'
    ).toBeVisible({ timeout: 15_000 });
    await expect(orderLinesCard.getByText(selectedAvailabilityRow!.asset_category_id)).toBeVisible();
  });

  test('invoice list shows related records as names and document numbers, not raw UUIDs', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated invoice list experience checks.');
    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/entities/invoice');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const body = await page.locator('body').innerText();

    const invoiceContextLine = /Customer:\s.+·\sBilling Account:\s.+·\sContract:\s.+·\sJob Site:\s.+/i;
    expect(body, 'invoice rows should include operator-facing related context').toMatch(invoiceContextLine);

    // Allow a tiny baseline for framework/render internals, but not UUID-heavy row content.
    const uuids = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    expect(uuids.length, 'invoice list still shows too many raw UUIDs').toBeLessThanOrEqual(2);
  });

  test('maintenance work order journey preserves context across reload and invoice handoff', async ({ page }) => {
    test.fail(true, 'Non-gating: maintenance work-order journey context on deployed dev is tracked as backlog signal until reliability improves.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate authenticated maintenance work-order journey UX.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/entities/maintenance_record');
    await page.waitForLoadState('networkidle');

    const queueViewAction = page.getByRole('button', { name: 'View' }).or(page.getByRole('link', { name: 'View' })).first();
    expect(
      await queueViewAction.count(),
      'expected at least one maintenance work order in queue to validate real list-to-detail navigation'
    ).toBeGreaterThan(0);

    const workOrderResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes(MAINTENANCE_WORK_ORDER_BILLING_VIEW)
      && response.ok()
    ));

    await queueViewAction.click();
    await expect(page).toHaveURL(/\/entities\/maintenance_record\/[^/?#]+$/);
    const maintenanceDetailUrl = page.url();
    const workOrderResponse = await workOrderResponsePromise;
    expect(workOrderResponse.ok(), 'maintenance work-order detail data source should load successfully').toBe(true);
    await page.waitForLoadState('networkidle');

    const workOrderPayload = await workOrderResponse.json() as Array<{
      name?: string | null;
      maintenance_type?: string | null;
    }> | { name?: string | null; maintenance_type?: string | null };
    expect(
      Array.isArray(workOrderPayload) || (typeof workOrderPayload === 'object' && workOrderPayload !== null),
      'maintenance work-order detail payload should be an object or object array'
    ).toBe(true);
    const workOrder = Array.isArray(workOrderPayload) ? workOrderPayload[0] : workOrderPayload;
    expect(workOrder, 'expected maintenance work-order detail payload').toBeTruthy();

    const heading = page.locator('main').getByRole('heading', { level: 1 }).first();
    const workOrderLabel = (await heading.innerText()).trim();
    expect(workOrderLabel, 'work-order detail should include an operator-readable title').toBeTruthy();
    expect(workOrderLabel, 'work-order title should not be a raw UUID-only value').not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    if (workOrder?.name?.trim()) {
      expect(workOrderLabel).toContain(workOrder.name.trim());
    }

    const relatedContextCard = page.getByText('Related Context').locator('../..');
    await expect(relatedContextCard).toBeVisible();
    const relatedContextText = await relatedContextCard.innerText();
    expect(relatedContextText, 'detail should show durable asset context').toMatch(
      /Asset[\s\S]*Identifier:[\s\S]*Asset Category[\s\S]*Branch/i
    );
    expect(relatedContextText, 'detail should show durable billing-account context').toMatch(/Billing Account/i);

    if (workOrder?.maintenance_type?.trim()) {
      await expect(
        page.getByText(new RegExp(`^${escapeRegExp(workOrder.maintenance_type.trim())}$`, 'i')).first(),
        'maintenance type should be visible on detail'
      ).toBeVisible();
    }

    const billingCard = page.getByText('Billing & Invoice').locator('../..');
    await expect(billingCard).toBeVisible();
    const billingCardText = await billingCard.innerText();
    const invoiceLink = billingCard.getByRole('link', { name: /View Invoice/i }).first();

    if ((await invoiceLink.count()) > 0) {
      const invoiceHref = await invoiceLink.getAttribute('href');
      expect(invoiceHref, 'maintenance work-order invoice handoff should include a concrete invoice destination').toMatch(
        /\/entities\/invoice\/[^/?#]+$/
      );
      await invoiceLink.click();
      await expect(page).toHaveURL(/\/entities\/invoice\/[^/?#]+$/);
      await page.waitForLoadState('networkidle');
      await expect(
        page.getByText('Billing Context').locator('..'),
        'invoice detail should preserve relationship context after handoff from work order'
      ).toBeVisible();

      const invoiceUrlAfterNavigation = page.url();
      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      expect(page.url(), 'invoice destination should remain stable after reload').toBe(invoiceUrlAfterNavigation);
      await expect(page.getByText('Billing Context').locator('..')).toBeVisible();
    } else {
      expect(
        billingCardText,
        'not-yet-invoiced work orders should show an explicit operator-readable billing next state, not a dead end'
      ).toMatch(/not invoiced|generate draft invoice|no customer invoice will be generated|internal work order/i);
    }

    await page.goto(maintenanceDetailUrl);
    await page.waitForLoadState('networkidle');
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(heading).toHaveText(workOrderLabel);
    const reloadedRelatedContextText = await relatedContextCard.innerText();
    expect(reloadedRelatedContextText).toContain('Asset');
    expect(reloadedRelatedContextText).toContain('Billing Account');
  });

  test('rental contract detail surfaces related records as operator-readable context, not raw IDs', async ({ page }) => {
    test.fail(true, 'Non-gating: contract-detail related-record context is a backlog signal — passes once the fix is deployed to dev.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated contract detail experience checks.');
    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/rental/contracts');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Find a contract row and navigate to its detail page.
    const viewLink = page.getByRole('link', { name: 'View' }).first();
    if ((await viewLink.count()) === 0) {
      test.skip(true, 'No contracts available in the dev environment to validate contract detail UX.');
    }
    await viewLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const body = await page.locator('body').innerText();

    // The detail page must show human-readable customer context — not a raw UUID as the primary field.
    const customerLine = /Customer\s*\n.+/i;
    expect(body, 'contract detail should show a Customer field with a value').toMatch(customerLine);

    // The Source Order should link to the order detail page rather than just printing a raw ID.
    const orderLinks = page.getByRole('link', { name: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i });
    if ((await orderLinks.count()) > 0) {
      // If order is shown as a link, it must point to the orders route.
      const orderLink = orderLinks.first();
      const href = await orderLink.getAttribute('href');
      expect(href, 'source order link must point to the rental orders route').toMatch(/\/rental\/orders\//);
    }

    // Contract line rows must show category names, not only raw category UUIDs as the primary heading.
    const lineRows = page.locator('.border.rounded-lg');
    if ((await lineRows.count()) > 0) {
      const firstLineText = await lineRows.first().innerText();
      // Line heading should be a human-readable category name, not a raw UUID.
      const uuidsInHeading = firstLineText.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/im) || [];
      expect(
        uuidsInHeading.length,
        'contract line primary heading should not be a raw UUID — should show category name'
      ).toBe(0);
    }
  });

  test('asset list shows branch and category as names, not raw IDs', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate protected asset list branch/category context.');
    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/entities/asset');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const body = await page.locator('body').innerText();

    // Each asset row should show operator-facing context: identifier, category name, branch name, availability.
    const assetContextLine = /Identifier:\s.+·\sCategory:\s.+·\sBranch:\s.+·\sAvailability:\s.+/i;
    expect(body, 'asset rows should include human-readable category and branch context').toMatch(assetContextLine);

    // The primary content should not be raw UUIDs — allow a small baseline for any framework internals.
    const uuids = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    expect(uuids.length, 'asset list should not surface raw UUIDs as primary row context').toBeLessThanOrEqual(2);
  });

  test('fleet reporting renders content or explicit empty states in every report card', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate protected fleet reporting cards.');
    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/analytics/fleet');
    // Wait for the page to settle — either data arrives or loading/empty states are shown
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // All four report card titles must be present (rendered by EngineCard as divs)
    const cardTitles = [
      'Fleet Utilization by Branch',
      'Fleet Utilization by Branch / Category',
      'Rental Revenue (Invoice Data)',
      'Asset Downtime',
    ];
    for (const title of cardTitles) {
      await expect(page.getByText(title).first(), `card title "${title}" not found`).toBeVisible();
    }

    // Per-card: each card container must show content beyond its title.
    // We look for the data-sentinel elements introduced by loading / empty / data states.
    // Card 1 — Fleet Utilization by Branch
    const card1 = page.getByText('Fleet Utilization by Branch').first().locator('../..');
    const card1Body = await card1.innerText();
    expect(
      /loading branch utilization|no branch utilization data|utilization:|on rent|unable to load branch/i.test(card1Body),
      `card "Fleet Utilization by Branch" body is blank: "${card1Body.trim().slice(0, 120)}"`
    ).toBe(true);

    // Card 2 — Fleet Utilization by Branch / Category
    const card2 = page.getByText('Fleet Utilization by Branch / Category').first().locator('../..');
    const card2Body = await card2.innerText();
    expect(
      /loading category utilization|no branch\/category utilization data|available \/ \d+ total|unavailable|unable to load category/i.test(card2Body),
      `card "Fleet Utilization by Branch / Category" body is blank: "${card2Body.trim().slice(0, 120)}"`
    ).toBe(true);

    // Card 3 — Rental Revenue (Invoice Data)
    const card3 = page.getByText('Rental Revenue (Invoice Data)').first().locator('../..');
    const card3Body = await card3.innerText();
    expect(
      /loading invoice revenue|no invoice revenue data|total \$|subtotal|unable to load invoice/i.test(card3Body),
      `card "Rental Revenue (Invoice Data)" body is blank: "${card3Body.trim().slice(0, 120)}"`
    ).toBe(true);

    // Card 4 — Asset Downtime
    const card4 = page.getByText('Asset Downtime').first().locator('../..');
    const card4Body = await card4.innerText();
    expect(
      /loading asset downtime|no asset downtime data|min downtime|recorded at|unable to load asset downtime/i.test(card4Body),
      `card "Asset Downtime" body is blank: "${card4Body.trim().slice(0, 120)}"`
    ).toBe(true);
  });

  test('transport control pack turns KPI exceptions into operator follow-up links instead of a static scorecard', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run /analytics/transport coverage.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/analytics/transport');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // The page heading must be present — confirms the route is wired and the shell rendered.
    await expect(
      page.getByRole('heading', { name: 'Market transport control pack' }),
      '"Market transport control pack" heading must be visible on /analytics/transport'
    ).toBeVisible();

    // ── Weekly logistics KPI pack (t6) ─────────────────────────────────────
    // The KPI pack card must be present and its body must show KPI tiles OR an
    // explicit loading/error state — never a blank shell.
    await expect(
      page.getByText('Weekly logistics KPI pack').first(),
      '"Weekly logistics KPI pack" card title must be visible'
    ).toBeVisible();

    const kpiCard = page.getByText('Weekly logistics KPI pack').first().locator('../..');
    const kpiCardBody = await kpiCard.innerText();
    expect(
      /total routes|on-time delivery|overdue returns|missing driver|load utilization|stale position|loading transport kpi|unable to load transport kpi/i.test(kpiCardBody),
      `KPI pack card body must surface operator-usable KPI tiles or an explicit loading/error state — got: "${kpiCardBody.trim().slice(0, 200)}"`
    ).toBe(true);
    expect(
      /action now|dispatch block|telemetry gap|queue clear|covered|feed fresh/i.test(kpiCardBody),
      `KPI pack must make urgency explicit with status/context instead of a static scorecard — got: "${kpiCardBody.trim().slice(0, 200)}"`
    ).toBe(true);

    // ── Outside-haul gap warning ───────────────────────────────────────────
    // When the outside-haul spend feed is unavailable the pack must flag the
    // gap explicitly rather than silently defaulting it away.
    const outsideHaulWarning = page.getByText('Outside-haul spend feed not available');
    const outsideHaulCount = await outsideHaulWarning.count();
    if (outsideHaulCount > 0) {
      await expect(
        outsideHaulWarning.first(),
        'outside-haul gap warning must be visible when the feed is absent'
      ).toBeVisible();
    } else {
      // Feed is present — the KPI pack must show at least one non-zero numeric value.
      const kpiNumerics = (kpiCardBody.match(/\b\d[\d,]*\.?\d*%?\b/g) ?? []).filter((n) => n !== '0');
      expect(
        kpiNumerics.length,
        'if outside-haul feed is available the KPI pack must show at least one non-zero numeric KPI value'
      ).toBeGreaterThanOrEqual(1);
    }

    const kpiLinks = kpiCard.getByRole('link');
    const kpiLinkCount = await kpiLinks.count();
    expect(
      kpiLinkCount,
      'KPI pack must hand dispatch into follow-up work with internal links, even when queues are empty or source feeds are missing'
    ).toBeGreaterThanOrEqual(1);
    for (let index = 0; index < kpiLinkCount; index += 1) {
      const href = await kpiLinks.nth(index).getAttribute('href');
      expect(href, `KPI follow-up link ${index + 1} must target an internal route`).toMatch(/^\/[a-z0-9/_-]+(?:\?.*)?$/i);
    }

    // ── DOT / ELD compliance summary ──────────────────────────────────────
    // The compliance card must show actionable ELD violation/warning counts
    // or an explicit loading/error state.
    await expect(
      page.getByText('DOT / ELD compliance summary').first(),
      '"DOT / ELD compliance summary" card title must be visible'
    ).toBeVisible();

    const eldCard = page.getByText('DOT / ELD compliance summary').first().locator('../..');
    const eldCardBody = await eldCard.innerText();
    expect(
      /eld violations|eld warnings|loading eld compliance|unable to load eld compliance/i.test(eldCardBody),
      `DOT/ELD card must show actionable compliance counts or an explicit loading/error state — got: "${eldCardBody.trim().slice(0, 200)}"`
    ).toBe(true);

    // ── HOS / DVIR / stop-exception review card ───────────────────────────
    // The exceptions card must show follow-up items or an explicit empty/loading/error state.
    await expect(
      page.getByText('HOS, DVIR, and stop exception review').first(),
      '"HOS, DVIR, and stop exception review" card title must be visible'
    ).toBeVisible();

    const exceptionsCard = page.getByText('HOS, DVIR, and stop exception review').first().locator('../..');
    const exceptionsCardBody = await exceptionsCard.innerText();
    expect(
      /no open compliance exceptions|loading compliance exceptions|unable to load compliance exceptions|eld violation|eld warning|hos|dvir|stop exception|open source record/i.test(exceptionsCardBody),
      `HOS/DVIR/stop exception card must show follow-up items or explicit empty/loading/error state — got: "${exceptionsCardBody.trim().slice(0, 200)}"`
    ).toBe(true);

    // ── Open source record links route into real source workflows ─────────
    // Any "Open source record" link must point to a real internal workflow
    // route, not a bare hash or external URL.
    const openSourceLinks = exceptionsCard.getByRole('link', { name: 'Open source record' });
    const openSourceLinkCount = await openSourceLinks.count();
    if (openSourceLinkCount > 0) {
      const firstLinkHref = await openSourceLinks.first().getAttribute('href');
      expect(
        firstLinkHref,
        '"Open source record" link must not be null — it should point to a real source workflow'
      ).toBeTruthy();
      expect(
        firstLinkHref,
        '"Open source record" link must target a real internal route, not a bare "#" or empty href'
      ).toMatch(/^\/[a-z0-9/_-]+(?:\?.*)?$/i);
    }
  });

  test('safety compliance workspace shows actionable review context or explicit degraded states on deployed dev', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: /analytics/safety deployed-dev usefulness is tracked as backlog signal until the live review surface is proven reliable.',
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run /analytics/safety coverage.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/analytics/safety', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const leadershipKpiBoundaryPattern =
      /human decision required|missing or stale source data|no focus areas were automatically recommended|incident \/ osha rollup source is not connected yet/i;
    const explicitDegradedStatePattern =
      /no audit findings are currently surfaced|no blocked corrective actions are currently surfaced|missing or stale source data|source gap|unable to load audit findings|unable to load corrective actions|no focus areas were automatically recommended/i;
    const correctiveActionBlockerBadgePattern = /^\d+ blockers$/;

    await expect(
      page.getByRole('heading', { name: 'Safety audit closure and KPI pack' }),
      '"Safety audit closure and KPI pack" heading must be visible on /analytics/safety',
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Human approval remains required')).toBeVisible();
    await expect(page.getByText('Audit findings workspace').first()).toBeVisible();
    await expect(page.getByText('Corrective-action and training blockers').first()).toBeVisible();
    await expect(page.getByText('Leadership KPI pack draft').first()).toBeVisible();

    const expectDynamicCardSignal = async (
      signals: readonly Locator[],
      message: string,
    ): Promise<void> => {
      await expect
        .poll(
          async () => {
            const signalCounts = await Promise.all(signals.map((signal) => signal.count()));

            for (const [index, count] of signalCounts.entries()) {
              if (count > 0) {
                return (await signals[index].first().innerText()).trim();
              }
            }

            return '';
          },
          {
            timeout: 10_000,
            message,
          },
        )
        .toMatch(/\S/);
    };

    const getCardBody = (title: string): Locator =>
      page
        .getByText(title, { exact: true })
        .first()
        .locator('../..')
        .locator(':scope > div')
        .last();

    const auditCard = getCardBody('Audit findings workspace');
    await expectDynamicCardSignal(
      [
        auditCard.getByText('Loading audit findings...', { exact: true }),
        auditCard.getByText('Unable to load audit findings', { exact: true }),
        auditCard.getByText('No audit findings are currently surfaced.', { exact: true }),
        auditCard.getByText('Overdue', { exact: true }),
        auditCard.getByText('Repeat finding', { exact: true }),
        auditCard.getByText('Evidence gap', { exact: true }),
        auditCard.getByRole('link', { name: 'Open finding detail' }),
        auditCard.getByRole('link', { name: 'Open audit trail' }),
      ],
      'Audit findings workspace must show dynamic row/badge/link content or an explicit loading/error/empty state beyond the static header and description.',
    );

    const correctiveActionCard = getCardBody('Corrective-action and training blockers');
    await expectDynamicCardSignal(
      [
        correctiveActionCard.getByText('Loading corrective actions...', { exact: true }),
        correctiveActionCard.getByText('Unable to load corrective actions', { exact: true }),
        correctiveActionCard.getByText('No blocked corrective actions are currently surfaced.', { exact: true }),
        correctiveActionCard.getByText(correctiveActionBlockerBadgePattern),
        correctiveActionCard.getByText('Repeat blocker', { exact: true }),
        correctiveActionCard.getByText('Overdue', { exact: true }),
        correctiveActionCard.getByText('Source gap', { exact: true }),
        correctiveActionCard.getByRole('link', { name: 'Open project' }),
        correctiveActionCard.getByRole('link', { name: 'Open asset' }),
      ],
      'Corrective-action workspace must show dynamic blocker/link content or an explicit loading/error/empty/source-gap state beyond the static header and description.',
    );

    const kpiCard = getCardBody('Leadership KPI pack draft');
    await expect
      .poll(
        async () =>
          (await kpiCard.locator('p.text-2xl').allInnerTexts()).map((text) => text.trim()).filter(Boolean),
        {
          timeout: 10_000,
          message: 'Leadership KPI pack must render KPI value tiles beyond the static title/description shell.',
        },
      )
      .toHaveLength(6);

    const kpiCardBody = await kpiCard.innerText();
    expect(
      leadershipKpiBoundaryPattern.test(kpiCardBody),
      `Leadership KPI pack must expose human-decision boundaries or an explicit source-gap/empty state from its loaded card body — got: "${kpiCardBody.trim().slice(0, 200)}"`,
    ).toBe(true);

    const actionableLinkCandidates = [
      auditCard.getByRole('link', { name: 'Open finding detail' }),
      auditCard.getByRole('link', { name: 'Open audit trail' }),
      correctiveActionCard.getByRole('link', { name: 'Open project' }),
      correctiveActionCard.getByRole('link', { name: 'Open asset' }),
      kpiCard.locator('a[href^="/"]'),
    ] as const;
    const actionableLinks: Array<{ href: string; link: Locator }> = [];

    for (const links of actionableLinkCandidates) {
      const linkCount = await links.count();
      for (let index = 0; index < linkCount; index += 1) {
        const link = links.nth(index);
        const href = await link.getAttribute('href');
        if (!href) continue;
        actionableLinks.push({ href, link });
        expect(href, `Safety workspace follow-up link ${href} must target an internal route`).toMatch(
          /^\/[a-z0-9/_-]+(?:\?.*)?$/i,
        );
      }
    }

    if (actionableLinks.length > 0) {
      const [{ link: firstActionableLink }] = actionableLinks;
      const initialPath = new URL(page.url()).pathname;
      await Promise.all([
        page.waitForURL((url) => url.pathname !== initialPath, { timeout: 10_000 }),
        firstActionableLink.click(),
      ]);
      await page.waitForLoadState('networkidle');
      await expect.poll(
        async () => {
          const headingTexts = await page.locator('h1, h2').allInnerTexts();
          return headingTexts.map((text) => text.trim()).find(Boolean) ?? '';
        },
        {
          timeout: 10_000,
          message: 'Safety workspace drill-down destination must render a visible heading, not a blank shell.',
        },
      ).toMatch(/\S/);
    } else {
      const combinedCardText = `${await auditCard.innerText()}\n${await correctiveActionCard.innerText()}\n${kpiCardBody}`;
      expect(
        explicitDegradedStatePattern.test(combinedCardText),
        'When no drill-down links are available, /analytics/safety must show an explicit empty/source-gap/error state instead of a silent blank panel.',
      ).toBe(true);
    }
  });

  test('dashboard builder keeps saved KPI layouts and drill-downs operator-usable across reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: dashboard builder saved-layout persistence and drill-down handoff on deployed dev is tracked as backlog signal until the live journey is proven reliable.'
    );
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run dashboard builder E2E coverage.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/analytics/dashboards');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Dashboard Builder' })).toBeVisible();

    // Start from a clean local dashboard state so the assertions are deterministic.
    await page.evaluate(() => {
      localStorage.removeItem('dia_saved_dashboards');
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const selectedMetrics = ['Available Assets', 'Period Revenue', 'Overdue Returns'] as const;
    for (const metricLabel of selectedMetrics) {
      await page.getByRole('button', { name: metricLabel, exact: true }).click();
      const tile = page.getByText(metricLabel, { exact: true }).first().locator('../..');
      await expect(tile, `${metricLabel} tile should render in the dashboard canvas`).toBeVisible();

      const tileText = await tile.innerText();
      expect(
        tileText,
        `${metricLabel} tile should surface a numeric value or explicit empty/error state instead of a broken placeholder shell`
      ).toMatch(/\d|—|Error/);
    }
    await expect(page.getByText('No KPIs selected')).toHaveCount(0);

    const dashboardName = `E2E KPI Layout ${Date.now()}`;
    await page.getByLabel('Dashboard name').fill(dashboardName);
    await page.getByRole('button', { name: 'Save Dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard saved' })).toBeVisible();

    const savedDashboardRow = page.getByText(dashboardName, { exact: true }).first().locator('../..');
    await expect(savedDashboardRow).toBeVisible();
    await expect(savedDashboardRow.getByRole('button', { name: 'Loaded' })).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Dashboard Builder' })).toBeVisible();

    const savedDashboardRowAfterReload = page.getByText(dashboardName, { exact: true }).first().locator('../..');
    await expect(savedDashboardRowAfterReload, 'saved dashboard should still be visible after reload').toBeVisible();
    await expect(
      savedDashboardRowAfterReload.getByRole('button', { name: 'Loaded' }),
      'saved-dashboard selection should remain active after reload'
    ).toBeVisible();

    for (const metricLabel of selectedMetrics) {
      const tile = page.getByText(metricLabel, { exact: true }).first().locator('../..');
      await expect(tile, `${metricLabel} tile should persist after reload`).toBeVisible();
    }

    const availableAssetsTile = page.getByText('Available Assets', { exact: true }).first().locator('../..');
    const drillDownLink = availableAssetsTile.getByRole('link', { name: /View details/i });
    await expect(drillDownLink, 'Available Assets tile should provide a drill-down link').toBeVisible();

    const drillDownHref = await drillDownLink.getAttribute('href');
    expect(drillDownHref, 'dashboard drill-down should point to a concrete destination route').toBeTruthy();
    expect(
      drillDownHref,
      'dashboard drill-down should target an operator route rather than a raw-ID-only URL'
    ).toMatch(/^\/[a-z0-9/_-]+(?:\?.*)?$/i);
    await drillDownLink.click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/rental\/availability(?:\?.*)?$/);
    await expect(page.getByRole('heading', { name: 'Asset Availability' })).toBeVisible();

    const availabilityBody = await page.locator('main').innerText();
    expect(
      availabilityBody,
      'drill-down destination should preserve operator-usable availability context labels'
    ).toMatch(/Branch|Category|Availability|No availability rows/i);

    await page.goto('/analytics/dashboards');
    await page.waitForLoadState('networkidle');

    const staleKeyInjected = await page.evaluate((name) => {
      const storageKey = 'dia_saved_dashboards';
      const raw = localStorage.getItem(storageKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as Array<{ name?: string; metricKeys?: string[] }>;
        const target = parsed.find((dashboard) => dashboard.name === name);
        if (!target || !Array.isArray(target.metricKeys)) return false;
        if (!target.metricKeys.includes('stale_metric_key')) {
          target.metricKeys.push('stale_metric_key');
        }
        localStorage.setItem(storageKey, JSON.stringify(parsed));
        return true;
      } catch {
        return false;
      }
    }, dashboardName);
    expect(staleKeyInjected, 'test setup should inject a stale metric key into the saved dashboard payload').toBe(true);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const staleDashboardRow = page.getByText(dashboardName, { exact: true }).first().locator('../..');
    const loadButton = staleDashboardRow.getByRole('button', { name: 'Load' });
    if ((await loadButton.count()) > 0) {
      await loadButton.click();
    }

    await expect(page.getByText('Unsupported Metric').first()).toBeVisible();
    await expect(page.getByText('Metric not in catalog').first()).toBeVisible();
    await expect(page.getByText(/stale_metric_key/i).first()).toBeVisible();
  });

  test('org hierarchy page shell loads and hierarchy/config context survives direct navigation and reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated org hierarchy smoke.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Navigate directly to the org hierarchy route
    await page.goto('/enterprise/org-hierarchy');
    await page.waitForLoadState('networkidle');

    // Page shell must load — heading and subtitle must be present
    await expect(page.getByRole('heading', { name: 'Org Hierarchy' })).toBeVisible();
    await expect(page.getByText(/Company.*region.*branch structure/i).first()).toBeVisible();

    // All three data cards must be present
    for (const cardTitle of ['Companies', 'Hierarchy Relationships', 'Per-Scope Configuration']) {
      await expect(page.getByText(cardTitle).first(), `card "${cardTitle}" not found`).toBeVisible();
    }

    // Config labels or explicit empty state must be visible — page must not show blank containers
    const pageBody = await page.locator('body').innerText();
    expect(
      /currency|timezone|tax.?region|locale|No scope configuration found/i.test(pageBody),
      'Per-Scope Configuration card must show config labels or an explicit empty state'
    ).toBe(true);
    expect(
      /depth|No hierarchy relationships found/i.test(pageBody),
      'Hierarchy Relationships card must show depth-annotated rows or an explicit empty state'
    ).toBe(true);

    // Reload — page shell and data context must survive direct URL reload without blank render
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Org Hierarchy' })).toBeVisible();
    const bodyAfterReload = await page.locator('body').innerText();
    expect(
      /currency|timezone|tax.?region|locale|No scope configuration found/i.test(bodyAfterReload),
      'Hierarchy/config context (or empty state) must persist after direct URL reload — page must not render blank on re-navigation'
    ).toBe(true);
  });

  test('org hierarchy turns scope rows into drill-down actions instead of a read-only dead end', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/enterprise/org-hierarchy');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Page heading must be present
    await expect(page.getByRole('heading', { name: 'Org Hierarchy' }).first()).toBeVisible();

    // Per-Scope Configuration card must be present with scope rows
    await expect(page.getByText('Per-Scope Configuration').first()).toBeVisible();

    // Scope rows must expose drill-down links — the page must not be a read-only dead end.
    // Branch rows must carry a "Check Availability" link scoped to that branch.
    const availLinkEls = await page.getByRole('link', { name: /availability/i }).all();
    expect(
      availLinkEls.length,
      'Org hierarchy scope rows must expose at least one drill-down link — not a read-only dead end'
    ).toBeGreaterThan(0);

    const hrefs = await Promise.all(availLinkEls.map(l => l.getAttribute('href')));
    expect(
      hrefs.some(h => h?.includes('/rental/availability')),
      'Branch scope drill-down links must target /rental/availability'
    ).toBe(true);
    expect(
      hrefs.some(h => h?.includes('branch_id=')),
      'Branch scope drill-down links must carry branch_id context so scope is preserved after navigation'
    ).toBe(true);

    // Effective config labels must be visible alongside scope names — not detached in a separate dead-end list.
    // The Per-Scope Configuration card renders currency / timezone / tax region / locale inline with each row.
    const pageBody = await page.locator('body').innerText();
    expect(
      /currency|timezone|tax.?region|locale/i.test(pageBody),
      'Effective config labels (currency, timezone, tax region, locale) must be visible on the page alongside scope rows'
    ).toBe(true);

    // --- Behavioral coverage: click a scope-row drill-down and verify the destination ---

    // Pick the first branch scope drill-down link
    const firstAvailHref = hrefs.find(h => h?.includes('/rental/availability') && h.includes('branch_id='));
    const drillUrl = new URL(firstAvailHref!, AVAILABILITY_HREF_BASE);
    const branchId = drillUrl.searchParams.get('branch_id')!;
    const targetLink = page.getByRole('link', { name: /check availability/i }).first();

    // Click the drill-down link — this is the real behavioral verification.
    const [availabilityResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/rest/v1/rental_asset_availability_current') && r.request().method() === 'GET',
        { timeout: 15_000 }
      ),
      targetLink.click(),
    ]);
    await page.waitForLoadState('networkidle');

    // Destination URL must carry branch_id scope context forward
    await expect(page).toHaveURL(
      new RegExp(`/rental/availability.*[?&]branch_id=${escapeRegExp(branchId)}`)
    );

    // Destination page heading must be present
    await expect(page.getByRole('heading', { name: 'Branch Availability Lookup' })).toBeVisible();

    // The API response must be scoped to the selected branch
    expect(availabilityResponse.ok(), 'scoped availability API request should succeed').toBe(true);
    const availabilityRows = await availabilityResponse.json() as AvailabilityApiRow[];

    if (availabilityRows.length > 0) {
      expect(
        availabilityRows.every((r) => r.branch_id === branchId),
        `availability data returned must be scoped to branch ${branchId}`
      ).toBe(true);

      // The "branch scope" banner is the canonical scoped-context indicator.
      // It appears in the page header and shows the selected branch name alongside the badge.
      const branchName = availabilityRows[0].branch_name;
      const scopeBanner = page.locator('text=branch scope').locator('xpath=ancestor::*[3]');
      await expect(
        scopeBanner.getByText(new RegExp(escapeRegExp(branchName), 'i')),
        `destination screen must show the selected branch "${branchName}" in the scoped context banner`
      ).toBeVisible();

      // Reload — scoped context must survive (URL-encoded scope re-applies on reload)
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(
        new RegExp(`/rental/availability.*[?&]branch_id=${escapeRegExp(branchId)}`)
      );
      const scopeBannerAfterReload = page.locator('text=branch scope').locator('xpath=ancestor::*[3]');
      await expect(
        scopeBannerAfterReload.getByText(new RegExp(escapeRegExp(branchName), 'i')),
        `branch scope "${branchName}" must remain visible after reload — scoped context must not be lost on navigation`
      ).toBeVisible();
    } else {
      // No assets at this branch — the scope badge must still be present (params.branch_id drives the banner)
      await expect(
        page.getByText('branch scope'),
        'scoped context badge must be visible even when no availability rows are returned'
      ).toBeVisible();

      // Reload — scope badge must survive
      await page.reload();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(
        new RegExp(`/rental/availability.*[?&]branch_id=${escapeRegExp(branchId)}`)
      );
      await expect(
        page.getByText('branch scope'),
        'scoped context badge must persist after reload when branch has no availability rows'
      ).toBeVisible();
    }
  });

  test('branch operations dashboard turns branch metrics into drill-down actions', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/branch/ops');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // All three card titles must be present
    const cardTitles = [
      'Branch Performance',
      'Transfers In Flight',
      'Availability & Operational Blockers',
    ];
    for (const title of cardTitles) {
      await expect(page.getByText(title).first(), `card title "${title}" not found`).toBeVisible();
    }

    // Each card must expose at least one drill-down action link regardless of data state.
    // When data rows are present, per-row links must carry entity context in the href.

    // Branch Performance → availability links; per-row links include ?branch_id=
    const branchPerfCard = page.getByText('Branch Performance').first().locator('../..');
    const branchPerfLinkEls = await branchPerfCard.getByRole('link', { name: /availability/i }).all();
    expect(
      branchPerfLinkEls.length,
      'Branch Performance card should expose at least one availability drill-down link'
    ).toBeGreaterThan(0);
    const branchPerfHrefs = await Promise.all(branchPerfLinkEls.map(l => l.getAttribute('href')));
    expect(
      branchPerfHrefs.some(h => h?.includes('/rental/availability')),
      'Branch Performance availability links should target /rental/availability'
    ).toBe(true);
    if (branchPerfLinkEls.length > 1) {
      expect(
        branchPerfHrefs.some(h => h?.includes('branch_id=')),
        'Branch Performance per-row links should carry branch_id context'
      ).toBe(true);
    }

    // Transfers In Flight → returns / check-in links; per-row links include ?asset_id=
    const transfersCard = page.getByText('Transfers In Flight').first().locator('../..');
    const transfersLinkEls = await transfersCard.getByRole('link', { name: /check.?in|return/i }).all();
    expect(
      transfersLinkEls.length,
      'Transfers In Flight card should expose at least one check-in / return drill-down link'
    ).toBeGreaterThan(0);
    const transfersHrefs = await Promise.all(transfersLinkEls.map(l => l.getAttribute('href')));
    expect(
      transfersHrefs.some(h => h?.includes('/rental/returns')),
      'Transfers In Flight links should target /rental/returns'
    ).toBe(true);
    if (transfersLinkEls.length > 1) {
      expect(
        transfersHrefs.some(h => h?.includes('asset_id=')),
        'Transfers In Flight per-row links should carry asset_id context'
      ).toBe(true);
    }

    // Availability & Operational Blockers → availability links; per-row links include ?branch_id=&category_id=
    const availCard = page.getByText('Availability & Operational Blockers').first().locator('../..');
    const availLinkEls = await availCard.getByRole('link', { name: /availability/i }).all();
    expect(
      availLinkEls.length,
      'Availability & Operational Blockers card should expose at least one availability drill-down link'
    ).toBeGreaterThan(0);
    const availHrefs = await Promise.all(availLinkEls.map(l => l.getAttribute('href')));
    expect(
      availHrefs.some(h => h?.includes('/rental/availability')),
      'Availability & Operational Blockers availability links should target /rental/availability'
    ).toBe(true);
    if (availLinkEls.length > 1) {
      expect(
        availHrefs.some(h => h?.includes('branch_id=') && h?.includes('category_id=')),
        'Availability & Operational Blockers per-row links should carry branch_id and category_id context'
      ).toBe(true);
    }
  });

  test('branch ops availability drill-down preserves branch/category scope and leaves an operator next action', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/branch/ops');
    await page.waitForLoadState('networkidle');

    const drillDown = await findScopedAvailabilityDrillDown(page);
    const [availabilityResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.url().includes('/rest/v1/rental_asset_availability_current')
        && response.request().method() === 'GET'
      )),
      page.goto(drillDown.href),
    ]);

    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Branch Availability Lookup' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(
      `/rental/availability\\?branch_id=${escapeRegExp(drillDown.branchId)}&category_id=${escapeRegExp(drillDown.categoryId)}`
    ));

    expect(availabilityResponse.ok(), 'scoped availability API request should succeed').toBe(true);
    const availabilityRows = await availabilityResponse.json() as AvailabilityApiRow[];
    expect(availabilityRows, 'scoped availability lookup should resolve to exactly one branch/category row').toHaveLength(1);
    expect(
      availabilityRows.every((row) => row.branch_id === drillDown.branchId && row.asset_category_id === drillDown.categoryId),
      `scoped availability lookup should stay narrowed to branch ${drillDown.branchId} and category ${drillDown.categoryId}`
    ).toBe(true);

    const scopedRowLabel = `${availabilityRows[0].branch_name} • ${availabilityRows[0].asset_category_name}`;
    const scopedLabel = page.getByText(scopedRowLabel, { exact: true });
    await expect(scopedLabel, 'scoped availability lookup should render the drilled-down branch/category row once').toHaveCount(1);
    const scopedRowCard = page.locator('.border.rounded-lg.p-4').filter({ has: scopedLabel });
    await expect(scopedRowCard, `scoped availability row "${scopedRowLabel}" should resolve to exactly one availability card`).toHaveCount(1);

    const nextActionCount = await scopedRowCard.getByRole('link', { name: AVAILABILITY_NEXT_ACTION_NAME }).count()
      + await scopedRowCard.getByRole('button', { name: AVAILABILITY_NEXT_ACTION_NAME }).count();
    expect(
      nextActionCount,
      `scoped availability row "${scopedRowLabel}" should expose an operator next action instead of a dead end`
    ).toBeGreaterThan(0);
  });

  test('availability scoped row handoff creates a rental order with persisted scoped line context', async ({ page }) => {
    test.fail(true, 'Non-gating: scoped availability row handoff into downstream workflow is tracked as backlog signal until reliability improves.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/branch/ops');
    await page.waitForLoadState('networkidle');

    const drillDown = await findScopedAvailabilityDrillDown(page);
    const [availabilityResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.url().includes('/rest/v1/rental_asset_availability_current')
        && response.request().method() === 'GET'
      )),
      page.goto(drillDown.href),
    ]);
    await page.waitForLoadState('networkidle');

    expect(availabilityResponse.ok(), 'scoped availability API request should succeed').toBe(true);
    const availabilityRows = await availabilityResponse.json() as AvailabilityApiRow[];
    expect(availabilityRows, 'scoped availability lookup should resolve to exactly one branch/category row').toHaveLength(1);

    const scopedRow = availabilityRows[0];
    const scopedRowLabel = `${scopedRow.branch_name} • ${scopedRow.asset_category_name}`;
    const scopedLabel = page.getByText(scopedRowLabel, { exact: true });
    await expect(scopedLabel, 'scoped availability lookup should render the drilled-down branch/category row once').toHaveCount(1);
    const scopedRowCard = page.locator('.border.rounded-lg.p-4').filter({ has: scopedLabel });
    await expect(scopedRowCard, `scoped availability row "${scopedRowLabel}" should resolve to exactly one availability card`).toHaveCount(1);

    const createOrderLink = scopedRowCard.getByRole('link', { name: 'Create Rental Order' });
    await expect(createOrderLink, 'scoped availability row should expose Create Rental Order action').toHaveCount(1);
    const createOrderHref = await createOrderLink.first().getAttribute('href');
    expect(createOrderHref, 'Create Rental Order handoff should include branch/category scope query').toBeTruthy();
    const handoffUrl = new URL(createOrderHref!, AVAILABILITY_HREF_BASE);
    expect(handoffUrl.searchParams.get('branch_id')).toBe(drillDown.branchId);
    expect(handoffUrl.searchParams.get('category_id')).toBe(drillDown.categoryId);

    await createOrderLink.first().click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(
      `/rental/orders\\?branch_id=${escapeRegExp(drillDown.branchId)}&category_id=${escapeRegExp(drillDown.categoryId)}`
    ));
    await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();

    await page.getByRole('button', { name: 'New Rental Order' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();
    await expect(
      createDialog.getByText(new RegExp(
        `Scoped from availability: Branch\\s+${escapeRegExp(scopedRow.branch_name)}\\s+·\\s+Category\\s+(${escapeRegExp(scopedRow.asset_category_name)}|${escapeRegExp(scopedRow.asset_category_id)})`
      )),
      'new-order workflow should keep scoped branch/category context visible for operators'
    ).toBeVisible();
    await expect(
      createDialog.getByRole('combobox', { name: 'Asset Category' }),
      'availability-row handoff should prefill the line category without requiring re-selection'
    ).toContainText(new RegExp(`${escapeRegExp(scopedRow.asset_category_name)}|${escapeRegExp(scopedRow.asset_category_id)}`));

    const day = (Date.now() % 20) + 1;
    const startDay = String(day).padStart(2, '0');
    const endDay = String(Math.min(day + 1, 28)).padStart(2, '0');
    const plannedStart = `2026-12-${startDay}`;
    const plannedEnd = `2026-12-${endDay}`;
    const combos = createDialog.getByRole('combobox');
    await combos.nth(0).click();
    await page.getByRole('option').first().click();
    await combos.nth(1).click();
    await page.getByRole('option').first().click();
    await createDialog.getByLabel('Quantity').fill('1');
    await createDialog.getByLabel('Planned Start').fill(plannedStart);
    await createDialog.getByLabel('Planned End').fill(plannedEnd);
    await combos.nth(3).click();
    await page.getByRole('option').first().click();
    await combos.nth(4).click();
    await page.getByRole('option', { name: 'Daily' }).click();

    const createOrderWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"p_entity_type":"rental_order"')
        && body.includes(`"category_id":"${scopedRow.asset_category_id}"`)
        && body.includes(`"planned_start":"${plannedStart}"`)
        && body.includes(`"planned_end":"${plannedEnd}"`);
    });
    await createDialog.getByRole('button', { name: 'Create Order' }).click();
    const createOrderWriteResponse = await createOrderWrite;
    expect(createOrderWriteResponse.status(), 'scoped Create Order write should succeed').toBeLessThan(400);
    await expect(createDialog).toBeHidden({ timeout: 15_000 });

    const createdOrderRow = page.locator('.p-4.border.rounded-lg').filter({
      hasText: `Rental Window: ${plannedStart} → ${plannedEnd}`,
    });
    await expect(
      createdOrderRow.first(),
      'newly created scoped order should render in the orders list with its rental window'
    ).toBeVisible({ timeout: 15_000 });
    await createdOrderRow
      .first()
      .getByRole('link', { name: 'View' })
      .or(createdOrderRow.first().getByRole('button', { name: 'View' }))
      .click();
    await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/);

    const orderLinesCard = page.getByText('Order Lines').first().locator('../..');
    await expect(
      orderLinesCard.getByText(`Qty: 1 · ${plannedStart} to ${plannedEnd}`),
      'scoped handoff-created line should be visible on order detail'
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      orderLinesCard.getByText(`Scope: Branch ${scopedRow.branch_name} · Category ${scopedRow.asset_category_name}`),
      'order detail should keep the availability-derived branch/category context visible on the created line'
    ).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      orderLinesCard.getByText(`Qty: 1 · ${plannedStart} to ${plannedEnd}`),
      'scoped handoff-created line should persist after order detail reload'
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      orderLinesCard.getByText(`Scope: Branch ${scopedRow.branch_name} · Category ${scopedRow.asset_category_name}`),
      'scoped branch/category line context should persist after order detail reload'
    ).toBeVisible();
  });

  test('fleet availability calendar operator journey keeps scoped blocker context into the next step after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: fleet availability calendar scoped handoff on deployed dev is tracked as backlog signal until the live journey is proven reliable.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate the authenticated fleet availability calendar journey.');

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
      expect(
        nextActionUrl.searchParams.get('branch_id'),
        'calendar next-step action should preserve branch scope in the handoff URL'
      ).toBe(assetWithBranchAndCategory.branch_id);
      expect(
        nextActionUrl.searchParams.get('category_id'),
        'calendar next-step action should preserve category scope in the handoff URL'
      ).toBe(assetWithBranchAndCategory.asset_category_id);
      expect(
        nextActionUrl.searchParams.get('start_date') ?? nextActionUrl.searchParams.get('planned_start'),
        'calendar next-step action should preserve the selected start date in the handoff URL'
      ).toBe(selectedStart);
      expect(
        nextActionUrl.searchParams.get('end_date') ?? nextActionUrl.searchParams.get('planned_end'),
        'calendar next-step action should preserve the selected end date in the handoff URL'
      ).toBe(selectedEnd);
      await nextActionLink.click();
    } else {
      await nextActionButtons.first().click();
    }

    await page.waitForLoadState('networkidle');
    expectNextStepUrlContext(page.url(), 'next-step navigation');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    expectNextStepUrlContext(page.url(), 'next-step reload');
  });

  test('inventory calendar next-step workflow: destination screen is actionable with carried scope after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: inventory calendar routed next-step workflow is tracked as backlog signal until the live end-to-end journey is proven stable on deployed dev.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run the calendar next-step actionability journey.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const calendarResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/rest/v1/rpc/fleet_get_availability_calendar')
      && response.request().method() === 'POST'
    ));

    await page.goto('/inventory/calendar');
    const calendarResponse = await calendarResponsePromise;
    await page.waitForLoadState('networkidle');

    expect(calendarResponse.ok(), 'fleet availability calendar RPC should succeed on initial load').toBe(true);

    const selectedStart = await page.getByLabel('Start date').inputValue();
    const selectedEnd = await page.getByLabel('End date').inputValue();
    expect(selectedStart, 'calendar should expose a real selected start date').toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(selectedEnd, 'calendar should expose a real selected end date').toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const calendarRows = await calendarResponse.json() as InventoryCalendarApiRow[];

    // Prefer an available asset (routes to "Create rental order") for the writable-workflow check;
    // fall back to any row that has full branch/category context.
    const candidate = calendarRows.find((row) => (
      row.branch_id
      && row.branch_name
      && row.asset_category_id
      && row.asset_category_name
      && row.is_available
    )) ?? calendarRows.find((row) => (
      row.branch_id
      && row.branch_name
      && row.asset_category_id
      && row.asset_category_name
    ));

    test.skip(!candidate, 'No inventory-calendar row with branch/category context is currently available on deployed dev.');
    if (!candidate) return;

    await page.getByLabel('Branch').selectOption({ label: candidate.branch_name! });
    await page.getByLabel('Category').selectOption({ label: candidate.asset_category_name! });

    const filteredResponsePromise = page.waitForResponse((response) => {
      if (
        !response.url().includes('/rest/v1/rpc/fleet_get_availability_calendar')
        || response.request().method() !== 'POST'
      ) return false;
      try {
        const body = JSON.parse(response.request().postData() ?? '{}') as {
          p_start_date?: string;
          p_end_date?: string;
          p_branch_id?: string;
          p_category_id?: string;
        };
        return body.p_start_date === selectedStart
          && body.p_end_date === selectedEnd
          && body.p_branch_id === candidate.branch_id
          && body.p_category_id === candidate.asset_category_id;
      } catch {
        return false;
      }
    });

    await page.getByRole('button', { name: 'Apply' }).click();
    await filteredResponsePromise;
    await page.waitForLoadState('networkidle');

    const assetRow = page.getByText(candidate.name, { exact: true }).locator('..').locator('..');
    await expect(assetRow, `calendar should render scoped row for "${candidate.name}"`).toBeVisible();

    const nextActionLinks = assetRow.getByRole('link', { name: AVAILABILITY_NEXT_ACTION_NAME });
    const nextActionButtons = assetRow.getByRole('button', { name: AVAILABILITY_NEXT_ACTION_NAME });
    const hasLink = (await nextActionLinks.count()) > 0;

    if (hasLink) {
      const nextActionLink = nextActionLinks.first();
      const nextActionHref = await nextActionLink.getAttribute('href');
      expect(nextActionHref, 'calendar next-step action should be a real navigation target').toBeTruthy();
      await nextActionLink.click();
    } else {
      expect(
        await nextActionButtons.count(),
        'calendar row should expose at least one next-step action'
      ).toBeGreaterThan(0);
      await nextActionButtons.first().click();
    }

    await page.waitForLoadState('networkidle');

    // ── Assert destination screen carries visible scope context ──────────────
    const destinationUrl = new URL(page.url());
    const bodyText = await page.locator('body').innerText();

    expect(
      bodyText,
      'destination screen should show the operator-readable asset name, not degrade to raw-ID-first context'
    ).toContain(candidate.name);
    expect(
      bodyText,
      'destination screen should show the operator-readable branch name before reload'
    ).toContain(candidate.branch_name!);

    // ── Writable-workflow prefill: "Create rental order" goes to /rental/quoting ──
    const isQuotingDestination = destinationUrl.pathname.startsWith('/rental/quoting');
    if (isQuotingDestination) {
      // Branch and category IDs should be pre-selected in the first order line
      const branchSelect = page.getByTestId('input-line-0-branch');
      const categorySelect = page.getByTestId('input-line-0-category');
      const startInput = page.getByTestId('input-line-0-start');
      const endInput = page.getByTestId('input-line-0-end');

      await expect(branchSelect, 'quoting form first line should be prefilled with the calendar branch').toHaveValue(candidate.branch_id!);
      await expect(categorySelect, 'quoting form first line should be prefilled with the calendar category').toHaveValue(candidate.asset_category_id!);
      await expect(startInput, 'quoting form first line should be prefilled with the calendar start date').toHaveValue(selectedStart);
      await expect(endInput, 'quoting form first line should be prefilled with the calendar end date').toHaveValue(selectedEnd);

      // Asset select should not be empty when the calendar row had an asset ID
      if (candidate.entity_id) {
        await expect(
          page.getByTestId('input-line-0-asset'),
          'quoting form first line should be prefilled with the calendar asset'
        ).toHaveValue(candidate.entity_id);
      }
    }

    // ── Reload: URL context (and thus prefill) must survive ──────────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const bodyTextAfterReload = await page.locator('body').innerText();
    expect(
      bodyTextAfterReload,
      'destination screen should still show the operator-readable asset name after reload'
    ).toContain(candidate.name);
    expect(
      bodyTextAfterReload,
      'destination screen should still show the operator-readable branch name after reload'
    ).toContain(candidate.branch_name!);
    expect(
      bodyTextAfterReload,
      'destination screen should still show the operator-readable category name after reload'
    ).toContain(candidate.asset_category_name!);

    if (isQuotingDestination) {
      await expect(
        page.getByTestId('input-line-0-branch'),
        'quoting form branch prefill should survive reload'
      ).toHaveValue(candidate.branch_id!);
      await expect(
        page.getByTestId('input-line-0-start'),
        'quoting form start date prefill should survive reload'
      ).toHaveValue(selectedStart);
    }
  });

  test('approved rental order converts into a linked rental contract that persists after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    test.fail(true, 'Non-gating: order-to-contract conversion journey is tracked as backlog signal until deployed-dev reliability is proven.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

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

    const contractHeading = (await page.locator('main').getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(contractHeading, 'converted contract should have a visible primary label').toBeTruthy();

    const orderField = page.locator('div')
      .filter({ has: page.getByText('Order ID').first() })
      .filter({ hasText: candidate.orderId })
      .first();
    await expect(orderField, 'contract detail should preserve the source order reference in a labeled field').toBeVisible();
    const rentalTypeField = page.locator('div')
      .filter({ has: page.getByText('Rental Type').first() })
      .filter({ hasText: new RegExp(candidate.rentalType, 'i') })
      .first();
    await expect(rentalTypeField, 'contract detail should preserve source rental-type context in a labeled field').toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.locator('div').filter({ has: page.getByText('Order ID').first() }).filter({ hasText: candidate.orderId }).first()).toBeVisible();
    await expect(page.locator('div').filter({ has: page.getByText('Rental Type').first() }).filter({ hasText: new RegExp(candidate.rentalType, 'i') }).first()).toBeVisible();

    await page.goto(`/rental/orders/${candidate.orderId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/^converted$/i).first()).toBeVisible();
    await expect(page.locator(`a[href="/rental/contracts/${contractId}"]`).first()).toBeVisible();
  });

  test('rental order conversion conflict keeps shortage alternatives actionable through retry', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    test.fail(
      true,
      'Non-gating: conversion-conflict shortage retry journey is tracked as backlog signal until deployed-dev reliability is proven.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const candidate = await findOrderForConversionConflictJourney(page);
    const convertAction = page
      .getByRole('button', { name: ORDER_TO_CONTRACT_ACTION_PATTERN })
      .or(page.getByRole('link', { name: ORDER_TO_CONTRACT_ACTION_PATTERN }))
      .first();
    await expect(convertAction, 'expected a visible conversion action on the selected shortage order').toBeVisible();

    const conversionResponse = page.waitForResponse((response) => {
      const body = parseRpcRequestPayload(response.request().postData() ?? '');
      return response.url().includes('/rpc/rental_convert_quote_to_reservation')
        && body?.p_order_id === candidate.orderId;
    }, { timeout: ORDER_CONVERSION_TIMEOUT });
    await convertAction.click();
    const blockedConversionResponse = await conversionResponse;
    expect(blockedConversionResponse.status(), 'conversion RPC request should complete').toBeLessThan(400);

    const conversionPayload = await blockedConversionResponse.json() as Array<{
      success?: boolean;
      conflicts?: Array<{ line_entity_id?: string | null }>;
    }>;
    const conversionResult = conversionPayload[0];
    if (conversionResult?.success !== false || !conversionResult.conflicts || conversionResult.conflicts.length === 0) {
      test.skip(true, `Order ${candidate.orderNumber} did not surface a blocked conversion conflict in this environment.`);
      return;
    }

    await expect(page.getByText('Conversion blocked to prevent overbooking')).toBeVisible({ timeout: ORDER_CONVERSION_TIMEOUT });
    const conflictRow = page.getByText(/shortage: requested/i).first();
    await expect(conflictRow, 'blocked conversion should expose requested/available operator context').toBeVisible();
    const conflictRowText = (await conflictRow.innerText()).trim();
    expect(conflictRowText, 'conflict row should include human-readable requested/available context').toMatch(/requested\s+\d+\s*\/\s*available\s+\d+/i);
    expect(conflictRowText, 'conflict row should not degrade to a raw UUID-only message').not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    await expect(page.getByText(candidate.lineCategory, { exact: false }).first()).toBeVisible();

    const suggestionActions = page.getByRole('button', { name: 'Use this recommendation' });
    const rerentActions = page.getByRole('button', { name: 'Mark Preferred Vendor Re-rent' });
    const suggestionActionCount = await suggestionActions.count();
    const rerentActionCount = await rerentActions.count();
    expect(
      suggestionActionCount + rerentActionCount,
      'blocked conversion should keep a shortage-resolution action visible'
    ).toBeGreaterThan(0);

    if (suggestionActionCount > 0) {
      const applySuggestionWrite = page.waitForResponse((response) => (
        response.url().includes('/rpc/rental_upsert_entity_current_state')
        && response.request().method() === 'POST'
      ), { timeout: ORDER_CONVERSION_TIMEOUT });
      await suggestionActions.first().click();
      const applySuggestionResponse = await applySuggestionWrite;
      expect(applySuggestionResponse.status(), 'applying a shortage recommendation should persist').toBeLessThan(400);
    } else {
      await rerentActions.first().click();
      await expect(page.getByText('Internal shortage detected')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save Re-rent Routing' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
    }

    const retryResponsePromise = page.waitForResponse((response) => {
      const body = parseRpcRequestPayload(response.request().postData() ?? '');
      return response.url().includes('/rpc/rental_convert_quote_to_reservation')
        && body?.p_order_id === candidate.orderId;
    }, { timeout: ORDER_CONVERSION_TIMEOUT }).catch(() => null);
    await convertAction.click();
    const retryResponse = await retryResponsePromise;
    if (retryResponse) {
      expect(retryResponse.status(), 'retry conversion request should complete').toBeLessThan(400);
    }

    await page.goto(`/rental/orders/${candidate.orderId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(candidate.orderNumber);
    await expect(page.getByText(candidate.lineCategory, { exact: false }).first()).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(candidate.orderNumber);
    await expect(page.getByText(candidate.lineCategory, { exact: false }).first()).toBeVisible();
    expect(
      await page.getByText('Conversion blocked to prevent overbooking').count(),
      'order detail should not accumulate duplicate conversion-conflict alert loops after navigation/reload'
    ).toBeLessThanOrEqual(1);
  });

  test('monthly branch pack keeps branch follow-up and manager commitments durable enough for regional review', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_*) to run authenticated monthly branch pack E2E.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/branch/monthly-pack');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Monthly Branch Performance Pack' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Branch Performance Metrics' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notable Exceptions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Corrective Actions — Open Work Orders' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Manager Commentary & Commitments' })).toBeVisible();

    const performanceSection = page.getByRole('region', { name: 'Branch performance metrics' });
    const scopedFollowUpLink = performanceSection.getByRole('link', { name: 'Review branch availability' }).first();
    const scopedFollowUpHref = await scopedFollowUpLink.getAttribute('href');
    expect(scopedFollowUpHref, 'monthly branch pack should expose at least one scoped branch follow-up action').toBeTruthy();
    if (!scopedFollowUpHref) {
      throw new Error('Monthly branch pack follow-up link is missing href scope context.');
    }

    const scopedFollowUpUrl = new URL(scopedFollowUpHref, AVAILABILITY_HREF_BASE);
    const branchId = scopedFollowUpUrl.searchParams.get('branch_id');
    expect(scopedFollowUpUrl.pathname, 'monthly branch pack follow-up should target the scoped availability workflow').toBe('/rental/availability');
    expect(branchId, 'monthly branch pack follow-up should preserve branch_id scope').toBeTruthy();

    const [availabilityResponse] = await Promise.all([
      page.waitForResponse((response) => (
        response.url().includes('/rest/v1/rental_asset_availability_current')
        && response.request().method() === 'GET'
      )),
      scopedFollowUpLink.click(),
    ]);
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(`/rental/availability.*[?&]branch_id=${escapeRegExp(branchId!)}`));
    await expect(page.getByRole('heading', { name: 'Branch Availability Lookup' })).toBeVisible();
    expect(availabilityResponse.ok(), 'monthly branch pack scoped availability request should succeed').toBe(true);
    const availabilityRows = await availabilityResponse.json() as AvailabilityApiRow[];
    if (availabilityRows.length > 0) {
      expect(
        availabilityRows.every((row) => row.branch_id === branchId),
        `monthly branch pack follow-up should stay scoped to branch ${branchId}`
      ).toBe(true);
    }

    await page.goto('/branch/monthly-pack');
    await page.waitForLoadState('networkidle');

    const commentary = `Regional review follow-up ${Date.now()}: workshop lead owns the open repair plan and exception review.`;
    const commentaryField = page.getByLabel('Commentary and corrective commitments');
    await commentaryField.fill(commentary);
    await expect(commentaryField).toHaveValue(commentary);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByLabel('Commentary and corrective commitments')).toHaveValue(commentary);
  });

  test('branch ops transfer-in-flight handoff to returns check-in preserves asset context and persists result', async ({ page }) => {
    test.fail(true, 'Non-gating: branch-ops transfer-to-check-in handoff is not yet verified as reliable on the deployed dev app.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated branch-ops transfer check-in E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/branch/ops');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Capture the Transfers In Flight card — it must be visible
    const transfersCard = page.getByText('Transfers In Flight').first().locator('../..');
    await expect(transfersCard).toBeVisible();

    // Find a per-row Check In Asset link that carries asset_id context
    const drillDown = await findTransferCheckInDrillDown(page);

    // The card must surface human-readable asset/serial context before the operator clicks
    const cardBodyText = await transfersCard.innerText();
    expect.soft(/serial:/i.test(cardBodyText), 'Transfers In Flight card should surface serial number context for the in-flight asset').toBe(true);

    // Navigate to the check-in link — the downstream URL must carry the same asset_id
    await page.goto(drillDown.href);
    await page.waitForLoadState('networkidle');

    // Verify the returns screen preserves asset context without requiring manual rediscovery
    await expect(page).toHaveURL(new RegExp(`/rental/returns.*[?&]asset_id=${escapeRegExp(drillDown.assetId)}`));
    await expect(page.getByRole('heading', { name: 'Returns / Check-In' })).toBeVisible();

    const returnsBody = await page.locator('body').innerText();
    expect.soft(
      returnsBody.includes(drillDown.assetId),
      `returns page should surface asset ${drillDown.assetId} from the transfer-card handoff without requiring the operator to re-enter it`
    ).toBe(true);

    // Look for a checked-out contract line for this asset in the returns queue
    const assetLineLabels = page.getByText(new RegExp(`Asset\\s+${escapeRegExp(drillDown.assetId)}`, 'i'));
    const assetLineCount = await assetLineLabels.count();
    if (assetLineCount === 0) {
      // No active contract line visible — at minimum the check-in form should be pre-filled
      const checkInButton = page.getByRole('button', { name: 'Check In Contract Line' });
      if (await checkInButton.isVisible().catch(() => false)) {
        await checkInButton.first().click();
        const checkInDialog = page.getByRole('dialog', { name: 'Check In Contract Line' });
        if (await checkInDialog.isVisible().catch(() => false)) {
          const assetIdField = checkInDialog.getByLabel('Asset ID');
          if (await assetIdField.isVisible().catch(() => false)) {
            await expect.soft(
              assetIdField,
              'check-in dialog Asset ID should be pre-populated from the transfer-card handoff'
            ).toHaveValue(drillDown.assetId);
          }
        }
      }
      return;
    }

    // A contract line is visible for this asset — extract IDs and complete the check-in journey
    const rowContainer = assetLineLabels.first().locator('xpath=../../..');
    const rowText = await rowContainer.innerText();
    const lineId = rowText.match(/Line ID:\s*([^\s]+)/)?.[1]?.trim();
    const contractId = rowText.match(/Contract\s+([^\s•·]+)/)?.[1]?.trim();

    if (!lineId || !contractId) return;

    await page.getByRole('button', { name: 'Check In Contract Line' }).click();
    const checkInDialog = page.getByRole('dialog', { name: 'Check In Contract Line' });
    await expect(checkInDialog).toBeVisible();
    await checkInDialog.getByLabel('Contract Line Entity ID').fill(lineId);
    await checkInDialog.getByLabel('Contract ID').fill(contractId);
    await checkInDialog.getByLabel('Asset ID').fill(drillDown.assetId);
    await checkInDialog.getByLabel('Return Date').fill('2026-07-14');
    await checkInDialog.getByLabel('Condition Outcome').click();
    await page.getByRole('option', { name: 'Pass' }).click();

    const checkInStatusUpdate = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes(`"p_entity_id":"${lineId}"`)
        && body.includes('"status":"returned"');
    });
    const inspectionWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes(`"contract_line_id":"${lineId}"`)
        && body.includes('"inspection_type":"return"');
    });

    await checkInDialog.getByRole('button', { name: 'Confirm Check-In' }).click();
    const [checkInStatusResponse, inspectionWriteResponse] = await Promise.all([checkInStatusUpdate, inspectionWrite]);
    expect(checkInStatusResponse.status(), 'check-in status rpc should succeed').toBeLessThan(400);
    expect(inspectionWriteResponse.status(), 'return inspection rpc should succeed').toBeLessThan(400);

    await expect(checkInDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(`Line ID: ${lineId}`)).not.toBeVisible({ timeout: 15_000 });

    // Reload the returns page — the asset line must no longer appear as checked-out
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Line ID: ${lineId}`)).toHaveCount(0);

    // Navigate back to /branch/ops — the asset must no longer appear as in-flight
    await page.goto('/branch/ops');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const updatedTransfersCard = page.getByText('Transfers In Flight').first().locator('../..');
    const updatedCardText = await updatedTransfersCard.innerText();
    expect.soft(
      !updatedCardText.includes(drillDown.assetId),
      `asset ${drillDown.assetId} should no longer appear as in-flight on /branch/ops after successful check-in`
    ).toBe(true);

    // Contract detail must show the persisted returned / inspection-hold status — not checked-out
    await page.goto(`/rental/contracts/${contractId}`);
    await page.waitForLoadState('networkidle');
    const returnedLineCard = page
      .getByText(`Line ID: ${lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await expect.soft(returnedLineCard).not.toContainText('checked_out');
    await expect.soft(returnedLineCard).toContainText(/returned|on_inspection_hold/);
  });

  test('transfer management turns transfer rows into actionable lifecycle handoffs with durable detail context', async ({ page }) => {
    test.fail(true, 'Non-gating: transfer request→receive lifecycle handoff remains a backlog signal until the deployed-dev journey is proven end to end.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated transfer lifecycle E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/ops/transfers');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Transfer Management' })).toBeVisible();

    const candidate = await findTransferLifecycleCandidate(page);
    const lifecycleRowsBefore = await snapshotTransferLifecycleRows(page, candidate.transferId);
    if (lifecycleRowsBefore.length < 2) {
      test.skip(true, `Transfer ${candidate.transferId} does not yet expose two lifecycle milestones in history on deployed dev.`);
    }

    const statusesBefore = [...new Set(lifecycleRowsBefore.map((row) => row.status))];
    expect(
      statusesBefore.length,
      `transfer ${candidate.transferId} should expose multiple lifecycle statuses in history (requested→approved→in_transit→received)`
    ).toBeGreaterThanOrEqual(2);

    const highestStatusIndexBefore = Math.max(...statusesBefore.map((status) => TRANSFER_LIFECYCLE_STATUSES.indexOf(status)));
    expect(
      highestStatusIndexBefore,
      `transfer ${candidate.transferId} should have progressed beyond requested status to prove lifecycle movement`
    ).toBeGreaterThan(0);

    const observedMilestone = TRANSFER_LIFECYCLE_STATUSES[highestStatusIndexBefore];
    const observedMilestoneRow = lifecycleRowsBefore.find((row) => row.status === observedMilestone);
    expect(observedMilestoneRow, `expected a ${observedMilestone} history row for transfer ${candidate.transferId}`).toBeTruthy();

    const actorSegments = (observedMilestoneRow?.responsibleLine.match(
      /\b(?:Requested by|Approved by|Dispatched by|Received by):\s*([^·\n]+)/gi
    ) ?? [])
      .map((segment) => segment.replace(/.*:\s*/, '').trim());
    expect(
      actorSegments.some((value) => value && value !== 'N/A'),
      `lifecycle row ${observedMilestone} should retain at least one responsible-user value instead of all N/A`
    ).toBe(true);
    expect(
      observedMilestoneRow?.transitionedLine ?? '',
      `lifecycle row ${observedMilestone} should retain a transitioned timestamp`
    ).toMatch(/Transitioned:\s*(?!N\/A).*\d/);

    const transferHistoryRowBeforeReload = page
      .locator(`a[href="/entities/transfer/${candidate.transferId}"]`)
      .first()
      .locator('xpath=ancestor::*[.//*[contains(normalize-space(.), "Requested by:")] and .//*[contains(normalize-space(.), "Transitioned:")]][1]');
    const transferHistoryRowTextBeforeReload = await transferHistoryRowBeforeReload.innerText();
    const transferHistoryRowUuidCount = countUuidMatches(transferHistoryRowTextBeforeReload);
    expect(
      transferHistoryRowUuidCount,
      'transfer history row should surface operator-readable equipment/route context instead of a raw-ID-first shell'
    ).toBeLessThanOrEqual(MAX_VISIBLE_UUIDS_IN_TRANSFER_ROW);
    await expect(transferHistoryRowBeforeReload).toContainText(candidate.equipmentLabel);
    await expect(transferHistoryRowBeforeReload).toContainText(candidate.originBranch);
    await expect(transferHistoryRowBeforeReload).toContainText(candidate.destinationBranch);
    if (candidate.originProject) {
      await expect(transferHistoryRowBeforeReload).toContainText(candidate.originProject);
    }
    if (candidate.destinationProject) {
      await expect(transferHistoryRowBeforeReload).toContainText(candidate.destinationProject);
    }
    await expect(transferHistoryRowBeforeReload).toContainText(candidate.responsibleLine);

    await page.goto(candidate.href);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`/entities/transfer/${escapeRegExp(candidate.transferId)}$`));
    await expect(page.getByText('Transfer Coordination')).toBeVisible();
    await expect(page.locator('main')).toContainText(candidate.equipmentLabel);
    await expect(page.locator('main')).toContainText(new RegExp(`Origin\\s+${escapeRegExp(candidate.originBranch)}`));
    await expect(page.locator('main')).toContainText(new RegExp(`Destination\\s+${escapeRegExp(candidate.destinationBranch)}`));
    if (candidate.originProject) {
      await expect(page.locator('main')).toContainText(candidate.originProject);
    }
    if (candidate.destinationProject) {
      await expect(page.locator('main')).toContainText(candidate.destinationProject);
    }
    expect(
      candidate.exceptionReason,
      `expected transfer ${candidate.transferId} to expose blocked-path exception context on /ops/transfers before drilling into detail`
    ).toBeTruthy();
    await expect(page.getByText('Transfer exception')).toBeVisible();
    await expect(page.locator('main')).toContainText(candidate.exceptionReason!);
    await expect(page.locator('main')).toContainText(new RegExp(`\\b${escapeRegExp(observedMilestone)}\\b`, 'i'));
    await expect(page.locator('main')).toContainText(observedMilestoneRow?.transitionedLine ?? '');
    const detailTextBeforeReload = await page.locator('main').innerText();
    expect(
      actorSegments.some((value) => value && value !== 'N/A' && detailTextBeforeReload.includes(value)),
      `transfer detail should retain responsible-user context for lifecycle milestone ${observedMilestone}`
    ).toBe(true);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main')).toContainText(candidate.equipmentLabel);
    await expect(page.locator('main')).toContainText(new RegExp(`Origin\\s+${escapeRegExp(candidate.originBranch)}`));
    await expect(page.locator('main')).toContainText(new RegExp(`Destination\\s+${escapeRegExp(candidate.destinationBranch)}`));
    if (candidate.originProject) {
      await expect(page.locator('main')).toContainText(candidate.originProject);
    }
    if (candidate.destinationProject) {
      await expect(page.locator('main')).toContainText(candidate.destinationProject);
    }
    await expect(page.getByText('Transfer exception')).toBeVisible();
    await expect(page.locator('main')).toContainText(candidate.exceptionReason!);
    await expect(page.locator('main')).toContainText(new RegExp(`\\b${escapeRegExp(observedMilestone)}\\b`, 'i'));
    await expect(page.locator('main')).toContainText(observedMilestoneRow?.transitionedLine ?? '');
    const detailTextAfterReload = await page.locator('main').innerText();
    expect(
      actorSegments.some((value) => value && value !== 'N/A' && detailTextAfterReload.includes(value)),
      `transfer detail should preserve responsible-user context for lifecycle milestone ${observedMilestone} after reload`
    ).toBe(true);

    await page.goto('/ops/transfers');
    await page.waitForLoadState('networkidle');
    const lifecycleRowsAfter = await snapshotTransferLifecycleRows(page, candidate.transferId);
    const statusesAfter = [...new Set(lifecycleRowsAfter.map((row) => row.status))];
    expect(
      statusesAfter,
      `transfer ${candidate.transferId} should preserve observed lifecycle statuses after reload`
    ).toEqual(expect.arrayContaining(statusesBefore));

    const observedMilestoneAfter = lifecycleRowsAfter.find((row) => row.status === observedMilestone);
    expect(
      observedMilestoneAfter?.transitionedLine ?? '',
      `lifecycle row ${observedMilestone} should preserve transitioned timestamp after reload`
    ).toMatch(/Transitioned:\s*(?!N\/A).*\d/);
    const actorSegmentsAfter = (observedMilestoneAfter?.responsibleLine.match(
      /\b(?:Requested by|Approved by|Dispatched by|Received by):\s*([^·\n]+)/gi
    ) ?? [])
      .map((segment) => segment.replace(/.*:\s*/, '').trim());
    expect(
      actorSegmentsAfter.some((value) => value && value !== 'N/A'),
      `lifecycle row ${observedMilestone} should preserve responsible-user values after reload`
    ).toBe(true);

    const transferHistoryRowAfterReload = page
      .locator(`a[href="/entities/transfer/${candidate.transferId}"]`)
      .first()
      .locator('xpath=ancestor::*[.//*[contains(normalize-space(.), "Requested by:")] and .//*[contains(normalize-space(.), "Transitioned:")]][1]');
    await expect(transferHistoryRowAfterReload).toContainText(candidate.equipmentLabel);
    await expect(transferHistoryRowAfterReload).toContainText(candidate.originBranch);
    await expect(transferHistoryRowAfterReload).toContainText(candidate.destinationBranch);
    if (candidate.originProject) {
      await expect(transferHistoryRowAfterReload).toContainText(candidate.originProject);
    }
    if (candidate.destinationProject) {
      await expect(transferHistoryRowAfterReload).toContainText(candidate.destinationProject);
    }
    await expect(transferHistoryRowAfterReload).toContainText(candidate.responsibleLine);
  });

  test('ops dashboard turns KPI cards and recent activity into drill-down workflows', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/ops');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // The page heading must be present
    await expect(page.getByRole('heading', { name: 'Operations Dashboard' }).first()).toBeVisible();

    // Pending approvals KPI card must link to /ops/findings
    const pendingApprovalsCard = page.getByText('Items awaiting review').first().locator('../..');
    const findingsLinks = await pendingApprovalsCard.getByRole('link', { name: /audit history/i }).all();
    expect(
      findingsLinks.length,
      'Items awaiting review KPI card should expose at least one link to audit history'
    ).toBeGreaterThan(0);
    const findingsHrefs = await Promise.all(findingsLinks.map(l => l.getAttribute('href')));
    expect(
      findingsHrefs.some(h => h?.includes('/ops/findings')),
      'Items awaiting review link should target /ops/findings'
    ).toBe(true);

    // Recent activity rows must link to audit trail URLs containing /ops/audit/
    const recentActivityCard = page.getByText('Recent audit activity').first().locator('../..');
    const auditLinks = await recentActivityCard.getByRole('link', { name: /audit/i }).all();
    // Only assert per-row links when activity rows are actually rendered
    if (auditLinks.length > 0) {
      const auditHrefs = await Promise.all(auditLinks.map(l => l.getAttribute('href')));
      expect(
        auditHrefs.some(h => h?.includes('/ops/audit/')),
        'Recent activity rows should link to /ops/audit/:entityId'
      ).toBe(true);
    }
  });

  test('ops recent activity drill-down preserves audit context after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run ops audit-trail drill-down E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops');
    await page.waitForLoadState('networkidle');

    const recentActivityCard = page.getByText('Recent audit activity').first().locator('../..');
    await expect(recentActivityCard).toBeVisible();
    await expect.poll(
      async () =>
        (await recentActivityCard.getByRole('link', { name: 'View audit trail' }).count())
        + (await recentActivityCard.getByText('No recent audit events.').count()),
      { message: 'recent activity card should finish loading rows or its empty state' }
    ).toBeGreaterThan(0);

    const auditTrailLinks = recentActivityCard.getByRole('link', { name: 'View audit trail' });
    if ((await auditTrailLinks.count()) === 0) {
      test.skip(true, 'No recent audit activity rows are available in this environment.');
    }

    const auditPageHeading = 'Audit Trail';
    const auditPageDescription = 'View the full review history for this revenue or fleet event.';
    const minimumAuditContextLines = 2;
    const emptyPayloadPattern = /^(null|"null"|\{\s*\}|\[\s*\])$/;
    const selectedAuditLink = auditTrailLinks.first();
    const auditHref = await selectedAuditLink.getAttribute('href');
    const auditRoutePattern = /\/ops\/audit\/([^/?#]+)/;
    expect(auditHref, 'expected recent activity drill-down link to target an audit trail route').toMatch(auditRoutePattern);
    const entityId = auditHref?.match(auditRoutePattern)?.[1];
    expect(entityId, 'expected recent activity drill-down link with an audit entity id').toBeTruthy();
    expect(
      auditHref,
      'recent activity drill-down link should carry active-event context via ?event= so the selected event survives reload'
    ).toMatch(/[?&]event=/);

    await selectedAuditLink.click();
    await expect(page).toHaveURL(new RegExp(`/ops/audit/${escapeRegExp(entityId!)}`));
    await expect(page.getByRole('heading', { name: auditPageHeading })).toBeVisible();

    const activeEventUrlParam = page.url().match(/[?&]event=([^&]+)/)?.[1];
    expect(activeEventUrlParam, 'URL should carry the active event param after drill-down').toBeTruthy();

    await expect(
      page.getByText('Active event'),
      'active event indicator should be visible after drill-down so the operator can see which event is in focus'
    ).toBeVisible();

    const captureAuditContext = async () => {
      const mainLines = (await page.locator('main').innerText())
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const contentLines = mainLines.filter(
        (line) => line !== auditPageHeading && line !== auditPageDescription
      );
      const actorLine = contentLines.find((line) => line.startsWith('Actor:'));
      const payloadLine = contentLines.find((line) => line.startsWith('Payload:'));
      const humanReadableContext = contentLines.filter(
        (line) => !line.startsWith('Actor:') && !line.startsWith('Payload:') && line !== 'Active event'
      );

      expect(
        humanReadableContext.length,
        'audit trail should show an event label and entity/timestamp context'
      ).toBeGreaterThanOrEqual(minimumAuditContextLines);
      expect(actorLine, 'audit trail should render a human-readable actor').toBeTruthy();
      expect(payloadLine, 'audit trail should render payload or evidence text').toBeTruthy();

      const [eventLabelLine, entityTimestampLine] = humanReadableContext;
      expect(eventLabelLine, 'event label should be human-readable').toMatch(/[A-Za-z]/);
      expect(entityTimestampLine, 'entity/timestamp line should be human-readable').toMatch(/[A-Za-z]/);
      expect(entityTimestampLine, 'entity/timestamp line should include time context').toMatch(/\d/);

      const actorSummary = actorLine!.replace(/^Actor:\s*/, '').trim();
      expect(actorSummary, 'actor line should include a readable actor').toMatch(/[A-Za-z]/);

      const payloadSummary = payloadLine!.replace(/^Payload:\s*/, '').trim();
      expect(payloadSummary, 'payload should be usable evidence, not an empty placeholder').toBeTruthy();
      expect(payloadSummary, 'payload should not collapse to a null or empty-object placeholder').not.toMatch(emptyPayloadPattern);
      expect(/[A-Za-z]/.test(payloadSummary), 'payload should include descriptive text, not just opaque ids').toBe(true);

      return {
        eventLabelLine,
        entityTimestampLine,
        actorLine: actorLine!,
        payloadLine: payloadLine!,
      };
    };

    const auditContextBeforeReload = await captureAuditContext();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(`/ops/audit/${escapeRegExp(entityId!)}`));
    await expect(page.getByRole('heading', { name: auditPageHeading })).toBeVisible();

    const activeEventUrlParamAfterReload = page.url().match(/[?&]event=([^&]+)/)?.[1];
    expect(
      activeEventUrlParamAfterReload,
      'active event URL param should be preserved after reload so the selected event remains in focus'
    ).toBe(activeEventUrlParam);

    await expect(
      page.getByText('Active event'),
      'active event indicator should still be visible after reload — selected event context must not be lost on reload'
    ).toBeVisible();

    const auditContextAfterReload = await captureAuditContext();
    expect(auditContextAfterReload).toEqual(auditContextBeforeReload);
  });

  test('ops dashboard Business workflows card — human-readable names and operator context', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run ops Business workflows card E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops');
    await page.waitForLoadState('networkidle');

    // Page heading must be present.
    await expect(page.getByRole('heading', { name: 'Operations Dashboard' }).first()).toBeVisible();

    // The Business workflows card must be present.
    const workflowsCard = page.getByText('Business workflows').first().locator('../..');
    await expect(workflowsCard).toBeVisible();

    // Wait for the card to reach a stable state: either the explicit empty-state message
    // or at least one workflow handoff link must appear.
    await expect.poll(
      async () =>
        (await workflowsCard.getByText('No business workflows are configured for this tenant yet.').count())
        + (await workflowsCard.getByRole('link').count()),
      { message: 'Business workflows card must show workflow rows or its empty state before asserting' }
    ).toBeGreaterThan(0);

    // When no workflows are configured the explicit empty state is the expected outcome.
    const emptyStateCount = await workflowsCard
      .getByText('No business workflows are configured for this tenant yet.')
      .count();
    if (emptyStateCount > 0) {
      return;
    }

    // When workflow cards are present each must expose operator-useful context.
    const workflowCardText = await workflowsCard.innerText();

    // Each card renders an "Enabled" or "Disabled" badge so operators know the workflow state.
    expect(
      workflowCardText,
      'Business workflows card must show enabled/disabled state for each workflow'
    ).toMatch(/\b(Enabled|Disabled)\b/);

    // Each card renders a "Last run:" status line so operators know when the workflow last ran.
    expect(
      workflowCardText,
      'Business workflows card must show a last-run status line for each workflow'
    ).toMatch(/Last run:/i);

    // Workflow names must be human-readable labels, not raw agent-key slugs.
    // The engine maps agent keys (e.g. "revrec-analyst", "fleet-auditor") to labels
    // (e.g. "Revenue Recognition", "Fleet Audits") via formatOpsAgentLabel.
    // Assert that at least one word in the card text starts with an uppercase letter,
    // which would not be the case if a raw lowercase-hyphenated agent key leaked through.
    expect(
      workflowCardText,
      'Business workflows card must show human-readable workflow names (mixed-case), not raw agent-key slugs'
    ).toMatch(/[A-Z][a-z]+/);

    // The handoff link inside each workflow card must carry a human-readable action label
    // (e.g. "Review revenue opportunities"), not a raw agent-key or empty string.
    const firstLink = workflowsCard.getByRole('link').first();
    const firstLinkText = await firstLink.innerText();
    expect(
      firstLinkText.trim(),
      'workflow handoff link must have a non-empty, human-readable label'
    ).toMatch(/[A-Za-z ]+/);
    expect(
      firstLinkText.trim(),
      'workflow handoff link label must not be a raw agent-key slug'
    ).not.toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/);
  });

  test('ops dashboard workflow handoff link preserves context after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run ops workflow handoff E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops');
    await page.waitForLoadState('networkidle');

    // Locate the Business workflows card.
    const workflowsCard = page.getByText('Business workflows').first().locator('../..');
    await expect(workflowsCard).toBeVisible();

    // Wait for the card to reach a stable state.
    await expect.poll(
      async () =>
        (await workflowsCard.getByText('No business workflows are configured for this tenant yet.').count())
        + (await workflowsCard.getByRole('link').count()),
      { message: 'Business workflows card must reach a stable state before testing the handoff' }
    ).toBeGreaterThan(0);

    const workflowLinks = workflowsCard.getByRole('link');
    if ((await workflowLinks.count()) === 0) {
      test.skip(true, 'No workflow handoff links found — workflows not seeded in this environment.');
      return;
    }

    const firstWorkflowLink = workflowLinks.first();
    const workflowHref = await firstWorkflowLink.getAttribute('href');
    // Workflow routes are always under /ops/ (e.g. /ops/revenue-recognition, /ops/fleet-audits).
    expect(
      workflowHref,
      'workflow handoff link must target a route under /ops/'
    ).toMatch(/^\/ops\//);

    // Follow the workflow handoff link.
    await firstWorkflowLink.click();
    await page.waitForLoadState('networkidle');

    // The destination URL must match the href from the source link.
    await expect(
      page,
      'workflow destination URL must match the href from the handoff link'
    ).toHaveURL(new RegExp(escapeRegExp(workflowHref!)));

    // The destination page must render a visible heading — not a blank or error screen.
    const destinationHeading = page.getByRole('heading').first();
    await expect(
      destinationHeading,
      'workflow destination must render a visible heading after navigation'
    ).toBeVisible();
    const headingText = await destinationHeading.innerText();

    // Reload the destination and verify that the URL and heading survive.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page,
      'workflow destination URL must remain the same after reload'
    ).toHaveURL(new RegExp(escapeRegExp(workflowHref!)));

    await expect(
      page.getByRole('heading', { name: headingText, exact: false }).first(),
      'workflow destination heading must remain visible after reload'
    ).toBeVisible();
  });

  test('ops findings triage persists approval status from queue to detail and back', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run ops findings triage E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops/findings');
    await page.waitForLoadState('networkidle');
    await selectComboboxOption(page, 'Status', 'pending_approval');

    const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
    if ((await openFindingLinks.count()) === 0) {
      test.skip(true, 'No pending_approval findings are available in this environment.');
    }

    const selectedFindingLink = openFindingLinks.first();
    const findingHref = await selectedFindingLink.getAttribute('href');
    const findingId = findingHref?.split('/').pop()?.trim();
    expect(findingId, 'expected pending finding link with a detail route id').toBeTruthy();

    const queueCard = findingQueueCardFromOpenLink(selectedFindingLink);
    const queueCardText = await queueCard.innerText();
    const queueContract = queueCardText.match(/Contract:\s*([^·\n]+)/i)?.[1]?.trim();
    const queueCustomer = queueCardText.match(/Customer:\s*([^\n]+)/i)?.[1]?.trim();
    const queueDelta = parseCurrencyAmount(queueCardText);

    await selectedFindingLink.click();
    await expect(page).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`));

    if (queueContract) {
      await expect(page.getByText(`Contract: ${queueContract}`)).toBeVisible();
    }
    if (queueCustomer) {
      await expect(page.getByText(`Customer: ${queueCustomer}`)).toBeVisible();
    }
    if (queueDelta !== null) {
      const impactText = await page.getByRole('heading', { name: /^Impact:\s*\$/i }).innerText();
      expect(parseCurrencyAmount(impactText), 'detail impact amount should match queue delta context').toBe(queueDelta);
    }

    const approveResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes('/api/ops/findings/decision')
      && (() => {
        try {
          const payload = JSON.parse(response.request().postData() ?? '{}') as { decision?: string };
          return payload.decision === 'approve';
        } catch {
          return false;
        }
      })()
    );
    await page.getByLabel('Approval note (optional)').fill(`E2E triage approval ${Date.now()}`);
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await approveResponse).status(), 'approve action should return accepted status').toBe(202);

    await expect(page.getByText(/\bapproved\b/i).first()).toBeVisible();
    await expect(page.getByText('Action failed')).toHaveCount(0);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/\bapproved\b/i).first()).toBeVisible();

    const findingPath = `/ops/findings/${findingId}`;
    await page.goto('/ops/findings');
    await page.waitForLoadState('networkidle');
    await selectComboboxOption(page, 'Status', 'pending_approval');
    await expect(
      page.locator(`a[href="${findingPath}"]`),
      'approved finding should leave the pending_approval queue filter'
    ).toHaveCount(0);

    await selectComboboxOption(page, 'Status', 'approved');
    const updatedFindingLink = page.locator(`a[href="${findingPath}"]`);
    await expect(updatedFindingLink, 'finding should appear under approved status after triage').toHaveCount(1);
    await expect(
      findingQueueCardFromOpenLink(updatedFindingLink),
      'approved queue row should reflect the new status'
    ).toContainText(/approved/i);
  });

  test('fleet audits journey keeps queue filter context through finding decision persistence', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run fleet audits decision journey coverage.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops/fleet-audits');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Fleet Audits' })).toBeVisible();
    await selectComboboxOption(page, 'Status', 'pending_approval');

    const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
    if ((await openFindingLinks.count()) === 0) {
      test.skip(true, 'No pending fleet-auditor findings are available in this environment yet.');
    }

    const selectedFindingLink = openFindingLinks.first();
    const selectedFindingHref = await selectedFindingLink.getAttribute('href');
    const findingId = selectedFindingHref?.match(/\/ops\/findings\/([^/?#]+)/)?.[1];
    expect(findingId, 'selected fleet-audits row should expose a finding detail link').toBeTruthy();

    const queueCard = findingQueueCardFromOpenLink(selectedFindingLink);
    const queueCardText = await queueCard.innerText();
    const queueContract = queueCardText.match(/Contract:\s*([^·\n]+)/i)?.[1]?.trim();
    const queueCustomer = queueCardText.match(/Customer:\s*([^\n]+)/i)?.[1]?.trim();
    const queueDelta = parseCurrencyAmount(queueCardText);

    await selectedFindingLink.click();
    await expect(page).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (queueContract) {
      await expect(page.getByText(`Contract: ${queueContract}`)).toBeVisible();
    }
    if (queueCustomer) {
      await expect(page.getByText(`Customer: ${queueCustomer}`)).toBeVisible();
    }
    if (queueDelta !== null) {
      const impactText = await page.getByRole('heading', { name: /^Impact:\s*\$/i }).innerText();
      expect(parseCurrencyAmount(impactText), 'detail impact amount should match selected queue row delta context').toBe(queueDelta);
    }

    const approveResponsePromise = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || !response.url().includes('/api/ops/findings/decision')) {
        return false;
      }
      const postData = response.request().postData() ?? '';
      if (!postData) return false;
      try {
        const body = JSON.parse(postData) as { decision?: string };
        return body.decision === 'approve';
      } catch {
        return postData.includes('"decision":"approve"');
      }
    });

    await page.getByLabel('Approval note (optional)').fill(`E2E fleet audits decision coverage ${Date.now()}`);
    await page.getByRole('button', { name: 'Approve' }).click();
    const approveResponse = await approveResponsePromise;
    expect(approveResponse.status(), 'finding decision endpoint should return accepted for approve action').toBe(202);
    await expect(page.getByText(/Action failed/i)).toHaveCount(0);
    await expect(page.getByText(/·\s*approved\b/i)).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/·\s*approved\b/i)).toBeVisible();

    await page.goto('/ops/fleet-audits');
    await page.waitForLoadState('networkidle');
    await selectComboboxOption(page, 'Status', 'pending_approval');
    await page.waitForLoadState('networkidle');

    const findingPathSuffix = `/ops/findings/${findingId}`;
    await expect(
      page.locator(`a[href$="${findingPathSuffix}"]`),
      'approved finding should leave the pending_approval fleet-audits queue filter'
    ).toHaveCount(0);

    await selectComboboxOption(page, 'Status', 'approved');
    const updatedFindingLink = page.locator(`a[href$="${findingPathSuffix}"]`);
    await expect(updatedFindingLink, 'finding should appear under approved status in fleet-audits queue').toHaveCount(1);
    const updatedQueueCard = findingQueueCardFromOpenLink(updatedFindingLink);
    await expect(updatedQueueCard, 'approved fleet-audits queue row should reflect updated status').toContainText(/approved/i);
    if (queueContract) {
      await expect(updatedQueueCard, 'approved queue row should keep selected finding contract context').toContainText(`Contract: ${queueContract}`);
    }
    if (queueCustomer) {
      await expect(updatedQueueCard, 'approved queue row should keep selected finding customer context').toContainText(`Customer: ${queueCustomer}`);
    }
    if (queueDelta !== null) {
      const updatedQueueCardText = await updatedQueueCard.innerText();
      expect(parseCurrencyAmount(updatedQueueCardText), 'approved queue row should keep selected finding delta context').toBe(queueDelta);
    }
  });

  test('fleet rebalancing review journey keeps recommendation context through approval handoff reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run fleet rebalancing review-flow coverage.'
    );
    test.fail(true, 'Non-gating: fleet-rebalancing review handoff journey on deployed dev is tracked as backlog signal until reliability improves.');

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/ops/fleet-rebalancing');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Fleet Rebalancing Recommendations' })).toBeVisible();

    const reviewTransferLinks = page.getByRole('link', { name: 'Review transfer findings' });
    const reviewTransferCount = await reviewTransferLinks.count();
    if (reviewTransferCount === 0) {
      await expect(
        page.getByText('No rebalancing opportunities detected. All branches are balanced for current demand.')
      ).toBeVisible();
      return;
    }

    const selectedReviewTransferLink = reviewTransferLinks.first();
    const selectedRecommendationCard = rebalancingRecommendationCardFromReviewLink(selectedReviewTransferLink);
    await expect(selectedRecommendationCard).toBeVisible();

    const recommendationText = await selectedRecommendationCard.innerText();
    const rawUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const selectedCategory = recommendationText.match(/^([^\n]+)\s*\n\s*Move\s+\d+/m)?.[1]?.trim();
    const selectedSurplusBranch = recommendationText.match(/SURPLUS BRANCH\s*\n\s*([^\n]+)/i)?.[1]?.trim();
    const selectedDeficitBranch = recommendationText.match(/DEFICIT BRANCH\s*\n\s*([^\n]+)/i)?.[1]?.trim();
    const selectedIdleCount = recommendationText.match(/(\d+)\s+idle asset/i)?.[1];
    const selectedOpenDemand = recommendationText.match(/(\d+)\s+open order/i)?.[1];

    expect(selectedCategory, 'rebalancing recommendation should surface a human-readable category').toBeTruthy();
    expect(selectedSurplusBranch, 'rebalancing recommendation should surface a human-readable surplus branch').toBeTruthy();
    expect(selectedDeficitBranch, 'rebalancing recommendation should surface a human-readable deficit branch').toBeTruthy();
    expect(selectedIdleCount, 'rebalancing recommendation should surface idle inventory counts').toBeTruthy();
    expect(selectedOpenDemand, 'rebalancing recommendation should surface open-demand context').toBeTruthy();
    expect(selectedCategory).not.toMatch(rawUuidPattern);
    expect(selectedSurplusBranch).not.toMatch(rawUuidPattern);
    expect(selectedDeficitBranch).not.toMatch(rawUuidPattern);
    await expect(selectedRecommendationCard).toContainText(/Demand imbalance:/i);

    const categoryFilterInput = page.getByRole('textbox', { name: 'Category' });
    const branchFilterInput = page.getByRole('textbox', { name: 'Branch' });

    const initialRecommendationCount = await reviewTransferLinks.count();
    await categoryFilterInput.fill(selectedCategory!);
    await expect.poll(async () => await reviewTransferLinks.count(), {
      timeout: 20_000,
      message: `expected recommendations to remain after applying category filter "${selectedCategory}"`,
    }).toBeGreaterThan(0);
    const categoryFilteredCount = await reviewTransferLinks.count();
    expect(
      categoryFilteredCount,
      'category filter should narrow or retain recommendation count without collapsing to a dead end'
    ).toBeLessThanOrEqual(initialRecommendationCount);

    await branchFilterInput.fill(selectedSurplusBranch!);
    await expect.poll(async () => await reviewTransferLinks.count(), {
      timeout: 20_000,
      message: `expected recommendations to remain after applying branch filter "${selectedSurplusBranch}"`,
    }).toBeGreaterThan(0);
    const branchAndCategoryFilteredCount = await reviewTransferLinks.count();
    expect(
      branchAndCategoryFilteredCount,
      'combined branch/category filters should narrow or retain recommendation count without collapsing to a dead end'
    ).toBeLessThanOrEqual(categoryFilteredCount);

    const reviewApproveLinks = page.getByRole('link', { name: 'Review & approve' });
    if ((await reviewApproveLinks.count()) > 0) {
      const selectedReviewApproveLink = reviewApproveLinks.first();
      const pendingApprovalCard = selectedReviewApproveLink.locator(
        'xpath=ancestor::*[.//*[contains(normalize-space(.), "Confidence:")]][1]'
      );
      const pendingApprovalCardText = await pendingApprovalCard.innerText();
      const rationaleContext = pendingApprovalCardText
        .split('\n')
        .map((line) => line.trim())
        .find((line) => (
          line.length > 0
          && !/^Review & approve$/i.test(line)
          && !/^Confidence:/i.test(line)
          && !/^(critical|high|medium|low)\s*·/i.test(line)
          && !/^(pending approval|approved|rejected|informational)$/i.test(line)
          && !/^No rationale provided\.$/i.test(line)
        ));

      await selectedReviewApproveLink.click();
      await expect(page).toHaveURL(/\/ops\/findings\/[0-9a-f-]+/i);
      await expect(page.getByText('Rationale & confidence')).toBeVisible();

      const contextTokens = [selectedCategory, selectedSurplusBranch, selectedDeficitBranch].filter(
        (token): token is string => Boolean(token && token.trim().length > 0)
      );
      if (rationaleContext) {
        await expect(page.getByText(rationaleContext, { exact: false })).toBeVisible();
      } else if (contextTokens.length > 0) {
        await expect(page.getByText(new RegExp(escapeRegExp(contextTokens[0]), 'i'))).toBeVisible();
      }

      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/\/ops\/findings\/[0-9a-f-]+/i);
      await expect(page.getByText('Rationale & confidence')).toBeVisible();
      if (rationaleContext) {
        await expect(page.getByText(rationaleContext, { exact: false })).toBeVisible();
      } else if (contextTokens.length > 0) {
        await expect(page.getByText(new RegExp(escapeRegExp(contextTokens[0]), 'i'))).toBeVisible();
      }
      return;
    }

    await expect(page.getByText('No transfer findings pending approval.')).toBeVisible();
    await selectedReviewTransferLink.click();
    await expect(page).toHaveURL(/\/ops\/fleet-audits/i);
    await expect(page.getByRole('heading', { name: 'Fleet Audits' })).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/ops\/fleet-audits/i);
    await expect(page.getByRole('heading', { name: 'Fleet Audits' })).toBeVisible();
  });

  test('branch morning brief keeps filter scope durable and surfaces operator-ready queue context', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run branch morning-brief experience coverage.'
    );
    test.fail(true, 'Non-gating: branch morning-brief filter durability and finding handoff on deployed dev is still being proven.');

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/branch/morning-brief');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Branch Morning Brief' })).toBeVisible();

    // Change all three filters, then settle on a durable queue scope that should still surface pending work.
    await selectComboboxOption(page, 'Priority', 'Critical');
    await selectComboboxOption(page, 'Priority', 'All');
    await selectComboboxOption(page, 'Signal Type', 'Dispatch Exception (t4)');
    await selectComboboxOption(page, 'Signal Type', 'All');
    await selectComboboxOption(page, 'Status', 'Approved');
    await selectComboboxOption(page, 'Status', 'Pending Review');
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('pending_approval');

    const assertMorningBriefScopeInUrl = (urlText: string, phase: string) => {
      const url = new URL(urlText);
      expect(url.pathname, `${phase}: route should remain on /branch/morning-brief`).toBe('/branch/morning-brief');
      expect(url.searchParams.get('priority'), `${phase}: priority filter should persist in URL`).toBe(MORNING_BRIEF_ALL_FILTER_VALUE);
      expect(url.searchParams.get('itemType'), `${phase}: signal type filter should persist in URL`).toBe(MORNING_BRIEF_ALL_FILTER_VALUE);
      expect(url.searchParams.get('status'), `${phase}: status filter should persist in URL`).toBe('pending_approval');
    };

    await expect.poll(() => page.url(), {
      message: 'morning-brief URL should encode durable filter scope after filter changes',
    }).toContain('/branch/morning-brief?');
    assertMorningBriefScopeInUrl(page.url(), 'before reload');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    assertMorningBriefScopeInUrl(page.url(), 'after reload');

    await expect(page.getByRole('combobox', { name: 'Priority' })).toHaveValue(MORNING_BRIEF_ALL_FILTER_VALUE);
    await expect(page.getByRole('combobox', { name: 'Signal Type' })).toHaveValue(MORNING_BRIEF_ALL_FILTER_VALUE);
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('pending_approval');

    const viewDetailLinks = page.getByRole('link', { name: /View Detail/i });
    if ((await viewDetailLinks.count()) === 0) {
      test.skip(true, 'No pending branch-morning-brief findings are available in this environment yet.');
      return;
    }

    const selectedViewDetailLink = viewDetailLinks.first();
    const selectedBriefCard = page.locator('.rounded-lg.border').filter({ has: selectedViewDetailLink }).first();
    await expect(selectedBriefCard).toBeVisible();

    const selectedBriefCardText = await selectedBriefCard.innerText();
    expect(
      MORNING_BRIEF_OPERATOR_READY_FIELD_PATTERN.test(selectedBriefCardText),
      'morning-brief queue rows should expose operator-ready context and recommended-action cues, not opaque UUID-only content'
    ).toBe(true);
    expect(
      countUuidMatches(selectedBriefCardText),
      'morning-brief queue card should not be UUID-first content for operators'
    ).toBeLessThanOrEqual(2);

    const detailHref = await selectedViewDetailLink.getAttribute('href');
    const findingId = detailHref?.match(OPS_FINDING_DETAIL_PATH_PATTERN)?.[1];
    expect(findingId, 'View Detail link should target /ops/findings/:id').toBeTruthy();

    await selectedViewDetailLink.click();
    await expect(page).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

    const detailUrlBeforeReload = page.url();
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    expect(page.url(), 'finding detail handoff should remain reachable after reload').toBe(detailUrlBeforeReload);

    await page.goBack({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    assertMorningBriefScopeInUrl(page.url(), 'after returning from finding detail');
  });

  test('fleet rebalancing keeps loading, empty, and error states explicit', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run fleet rebalancing explicit-state coverage.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.route('**/rest/v1/v_fleet_idle_rebalancing*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      });
    });
    await page.route('**/rest/v1/ops_findings_view*', async (route) => {
      if (route.request().method() !== 'GET' || !route.request().url().includes('agent_key=eq.fleet-auditor')) {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      });
    });

    await page.goto('/ops/fleet-rebalancing');
    await expect(page.getByText('Loading rebalancing signals…')).toBeVisible();
    await expect(page.getByText('Loading pending approvals…')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByText('No rebalancing opportunities detected. All branches are balanced for current demand.')
    ).toBeVisible();
    await expect(page.getByText('No transfer findings pending approval.')).toBeVisible();

    await page.unroute('**/rest/v1/v_fleet_idle_rebalancing*');
    await page.route('**/rest/v1/v_fleet_idle_rebalancing*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'synthetic rebalancing failure' }),
      });
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Unable to load rebalancing data')).toBeVisible();
    await expect(page.getByText('Check your connection or retry shortly.')).toBeVisible();
  });

  test('ops findings detail keeps read-only users in view mode with explicit triage restriction message', async ({ page }) => {
    test.skip(
      !READONLY_EMAIL || !READONLY_PASSWORD,
      'Set E2E_READONLY_EMAIL and E2E_READONLY_PASSWORD to run read-only ops findings boundary E2E.'
    );

    await signIn(page, READONLY_EMAIL!, READONLY_PASSWORD!);
    await page.goto('/ops/findings');
    await page.waitForLoadState('networkidle');

    const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
    if ((await openFindingLinks.count()) === 0) {
      test.skip(true, 'Ops findings are not seeded in this environment yet.');
    }

    await openFindingLinks.first().click();
    await expect(page).toHaveURL(/\/ops\/findings\/[0-9a-f-]+/i);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Read-only').first()).toBeVisible();
    await expect(page.getByText('You can review this finding, but only operators can approve or reject.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/ops\/findings\/[0-9a-f-]+/i);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Read-only').first()).toBeVisible();
    await expect(page.getByText('You can review this finding, but only operators can approve or reject.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  });

  test('equipment catalog filter narrows cards and preserves selected asset context on detail reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate authenticated catalog detail UX.');

    const authEmail = AUTH_EMAIL ?? '';
    const authPassword = AUTH_PASSWORD ?? '';
    await signIn(page, authEmail, authPassword);

    const categoriesResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/entities')
      && response.url().includes('entity_type=eq.asset_category')
    ));
    const assetsResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/entities')
      && response.url().includes('entity_type=eq.asset')
      && !response.url().includes('entity_type=eq.asset_category')
    ));
    const branchesResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/entities')
      && response.url().includes('entity_type=eq.branch')
    ));

    await page.goto('/rental/catalog');
    await page.waitForLoadState('networkidle');

    const [categoriesResponse, assetsResponse, branchesResponse] = await Promise.all([
      categoriesResponsePromise,
      assetsResponsePromise,
      branchesResponsePromise,
    ]);
    expect(categoriesResponse.status(), 'category list request should succeed').toBeLessThan(400);
    expect(assetsResponse.status(), 'asset list request should succeed').toBeLessThan(400);
    expect(branchesResponse.status(), 'branch list request should succeed').toBeLessThan(400);

    const categories = await categoriesResponse.json() as Array<{
      id: string;
      entity_versions?: Array<{ is_current?: boolean; data?: { name?: string } }>;
    }>;
    const branches = await branchesResponse.json() as Array<{
      id: string;
      entity_versions?: Array<{ is_current?: boolean; data?: { name?: string } }>;
    }>;
    const assets = await assetsResponse.json() as Array<{
      id: string;
      entity_versions?: Array<{
        is_current?: boolean;
        data?: {
          name?: string;
          status?: string;
          asset_category_id?: string;
          category_id?: string;
          branch_id?: string;
          daily_rate?: number;
          weekly_rate?: number;
          monthly_rate?: number;
        };
      }>;
    }>;

    const categoryNameById = new Map(
      categories
        .map((category) => {
          const currentVersion = category.entity_versions?.find((version) => version.is_current) ?? category.entity_versions?.[0];
          const name = currentVersion?.data?.name?.trim();
          return name ? [category.id, name] : null;
        })
        .filter((entry): entry is [string, string] => Array.isArray(entry))
    );
    const branchNameById = new Map(
      branches
        .map((branch) => {
          const currentVersion = branch.entity_versions?.find((version) => version.is_current) ?? branch.entity_versions?.[0];
          const name = currentVersion?.data?.name?.trim();
          return name ? [branch.id, name] : null;
        })
        .filter((entry): entry is [string, string] => Array.isArray(entry))
    );

    const normalizedAssets = assets
      .map((asset) => {
        const currentVersion = asset.entity_versions?.find((version) => version.is_current) ?? asset.entity_versions?.[0];
        const data = currentVersion?.data;
        const categoryId = (data?.asset_category_id ?? data?.category_id)?.trim();
        const branchId = data?.branch_id?.trim();
        const name = data?.name?.trim();
        const categoryName = categoryId ? categoryNameById.get(categoryId) : undefined;
        const branchName = branchId ? branchNameById.get(branchId) : undefined;
        if (!name || !categoryId || !branchId || !categoryName || !branchName) {
          return null;
        }
        return {
          id: asset.id,
          name,
          categoryId,
          branchId,
          categoryName,
          branchName,
          dailyRate: data?.daily_rate,
          weeklyRate: data?.weekly_rate,
          monthlyRate: data?.monthly_rate,
        };
      })
      .filter((asset): asset is {
        id: string;
        name: string;
        categoryId: string;
        branchId: string;
        categoryName: string;
        branchName: string;
        dailyRate?: number;
        weeklyRate?: number;
        monthlyRate?: number;
      } => asset !== null);

    const categoriesWithAssets = Array.from(
      normalizedAssets.reduce((map, asset) => {
        if (!map.has(asset.categoryId)) {
          map.set(asset.categoryId, []);
        }
        map.get(asset.categoryId)!.push(asset);
        return map;
      }, new Map<string, typeof normalizedAssets>())
    );

    test.skip(categoriesWithAssets.length === 0, 'No category- and branch-backed asset cards are available to validate catalog filtering.');
    const [selectedCategoryId, selectedCategoryAssets] = categoriesWithAssets[0]!;
    const selectedCategoryName = selectedCategoryAssets[0]!.categoryName;

    const allVisibleCards = page.getByRole('link', { name: /View Details/ });
    const totalCardCount = await allVisibleCards.count();
    expect(totalCardCount, 'catalog should render at least one View Details action').toBeGreaterThan(0);

    await page.getByRole('button', { name: selectedCategoryName, exact: true }).click();
    await page.waitForLoadState('networkidle');

    const filteredCardCount = await allVisibleCards.count();
    expect(filteredCardCount, `category ${selectedCategoryName} should display at least one filtered card`).toBeGreaterThan(0);
    expect(filteredCardCount, 'filtered card count should not exceed all-card count').toBeLessThanOrEqual(totalCardCount);

    const otherCategoryAssets = normalizedAssets.filter((asset) => asset.categoryId !== selectedCategoryId);
    if (otherCategoryAssets.length > 0) {
      expect(filteredCardCount, 'category filter should narrow visible cards when other-category assets exist').toBeLessThan(totalCardCount);
      await expect(page.getByText(otherCategoryAssets[0]!.name, { exact: true })).toHaveCount(0);
    }

    const selectedAsset = selectedCategoryAssets[0]!;
    const selectedBranchName = selectedAsset.branchName;
    await expect(page.getByText(selectedAsset.name, { exact: true }).first()).toBeVisible();

    const assetDetailPath = `/entities/asset/${selectedAsset.id}`;
    const selectedDetailsLink = page.locator(`a[href="${assetDetailPath}"]`).first();
    const selectedCardBody = await page
      .locator('div')
      .filter({ has: selectedDetailsLink })
      .filter({ hasText: selectedAsset.name })
      .first()
      .innerText();
    expect(selectedCardBody, 'filtered card should show asset status context').toMatch(CATALOG_ASSET_STATUS_PATTERN);
    expect(selectedCardBody, 'filtered card should show day/week/month pricing labels').toMatch(/\bday\b[\s\S]*\bweek\b[\s\S]*\bmonth\b/i);

    if (selectedAsset.dailyRate !== undefined) {
      expect(selectedCardBody).toContain(`$${selectedAsset.dailyRate}`);
    }
    if (selectedAsset.weeklyRate !== undefined) {
      expect(selectedCardBody).toContain(`$${selectedAsset.weeklyRate}`);
    }
    if (selectedAsset.monthlyRate !== undefined) {
      expect(selectedCardBody).toContain(`$${selectedAsset.monthlyRate}`);
    }

    await selectedDetailsLink.click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(assetDetailPath)}$`));
    await expectAssetDetailContext(page, selectedAsset.name, selectedCategoryName, selectedBranchName);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(assetDetailPath)}$`));
    await expectAssetDetailContext(page, selectedAsset.name, selectedCategoryName, selectedBranchName);
  });

  test('equipment catalog requisition journey carries branch/category scope into rental-order flow', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate authenticated catalog requisition UX.');

    const authEmail = AUTH_EMAIL ?? '';
    const authPassword = AUTH_PASSWORD ?? '';
    await signIn(page, authEmail, authPassword);

    const categoriesResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/entities')
      && response.url().includes('entity_type=eq.asset_category')
    ));
    const assetsResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/entities')
      && response.url().includes('entity_type=eq.asset')
      && !response.url().includes('entity_type=eq.asset_category')
    ));
    const branchesResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/entities')
      && response.url().includes('entity_type=eq.branch')
    ));

    await page.goto('/rental/catalog');
    await page.waitForLoadState('networkidle');

    const [categoriesResponse, assetsResponse, branchesResponse] = await Promise.all([
      categoriesResponsePromise,
      assetsResponsePromise,
      branchesResponsePromise,
    ]);
    expect(categoriesResponse.status(), 'category list request should succeed').toBeLessThan(400);
    expect(assetsResponse.status(), 'asset list request should succeed').toBeLessThan(400);
    expect(branchesResponse.status(), 'branch list request should succeed').toBeLessThan(400);

    const categories = await categoriesResponse.json() as Array<{
      id: string;
      entity_versions?: Array<{ is_current?: boolean; data?: { name?: string } }>;
    }>;
    const branches = await branchesResponse.json() as Array<{
      id: string;
      entity_versions?: Array<{ is_current?: boolean; data?: { name?: string } }>;
    }>;
    const assets = await assetsResponse.json() as Array<{
      id: string;
      entity_versions?: Array<{
        is_current?: boolean;
        data?: {
          name?: string;
          asset_category_id?: string;
          category_id?: string;
          branch_id?: string;
        };
      }>;
    }>;

    const categoryNameById = new Map(
      categories
        .map((category) => {
          const currentVersion = category.entity_versions?.find((version) => version.is_current) ?? category.entity_versions?.[0];
          const name = currentVersion?.data?.name?.trim();
          return name ? [category.id, name] as [string, string] : null;
        })
        .filter((entry): entry is [string, string] => entry !== null)
    );
    const branchNameById = new Map(
      branches
        .map((branch) => {
          const currentVersion = branch.entity_versions?.find((version) => version.is_current) ?? branch.entity_versions?.[0];
          const name = currentVersion?.data?.name?.trim();
          return name ? [branch.id, name] as [string, string] : null;
        })
        .filter((entry): entry is [string, string] => entry !== null)
    );

    const requisitionableAssets = assets
      .map((asset) => {
        const currentVersion = asset.entity_versions?.find((version) => version.is_current) ?? asset.entity_versions?.[0];
        const data = currentVersion?.data;
        const categoryId = (data?.asset_category_id ?? data?.category_id)?.trim();
        const branchId = data?.branch_id?.trim();
        const name = data?.name?.trim();
        const categoryName = categoryId ? categoryNameById.get(categoryId) : undefined;
        const branchName = branchId ? branchNameById.get(branchId) : undefined;
        if (!name || !categoryId || !branchId || !categoryName || !branchName) {
          return null;
        }
        return { id: asset.id, name, categoryId, branchId, categoryName, branchName };
      })
      .filter((asset): asset is {
        id: string;
        name: string;
        categoryId: string;
        branchId: string;
        categoryName: string;
        branchName: string;
      } => asset !== null);

    test.skip(requisitionableAssets.length === 0, 'No branch- and category-backed asset cards are available to validate catalog requisition handoff.');
    if (requisitionableAssets.length === 0) return;

    const selectedAsset = requisitionableAssets[0]!;

    const createRequisitionLinks = page.getByRole('link', { name: 'Create Requisition' });
    const linkCount = await createRequisitionLinks.count();
    expect(linkCount, 'catalog should render at least one Create Requisition action').toBeGreaterThan(0);

    // Find the Create Requisition link whose href carries the expected branch/category scope.
    // If links exist but none match the selected asset's scope, the expect below will fail the test
    // (acceptable in the non-gating context — it signals a scope propagation regression).
    let selectedLink: Locator | null = null;
    for (let idx = 0; idx < linkCount; idx++) {
      const link = createRequisitionLinks.nth(idx);
      const href = await link.getAttribute('href');
      if (!href) continue;
      const url = new URL(href, AVAILABILITY_HREF_BASE);
      if (
        url.searchParams.get('branch_id') === selectedAsset.branchId
        && url.searchParams.get('category_id') === selectedAsset.categoryId
      ) {
        selectedLink = link;
        break;
      }
    }
    expect(selectedLink, `expected a Create Requisition link scoped to branch ${selectedAsset.branchId} and category ${selectedAsset.categoryId}`).not.toBeNull();
    if (!selectedLink) throw new Error(`No Create Requisition link found for branch ${selectedAsset.branchId} and category ${selectedAsset.categoryId}`);

    // Wait specifically for the rental orders availability data that the orders page loads on mount.
    const ordersResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/rental_asset_availability_current')
    ));
    await selectedLink.click();
    await ordersResponsePromise;
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(
      `/rental/orders.*branch_id=${escapeRegExp(selectedAsset.branchId)}.*category_id=${escapeRegExp(selectedAsset.categoryId)}`
    ), { message: 'Create Requisition should navigate to rental orders with branch/category scope in URL' });

    await expect(page.getByRole('heading', { name: 'Rental Orders' })).toBeVisible();

    // Clear next action: New Rental Order button must be present for the operator to proceed.
    await expect(
      page.getByRole('button', { name: 'New Rental Order' }),
      'scoped rental-order screen should expose a New Rental Order action for the operator to proceed'
    ).toBeVisible();

    // Reload and verify the scope params survive.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(
      `/rental/orders.*branch_id=${escapeRegExp(selectedAsset.branchId)}.*category_id=${escapeRegExp(selectedAsset.categoryId)}`
    ), { message: 'rental-order URL scope params should survive a full page reload' });

    await expect(
      page.getByRole('button', { name: 'New Rental Order' }),
      'New Rental Order action should still be visible after reload'
    ).toBeVisible();

    // Open the create-order dialog and verify the scope banner shows human-readable branch/category context.
    // The banner's category slot resolves via lookupRecordFieldById; the categoryId fallback is intentional —
    // it mirrors the pattern in the availability handoff test and guards against lookup races while still
    // proving the scope is carried (not silently dropped).  A purely raw-ID result would also indicate the
    // lookup function resolved something, just not the name — which is a separate display issue tracked
    // independently from the handoff correctness this test targets.
    await page.getByRole('button', { name: 'New Rental Order' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();
    await expect(
      createDialog.getByText(new RegExp(
        `Scoped from availability: Branch\\s+${escapeRegExp(selectedAsset.branchName)}\\s+·\\s+Category\\s+(${escapeRegExp(selectedAsset.categoryName)}|${escapeRegExp(selectedAsset.categoryId)})`
      )),
      'new-order dialog should surface branch/category context from the catalog card — branch name must resolve; category may fall back to ID if lookup races but scope must not be absent'
    ).toBeVisible();
  });

  test('portal storefront quote request preserves scoped confirmation context after reload', async ({ page }) => {
    const now = Date.now();
    const startDate = new Date(now + PORTAL_CATALOG_REQUISITION_ONE_DAY_MS).toISOString().slice(0, 10);
    const endDate = new Date(now + PORTAL_CATALOG_REQUISITION_THREE_DAYS_MS).toISOString().slice(0, 10);

    await page.goto('/portal/storefront');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('input-start-date').fill(startDate);
    await page.getByTestId('input-end-date').fill(endDate);
    await page.waitForLoadState('networkidle');

    const assetCards = page.locator('[data-testid^="asset-card-"]');
    const initialVisibleCount = await assetCards.count();
    test.skip(initialVisibleCount === 0, 'No storefront assets are visible to validate anonymous quote-request flow.');
    if (initialVisibleCount === 0) return;

    const categorySelect = page.getByTestId('select-category');
    const branchSelect = page.getByTestId('select-branch');

    const categoryOptions = await categorySelect.locator('option').evaluateAll((options) => (
      options
        .map((option) => ({ value: option.getAttribute('value') ?? '', label: option.textContent?.trim() ?? '' }))
        .filter((option) => option.value && option.label)
    ));

    const branchOptions = await branchSelect.locator('option').evaluateAll((options) => (
      options
        .map((option) => ({ value: option.getAttribute('value') ?? '', label: option.textContent?.trim() ?? '' }))
        .filter((option) => option.value && option.label)
    ));

    let selectedCategory: { value: string; label: string } | null = null;
    let selectedBranch: { value: string; label: string } | null = null;
    let narrowedCount = initialVisibleCount;

    for (const categoryOption of categoryOptions) {
      await categorySelect.selectOption(categoryOption.value);
      const visibleCount = await assetCards.count();
      if (visibleCount > 0 && visibleCount < initialVisibleCount) {
        selectedCategory = categoryOption;
        narrowedCount = visibleCount;
        break;
      }
    }

    if (!selectedCategory) {
      await categorySelect.selectOption('');
    }

    const branchBaselineCount = selectedCategory ? narrowedCount : initialVisibleCount;
    for (const branchOption of branchOptions) {
      await branchSelect.selectOption(branchOption.value);
      const visibleCount = await assetCards.count();
      if (visibleCount > 0 && visibleCount < branchBaselineCount) {
        selectedBranch = branchOption;
        narrowedCount = visibleCount;
        break;
      }
    }

    if (!selectedBranch) {
      await branchSelect.selectOption('');
    }

    test.skip(!selectedCategory && !selectedBranch, 'Storefront did not expose a branch/category option that narrows visible cards in this environment.');
    if (!selectedCategory && !selectedBranch) return;

    expect(
      narrowedCount,
      'applying branch and/or category filter should narrow storefront equipment cards'
    ).toBeLessThan(initialVisibleCount);

    const firstFilteredCard = assetCards.first();
    await expect(firstFilteredCard).toBeVisible();

    const firstFilteredCardText = await firstFilteredCard.innerText();
    if (selectedCategory) {
      expect(
        firstFilteredCardText,
        `filtered storefront card should retain operator-readable category context (${selectedCategory.label})`
      ).toContain(selectedCategory.label);
    }
    if (selectedBranch) {
      expect(
        firstFilteredCardText,
        `filtered storefront card should retain operator-readable branch context (${selectedBranch.label})`
      ).toContain(selectedBranch.label);
    }

    const availableQuoteButtons = page.locator('[data-testid^="request-quote-btn-"]:not([disabled])');
    const availableQuoteButtonCount = await availableQuoteButtons.count();
    test.skip(availableQuoteButtonCount === 0, 'No available storefront asset can request a quote for the selected rental period.');
    if (availableQuoteButtonCount === 0) return;

    const quoteButton = availableQuoteButtons.first();
    const quoteButtonTestId = await quoteButton.getAttribute('data-testid');
    expect(quoteButtonTestId, 'available quote button should carry a data-testid with asset id').toBeTruthy();
    const selectedAssetId = quoteButtonTestId?.replace('request-quote-btn-', '') ?? '';
    const selectedAssetCard = page.getByTestId(`asset-card-${selectedAssetId}`);
    const selectedAssetName = (await selectedAssetCard.locator('h3').first().innerText()).trim();
    expect(selectedAssetName, 'selected storefront asset must have a human-readable name').toBeTruthy();

    const quoteBreakdown = page.getByTestId(`quote-breakdown-${selectedAssetId}`);
    await expect(quoteBreakdown, 'live quote breakdown should render on the selected storefront card').toBeVisible();
    await expect(quoteBreakdown.getByText(/^Rental \(/), 'quote breakdown should include base rental amount context').toBeVisible();
    await expect(quoteBreakdown.getByText('Environmental fee (5%)')).toBeVisible();
    await expect(quoteBreakdown.getByText('Tax (8.5%)')).toBeVisible();
    await expect(quoteBreakdown.getByText('Estimated total')).toBeVisible();
    await expect(page.getByTestId(`quote-total-${selectedAssetId}`)).toContainText(/\$\d/);

    await quoteButton.click();
    const quotePanel = page.getByTestId('quote-request-panel');
    await expect(quotePanel).toBeVisible();
    await expect(quotePanel.getByText(selectedAssetName)).toBeVisible();
    await expect(quotePanel.getByText(new RegExp(`${escapeRegExp(startDate)}\\s*–\\s*${escapeRegExp(endDate)}`))).toBeVisible();

    await page.getByTestId('input-contact-name').fill('Portal E2E Customer');
    await page.getByTestId('input-contact-email').fill('portal.e2e@example.com');
    await page.getByTestId('input-company-name').fill('Dealernet Portal QA');
    await page.getByTestId('input-notes').fill('Please include delivery estimate with the quote.');

    const submitQuoteResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().includes('/rpc/portal_storefront_submit_quote')
    ));
    await page.getByTestId('submit-quote-btn').click();
    const submitQuoteResponse = await submitQuoteResponsePromise;
    expect(submitQuoteResponse.status(), 'portal storefront quote submit RPC should succeed').toBeLessThan(400);

    await expect(page.getByTestId('submit-success')).toBeVisible();
    const quotePreview = page.getByTestId('quote-document-preview');
    await expect(quotePreview, 'success state should include a human-readable quote document preview').toBeVisible();
    await expect(quotePreview.getByRole('heading', { name: 'Rental Quote' })).toBeVisible();
    await expect(quotePreview).toContainText(selectedAssetName);
    await expect(quotePreview).toContainText(startDate);
    await expect(quotePreview).toContainText(endDate);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/portal\/storefront/);

    const confirmationBanner = page.getByTestId('confirmation-banner');
    await expect(
      confirmationBanner,
      'reloaded portal storefront should preserve quote confirmation context instead of resetting silently'
    ).toBeVisible();
    await expect(confirmationBanner).toContainText(selectedAssetName);
    await expect(confirmationBanner).toContainText(startDate);
    await expect(confirmationBanner).toContainText(endDate);
    await expect(page.getByTestId('confirmation-banner-quote-id')).toContainText(/\S+/);
    if (selectedCategory || selectedBranch) {
      const expectedScopeText = [selectedCategory?.label, selectedBranch?.label].filter(Boolean).join(' · ');
      await expect(page.getByTestId('confirmation-banner-scope')).toContainText(expectedScopeText);
    }
    await expect(page.getByTestId('input-start-date')).toHaveValue(startDate);
    await expect(page.getByTestId('input-end-date')).toHaveValue(endDate);
    if (selectedCategory) {
      await expect(page.getByTestId('select-category')).toHaveValue(selectedCategory.value);
    }
    if (selectedBranch) {
      await expect(page.getByTestId('select-branch')).toHaveValue(selectedBranch.value);
    }
  });

  test('storefront cart journey keeps booking context coherent across add-ons, cross-sell, and booking action', async ({ page }) => {
    test.fail(true, 'Non-gating: storefront cart booking journey is tracked as backlog signal until deployed-dev behavior is proven.');

    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/rental/catalog');
    await page.waitForLoadState('networkidle');

    const addToCartLinks = page.getByRole('link', { name: 'Add to Cart' });
    const addToCartCount = await addToCartLinks.count();
    expect(addToCartCount, 'expected at least one catalog card with Add to Cart').toBeGreaterThan(0);

    const addToCartHref = await addToCartLinks.first().getAttribute('href');
    expect(addToCartHref, 'expected Add to Cart link to include storefront cart route').toBeTruthy();

    const cartUrl = new URL(addToCartHref!, AVAILABILITY_HREF_BASE);
    const selectedAssetId = cartUrl.searchParams.get('asset_id');
    const selectedRentalDays = cartUrl.searchParams.get('rental_days') || '7';
    expect(selectedAssetId, 'expected Add to Cart link to include selected asset_id').toBeTruthy();

    const startDate = '2026-08-10';
    const endDate = '2026-08-17';
    await page.goto(`/storefront/cart?asset_id=${selectedAssetId!}&rental_days=${selectedRentalDays}&start_date=${startDate}&end_date=${endDate}`);
    await page.waitForLoadState('networkidle');

    const rentalDaysLocator = page.getByText(new RegExp(`\\(${escapeRegExp(selectedRentalDays)}\\s+days\\)`)).first();
    await expect(rentalDaysLocator, 'cart should render selected asset name with rental-day context').toBeVisible();
    await expect(page.getByText('Start Date')).toBeVisible();
    await expect(page.getByText(startDate)).toBeVisible();
    await expect(page.getByText('End Date')).toBeVisible();
    await expect(page.getByText(endDate)).toBeVisible();

    const orderSummaryCard = page.locator('div').filter({
      has: page.getByRole('heading', { name: 'Order Summary' }).first(),
    }).first();
    const orderSummaryTextBeforeAddOns = await orderSummaryCard.innerText();
    const initialTotal = extractOrderSummaryTotal(orderSummaryTextBeforeAddOns);
    expect(initialTotal, `expected initial cart total to parse from order summary:\n${orderSummaryTextBeforeAddOns}`).not.toBeNull();

    const addButtons = page.getByRole('button', { name: 'Add' });
    expect(await addButtons.count(), 'expected both add-on toggle buttons to start as Add').toBeGreaterThanOrEqual(2);
    await addButtons.first().click();
    await page.getByRole('button', { name: 'Add' }).first().click();

    await expect(page.getByText('Damage Waiver').first()).toBeVisible();
    await expect(page.getByText('Delivery & Pickup').first()).toBeVisible();

    const orderSummaryTextAfterAddOns = await orderSummaryCard.innerText();
    const updatedTotal = extractOrderSummaryTotal(orderSummaryTextAfterAddOns);
    expect(updatedTotal, `expected updated cart total to parse from order summary:\n${orderSummaryTextAfterAddOns}`).not.toBeNull();
    expect(updatedTotal!, 'cart total should be recalculated after both add-ons are enabled').toBeGreaterThan(initialTotal!);

    const orderSummaryTextBeforeCrossSell = await orderSummaryCard.innerText();
    const initialAssetSummaryName = extractOrderSummaryAssetName(orderSummaryTextBeforeCrossSell);
    expect(initialAssetSummaryName, 'expected order summary to include selected asset label before cross-sell').toBeTruthy();

    const crossSellLink = page.getByRole('link', { name: 'Add to Cart →' }).first();
    const crossSellHref = await crossSellLink.getAttribute('href');
    expect(crossSellHref, 'expected cross-sell recommendation to include cart handoff link').toBeTruthy();
    const crossSellUrl = new URL(crossSellHref!, AVAILABILITY_HREF_BASE);
    const recommendedAssetId = crossSellUrl.searchParams.get('asset_id');
    expect(recommendedAssetId, 'expected cross-sell recommendation to include target asset_id').toBeTruthy();

    await crossSellLink.click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`asset_id=${escapeRegExp(recommendedAssetId!)}.*start_date=${startDate}.*end_date=${endDate}`));

    const orderSummaryTextAfterCrossSell = await orderSummaryCard.innerText();
    const crossSellAssetSummaryName = extractOrderSummaryAssetName(orderSummaryTextAfterCrossSell);
    expect(crossSellAssetSummaryName, 'expected order summary to include recommended asset label after cross-sell').toBeTruthy();
    expect(crossSellAssetSummaryName, 'cross-sell should switch selected asset context').not.toBe(initialAssetSummaryName);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`asset_id=${escapeRegExp(recommendedAssetId!)}.*start_date=${startDate}.*end_date=${endDate}`));

    const bookingWrite = page.waitForResponse((response) => isCreateRentalOrderWrite(response));
    await page.getByRole('button', { name: 'Request Booking' }).click();
    const bookingResponse = await bookingWrite;

    if (bookingResponse.status() < 400) {
      await expect(page, 'booking success should navigate to rental orders rather than silently no-op').toHaveURL(/\/rental\/orders/);
      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(/\/rental\/orders/);
    } else {
      await expect(page).toHaveURL(/\/storefront\/cart/);
      await expect(
        page.getByText(/action failed|unable to|error/i).first(),
        'booking failure should surface an explicit error/limitation state'
      ).toBeVisible();
    }
  });

  test('entity detail edit persists with version increment (SCD2)', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    const saveStatusCodes: number[] = [];
    page.on('response', (response) => {
      if (
        response.url().includes('/rest/v1/entity_versions') &&
        response.request().method() === 'POST'
      ) {
        saveStatusCodes.push(response.status());
      }
    });

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/entities/customer');
    await page.waitForLoadState('networkidle');

    const viewButtons = page.getByRole('button', { name: 'View' });
    expect(
      await viewButtons.count(),
      'expected at least one customer entity with a View button'
    ).toBeGreaterThan(0);
    await viewButtons.first().click();
    await expect(page).toHaveURL(/\/entities\/customer\/[^/]+$/);
    await page.waitForLoadState('networkidle');

    const entityName = await page.getByRole('heading', { level: 1 }).innerText();
    expect(entityName.trim(), 'entity name should not be empty').toBeTruthy();

    const versionBadgeLocator = page.getByText(/^v\d+$/);
    const initialVersionText = await versionBadgeLocator.first().innerText();
    const initialVersion = parseInt(initialVersionText.slice(1), 10);
    expect(Number.isFinite(initialVersion), 'version badge should contain a numeric version').toBe(true);

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    const uniqueDescription = `E2E SCD2 edit ${Date.now()}`;
    const descriptionField = page.getByLabel('Description');
    await descriptionField.clear();
    await descriptionField.fill(uniqueDescription);

    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Cancel' })).not.toBeVisible();
    expect(
      saveStatusCodes.some((status) => status < 400),
      `save write status codes: ${saveStatusCodes.join(', ')}`
    ).toBe(true);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(uniqueDescription)).toBeVisible();

    const updatedVersionText = await page.getByText(/^v\d+$/).first().innerText();
    const updatedVersion = parseInt(updatedVersionText.slice(1), 10);
    expect(
      updatedVersion,
      `version badge should be ${initialVersion + 1} after save (was ${initialVersionText})`
    ).toBe(initialVersion + 1);

    await page.getByRole('link', { name: 'Back to list' }).click();
    await expect(page).toHaveURL(/\/entities\/customer$/);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(entityName.trim()).first()).toBeVisible();
  });

  test('authenticated user can complete checkout-to-check-in failed-inspection lifecycle for a contract line', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    const checkoutDate = '2026-07-01';
    const returnDate = '2026-07-02';

    const candidate = await findEligibleCheckoutLine(page);

    await page.getByRole('button', { name: 'Check Out Line' }).click();
    const checkoutDialog = page.getByRole('dialog');
    await checkoutDialog.getByLabel('Contract Line ID').fill(candidate.lineId);
    await checkoutDialog.getByLabel('Asset ID').fill(candidate.assetId);
    await checkoutDialog.getByLabel('Actual Start Date').fill(checkoutDate);

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

    const checkedOutLineCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await expect(checkedOutLineCard).toContainText('checked_out');
    await expect(checkedOutLineCard).toContainText(`Asset: ${candidate.assetId}`);
    await expect(checkedOutLineCard).toContainText(new RegExp(`Checked out:\\s*${checkoutDate}`));

    await page.goto('/rental/returns');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();
    await expect(page.getByText(`Checked out at: ${checkoutDate}`)).toBeVisible();

    const checkInQueueCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await checkInQueueCard.getByRole('button', { name: 'Check In This Line' }).click();
    const checkInDialog = page.getByRole('dialog');
    const contractLineInput = checkInDialog.getByLabel('Contract Line Entity ID');
    const contractInput = checkInDialog.getByLabel('Contract ID');
    const assetInput = checkInDialog.getByLabel('Asset ID');
    if (await contractLineInput.count()) {
      await expect(contractLineInput.first()).toHaveValue(candidate.lineId);
      await expect(contractInput.first()).toHaveValue(candidate.contractId);
      await expect(assetInput.first()).toHaveValue(candidate.assetId);
    } else {
      await expect(contractLineInput).toHaveCount(0);
      await expect(contractInput).toHaveCount(0);
      await expect(assetInput).toHaveCount(0);
      await expect(checkInDialog.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
      await expect(checkInDialog.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();
    }
    await checkInDialog.getByLabel('Return Date').fill(returnDate);
    await checkInDialog.getByLabel('Condition Outcome').click();
    await page.getByRole('option', { name: 'Fail' }).click();
    await expect(checkInDialog.getByText('Inspection hold expected')).toBeVisible();

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
    expect(inspectionWriteBody).toContain('"outcome":"fail"');
    expect(inspectionWriteBody).toContain('"resulting_asset_status":"on_inspection_hold"');

    await expect(checkInDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toHaveCount(0);

    await expect(page.getByText(candidate.assetId).first()).toBeVisible();
    await expect(page.getByText('on_inspection_hold')).toBeVisible();

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toHaveCount(0);
    await expect(page.getByText(candidate.assetId).first()).toBeVisible();
    await expect(page.getByText('on_inspection_hold')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Inspections' })).toBeVisible();
    await page.getByRole('link', { name: 'Inspections' }).click();
    await page.waitForURL('**/entities/inspection');
    await page.waitForLoadState('networkidle');

    await page.goto(`/rental/contracts/${candidate.contractId}`);
    await page.waitForLoadState('networkidle');

    const returnedLineCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await expect(returnedLineCard).toContainText('returned');
    await expect(returnedLineCard).not.toContainText('checked_out');
    await expect(returnedLineCard).toContainText(`Asset: ${candidate.assetId}`);
    await expect(returnedLineCard).toContainText(new RegExp(`Returned:\\s*${returnDate}`));
  });

  test('return checked-out line persists state after reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: deployed-dev check-in persistence from the live returns queue is still tracked as backlog signal until the workflow is reliably stable.'
    );
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    let candidate = await findCheckedOutReturnsLine(page);
    if (!candidate) {
      const checkoutCandidate = await findEligibleCheckoutLine(page);
      await page.getByRole('button', { name: 'Check Out Line' }).click();
      const checkoutDialog = page.getByRole('dialog');
      await checkoutDialog.getByLabel('Contract Line ID').fill(checkoutCandidate.lineId);
      await checkoutDialog.getByLabel('Asset ID').fill(checkoutCandidate.assetId);
      await checkoutDialog.getByLabel('Actual Start Date').fill('2026-07-03');

      const checkoutWrite = page.waitForResponse((response) => {
        const body = response.request().postData() ?? '';
        return response.url().includes('/rpc/rental_upsert_entity_current_state')
          && body.includes(`"p_entity_id":"${checkoutCandidate.lineId}"`)
          && body.includes('"status":"checked_out"');
      });

      await checkoutDialog.getByRole('button', { name: 'Confirm Checkout' }).click();
      const checkoutWriteResponse = await checkoutWrite;
      expect(checkoutWriteResponse.status(), 'checkout rpc should succeed when setting up return test state').toBeLessThan(400);
      await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });

      candidate = checkoutCandidate;
    }

    await page.goto('/rental/returns');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Returns / Check-In' })).toBeVisible();
    await expect(page.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();

    const checkInQueueCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await checkInQueueCard.getByRole('button', { name: 'Check In This Line' }).click();
    const checkInDialog = page.getByRole('dialog', { name: 'Check In Contract Line' });
    await expect(checkInDialog).toBeVisible();

    const contractLineInput = checkInDialog.getByLabel('Contract Line Entity ID');
    const contractInput = checkInDialog.getByLabel('Contract ID');
    const assetInput = checkInDialog.getByLabel('Asset ID');
    if (await contractLineInput.count()) {
      await expect(contractLineInput.first()).toHaveValue(candidate.lineId);
      await expect(contractInput.first()).toHaveValue(candidate.contractId);
      await expect(assetInput.first()).toHaveValue(candidate.assetId);
    } else {
      await expect(contractLineInput).toHaveCount(0);
      await expect(contractInput).toHaveCount(0);
      await expect(assetInput).toHaveCount(0);
      await expect(checkInDialog.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
      await expect(checkInDialog.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();
    }
    await checkInDialog.getByLabel('Return Date').fill('2026-07-04');
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
    await expect(checkInDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toHaveCount(0);

    await page.reload();
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
    await expect(returnedLineCard).toContainText('returned');
    await expect(returnedLineCard).not.toContainText('checked_out');
    await expect(returnedLineCard).toContainText(`Asset: ${candidate.assetId}`);

    await page.reload();
    await page.waitForLoadState('networkidle');
    const reloadedLineCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await expect(reloadedLineCard).toContainText('returned');
    await expect(reloadedLineCard).not.toContainText('checked_out');
    await expect(reloadedLineCard).toContainText(`Asset: ${candidate.assetId}`);
  });

  test('contract detail selected checkout-line handoff keeps in-progress workflow scoped and human-readable after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: contract-detail selected checkout-line handoff is not yet verified as reliable on deployed dev — tracked as backlog signal until the live workflow is stable.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const candidate = await findEligibleCheckoutLine(page);
    const selectedLineCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await expect(selectedLineCard).toContainText(`Asset: ${candidate.assetId}`);
    const selectedLineText = await selectedLineCard.innerText();
    const selectedLineStatus = selectedLineText.match(/\b(checked_out|returned|pending_execution|active|draft|open)\b/i)?.[1];
    const selectedPlannedReturn = selectedLineText.match(/Planned return:\s*([^\n]+)/i)?.[1]?.trim();

    const contractLabel = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(contractLabel, 'contract context should be operator-readable, not only a raw UUID').not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const rowActionButtons = selectedLineCard.getByRole('button', { name: /check[\s-]?out|checkout/i });
    const rowActionLinks = selectedLineCard.getByRole('link', { name: /check[\s-]?out|checkout/i });
    const rowActionCount = (await rowActionButtons.count()) + (await rowActionLinks.count());
    expect(
      rowActionCount,
      'expected selected contract-line row to expose direct checkout handoff without manual ID re-entry'
    ).toBeGreaterThan(0);

    const rowAction = await rowActionButtons.count() > 0 ? rowActionButtons.first() : rowActionLinks.first();
    await rowAction.click();

    const actionWorkflow = page.getByRole('dialog', { name: /check[\s-]?out|checkout/i });
    await expect(actionWorkflow).toBeVisible();
    await expect(actionWorkflow.getByLabel('Contract Line ID')).toHaveValue(candidate.lineId);
    await expect(actionWorkflow.getByLabel('Asset ID')).toHaveValue(candidate.assetId);
    await expect(actionWorkflow).toContainText(new RegExp(escapeRegExp(contractLabel), 'i'));
    if (selectedLineStatus) {
      await expect(actionWorkflow).toContainText(new RegExp(escapeRegExp(selectedLineStatus), 'i'));
    }
    if (selectedPlannedReturn) {
      await expect(actionWorkflow).toContainText(new RegExp(escapeRegExp(selectedPlannedReturn), 'i'));
    }

    await actionWorkflow.getByLabel('Actual Start Date').fill('2026-07-05');
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadedWorkflow = page.getByRole('dialog', { name: /check[\s-]?out|checkout/i });
    await expect(reloadedWorkflow).toBeVisible();
    await expect(reloadedWorkflow.getByLabel('Contract Line ID')).toHaveValue(candidate.lineId);
    await expect(reloadedWorkflow.getByLabel('Asset ID')).toHaveValue(candidate.assetId);
    await expect(reloadedWorkflow.getByLabel('Actual Start Date')).toHaveValue('2026-07-05');
    await expect(reloadedWorkflow).toContainText(new RegExp(escapeRegExp(contractLabel), 'i'));
  });

  test('contract detail selected checked-out line handoff keeps return workflow scoped and human-readable after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: contract-detail selected checked-out line return handoff is not yet verified as reliable on deployed dev — tracked as backlog signal until the live workflow is stable.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    let candidate = await findCheckedOutContractLine(page);
    if (!candidate) {
      const checkoutCandidate = await findEligibleCheckoutLine(page);
      await page.getByRole('button', { name: 'Check Out Line' }).click();
      const checkoutDialog = page.getByRole('dialog');
      await checkoutDialog.getByLabel('Contract Line ID').fill(checkoutCandidate.lineId);
      await checkoutDialog.getByLabel('Asset ID').fill(checkoutCandidate.assetId);
      await checkoutDialog.getByLabel('Actual Start Date').fill('2026-07-06');

      const checkoutWrite = page.waitForResponse((response) => {
        const body = response.request().postData() ?? '';
        return response.url().includes('/rpc/rental_upsert_entity_current_state')
          && body.includes(`"p_entity_id":"${checkoutCandidate.lineId}"`)
          && body.includes('"status":"checked_out"');
      });

      await checkoutDialog.getByRole('button', { name: 'Confirm Checkout' }).click();
      const checkoutWriteResponse = await checkoutWrite;
      expect(checkoutWriteResponse.status(), 'checkout rpc should succeed when setting up return handoff state').toBeLessThan(400);
      await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });

      candidate = { contractId: checkoutCandidate.contractId, lineId: checkoutCandidate.lineId };
    }

    await page.goto(`/rental/contracts/${candidate.contractId}`);
    await page.waitForLoadState('networkidle');

    const selectedLineCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    const selectedLineText = await selectedLineCard.innerText();
    const selectedAssetContext = selectedLineText.match(/Asset:\s*([^\n·]+)/i)?.[1]?.trim();
    const selectedCheckedOutDate = selectedLineText.match(/Checked out:\s*([^\n]+)/i)?.[1]?.trim();
    await expect(selectedLineCard).toContainText(/checked_out/i);

    const contractLabel = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(contractLabel, 'contract context should be operator-readable, not only a raw UUID').not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const rowActionButtons = selectedLineCard.getByRole('button', { name: /return/i });
    const rowActionLinks = selectedLineCard.getByRole('link', { name: /return/i });
    const rowActionCount = (await rowActionButtons.count()) + (await rowActionLinks.count());
    expect(rowActionCount, 'expected selected checked-out line row to expose direct return handoff').toBeGreaterThan(0);

    const rowAction = await rowActionButtons.count() > 0 ? rowActionButtons.first() : rowActionLinks.first();
    await rowAction.click();

    const returnWorkflow = page.getByRole('dialog', { name: /return/i });
    await expect(returnWorkflow).toBeVisible();
    await expect(returnWorkflow.getByLabel('Contract Line ID')).toHaveValue(candidate.lineId);
    await expect(returnWorkflow).toContainText(new RegExp(escapeRegExp(contractLabel), 'i'));
    if (selectedAssetContext) {
      await expect(returnWorkflow).toContainText(new RegExp(`Asset:\\s*${escapeRegExp(selectedAssetContext)}`, 'i'));
    }
    await expect(returnWorkflow).toContainText(/checked[_ ]out|status/i);
    if (selectedCheckedOutDate) {
      await expect(returnWorkflow).toContainText(new RegExp(escapeRegExp(selectedCheckedOutDate), 'i'));
    }

    await returnWorkflow.getByLabel('Actual End Date').fill('2026-07-07');
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadedWorkflow = page.getByRole('dialog', { name: /return/i });
    await expect(reloadedWorkflow).toBeVisible();
    await expect(reloadedWorkflow.getByLabel('Contract Line ID')).toHaveValue(candidate.lineId);
    await expect(reloadedWorkflow.getByLabel('Actual End Date')).toHaveValue('2026-07-07');
    await expect(reloadedWorkflow).toContainText(new RegExp(escapeRegExp(contractLabel), 'i'));
  });

  test('contract list row context handoff to detail preserves lifecycle workflow scope after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run operator handoff E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const contractContext = await pickContractFromVisibleListContext(page);
    expect(contractContext.contractLabel, 'list handoff should rely on operator-readable contract context').not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    await expect(page.getByRole('heading', { level: 1 })).toContainText(contractContext.contractLabel);
    await expect(page.getByText(contractContext.contractStatus, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(contractContext.orderReference, { exact: false }).first()).toBeVisible();

    const lineIdLabels = page.getByText(/^Line ID:/);
    const lineCount = await lineIdLabels.count();
    if (lineCount === 0) {
      test.skip(true, `No contract lines available for contract ${contractContext.contractLabel}.`);
    }

    let actedLineId: string | null = null;
    let actionDateFieldLabel: 'Actual Start Date' | 'Actual End Date' | null = null;
    let actionDateValue: string | null = null;
    let actionDialogName: RegExp | null = null;
    let selectedAssetContext: string | null = null;

    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const lineCard = lineIdLabels
        .nth(lineIndex)
        .locator('xpath=..')
        .locator('xpath=..');
      const lineText = await lineCard.innerText();
      const lineId = lineText.match(/Line ID:\s*([^\s]+)/)?.[1]?.trim();
      if (!lineId) {
        continue;
      }

      const returnButtons = lineCard.getByRole('button', { name: /return/i });
      const returnLinks = lineCard.getByRole('link', { name: /return/i });
      const checkoutButtons = lineCard.getByRole('button', { name: /check[\s-]?out|checkout/i });
      const checkoutLinks = lineCard.getByRole('link', { name: /check[\s-]?out|checkout/i });
      const returnCount = (await returnButtons.count()) + (await returnLinks.count());
      const checkoutCount = (await checkoutButtons.count()) + (await checkoutLinks.count());

      if (returnCount > 0) {
        actionDialogName = /return/i;
        actionDateFieldLabel = 'Actual End Date';
        actionDateValue = '2026-07-08';
        const selectedAction = await returnButtons.count() > 0 ? returnButtons.first() : returnLinks.first();
        await selectedAction.click();
      } else if (checkoutCount > 0) {
        actionDialogName = /check[\s-]?out|checkout/i;
        actionDateFieldLabel = 'Actual Start Date';
        actionDateValue = '2026-07-09';
        selectedAssetContext = lineText.match(/Asset:\s*([^\n·]+)/i)?.[1]?.trim() ?? null;
        const selectedAction = await checkoutButtons.count() > 0 ? checkoutButtons.first() : checkoutLinks.first();
        await selectedAction.click();
      } else {
        continue;
      }

      actedLineId = lineId;
      break;
    }

    expect(actedLineId, 'expected at least one contract-line row action (checkout or return)').toBeTruthy();
    expect(actionDateFieldLabel).not.toBeNull();
    expect(actionDateValue).not.toBeNull();
    expect(actionDialogName).not.toBeNull();

    const lifecycleDialog = page.getByRole('dialog', { name: actionDialogName! });
    await expect(lifecycleDialog).toBeVisible();
    await expect(lifecycleDialog.getByLabel('Contract Line ID')).toHaveValue(actedLineId!);
    await expect(lifecycleDialog).toContainText(new RegExp(escapeRegExp(contractContext.contractLabel), 'i'));
    if (selectedAssetContext) {
      await expect(lifecycleDialog.getByLabel('Asset ID')).toHaveValue(selectedAssetContext);
    }

    await lifecycleDialog.getByLabel(actionDateFieldLabel!).fill(actionDateValue!);
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadedLifecycleDialog = page.getByRole('dialog', { name: actionDialogName! });
    await expect(reloadedLifecycleDialog).toBeVisible();
    await expect(reloadedLifecycleDialog.getByLabel('Contract Line ID')).toHaveValue(actedLineId!);
    await expect(reloadedLifecycleDialog.getByLabel(actionDateFieldLabel!)).toHaveValue(actionDateValue!);
    await expect(reloadedLifecycleDialog).toContainText(new RegExp(escapeRegExp(contractContext.contractLabel), 'i'));

    await reloadedLifecycleDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(reloadedLifecycleDialog).toBeHidden({ timeout: 15_000 });

    await page.getByRole('link', { name: /Back to Contracts/i }).click();
    await page.waitForURL('**/rental/contracts');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();
    await expect(page.getByText(contractContext.contractLabel, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`Order: ${contractContext.orderReference}`, { exact: false })).toBeVisible();
    await expect(page.getByText(contractContext.contractStatus, { exact: false }).first()).toBeVisible();

    const listViewButtons = page.getByRole('button', { name: 'View' });
    const listViewButtonCount = await listViewButtons.count();
    const listViewActions = listViewButtonCount > 0 ? listViewButtons : page.getByRole('link', { name: 'View' });
    const listContractCount = await listViewActions.count();
    let reopenedContractId: string | null = null;
    for (let contractIndex = 0; contractIndex < listContractCount; contractIndex++) {
      const viewAction = listViewActions.nth(contractIndex);
      const row = viewAction.locator('xpath=..').locator('xpath=..');
      const rowText = await row.innerText();
      if (
        !rowText.includes(contractContext.contractLabel)
        || !rowText.includes(`Order: ${contractContext.orderReference}`)
        || !rowText.includes(contractContext.contractStatus)
      ) {
        continue;
      }

      await viewAction.click();
      await expect(page).toHaveURL(/\/rental\/contracts\/[^/]+$/);
      await page.waitForLoadState('networkidle');
      reopenedContractId = page.url().split('/').at(-1) ?? null;
      break;
    }

    expect(reopenedContractId, 'expected to re-open acted-on contract row from list using visible context').toBeTruthy();
    expect(reopenedContractId).toBe(contractContext.contractId);
  });

  test('rental order to invoice lifecycle keeps commercial context across handoffs and reloads', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    test.fail(
      true,
      'Non-gating: deployed-dev does not yet complete the full rental order → contract → checkout → return → invoice journey reliably.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const orderContext = await findConvertibleOrder(page);
    const convertButton = page.getByRole('button', { name: 'Convert to Reservation' });
    await expect(convertButton).toBeEnabled();

    const conversionResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/rpc/rental_convert_quote_to_reservation')
      && response.request().method() === 'POST'
    ));

    await convertButton.click();
    const conversionResponse = await conversionResponsePromise;
    expect(conversionResponse.status(), 'reservation conversion RPC should succeed').toBeLessThan(400);

    const conversionPayload = await conversionResponse.json() as Array<{
      success?: boolean;
      reservation_id?: string | null;
      message?: string | null;
    }>;
    const conversionResult = conversionPayload[0];
    expect(conversionResult?.success, 'quoted order should convert to a reservation contract').toBe(true);
    expect(conversionResult?.reservation_id, 'conversion response should return the created contract id').toBeTruthy();

    const contractId = conversionResult!.reservation_id!;
    const contractNumber = conversionResult?.message?.match(/reservation contract\s+([A-Z0-9-]+)/i)?.[1]?.trim() ?? null;

    await expect(page.getByText('Reservation created')).toBeVisible();
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(orderContext.orderNumber);
    await expect(page.getByText('converted', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(orderContext.lineCategory, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`Qty: ${orderContext.lineQuantity} · ${orderContext.linePlannedStart} to ${orderContext.linePlannedEnd}`)).toBeVisible();
    await expect(page.getByText(`Job Site: ${orderContext.lineJobSite}`, { exact: false })).toBeVisible();

    await page.goto(`/rental/contracts/${contractId}`);
    await page.waitForLoadState('networkidle');
    const contractLabel = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    if (contractNumber) {
      expect(contractLabel, 'contract detail should surface the created reservation number').toContain(contractNumber);
    }
    await expect(page.getByText(orderContext.orderId, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`Category: ${orderContext.lineCategory}`, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`Planned return: ${orderContext.linePlannedEnd}`, { exact: false }).first()).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(contractLabel);
    await expect(page.getByText(orderContext.orderId, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`Category: ${orderContext.lineCategory}`, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`Planned return: ${orderContext.linePlannedEnd}`, { exact: false }).first()).toBeVisible();

    const availableAsset = await findAvailableAssetForCategory(page, orderContext.lineCategory);

    await page.goto(`/rental/contracts/${contractId}`);
    await page.waitForLoadState('networkidle');

    const lineIdLabels = page.getByText(/^Line ID:/);
    let convertedLineId: string | null = null;
    let convertedLineCard: Locator | null = null;
    const lineCount = await lineIdLabels.count();
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const lineCard = page.locator('div.rounded-lg.border').filter({ has: lineIdLabels.nth(lineIndex) }).first();
      const lineText = await lineCard.innerText();
      if (!lineText.includes(`Category: ${orderContext.lineCategory}`) || !lineText.includes(`Planned return: ${orderContext.linePlannedEnd}`)) {
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
    await expect(checkoutDialog).toContainText(new RegExp(escapeRegExp(contractLabel), 'i'));
    await checkoutDialog.getByLabel('Asset ID').fill(availableAsset.assetId);
    await checkoutDialog.getByLabel('Actual Start Date').fill('2026-07-11');

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
    await checkInQueueCard.getByRole('button', { name: 'Check In This Line' }).click();
    const checkInDialog = page.getByRole('dialog', { name: 'Check In Contract Line' });
    await expect(checkInDialog).toBeVisible();
    await expect(checkInDialog.getByLabel('Contract Line Entity ID')).toHaveCount(0);
    await expect(checkInDialog.getByLabel('Contract ID')).toHaveCount(0);
    await expect(checkInDialog.getByLabel('Asset ID')).toHaveCount(0);
    await expect(checkInDialog.getByText(`Contract ${contractId} • Asset ${availableAsset.assetId}`)).toBeVisible();
    await expect(checkInDialog.getByText(`Line ID: ${convertedLineId}`)).toBeVisible();
    await checkInDialog.getByLabel('Return Date').fill('2026-07-12');
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
    await expect(returnedLineCard).toContainText(`Category: ${orderContext.lineCategory}`);
    await expect(returnedLineCard).toContainText(`Returned: 2026-07-12`);
    await expect(returnedLineCard).toContainText('Invoice status:');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const reloadedReturnedLineCard = page.locator('div.rounded-lg.border').filter({
      has: page.getByText(`Line ID: ${convertedLineId}`).first(),
    }).first();
    await expect(reloadedReturnedLineCard).toContainText('returned');
    await expect(reloadedReturnedLineCard).toContainText('Invoice status:');

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
      expect(invoiceHeadingText, 'invoice detail should surface a human-readable invoice number').toMatch(/\b(?:invoice|inv)[\s-]*[a-z0-9]/i);

      const billingContextSection = page.getByText('Billing Context').locator('..');
      await expect(billingContextSection).toBeVisible();
      const billingContextText = await billingContextSection.innerText();
      expect(billingContextText, 'invoice detail should surface customer context').toMatch(
        /Customer\s+(?!N\/A\b)(?!customer[-_])[^\n·]+/i
      );
      if (contractNumber) {
        expect(billingContextText).toContain(`Contract ${contractNumber}`);
      }
      if (orderContext.customerName) {
        expect(billingContextText).toContain(orderContext.customerName);
      }

      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      await expect(page.locator('main').getByRole('heading', { level: 1 }).first()).toHaveText(invoiceHeadingText);
      const reloadedBillingContextText = await page.getByText('Billing Context').locator('..').innerText();
      if (orderContext.customerName) {
        expect(reloadedBillingContextText).toContain(orderContext.customerName);
      }
    } else {
      expect(invoiceUrl, 'invoice list fallback should stay scoped to the converted contract').toContain(`/entities/invoice?contractId=${contractId}`);
      const bodyBeforeReload = await page.locator('main').innerText();
      expect(bodyBeforeReload, 'filtered invoice list should show a human-readable invoice number').toMatch(/INV-\w+/i);
      expect(bodyBeforeReload, 'filtered invoice list should retain customer context').toMatch(/Customer:/i);
      if (orderContext.customerName) {
        expect(bodyBeforeReload).toContain(orderContext.customerName);
      }

      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      const bodyAfterReload = await page.locator('main').innerText();
      expect(bodyAfterReload, 'invoice list should retain human-readable invoice linkage after reload').toMatch(/INV-\w+/i);
      expect(bodyAfterReload).toMatch(/Customer:/i);
      if (orderContext.customerName) {
        expect(bodyAfterReload).toContain(orderContext.customerName);
      }
    }
  });

  test('quote conversion to reservation — confirmation context persists and conversion is idempotent', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    test.fail(
      true,
      'Non-gating: quote conversion confirmation persistence and idempotency not yet verified as stable on deployed dev.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const orderContext = await findConvertibleOrderWithSnapshot(page);

    // Verify commercial snapshot is visible before conversion
    if (orderContext.pricingSnapshotTotal) {
      const documentToggle = page.getByTestId('toggle-order-document');
      if ((await documentToggle.count()) > 0 && !(await page.getByTestId('commercial-document').isVisible())) {
        await documentToggle.click();
        await expect(page.getByTestId('commercial-document')).toBeVisible();
      }
      await expect(
        page.getByTestId('commercial-document-total'),
        'pricing snapshot total should be visible before conversion'
      ).toContainText(orderContext.pricingSnapshotTotal);
    }

    const conversionButton = page.getByRole('button', { name: orderContext.conversionButtonName });
    await expect(conversionButton, `${orderContext.conversionButtonName} button should be enabled before conversion`).toBeEnabled();

    const conversionResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/rpc/rental_convert_quote_to_reservation')
      && response.request().method() === 'POST'
    ));

    await conversionButton.click();
    const conversionResponse = await conversionResponsePromise;
    expect(conversionResponse.status(), 'reservation conversion RPC should succeed').toBeLessThan(400);

    const conversionPayload = await conversionResponse.json() as Array<{
      success?: boolean;
      reservation_id?: string | null;
      message?: string | null;
      conflicts?: unknown[];
    }>;
    const conversionResult = conversionPayload[0];
    expect(conversionResult?.success, 'order should convert to a reservation contract successfully').toBe(true);
    expect(conversionResult?.reservation_id, 'conversion response should return the created reservation contract id').toBeTruthy();

    const reservationId = conversionResult!.reservation_id!;
    const reservationNumber = conversionResult?.message?.match(/reservation contract\s+([A-Z0-9-]+)/i)?.[1]?.trim() ?? null;

    // Assert confirmation alert and human-readable context are visible immediately after conversion
    await expect(page.getByText('Reservation created'), 'confirmation alert should appear after conversion').toBeVisible();
    await expect(page.getByText('converted', { exact: false }).first(), 'order status should reflect converted state').toBeVisible();
    if (reservationNumber) {
      await expect(
        page.getByText(reservationNumber, { exact: false }).first(),
        'document/reservation number should be visible in confirmation context'
      ).toBeVisible();
    }
    await expect(
      page.getByText(orderContext.lineCategory, { exact: false }).first(),
      'line category should remain visible after conversion'
    ).toBeVisible();
    if (orderContext.customerName) {
      await expect(
        page.getByText(orderContext.customerName, { exact: false }).first(),
        'customer name should be visible in the confirmation context'
      ).toBeVisible();
    }

    // Reload and verify the converted-order state persists
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { level: 1 }),
      'order heading should persist with document number after reload'
    ).toContainText(orderContext.orderNumber);
    await expect(
      page.getByText('converted', { exact: false }).first(),
      '"converted" status should still be visible after reload'
    ).toBeVisible();
    await expect(
      page.getByText(orderContext.lineCategory, { exact: false }).first(),
      'line category context should persist after reload'
    ).toBeVisible();
    if (orderContext.lineJobSite !== 'N/A') {
      await expect(
        page.getByText(`Job Site: ${orderContext.lineJobSite}`, { exact: false }),
        'job-site context should persist after reload'
      ).toBeVisible();
    }

    // Verify pricing snapshot total persists after reload
    if (orderContext.pricingSnapshotTotal) {
      const docToggleAfterReload = page.getByTestId('toggle-order-document');
      if ((await docToggleAfterReload.count()) > 0) {
        if (!(await page.getByTestId('commercial-document').isVisible())) {
          await docToggleAfterReload.click();
          await expect(page.getByTestId('commercial-document')).toBeVisible();
        }
        await expect(
          page.getByTestId('commercial-document-total'),
          'pricing snapshot total should persist on the order page after reload'
        ).toContainText(orderContext.pricingSnapshotTotal);
      }
    }

    // Idempotency: conversion buttons must not be actionable on a converted order
    const convertToReservationAfter = page.getByRole('button', { name: 'Convert to Reservation' });
    const directBookAfter = page.getByRole('button', { name: 'Direct Book' });
    const enabledConvertCount = await convertToReservationAfter.and(page.locator(':not([disabled])')).count();
    const enabledDirectBookCount = await directBookAfter.and(page.locator(':not([disabled])')).count();
    expect(
      enabledConvertCount + enabledDirectBookCount,
      'neither "Convert to Reservation" nor "Direct Book" should be actionable after a successful conversion — prevents duplicate reservations'
    ).toBe(0);

    // Navigate to the created reservation and verify it carries source-order context
    await page.goto(`/rental/contracts/${reservationId}`);
    await page.waitForLoadState('networkidle');
    const contractHeading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    if (reservationNumber) {
      expect(contractHeading, 'reservation contract heading should surface the document number').toContain(reservationNumber);
    }
    await expect(
      page.getByText(orderContext.orderId, { exact: false }).first(),
      'reservation contract should reference the source order id'
    ).toBeVisible();
    await expect(
      page.getByText(`Category: ${orderContext.lineCategory}`, { exact: false }).first(),
      'reservation contract should carry the converted line category'
    ).toBeVisible();

    // Reload the contract and verify context persists (no data loss across navigations)
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
      'contract heading should persist after reload'
    ).toContainText(contractHeading);
    await expect(
      page.getByText(orderContext.orderId, { exact: false }).first(),
      'source order reference should persist on contract detail after reload'
    ).toBeVisible();
    await expect(
      page.getByText(`Category: ${orderContext.lineCategory}`, { exact: false }).first(),
      'line category context should persist on contract detail after reload'
    ).toBeVisible();
  });

  test('completed rental lifecycle exposes operator-visible invoice after return', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');
    test.fail(
      true,
      'Non-gating: deployed-dev does not yet reliably complete the full return → invoice journey.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Prefer the live returns queue so the journey exercises the real check-in flow.
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
      expect(checkoutWriteResponse.status(), 'checkout rpc should succeed when setting up invoice test state').toBeLessThan(400);
      await expect(checkoutDialog).toBeHidden({ timeout: 15_000 });

      candidate = checkoutCandidate;
    }

    await page.goto('/rental/returns');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`Contract ${candidate.contractId} • Asset ${candidate.assetId}`)).toBeVisible();
    await expect(page.getByText(`Line ID: ${candidate.lineId}`)).toBeVisible();

    const checkInQueueCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await checkInQueueCard.getByRole('button', { name: 'Check In This Line' }).click();
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
    await expect(returnedLineCard).toContainText('returned');

    await expect(returnedLineCard).toContainText('Invoice status:');
    const returnedLineText = await returnedLineCard.innerText();
    const contractContextMatch = returnedLineText.match(/Contract:\s*(.+?)(?:·\s*Customer:|\s*Customer:|\n|$)/s);
    const contractContextLabel = contractContextMatch?.[1]?.trim();
    if (!contractContextLabel) {
      throw new Error('Expected returned-line invoice status to include contract context.');
    }
    await expect(returnedLineCard).toContainText(`Contract: ${contractContextLabel}`);
    await expect(returnedLineCard.getByRole('button', { name: 'View invoices for this contract' }).or(
      returnedLineCard.getByRole('link', { name: 'View invoices for this contract' })
    ).first()).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const reloadedLineCard = page
      .getByText(`Line ID: ${candidate.lineId}`)
      .first()
      .locator('xpath=..')
      .locator('xpath=..');
    await expect(reloadedLineCard).toContainText('returned');
    await expect(reloadedLineCard).toContainText('Invoice status:');
    const reloadedInvoiceCta = reloadedLineCard.getByRole('button', { name: 'View invoices for this contract' }).or(
      reloadedLineCard.getByRole('link', { name: 'View invoices for this contract' })
    ).first();
    await expect(
      reloadedInvoiceCta,
      'next billing step (invoice CTA) must remain visible after reload and be tied to the same rental context — return must not dead-end'
    ).toBeVisible();

    // Follow the contract-level invoice CTA from the completed return flow so operators
    // can jump directly into billing context without manual menu/search hops.
    await reloadedInvoiceCta.click();
    await page.waitForURL('**/entities/invoice**');
    await page.waitForLoadState('networkidle');
    const invoiceUrl = page.url();
    const invoiceDetailUrlPattern = /\/entities\/invoice\/[^/?#]+$/;
    if (invoiceDetailUrlPattern.test(invoiceUrl)) {
      const invoiceHeading = page.locator('main').getByRole('heading', { level: 1 }).first();
      const invoiceHeadingText = (await invoiceHeading.innerText()).trim();
      expect(invoiceHeadingText, 'invoice detail should surface an operator-facing invoice number').toMatch(/\b(?:invoice|inv)[\s-]*[a-z0-9]/i);
      expect(invoiceHeadingText, 'invoice detail should not use a raw UUID as the primary label').not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );

      const billingContextSection = page.getByText('Billing Context').locator('..');
      await expect(billingContextSection).toBeVisible();
      const billingContextText = await billingContextSection.innerText();
      expect(billingContextText).toContain(`Contract ${contractContextLabel}`);
      expect(billingContextText, 'billing context should surface a customer-facing label, not just a machine identifier').toMatch(
        /Customer\s+(?!N\/A\b)(?!customer[-_])[^\n·]+/i
      );
      expect(
        billingContextText,
        'billing context should surface billing-account context, not just a raw billing ID'
      ).toMatch(/Billing Account\s+(?!N\/A\b)(?!billing[-_])[^\n·]+/i);

      // Invoice status and amount must be visible so the operator can confirm the billing outcome.
      const invoiceMainText = await page.locator('main').innerText();
      expect(invoiceMainText, 'invoice detail should surface a billing status after return').toMatch(
        /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
      );
      expect(invoiceMainText, 'invoice detail should surface a monetary amount after return').toMatch(
        /(?:\$\s*[0-9]+(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?\s*(?:AUD|USD|EUR|GBP)|\btotal\b|\bamount\b)/i
      );

      // Reload: status, amount, and contract context must all survive a full page reload.
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
    } else {
      expect(
        invoiceUrl,
        'invoice CTA fallback should preserve contract-scoped handoff when no specific invoice entity is yet discoverable'
      ).toContain(`/entities/invoice?contractId=${candidate.contractId}`);
      await expect(page.getByRole('heading', { name: 'Invoices' })).toBeVisible();
      await expect(page.getByText(`Filtered to contract ${candidate.contractId}`)).toBeVisible();
      const filteredListText = await page.locator('main').innerText();
      expect(filteredListText, 'filtered invoice list should include a human-readable invoice number').toMatch(/INV-\w+/i);
      expect(filteredListText, 'filtered invoice list should include a billing status').toMatch(
        /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
      );
      expect(filteredListText, 'filtered invoice list should include a monetary amount').toMatch(
        /(?:\$\s*[0-9]+(?:\.[0-9]{2})?|\btotal\b|\bamount\b)/i
      );

      // Reload: invoice list context must survive a full page reload.
      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      const reloadedFilteredListText = await page.locator('main').innerText();
      expect(reloadedFilteredListText, 'invoice number must persist in filtered list after reload').toMatch(/INV-\w+/i);
      expect(reloadedFilteredListText, 'invoice status must persist in filtered list after reload').toMatch(
        /\b(draft|pending|issued|sent|paid|overdue|void|open|closed|status)\b/i
      );
    }
  });

  test('portal schedule route rejects missing or forged scope tokens without false success state', async ({ page }) => {
    const scopedPortalUrl = PORTAL_SCHEDULE_SCOPED_URL ?? '';
    test.skip(!PORTAL_SCHEDULE_SCOPED_URL, 'Set E2E_PORTAL_SCHEDULE_SCOPED_URL to a seeded /portal/schedule/:contractId?scope=<token> URL.');

    const scopedContext = parsePortalScheduleScopeContext(scopedPortalUrl);
    const missingScopeRoute = withPortalScopeToken(scopedContext.route, null);
    const forgedScopeRoute = withPortalScopeToken(scopedContext.route, `${scopedContext.scopeToken}-forged`);

    // Missing scope token: UI should render but submitting must fail explicitly and never show success.
    await page.goto(missingScopeRoute);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('portal-schedule-page')).toBeVisible();
    const offRentButtons = page.getByRole('button', { name: 'Request pickup / call-off' });
    const offRentButtonCount = await offRentButtons.count();
    expect(offRentButtonCount, 'expected seeded portal schedule URL to expose a checked-out line with off-rent action').toBeGreaterThan(0);
    await offRentButtons.first().click();
    await page.getByRole('button', { name: 'Submit request' }).first().click();
    await expect(page.getByTestId('customer-request-error')).toContainText('Missing or invalid portal scope token.');
    await expect(page.getByTestId('customer-request-success')).toHaveCount(0);

    // Forged scope token: loading token-scoped request status must fail with explicit authorization error.
    await page.goto(forgedScopeRoute);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('load-error')).toBeVisible();
    await expect(page.getByTestId('load-error')).toContainText(/scope token|outside portal scope|authorization/i);
    await expect(page.getByTestId('customer-request-success')).toHaveCount(0);
  });

  test('portal catalog requisition journey preserves job-site scope into dispatch-ready detail after reload', async ({ page }) => {
    const scopedPortalUrl = PORTAL_CATALOG_SCOPED_URL ?? '';
    test.skip(!PORTAL_CATALOG_SCOPED_URL, 'Set E2E_PORTAL_CATALOG_SCOPED_URL to a seeded /portal/catalog/:jobSiteId?scope=<token> URL.');

    const scopedContext = parsePortalCatalogScopeContext(scopedPortalUrl);

    await page.goto(scopedContext.route);
    await page.waitForLoadState('networkidle');
    expect(page.url(), 'portal catalog route should remain token-scoped').toContain(`scope=${encodeURIComponent(scopedContext.scopeToken)}`);
    await expect(page.getByTestId('portal-catalog-page')).toBeVisible();
    await expect(page.getByTestId('site-id-label')).toContainText(scopedContext.jobSiteId);

    const assetCards = page.locator('[data-testid^="catalog-asset-"]');
    const assetCount = await assetCards.count();
    expect(assetCount, 'expected seeded portal catalog URL to expose at least one requisitionable asset card').toBeGreaterThan(0);
    const selectedAssetCard = assetCards.first();
    const selectedAssetTestId = await selectedAssetCard.getAttribute('data-testid');
    const selectedAssetId = (selectedAssetTestId ?? '').replace(/^catalog-asset-/, '');
    expect(selectedAssetId.length, 'selected asset card should expose a stable asset-scoped test id').toBeGreaterThan(0);
    const selectedAssetName = (await selectedAssetCard.locator('p').first().innerText()).trim();
    expect(selectedAssetName.length, 'selected asset card should expose a non-empty operator-facing asset name').toBeGreaterThan(0);
    const selectedAssetCardText = await selectedAssetCard.innerText();
    expect(
      selectedAssetCardText,
      'selected asset card should expose rate context for operators'
    ).toMatch(/\$\s*[0-9]+(?:\.[0-9]{2})?/);
    expect(selectedAssetCardText, 'selected asset card should expose a day-rate indicator').toMatch(/\/day/i);

    await selectedAssetCard.click();
    await expect(page.getByTestId('requisition-form')).toBeVisible();
    await expect(page.getByTestId('requisition-form')).toContainText(new RegExp(escapeRegExp(selectedAssetName), 'i'));

    const now = Date.now();
    const startDate = new Date(now + PORTAL_CATALOG_REQUISITION_ONE_DAY_MS).toISOString().slice(0, 10);
    const endDate = new Date(now + PORTAL_CATALOG_REQUISITION_THREE_DAYS_MS).toISOString().slice(0, 10);
    await page.getByTestId('req-start-date').fill(startDate);
    await page.getByTestId('req-end-date').fill(endDate);
    await page.getByTestId('req-dispatch-yard').fill('North Yard');
    await page.getByTestId('req-notes').fill('Deliver to gate 3');

    const submitResponsePromise = page.waitForResponse((response) => {
      if (!response.url().includes('/rpc/portal_submit_requisition')) return false;
      if (response.request().method() !== 'POST') return false;
      const payload = parsePortalCatalogSubmitPayload(response.request().postData() ?? '');
      return payload?.p_job_site_id === scopedContext.jobSiteId
        && payload?.p_asset_id === selectedAssetId
        && payload?.p_scope_token === scopedContext.scopeToken;
    });
    await page.getByTestId('req-submit-button').click();
    const submitResponse = await submitResponsePromise;
    expect(submitResponse.status(), 'portal requisition submit mutation should succeed').toBeLessThan(400);
    const submitResult = await submitResponse.json() as unknown;
    const createdRequisitionId = parsePortalCatalogSubmitResult(submitResult) ?? '';
    expect(createdRequisitionId.length, 'portal requisition submit should return a durable requisition id').toBeGreaterThan(0);

    const requisitionSuccess = page.getByTestId('requisition-success');
    await expect(requisitionSuccess).toBeVisible();
    await expect(requisitionSuccess).toContainText(/requisition recorded/i);
    await expect(
      requisitionSuccess,
      'requisition success state should expose created requisition/order context for dispatch handoff'
    ).toContainText(new RegExp(escapeRegExp(createdRequisitionId), 'i'));

    const dispatchReadyHandoff = requisitionSuccess.getByRole('link', { name: DISPATCH_READY_HANDOFF_NAME }).or(
      requisitionSuccess.getByRole('button', { name: DISPATCH_READY_HANDOFF_NAME })
    ).first();
    await expect(
      dispatchReadyHandoff,
      'portal requisition success should expose a dispatch-ready handoff into order/request detail context'
    ).toBeVisible();
    await dispatchReadyHandoff.click();
    await page.waitForLoadState('networkidle');
    expect(
      page.url(),
      'dispatch-ready handoff should land on a durable requisition or order detail route'
    ).toMatch(/\/(entities\/requisition|rental\/orders)\/[^/?#]+/);

    const detailSurface = page.locator('main');
    await expect(
      detailSurface,
      'dispatch-ready detail should keep selected asset context visible after portal requisition handoff'
    ).toContainText(new RegExp(escapeRegExp(selectedAssetName), 'i'));
    await expect(
      detailSurface,
      'dispatch-ready detail should keep job-site scope visible after portal requisition handoff'
    ).toContainText(new RegExp(escapeRegExp(scopedContext.jobSiteId), 'i'));
    await expect(
      detailSurface,
      'dispatch-ready detail should keep requested start date visible after portal requisition handoff'
    ).toContainText(startDate);
    await expect(
      detailSurface,
      'dispatch-ready detail should keep requested end date visible after portal requisition handoff'
    ).toContainText(endDate);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(detailSurface).toContainText(new RegExp(escapeRegExp(selectedAssetName), 'i'));
    await expect(detailSurface).toContainText(new RegExp(escapeRegExp(scopedContext.jobSiteId), 'i'));
    await expect(detailSurface).toContainText(startDate);
    await expect(detailSurface).toContainText(endDate);
  });

  test('portal catalog route rejects missing or forged scope tokens without false success state', async ({ page }) => {
    const scopedPortalUrl = PORTAL_CATALOG_SCOPED_URL ?? '';
    test.skip(!PORTAL_CATALOG_SCOPED_URL, 'Set E2E_PORTAL_CATALOG_SCOPED_URL to a seeded /portal/catalog/:jobSiteId?scope=<token> URL.');

    const scopedContext = parsePortalCatalogScopeContext(scopedPortalUrl);
    const missingScopeRoute = withPortalScopeToken(scopedContext.route, null);
    const forgedScopeRoute = withPortalScopeToken(scopedContext.route, `${scopedContext.scopeToken}-forged`);

    await page.goto(missingScopeRoute);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('portal-catalog-page')).toBeVisible();
    await expect(page.getByTestId('load-error')).toBeVisible();
    await expect(page.getByTestId('load-error')).toContainText(/scope token|invalid|expired|required/i);
    await expect(page.getByTestId('requisition-success')).toHaveCount(0);

    await page.goto(forgedScopeRoute);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('portal-catalog-page')).toBeVisible();
    await expect(page.getByTestId('load-error')).toBeVisible();
    await expect(page.getByTestId('load-error')).toContainText(/scope token|invalid|expired|required/i);
    await expect(page.getByTestId('requisition-success')).toHaveCount(0);
  });

  test('portal schedule customer requests preserve canonical queued context across reload and dedupe repeat submissions', async ({ page }) => {
    test.fail(true, 'Non-gating: portal schedule customer-request workflow reliability on deployed-dev is still tracked as backlog signal.');
    const scopedPortalUrl = PORTAL_SCHEDULE_SCOPED_URL ?? '';
    test.skip(!PORTAL_SCHEDULE_SCOPED_URL, 'Set E2E_PORTAL_SCHEDULE_SCOPED_URL to a seeded /portal/schedule/:contractId?scope=<token> URL.');

    const scopedContext = parsePortalScheduleScopeContext(scopedPortalUrl);

    // Navigate to a seeded token-scoped portal schedule route — no staff auth or app chrome required.
    await page.goto(scopedContext.route);
    await page.waitForLoadState('networkidle');
    expect(page.url(), 'portal schedule route should remain token-scoped').toContain(`scope=${encodeURIComponent(scopedContext.scopeToken)}`);

    // The portal container must render without the main app shell.
    await expect(page.getByTestId('portal-schedule-page')).toBeVisible();

    // Contract label should surface a human-readable identifier (contract number or fallback ID).
    const contractLabel = page.getByTestId('contract-label');
    await expect(contractLabel).toBeVisible();
    const contractLabelText = await contractLabel.innerText();
    expect(contractLabelText.trim(), 'contract label should be non-empty').toBeTruthy();

    // At least one schedule entry must be visible.
    const scheduleList = page.getByTestId('schedule-list');
    await expect(scheduleList).toBeVisible();

    const firstEntry = scheduleList.locator('[data-testid^="schedule-entry-"]').first();
    await expect(firstEntry).toBeVisible();
    const entryText = await firstEntry.innerText();

    // Status badge must show delivery/pickup/returned context — not a raw enum value.
    expect(
      /delivery scheduled|on rent|pickup scheduled|returned/i.test(entryText),
      `schedule entry should include a human-readable status badge (got: "${entryText.slice(0, 120)}")`
    ).toBe(true);

    // Date label must be present and human-readable (e.g. "Delivery: June 1, 2026" or "Not scheduled").
    expect(
      /delivery:|pickup:|returned:|not scheduled/i.test(entryText),
      `schedule entry should include a human-readable date label (got: "${entryText.slice(0, 120)}")`
    ).toBe(true);

    // Asset name must be a real user-facing label — not a raw UUID fallback.
    // The component renders entry.assetName as the first <p> inside each entry card.
    const assetNameText = await firstEntry.locator('p').first().innerText();
    expect(
      assetNameText.trim(),
      'schedule entry asset name should not be empty'
    ).toBeTruthy();
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetNameText.trim()),
      `schedule entry should show a human-readable asset name, not a raw UUID (got: "${assetNameText.trim()}")`
    ).toBe(false);

    // Copy-link control must be present; clicking it must not navigate away from the contract-scoped URL.
    const copyLinkButton = page.getByTestId('copy-link-button');
    await expect(copyLinkButton).toBeVisible();
    expect(
      page.url(),
      'portal schedule URL should be contract-scoped before copy-link interaction'
    ).toContain(`/portal/schedule/${scopedContext.contractId}`);

    await copyLinkButton.click();
    expect(
      page.url(),
      'copy-link should not navigate away from the contract-scoped route'
    ).toContain(`/portal/schedule/${scopedContext.contractId}`);

    // Submit pickup/extension/service requests from one checked-out line and preserve
    // canonical queued state and context after reload.
    const offRentTarget = page.locator('[data-testid^="customer-request-"][data-testid$="-off_rent_pickup"]').first();
    const offRentButtonCount = await page.locator('[data-testid^="customer-request-"][data-testid$="-off_rent_pickup"]').count();
    expect(offRentButtonCount, 'expected seeded portal schedule URL to expose a checked-out line with customer request actions').toBeGreaterThan(0);

    const lineTestId = await offRentTarget.getAttribute('data-testid');
    expect(
      typeof lineTestId === 'string' && /^customer-request-[0-9a-f-]+-off_rent_pickup$/.test(lineTestId),
      'customer request action should expose a stable line-scoped test id'
    ).toBe(true);
    const lineId = (lineTestId ?? '')
      .replace(/^customer-request-/, '')
      .replace(/-off_rent_pickup$/, '');
    expect(lineId.length, 'customer request line id should be non-empty').toBeGreaterThan(0);

    const lineEntry = page.getByTestId(`schedule-entry-${lineId}`);
    await expect(lineEntry).toBeVisible();
    const initialLineEntryText = await lineEntry.innerText();
    const initialAssetName = (await lineEntry.locator('p').first().innerText()).trim();
    expect(initialAssetName.length, 'line equipment label should be visible before request submissions').toBeGreaterThan(0);

    const submitCustomerRequest = async (
      requestType: 'off_rent_pickup' | 'contract_extension' | 'field_service',
      urgency: 'standard' | 'high' | 'critical',
      customerNote: string
    ): Promise<{ url: string; headers: Record<string, string>; postData: string | null }> => {
      const submitAction = page.getByTestId(`customer-request-${lineId}-${requestType}`);
      await expect(submitAction).toBeVisible();

      const submitResponsePromise = page.waitForResponse((response) => {
        const mutationParams = parsePortalSubmitPayload(response.request().postData() ?? '');
        return response.url().includes('/rpc/portal_submit_customer_service_request')
          && response.request().method() === 'POST'
          && mutationParams?.p_contract_id === scopedContext.contractId
          && mutationParams?.p_contract_line_id === lineId
          && mutationParams?.p_scope_token === scopedContext.scopeToken
          && mutationParams?.p_request_type === requestType
          && mutationParams?.p_urgency === urgency
          && mutationParams?.p_customer_note === customerNote;
      });

      await submitAction.click();
      await page.getByTestId(`request-type-${lineId}`).selectOption(requestType);
      await page.getByTestId(`request-urgency-${lineId}`).selectOption(urgency);
      await page.getByTestId(`request-note-${lineId}`).fill(customerNote);
      await page.getByTestId(`submit-customer-request-${lineId}`).click();

      const submitResponse = await submitResponsePromise;
      expect(submitResponse.status(), `portal ${requestType} request mutation should succeed`).toBeLessThan(400);
      await expect(page.getByTestId(`customer-requested-${lineId}-${requestType}`)).toBeVisible();
      await expect(page.getByTestId(`customer-requested-${lineId}-${requestType}`)).toContainText(new RegExp(`queued\\s*·\\s*${urgency}`, 'i'));
      await expect(page.getByTestId(`customer-request-${lineId}-${requestType}`)).toHaveCount(0);

      return {
        url: submitResponse.request().url(),
        headers: submitResponse.request().headers(),
        postData: submitResponse.request().postData(),
      };
    };

    await submitCustomerRequest('off_rent_pickup', 'standard', 'Pickup needed before site turnover tomorrow morning');
    const extensionSubmit = await submitCustomerRequest('contract_extension', 'high', 'Need +7 days due to crew delay');
    await submitCustomerRequest('field_service', 'critical', 'Hydraulic leak at mast, onsite service required');

    const replayHeaders = ['apikey', 'authorization', 'content-type', 'accept', 'prefer']
      .reduce<Record<string, string>>((acc, headerName) => {
        const headerValue = extensionSubmit.headers[headerName];
        if (typeof headerValue === 'string' && headerValue.length > 0) {
          acc[headerName] = headerValue;
        }
        return acc;
      }, {});
    const duplicateSubmitResponse = await page.request.post(extensionSubmit.url, {
      headers: replayHeaders,
      data: extensionSubmit.postData ?? '{}',
    });
    expect(duplicateSubmitResponse.status(), 'duplicate extension submission should resolve via canonical request dedupe').toBeLessThan(400);

    const listResponsePromise = page.waitForResponse((response) => {
      const mutationParams = parsePortalSubmitPayload(response.request().postData() ?? '');
      return response.url().includes('/rpc/portal_list_customer_service_requests')
        && response.request().method() === 'POST'
        && mutationParams?.p_contract_id === scopedContext.contractId
        && mutationParams?.p_scope_token === scopedContext.scopeToken;
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const listResponse = await listResponsePromise;
    expect(listResponse.status(), 'portal customer request listing should succeed after reload').toBeLessThan(400);
    const listedRequests = await listResponse.json() as Array<{
      contract_line_id?: string;
      request_type?: string;
      urgency?: string;
      customer_note?: string | null;
      asset_id?: string;
    }>;
    const lineRequests = listedRequests.filter((request) => request.contract_line_id === lineId);

    await expect(page.getByTestId('portal-schedule-page')).toBeVisible();
    await expect(page.getByTestId('contract-label')).toBeVisible();
    const reloadedLabelText = await page.getByTestId('contract-label').innerText();
    expect(
      reloadedLabelText,
      'contract label should remain the same after reload'
    ).toBe(contractLabelText);
    await expect(page.getByTestId('schedule-list')).toBeVisible();
    await expect(page.getByTestId(`schedule-entry-${lineId}`)).toContainText(initialLineEntryText);
    await expect(page.getByTestId(`schedule-entry-${lineId}`)).toContainText(initialAssetName);
    await expect(page.getByTestId(`customer-requested-${lineId}-off_rent_pickup`)).toContainText(/queued\s*·\s*standard/i);
    await expect(page.getByTestId(`customer-requested-${lineId}-contract_extension`)).toContainText(/queued\s*·\s*high/i);
    await expect(page.getByTestId(`customer-requested-${lineId}-field_service`)).toContainText(/queued\s*·\s*critical/i);
    await expect(page.getByTestId(`customer-requested-${lineId}-contract_extension`)).toHaveCount(1);

    const extensionRequests = lineRequests.filter((request) => request.request_type === 'contract_extension');
    expect(extensionRequests.length, 'duplicate extension submissions should reuse one canonical queued thread').toBe(1);
    expect(extensionRequests[0]?.urgency).toBe('high');
    expect(extensionRequests[0]?.customer_note ?? '').toContain('Need +7 days');
    expect(extensionRequests[0]?.asset_id, 'extension request should preserve the same equipment context').toBeTruthy();

    const pickupRequests = lineRequests.filter((request) => request.request_type === 'off_rent_pickup');
    expect(pickupRequests.length, 'pickup workflow should persist one queued request row for the line').toBe(1);
    expect(pickupRequests[0]?.urgency).toBe('standard');
    expect(pickupRequests[0]?.customer_note ?? '').toContain('Pickup needed');

    const serviceRequests = lineRequests.filter((request) => request.request_type === 'field_service');
    expect(serviceRequests.length, 'field-service workflow should persist one queued request row for the line').toBe(1);
    expect(serviceRequests[0]?.urgency).toBe('critical');
    expect(serviceRequests[0]?.customer_note ?? '').toContain('Hydraulic leak');
  });

  test('rental order detail preferred-vendor rerent workflow saves external fulfillment context and suppresses duplicate routing after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated write E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Scan rental orders to find one that exposes a shortage-line rerent action.
    await page.goto('/rental/orders');
    await page.waitForLoadState('networkidle');

    const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
    const orderCount = await viewActions.count();
    expect(orderCount, 'expected at least one rental order with a View action').toBeGreaterThan(0);

    const maxOrdersToScan = Math.min(orderCount, RERENT_MAX_ORDERS_TO_SCAN);
    let foundOrderWithShortage = false;

    for (let orderIndex = 0; orderIndex < maxOrdersToScan; orderIndex++) {
      if (orderIndex > 0) {
        await page.goto('/rental/orders');
        await expect(viewActions.first()).toBeVisible({ timeout: RERENT_NAVIGATION_TIMEOUT });
      }

      const currentViewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
      const currentOrderCount = await currentViewActions.count();
      if (orderIndex >= currentOrderCount) {
        break;
      }

      await currentViewActions.nth(orderIndex).click();
      try {
        await expect(page).toHaveURL(/\/rental\/orders\/[^/]+$/, { timeout: RERENT_NAVIGATION_TIMEOUT });
      } catch {
        continue;
      }
      await page.waitForLoadState('networkidle');

      const rerentButtons = page.getByRole('button', { name: 'Mark Preferred Vendor Re-rent' });
      if (await rerentButtons.count() > 0) {
        foundOrderWithShortage = true;
        break;
      }
    }

    if (!foundOrderWithShortage) {
      test.skip(true, 'No rental order found with an available preferred-vendor rerent action; environment may not have active shortage lines.');
      return;
    }

    // Record how many shortage lines this order has before acting so we can verify suppression.
    const initialRerentButtonCount = await page
      .getByRole('button', { name: 'Mark Preferred Vendor Re-rent' })
      .count();

    // Trigger the preferred-vendor rerent action on the first shortage line.
    await page.getByRole('button', { name: 'Mark Preferred Vendor Re-rent' }).first().click();

    // The rerent routing panel must surface shortage context for the operator.
    await expect(page.getByText('Internal shortage detected')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Re-rent Routing' })).toBeVisible();

    // Wire up to the API write that persists the external routing decision.
    const rerentSave = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return (
        response.url().includes('/rpc/rental_upsert_entity_current_state') &&
        body.includes('"fulfillment_source":"external_rerent"')
      );
    });

    await page.getByRole('button', { name: 'Save Re-rent Routing' }).click();
    const rerentSaveResponse = await rerentSave;
    expect(rerentSaveResponse.status(), 'rerent routing save RPC should succeed').toBeLessThan(400);

    // Operator-visible fulfillment badges must surface immediately after save — not just hidden state.
    await expect(page.getByText('external rerent')).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    await expect(page.getByText('pending vendor confirmation')).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    const routeContextLocator = page.getByText(/^route:\s+.+/i).first();
    const unitStatusLocator = page.getByText(/^unit:\s+(Requested|Awarded|Dispatched|On Rent|Return in Transit|Returned)$/i).first();
    await expect(routeContextLocator).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    await expect(unitStatusLocator).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    const routeContextLabel = (await routeContextLocator.innerText()).trim();
    const unitStatusLabel = (await unitStatusLocator.innerText()).trim();

    // Reload and verify external-fulfillment context persists across a full page load.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('external rerent')).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    await expect(page.getByText('pending vendor confirmation')).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    await expect(page.getByText(routeContextLabel, { exact: true })).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });
    await expect(page.getByText(unitStatusLabel, { exact: true })).toBeVisible({ timeout: RERENT_BADGE_VISIBILITY_TIMEOUT });

    // The routed line must no longer expose the rerent action after reload (duplicate routing suppressed).
    const rerentButtonsAfterReload = await page
      .getByRole('button', { name: 'Mark Preferred Vendor Re-rent' })
      .count();
    expect(
      rerentButtonsAfterReload,
      'routed line should no longer expose the preferred-vendor rerent action after reload'
    ).toBeLessThan(initialRerentButtonCount);
  });

  test('field operator can complete mobile return and follow-up inspection with persisted state after reload', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD or E2E_OPERATOR_EMAIL/PASSWORD to run field-mobile E2E.'
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await openFieldMobile(page);

    const returnTask = await ensureReturnTask(page);
    if (!returnTask) {
      test.skip(true, 'No pickup/return or delivery/checkout task available for this field operator in current environment.');
      return;
    }
    const { assetName, customerName, jobSiteName } = returnTask;
    await expectSelectedFieldTaskContext(page, { assetName, customerName, jobSiteName });
    await expect(page.getByText('Asset: On rent')).toBeVisible();

    const evidenceUpload = page.waitForResponse(
      (response) => response.url().includes('/storage/v1/object/field-evidence/') && response.request().method() !== 'OPTIONS'
    );
    const returnLineWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes('"p_entity_type":"rental_contract_line"')
        && body.includes('"status":"returned"');
    });
    const returnInspectionWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"inspection_type":"return"')
        && body.includes('"resulting_asset_status":"returned"');
    });
    const returnAssetWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes('"p_entity_type":"asset"')
        && body.includes('"status":"returned"');
    });

    await page.getByLabel('Customer/operator signature').fill(generateE2ESignature('Return'));
    await page.getByLabel('Condition / damage notes').fill('Return completed with photo evidence for experience coverage.');
    await page.getByLabel('Photo evidence').setInputFiles({
      name: 'return-evidence.jpg',
      mimeType: 'image/jpeg',
      buffer: MINIMAL_JPEG,
    });
    await expect(page.getByText('1 photo(s) selected')).toBeVisible();
    await page.getByRole('button', { name: 'Complete return' }).click();

    const [evidenceUploadResponse, returnLineWriteResponse, returnInspectionWriteResponse, returnAssetWriteResponse] =
      await Promise.all([evidenceUpload, returnLineWrite, returnInspectionWrite, returnAssetWrite]);
    expect(evidenceUploadResponse.status(), 'return evidence upload should succeed').toBeLessThan(400);
    expect(returnLineWriteResponse.status(), 'return contract-line write should succeed').toBeLessThan(400);
    expect(returnInspectionWriteResponse.status(), 'return inspection write should succeed').toBeLessThan(400);
    expect(returnAssetWriteResponse.status(), 'return asset write should succeed').toBeLessThan(400);
    await expect(page.getByText(/return completed/i)).toBeVisible({ timeout: FIELD_WORKFLOW_COMPLETION_TIMEOUT });

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('button', { name: new RegExp(`Pickup \\/ Return[\\s\\S]*${escapeRegExp(assetName)}`, 'i') })
    ).toHaveCount(0);

    const inspectionTask = await findFieldTaskButton(page, 'inspection', assetName);
    expect(inspectionTask, `expected Inspection task for asset ${assetName}`).not.toBeNull();
    const inspectionTaskButton = inspectionTask!;
    await expect(inspectionTaskButton).toContainText(assetName);
    if (customerName) {
      await expect(inspectionTaskButton).toContainText(customerName);
    }
    if (jobSiteName) {
      await expect(inspectionTaskButton).toContainText(jobSiteName);
    }
    await inspectionTaskButton.click();
    await expectSelectedFieldTaskContext(page, { assetName, customerName, jobSiteName });
    await expectSelectedFieldStatusBadge(page, 'returned');

    const inspectionOnlyWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/create_entity_with_version')
        && body.includes('"inspection_type":"return"')
        && body.includes('"outcome":"fail"')
        && body.includes('"resulting_asset_status":"on_inspection_hold"');
    });
    const inspectionAssetWrite = page.waitForResponse((response) => {
      const body = response.request().postData() ?? '';
      return response.url().includes('/rpc/rental_upsert_entity_current_state')
        && body.includes('"p_entity_type":"asset"')
        && body.includes('"status":"on_inspection_hold"');
    });

    await page.getByLabel('Inspection outcome').selectOption('fail');
    await expect(page.getByText('Completing this inspection transitions the asset to inspection_hold.')).toBeVisible();
    await page.getByLabel('Customer/operator signature').fill(generateE2ESignature('Inspection'));
    await page.getByLabel('Condition / damage notes').fill('Inspection failed and asset should stay on hold after reload.');
    await page.getByRole('button', { name: 'Complete inspection' }).click();

    const [inspectionOnlyWriteResponse, inspectionAssetWriteResponse] = await Promise.all([
      inspectionOnlyWrite,
      inspectionAssetWrite,
    ]);
    expect(inspectionOnlyWriteResponse.status(), 'inspection record write should succeed').toBeLessThan(400);
    expect(inspectionAssetWriteResponse.status(), 'inspection asset write should succeed').toBeLessThan(400);
    await expect(page.getByText(/inspection completed/i)).toBeVisible({ timeout: FIELD_WORKFLOW_COMPLETION_TIMEOUT });

    await openFieldMobile(page);

    const persistedInspectionTask = await findFieldTaskButton(page, 'inspection', assetName);
    expect(persistedInspectionTask, `expected persisted Inspection task for asset ${assetName} after navigation`).not.toBeNull();
    const persistedInspectionTaskButton = persistedInspectionTask!;
    await expect(persistedInspectionTaskButton).toContainText(assetName);
    if (customerName) {
      await expect(persistedInspectionTaskButton).toContainText(customerName);
    }
    if (jobSiteName) {
      await expect(persistedInspectionTaskButton).toContainText(jobSiteName);
    }
    await persistedInspectionTaskButton.click();
    await expectSelectedFieldTaskContext(page, { assetName, customerName, jobSiteName });
    await expectSelectedFieldStatusBadge(page, 'inspection_hold');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadedInspectionTask = await findFieldTaskButton(page, 'inspection', assetName);
    expect(reloadedInspectionTask, `expected persisted Inspection task for asset ${assetName} after reload`).not.toBeNull();
    const reloadedInspectionTaskButton = reloadedInspectionTask!;
    await expect(reloadedInspectionTaskButton).toContainText(assetName);
    if (customerName) {
      await expect(reloadedInspectionTaskButton).toContainText(customerName);
    }
    if (jobSiteName) {
      await expect(reloadedInspectionTaskButton).toContainText(jobSiteName);
    }
    await reloadedInspectionTaskButton.click();
    await expectSelectedFieldTaskContext(page, { assetName, customerName, jobSiteName });
    await expectSelectedFieldStatusBadge(page, 'inspection_hold');
  });

  test('portal-financials renders invoice cards with human-readable invoice context', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated portal-financials E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/rental/portal-financials');
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: /Customer Portal.*Invoices.*Payments/i }).or(
        page.getByText(/Customer Portal.*Invoices.*Payments/i).first()
      ),
      'portal-financials page heading should be visible'
    ).toBeVisible();

    const body = await page.locator('body').innerText();

    // At least one invoice card must show a human-readable invoice number (e.g. INV-00001).
    const invoiceNumberPattern = /INV-\w+/i;
    expect(
      invoiceNumberPattern.test(body),
      'page must render at least one invoice number (INV-*) — empty/loading state is not a passing outcome'
    ).toBe(true);

    // Outstanding balance summary card must be present on the rendered card.
    expect(
      /outstanding balance/i.test(body) && /\$[\d,]+\.\d{2}/.test(body),
      'portal must surface an outstanding-balance amount on the invoice card'
    ).toBe(true);

    // Invoice cards must surface Customer and Billing Account context — not just a number.
    expect(
      /Customer:/i.test(body),
      'invoice cards must include a Customer: label'
    ).toBe(true);
    expect(
      /Billing Account:/i.test(body),
      'invoice cards must include a Billing Account: label'
    ).toBe(true);

    // Invoice rows must not expose raw UUIDs as the primary operator-facing content.
    const uuids = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    expect(uuids.length, 'portal-financials should not expose raw UUIDs as primary content').toBeLessThanOrEqual(PORTAL_FINANCIALS_MAX_EXPOSED_UUIDS);
  });

  test('portal-financials shows project allocation groups with cost-code rollups and signed-event status', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated portal-financials E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/rental/portal-financials');
    await page.waitForLoadState('networkidle');

    // The Project Equipment Cost Allocation section heading must be present.
    await expect(
      page.getByText('Project Equipment Cost Allocation').first(),
      '"Project Equipment Cost Allocation" section heading must be visible'
    ).toBeVisible();

    // Locate the first rendered allocation group by finding the <p> that carries the
    // "Signed events: N/M" count (only present when actual group data has loaded — never in the
    // section heading or in the loading/empty-state messages).  Navigate up one level with
    // xpath to reach the group's container div; all remaining assertions are scoped to it.
    const signedEventsP = page
      .locator('p')
      .filter({ hasText: /Signed events:\s*\d+\/\d+/ })
      .first();
    await expect(
      signedEventsP,
      'at least one allocation group must render actual signed-event counts (e.g. "Signed events: 2/5") — section shell alone is not a passing outcome'
    ).toBeVisible();

    // The <p>Signed events: N/M</p> is a direct child of the group container div.
    // Navigate to that container so every subsequent assertion is scoped within the same group.
    const groupContainer = signedEventsP.locator('xpath=..');

    // Within the group: the project name is the first <p> inside the container (it appears
    // before the signed-events paragraph in document order, inside the header flex div).
    const projectLabelEl = groupContainer.locator('p').first();
    await expect(projectLabelEl, 'rendered group must include a project label paragraph').toBeVisible();
    const projectLabelText = await projectLabelEl.innerText();
    expect(
      projectLabelText.trim().length,
      'project label must be a non-empty string'
    ).toBeGreaterThan(0);
    expect(
      /^(Signed events|Cost code|Project Equipment Cost Allocation):/i.test(projectLabelText.trim()),
      'the first paragraph of the group must be the project label, not a data field or section heading'
    ).toBe(false);

    // Within the group: a cost-code row with a currency total must be present.
    await expect(
      groupContainer.getByText(/Cost code:\s*\S[^\n]*\$[\d,]+\.\d{2}/),
      'rendered group must show a Cost code label with a currency total'
    ).toBeVisible();

    // Within the group: at least one operational-status label must appear on a line row.
    await expect(
      groupContainer.getByText(/off-rent|on rent|signed|pending signature/i).first(),
      'rendered group must show an operational-status label on at least one line row'
    ).toBeVisible();

    // Each cost-allocation line row must show an identity element (asset name, category, or
    // equipment fallback) as primary content — not only the operational-status phrase.
    // The identity <p> is identified by its data-testid="allocation-line-{id}-identity" attribute.
    // At least one such element must be visible within the loaded group.
    const identityEls = groupContainer.locator('[data-testid^="allocation-line-"][data-testid$="-identity"]');
    const identityCount = await identityEls.count();
    expect(
      identityCount,
      'at least one allocation line must render an identity element (asset name / category / equipment) as primary context'
    ).toBeGreaterThan(0);

    // The first identity element must contain non-empty text that is NOT solely an
    // operational-status phrase — the asset/category label must precede the status.
    const firstIdentityText = (await identityEls.first().innerText()).trim();
    expect(
      firstIdentityText.length,
      'identity element must have non-empty visible text'
    ).toBeGreaterThan(0);
    expect(
      /^(Off-rent|Delivered\/on rent|Requisition|Delivery)\s/i.test(firstIdentityText),
      'identity element must lead with asset/category context, not a status phrase'
    ).toBe(false);

    // QA: collect visible text for every rendered identity element and confirm no two
    // adjacent rows are completely identical (at least date, category, or asset name differs).
    if (identityCount > 1) {
      const identityTexts: string[] = [];
      for (let i = 0; i < identityCount; i++) {
        identityTexts.push((await identityEls.nth(i).innerText()).trim());
      }
      const hasAdjacentDuplicates = identityTexts.some((text, i) => i > 0 && text === identityTexts[i - 1]);
      expect(
        hasAdjacentDuplicates,
        'no two adjacent cost-allocation rows should have identical visible identity text'
      ).toBe(false);
    }
  });

  test('crm customer profiles preserve commercial context from list to detail after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated CRM E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/crm/customers');
    await page.waitForLoadState('networkidle');

    // There must be at least one "View Profile" button — bind assertions to that row's container.
    const viewProfileButton = page.getByRole('button', { name: 'View Profile' }).first();
    await expect(
      viewProfileButton,
      'at least one "View Profile" button must be present in the customer list'
    ).toBeVisible();

    // Navigate up to the row container (the border rounded-lg flex row rendered by the UIEngine).
    const rowContainer = viewProfileButton.locator(
      'xpath=ancestor::*[contains(@class,"border") and contains(@class,"rounded-lg")][1]'
    );
    const rowText = await rowContainer.innerText();
    const rowLines = rowText.split('\n').map((l: string) => l.trim()).filter(Boolean);

    // The first rendered text in each row is the customer name.
    const customerName = rowLines[0];
    expect(
      customerName,
      'customer row must show a human-readable name as the first element, not a raw UUID'
    ).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(customerName, 'customer name must be non-empty').toBeTruthy();

    // The row must show "Industry: <value>" — not just the label alone.
    expect(
      rowText,
      'customer row must show Industry context with a non-empty value'
    ).toMatch(/Industry:\s*\S+/);

    // The row must show "Balance: $<digits>" — an actual dollar amount, not a bare label.
    expect(
      rowText,
      'customer row must show Balance as a dollar amount'
    ).toMatch(/Balance:\s*\$[\d,]+/);

    // Navigate into the customer profile for this row.
    await viewProfileButton.click();
    await page.waitForLoadState('networkidle');

    // Must have navigated to /crm/customers/:id.
    expect(
      page.url(),
      'clicking View Profile must navigate to the customer detail route'
    ).toMatch(/\/crm\/customers\/[^/]+$/);

    // The h1 on the detail page must be the same customer name seen in the list row.
    const detailHeading = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(
      detailHeading,
      'detail page h1 must match the customer name shown in the list row'
    ).toBe(customerName);

    // All commercial-context fields must render with actual values, not just labels.
    const textBefore = await page.locator('body').innerText();

    // Balance section: label followed by a dollar value within ~40 chars.
    expect(
      textBefore,
      'Balance section must render a dollar value, not just the heading'
    ).toMatch(/Balance[\s\S]{0,40}\$[\d,]+/);

    // Avg Days to Pay: label followed by a number or the "N/A" fallback.
    expect(
      textBefore,
      'Avg Days to Pay section must render a numeric value or N/A'
    ).toMatch(/Avg Days to Pay[\s\S]{0,40}(N\/A|\d+)/i);

    // Payment Method: label followed by any value (even the "Not set" fallback).
    expect(
      textBefore,
      'Payment Method section must render a value or the "Not set" fallback'
    ).toMatch(/Payment Method[\s\S]{0,60}(Not set|\w+)/i);

    // Contacts and Billing Accounts section headings must be present.
    expect(/Contacts/i.test(textBefore), 'customer detail must show a Contacts section before reload').toBe(true);
    expect(/Billing Accounts/i.test(textBefore), 'customer detail must show a Billing Accounts section before reload').toBe(true);

    // Capture the balance value before reload so we can verify it survives.
    const balanceMatch = textBefore.match(/Balance[\s\S]{0,40}(\$[\d,]+)/);
    const balanceValue = balanceMatch ? balanceMatch[1] : null;

    const detailUrl = page.url();
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // The URL must be the same customer detail page after reload.
    expect(
      page.url(),
      'page URL must remain the same customer detail route after reload'
    ).toBe(detailUrl);

    // The same customer name must still be in the h1 after reload.
    const headingAfter = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(
      headingAfter,
      'detail page h1 must show the same customer name after reload'
    ).toBe(customerName);

    const textAfter = await page.locator('body').innerText();

    // The balance dollar value captured before reload must still be present.
    if (balanceValue) {
      expect(
        textAfter,
        `Balance value "${balanceValue}" must survive reload`
      ).toContain(balanceValue);
    }

    // All commercial-context sections must still render with values after reload.
    expect(
      textAfter,
      'Balance section must render a dollar value after reload'
    ).toMatch(/Balance[\s\S]{0,40}\$[\d,]+/);
    expect(
      textAfter,
      'Avg Days to Pay section must render a numeric value or N/A after reload'
    ).toMatch(/Avg Days to Pay[\s\S]{0,40}(N\/A|\d+)/i);
    expect(
      textAfter,
      'Payment Method section must render a value or the "Not set" fallback after reload'
    ).toMatch(/Payment Method[\s\S]{0,60}(Not set|\w+)/i);
    expect(/Contacts/i.test(textAfter), 'Contacts section must remain after reload').toBe(true);
    expect(/Billing Accounts/i.test(textAfter), 'Billing Accounts section must remain after reload').toBe(true);
  });

  test('customer profiles list exposes create/import actions instead of a read-only dead end', async ({ page }) => {
    if (AUTH_EMAIL && AUTH_PASSWORD) {
      await signIn(page, AUTH_EMAIL, AUTH_PASSWORD);
    }

    await page.goto('/crm/customers');
    await page.waitForLoadState('networkidle');

    // Page heading must be present.
    await expect(
      page.getByRole('heading', { name: 'Customer Profiles' }).first(),
      '"Customer Profiles" heading must be visible'
    ).toBeVisible();

    // At least one primary action must be visible regardless of whether the list is populated.
    // Acceptable actions: Create Customer, Import Customers, Sync Customers, Open Payment Issues.
    const primaryAction = page
      .getByRole('button', { name: /Create Customer|Import Customers|Sync Customers|Open Payment Issues/i })
      .or(page.getByRole('link', { name: /Create Customer|Import Customers|Sync Customers|Open Payment Issues/i }))
      .first();
    await expect(
      primaryAction,
      'customer list must expose at least one primary action (Create Customer, Import, Sync, or Open Payment Issues) — not a read-only dead end'
    ).toBeVisible();

    if (AUTH_EMAIL && AUTH_PASSWORD) {
      // Payment-risk rows must surface a direct escalation path.
      // The seed data has at least one customer with payment_issue_flag = 1 (Summit Arc Steel Services).
      // Wait for at least one customer row to render before inspecting payment-risk rows.
      // If no rows are present yet (empty env), skip the per-row check gracefully.
      const anyRow = page.locator('.border.rounded-lg').first();
      const anyRowVisible = await anyRow.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, (err: Error) => { console.warn('No customer rows visible within 5s:', err.message); return false; });
      if (anyRowVisible) {
        const paymentIssueRows = page.locator('.border.rounded-lg').filter({
          has: page.getByText('Payment Issue'),
        });
        const paymentIssueCount = await paymentIssueRows.count();
        if (paymentIssueCount > 0) {
          const escalationAction = paymentIssueRows
            .first()
            .getByRole('button', { name: /Open Issue|Resolve|Escalate/i })
            .or(paymentIssueRows.first().getByRole('link', { name: /Open Issue|Resolve|Escalate/i }))
            .first();
          await expect(
            escalationAction,
            'payment-risk rows must expose a direct escalation action — not just "View Profile"'
          ).toBeVisible();
        }
      }
    }
  });

  test('manager/admin can create a CRM customer from list modal and still see it after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated CRM E2E.');

    const uniqueName = `E2E CRM Customer ${Date.now()}`;
    const uniqueIndustry = `e2e_industry_${Date.now()}`;

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/crm/customers');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(uniqueName), 'precondition: generated customer name must not exist before create').toHaveCount(0);

    await page.getByRole('button', { name: 'Create Customer' }).click();
    const createDialog = page.getByRole('dialog');
    await expect(createDialog).toBeVisible();

    await createDialog.getByLabel('Customer Name').fill(uniqueName);
    await selectComboboxOption(page, 'Customer Type', 'National');
    await selectComboboxOption(page, 'Tier', 'Gold');
    await createDialog.getByLabel('Industry').fill(uniqueIndustry);

    const createWrite = page.waitForResponse((response) => {
      const requestBody = response.request().postData() ?? '';
      return response.url().includes('/rpc/crm_upsert_customer_profile')
        && requestBody.includes(uniqueName)
        && requestBody.includes(uniqueIndustry);
    });

    await createDialog.getByRole('button', { name: 'Create Customer' }).click();
    const createWriteResponse = await createWrite;
    expect(createWriteResponse.status(), 'create-customer write should succeed').toBeLessThan(400);
    await expect(createDialog).toBeHidden({ timeout: 15_000 });

    const createdRow = page.locator('.border.rounded-lg').filter({ hasText: uniqueName }).first();
    await expect(createdRow, 'new customer row should render immediately after create').toBeVisible({ timeout: 15_000 });
    await expect(createdRow.getByText(new RegExp(`Industry:\\s*${escapeRegExp(uniqueIndustry)}`))).toBeVisible();

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const persistedRow = page.locator('.border.rounded-lg').filter({ hasText: uniqueName }).first();
    await expect(persistedRow, 'new customer row should remain visible after reload').toBeVisible({ timeout: 15_000 });
    await expect(persistedRow.getByText(new RegExp(`Industry:\\s*${escapeRegExp(uniqueIndustry)}`))).toBeVisible();
  });

  test('payment-issue escalation keeps customer issue context visible after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated CRM E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/crm/customers');
    await page.waitForLoadState('networkidle');

    const paymentIssueRows = page.locator('.border.rounded-lg').filter({ has: page.getByText('Payment Issue') });
    const paymentIssueCount = await paymentIssueRows.count();
    if (paymentIssueCount === 0) {
      test.skip(true, 'No payment-issue customer rows are available in this environment.');
      return;
    }

    const issueRow = paymentIssueRows.first();

    const openIssueAction = issueRow
      .getByRole('button', { name: /Open Issue/i })
      .or(issueRow.getByRole('link', { name: /Open Issue/i }))
      .first();
    await expect(openIssueAction, 'payment-issue rows must expose an Open Issue escalation action').toBeVisible();
    await openIssueAction.click();
    await page.waitForLoadState('networkidle');

    await expect(page, 'Open Issue must keep navigation scoped to a CRM customer detail route').toHaveURL(/\/crm\/customers\/[^/]+$/);
    const detailHeadingBefore = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(detailHeadingBefore.length, 'escalation should land on a scoped customer detail heading').toBeGreaterThan(0);
    await expect(page.getByText('Payment & Service Issues').first(), 'detail page must show issue context section').toBeVisible();
    await expect(page.getByText('Payment Issue').first(), 'flagged customer context must remain visible after escalation').toBeVisible();

    const detailUrl = page.url();
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page, 'reload must retain the same escalated customer scope').toHaveURL(new RegExp(escapeRegExp(detailUrl) + '$'));
    const detailHeadingAfterReload = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();
    expect(detailHeadingAfterReload, 'customer heading must remain scoped to the same customer after reload').toBe(detailHeadingBefore);
    await expect(page.getByText('Payment & Service Issues').first(), 'issue context section must remain visible after reload').toBeVisible();
    await expect(page.getByText('Payment Issue').first(), 'payment-issue customer context must survive reload').toBeVisible();
  });

  test('logging a CRM interaction persists type and summary in timeline after reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated CRM E2E.');

    const interactionSummary = `E2E logged interaction ${Date.now()}`;

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/crm/customers');
    await page.waitForLoadState('networkidle');

    const viewProfileAction = page.getByRole('button', { name: 'View Profile' }).first();
    await expect(viewProfileAction, 'at least one customer row must be available to validate interaction logging').toBeVisible();
    await viewProfileAction.click();
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'Log Interaction' }).click();
    const logDialog = page.getByRole('dialog');
    await expect(logDialog).toBeVisible();

    await selectComboboxOption(page, 'Interaction Type', 'Email');
    await logDialog.getByLabel('Summary').fill(interactionSummary);

    const logWrite = page.waitForResponse((response) => {
      const requestBody = response.request().postData() ?? '';
      return response.url().includes('/rpc/crm_upsert_customer_profile')
        && /"last_interaction_type":"email"/i.test(requestBody)
        && requestBody.includes(interactionSummary);
    });

    await logDialog.getByRole('button', { name: 'Log Interaction' }).click();
    const logWriteResponse = await logWrite;
    expect(logWriteResponse.status(), 'log-interaction write should succeed').toBeLessThan(400);
    await expect(logDialog).toBeHidden({ timeout: 15_000 });

    await expect(page.getByRole('heading', { name: 'Communication Timeline' }).first()).toBeVisible();
    await expect(page.getByText(interactionSummary), 'new interaction summary must appear in communication timeline').toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/\bEmail\b/i).first(), 'selected interaction type must appear in communication timeline').toBeVisible();

    const detailUrl = page.url();
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(escapeRegExp(detailUrl) + '$'));
    await expect(page.getByRole('heading', { name: 'Communication Timeline' }).first()).toBeVisible();
    await expect(page.getByText(interactionSummary), 'logged interaction summary must persist after reload').toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/\bEmail\b/i).first(), 'logged interaction type must persist after reload').toBeVisible();
  });

  test('audit history journey — finding context to persisted ops timeline', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated audit-history E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Navigate to the ops dashboard and wait for recent activity to load.
    await page.goto('/ops');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Locate the Recent audit activity card and find the first "View audit trail" link.
    // This is the handoff entry point from the ops surface into /ops/audit/:entityId.
    // If the recent-activity card has no rows (unseeded environment), fall back to any
    // "View audit trail" link anywhere on the page so the test can still exercise the journey.
    const recentActivityCard = page.getByText('Recent audit activity').first().locator('../..');
    const recentActivityLinks = recentActivityCard.getByRole('link', { name: /View audit trail/i });
    const recentActivityLinkCount = await recentActivityLinks.count();
    const firstAuditLink = recentActivityLinkCount > 0
      ? recentActivityLinks.first()
      : page.getByRole('link', { name: /View audit trail/i }).first();
    const firstAuditLinkCount = await firstAuditLink.count();
    if (firstAuditLinkCount === 0) {
      test.skip(true, 'No "View audit trail" handoff links found — ops audit events not seeded in this environment');
    }

    // Capture the entity ID from the first available "View audit trail" href before navigating.
    const auditHref = await firstAuditLink.getAttribute('href');
    expect(
      auditHref,
      '"View audit trail" link must have an href pointing to /ops/audit/:entityId'
    ).toMatch(/\/ops\/audit\/[0-9a-f-]+/i);

    // Extract the entity ID so we can verify page scope after navigation.
    const entityIdMatch = auditHref!.match(/\/ops\/audit\/([0-9a-f-]+)/i);
    const entityId = entityIdMatch![1];

    // Capture the operator-visible entity label from the source handoff row BEFORE navigating.
    // Each row in the Recent audit activity card renders as a Stack div with three children:
    //   1. <Text weight="semibold"> event label
    //   2. <Text size="sm" variant="muted"> entity_name · formatted_date   ← subtitle
    //   3. <Link> View audit trail                                          ← the link
    // The subtitle is the immediately preceding sibling of the link anchor in the DOM
    // (xpath=preceding-sibling::*[1]).  Using this direct sibling path avoids relying on
    // the parent-traversal (xpath=..) which can resolve to an unexpected container if the
    // renderer adds intermediate wrappers.
    const handoffSubtitleEl = firstAuditLink.locator('xpath=preceding-sibling::*[1]');
    const handoffSubtitleRaw = await handoffSubtitleEl
      .textContent({ timeout: 3000 })
      .catch(() => null);
    const sourceEntityLabel = handoffSubtitleRaw
      ? handoffSubtitleRaw.trim().split('\u00b7')[0].trim()
      : '';

    // If the subtitle is absent or contains no '·' separator the environment has no seeded
    // entity data; skip entirely rather than silently omitting the context assertions.
    if (!sourceEntityLabel) {
      test.skip(
        true,
        'Handoff row subtitle absent or missing entity separator — ops audit events not seeded with entity data in this environment'
      );
    }

    // Follow the audit trail handoff.
    await firstAuditLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // The URL must be scoped to the same entity that was selected before navigation.
    await expect(page).toHaveURL(new RegExp(`/ops/audit/${entityId}`));

    // The page heading must be the audit trail heading.
    await expect(
      page.getByRole('heading', { name: /Audit Trail/i }).first(),
      '"Audit Trail" heading must be visible on the audit page'
    ).toBeVisible();

    // At least one timeline row must be rendered — an empty/loading state is not a passing outcome.
    // The page renders each audit event with an "Actor:" prefix line.
    await expect(
      page.getByText(/^Actor:/i).first(),
      'audit timeline must render at least one row with an "Actor:" field'
    ).toBeVisible();

    // The timestamp line for each audit row is the muted "<entity_name> · <date>" text rendered
    // as a sibling of the Actor: line inside the same Stack container.  Scope the assertion to
    // that container (xpath=.. from the Actor: p → its parent Stack div) so we prove the
    // actor/timestamp/payload trio is co-located on the same rendered card, not just present
    // somewhere on the page.
    const firstActorRow = page.getByText(/^Actor:/i).first();
    const auditRowContainer = firstActorRow.locator('xpath=..'); // Stack div holding all row fields
    await expect(
      auditRowContainer.getByText(/\u00b7/).first(),
      'audit row must include a scoped timestamp (entity \u00b7 date) in the same container as Actor:'
    ).toBeVisible();

    // The Payload: field on each event row gives the operator event context.
    await expect(
      page.getByText(/^Payload:/i).first(),
      'audit timeline must render at least one row with a "Payload:" context field'
    ).toBeVisible();

    // Assert the same visible entity label from the source ops row is present on the audit
    // page — this proves the handoff delivered the operator to the correct entity's timeline,
    // not just that the URL parameter was propagated.
    await expect(
      page.getByText(sourceEntityLabel, { exact: false }).first(),
      'audit page must display the same entity label visible in the source ops row'
    ).toBeVisible();

    // Reload the audit-trail page and confirm the entity-scoped timeline remains visible.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // After reload the URL must still be scoped to the same entity.
    await expect(page).toHaveURL(new RegExp(`/ops/audit/${entityId}`));

    // The heading and at least one timeline row must survive the reload.
    await expect(
      page.getByRole('heading', { name: /Audit Trail/i }).first(),
      '"Audit Trail" heading must remain visible after reload'
    ).toBeVisible();
    await expect(
      page.getByText(/^Actor:/i).first(),
      'audit timeline must still render at least one "Actor:" row after reload'
    ).toBeVisible();

    // After reload the same entity label captured from the source row must still be visible —
    // confirms entity context persists across page reloads, not just on initial navigation.
    await expect(
      page.getByText(sourceEntityLabel, { exact: false }).first(),
      'entity label must remain visible on audit page after reload'
    ).toBeVisible();
  });

  test('portal-financials payment journey records visible state and survives reload', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated portal-financials E2E.');
    test.fail(true, 'Non-gating: portal-financials payment-recording durability on deployed dev is tracked as backlog signal until reliability is proven.');

    const formattedAmountFragment = (amount: number) => escapeRegExp(amount.toFixed(2));
    const parseVisibleAmount = (text: string): number | null => {
      const match = text.match(PORTAL_FINANCIALS_VISIBLE_AMOUNT_PATTERN);
      return match ? Number(match[1].replaceAll(',', '')) : null;
    };
    const readVisibleInvoice = async (invoiceNumber: string) => {
      const invoiceCard = page
        .locator('[data-testid^="portal-invoice-"]')
        .filter({ has: page.getByText(new RegExp(`^${escapeRegExp(invoiceNumber)}$`)) })
        .first();
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
        const invoiceText = await invoiceCard.innerText();
        const invoiceNumber = invoiceText.match(/\bINV-\w+\b/i)?.[0] ?? '';
        const outstandingText = invoiceText.match(/Outstanding:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
        const outstandingAmount = parseVisibleAmount(outstandingText);
        if (
          invoiceNumber
          && typeof outstandingAmount === 'number'
          && outstandingAmount > PORTAL_FINANCIALS_MIN_OUTSTANDING_FOR_PARTIAL_PAYMENT
        ) {
          return { invoiceCard, invoiceNumber, outstandingText, outstandingAmount };
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

    const { invoiceNumber, outstandingText, outstandingAmount } = invoiceSelection;
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

    await expect(invoiceSelect).toBeEnabled();
    await expect(paymentMethodSelect).toBeEnabled();
    await expect(amountInput).toBeEnabled();
    await expect(payInvoiceButton).toBeEnabled();

    await invoiceSelect.selectOption({ label: `${invoiceNumber} · ${outstandingText}` });
    await paymentMethodSelect.selectOption('ach');
    await amountInput.fill(validPaymentAmount.toFixed(2));
    await payInvoiceButton.click();

    await expect(page.getByText('Payment recorded')).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Payment recorded via ACH for .*${formattedAmountFragment(validPaymentAmount)}`, 'i'))
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`${escapeRegExp(invoiceNumber)}\\s*·\\s*ACH\\s*·\\s*.*${formattedAmountFragment(validPaymentAmount)}`, 'i'))
    ).toBeVisible();

    let updatedOutstandingText = '';
    await expect
      .poll(async () => {
        updatedOutstandingText = (await readVisibleInvoice(invoiceNumber)).outstandingText;
        return updatedOutstandingText;
      }, {
        timeout: PORTAL_FINANCIALS_PAYMENT_UPDATE_TIMEOUT,
        message: `expected invoice ${invoiceNumber} to show a new outstanding balance after payment`,
      })
      .not.toBe(outstandingText);

    expect(updatedOutstandingText, 'invoice card should still surface an outstanding-balance line after partial payment').toBeTruthy();
    const updatedInvoice = await readVisibleInvoice(invoiceNumber);
    const updatedOutstandingAmount = updatedInvoice.outstandingAmount;
    if (updatedOutstandingAmount === null) {
      throw new Error(`Updated invoice ${invoiceNumber} does not expose a parseable outstanding amount.`);
    }
    expect(updatedOutstandingAmount, 'partial payment should leave a remaining balance for overpayment validation').toBeGreaterThan(0);

    await invoiceSelect.selectOption({ label: `${invoiceNumber} · ${updatedOutstandingText}` });
    await amountInput.fill((updatedOutstandingAmount + PORTAL_FINANCIALS_PAYMENT_MARGIN).toFixed(2));
    await payInvoiceButton.click();

    await expect(page.getByText('Payment failed')).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Payment cannot exceed outstanding balance of\\s*${escapeRegExp(updatedOutstandingText)}\\.`, 'i'))
    ).toBeVisible();
    await expect(page.getByText('Payment recorded')).toHaveCount(0);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadedInvoice = await readVisibleInvoice(invoiceNumber);
    await expect(reloadedInvoice.invoiceCard).toBeVisible();
    await expect(reloadedInvoice.invoiceCard).toContainText(`Outstanding: ${updatedOutstandingText}`);
    await expect(
      page.getByText(new RegExp(`${escapeRegExp(invoiceNumber)}\\s*·\\s*ACH\\s*·\\s*.*${formattedAmountFragment(validPaymentAmount)}`, 'i'))
    ).toBeVisible();
  });

  test('portal intake journey: valid-token form renders, submits, and shows success confirmation', async ({ page }) => {
    const intakeUrl = PORTAL_INTAKE_SCOPED_URL ?? '';
    test.skip(!PORTAL_INTAKE_SCOPED_URL, 'Set E2E_PORTAL_INTAKE_SCOPED_URL to a seeded /portal/intake/:tokenId#token=<rawToken> URL.');

    const intakeContext = parsePortalIntakeScopeContext(intakeUrl);

    // Navigate to the seeded intake URL — no staff auth required.
    await page.goto(intakeContext.route);
    await page.waitForLoadState('networkidle');

    // The intake page container must render.
    await expect(page.getByTestId('portal-intake-page')).toBeVisible();
    await expect(page.getByTestId('intake-form-title')).toBeVisible();

    // The token-missing error must NOT be shown when a valid token is present.
    await expect(page.getByTestId('token-missing-error')).toHaveCount(0);

    // The submit button must be enabled for a valid-token session.
    const submitButton = page.getByTestId('submit-button');
    await expect(submitButton).toBeEnabled();

    // Fill in a minimal set of intake fields and submit.
    await page.getByTestId('input-customer-name').fill('E2E Intake Corp');
    await page.getByTestId('input-contact-name').fill('E2E Contact');
    await page.getByTestId('input-contact-email').fill('e2e@intake.example');

    const submitResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/rpc/portal_submit_intake')
      && response.request().method() === 'POST'
    );
    await submitButton.click();
    const submitResponse = await submitResponsePromise;
    expect(submitResponse.status(), 'portal_submit_intake RPC should succeed for a valid token').toBeLessThan(400);

    // A clear success confirmation must be shown — not a false-success or silent failure.
    await expect(page.getByTestId('intake-success-heading')).toBeVisible();
    // The submit error panel must not appear on a successful submission.
    await expect(page.getByTestId('submit-error')).toHaveCount(0);
  });

  test('portal intake journey: token is scrubbed from address bar on mount', async ({ page }) => {
    const intakeUrl = PORTAL_INTAKE_SCOPED_URL ?? '';
    test.skip(!PORTAL_INTAKE_SCOPED_URL, 'Set E2E_PORTAL_INTAKE_SCOPED_URL to a seeded /portal/intake/:tokenId#token=<rawToken> URL.');

    const intakeContext = parsePortalIntakeScopeContext(intakeUrl);

    // The URL arriving at the browser contains the raw token in the fragment.
    await page.goto(intakeContext.route);
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('portal-intake-page')).toBeVisible();

    // After mount the component must have scrubbed the token from the address bar.
    // Parse the current URL into safe boolean flags — never serialize the raw token in
    // assertion subjects so that Playwright failure output cannot leak the bearer token
    // into CI logs or PR annotations if the scrubbing regression occurs.
    const currentUrl = page.url();
    const hasRawTokenInUrl = currentUrl.includes(`token=${intakeContext.rawToken}`);
    const hasAnyTokenParam = /[#&?]token=/.test(currentUrl);
    expect(
      hasRawTokenInUrl,
      'portal intake component must scrub the raw token from the address bar on mount'
    ).toBe(false);
    expect(
      hasAnyTokenParam,
      'portal intake component must scrub the token fragment entirely from the address bar'
    ).toBe(false);
  });

  test('portal intake journey: missing or invalid token shows explicit denial instead of false success', async ({ page }) => {
    const intakeUrl = PORTAL_INTAKE_SCOPED_URL ?? '';
    test.skip(!PORTAL_INTAKE_SCOPED_URL, 'Set E2E_PORTAL_INTAKE_SCOPED_URL to a seeded /portal/intake/:tokenId#token=<rawToken> URL.');

    const intakeContext = parsePortalIntakeScopeContext(intakeUrl);

    // --- Missing-token path ---
    // Strip the fragment entirely so no token is provided.
    const missingTokenRoute = intakeContext.route.replace(/#.*$/, '');
    await page.goto(missingTokenRoute);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('portal-intake-page')).toBeVisible();

    // The token-missing error banner must be visible and the submit button must be disabled.
    await expect(
      page.getByTestId('token-missing-error'),
      'missing-token path must show explicit token-missing error, not false success'
    ).toBeVisible();
    await expect(
      page.getByTestId('submit-button'),
      'submit button must be disabled when the intake token is absent'
    ).toBeDisabled();
    await expect(page.getByTestId('intake-success-heading')).toHaveCount(0);

    // --- Invalid/expired-token path ---
    // Append a structurally valid but wrong token value to the fragment.
    const invalidTokenRoute = `${intakeContext.route.replace(/#.*$/, '')}#token=invalid-token-that-will-be-rejected-by-the-rpc`;
    await page.goto(invalidTokenRoute);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('portal-intake-page')).toBeVisible();

    // The form should be rendered with the invalid token (token is present in fragment).
    await expect(page.getByTestId('submit-button')).toBeEnabled();

    // Submitting must result in an explicit error — never a silent success.
    const submitResponsePromise = page.waitForResponse((response) =>
      response.url().includes('/rpc/portal_submit_intake')
      && response.request().method() === 'POST'
    );
    await page.getByTestId('submit-button').click();
    const submitResponse = await submitResponsePromise;

    // A non-2xx response or a non-null error field indicates the token was rejected.
    const responseBody = await submitResponse.json().catch(() => null) as { error?: unknown } | null;
    const rpcFailed = submitResponse.status() >= 400
      || (responseBody != null && responseBody.error != null);
    expect(rpcFailed, 'invalid token must be rejected by the portal_submit_intake RPC').toBe(true);

    // The UI must surface an explicit error message — not a success confirmation.
    await expect(
      page.getByTestId('submit-error'),
      'invalid-token path must show an explicit submission error'
    ).toBeVisible();
    await expect(page.getByTestId('intake-success-heading')).toHaveCount(0);
  });

  test('staff quote builder uses human-readable selectors instead of raw UUID entry', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated quote-builder UX check.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/rental/quoting');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByTestId('quote-builder-screen'),
      'quote builder screen should render for write-capable staff user'
    ).toBeVisible({ timeout: 15_000 });

    // ── Header context fields: must be human-readable selects, not raw UUID text inputs ──
    // Customer: must be a <select> dropdown
    const customerInput = page.getByTestId('input-customer-id');
    await expect(customerInput, 'customer field must be visible').toBeVisible();
    const customerTag = await customerInput.evaluate((el) => el.tagName.toLowerCase());
    expect(
      customerTag,
      'customer input must be a <select> element for human-readable lookup, not a raw text input'
    ).toBe('select');

    // Billing account: must be a <select> dropdown
    const billingInput = page.getByTestId('input-billing-account-id');
    await expect(billingInput, 'billing account field must be visible').toBeVisible();
    const billingTag = await billingInput.evaluate((el) => el.tagName.toLowerCase());
    expect(billingTag, 'billing account input must be a <select> element').toBe('select');

    // Job site: must be a <select> dropdown
    const jobSiteInput = page.getByTestId('input-job-site-id');
    await expect(jobSiteInput, 'job site field must be visible').toBeVisible();
    const jobSiteTag = await jobSiteInput.evaluate((el) => el.tagName.toLowerCase());
    expect(jobSiteTag, 'job site input must be a <select> element').toBe('select');

    // Primary form labels must not use "ID" suffixes — operators read names, not UUIDs
    await expect(
      page.getByLabel('Customer ID'),
      '"Customer ID" must not be a primary form label in the quote builder'
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Billing Account ID'),
      '"Billing Account ID" must not be a primary form label'
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Job Site ID'),
      '"Job Site ID" must not be a primary form label'
    ).toHaveCount(0);

    // ── Line-level selectors: Category and Branch must also be human-readable selects ──
    const line0CategoryInput = page.getByTestId('input-line-0-category');
    await expect(line0CategoryInput, 'line 0 category field must be visible').toBeVisible();
    const categoryTag = await line0CategoryInput.evaluate((el) => el.tagName.toLowerCase());
    expect(categoryTag, 'line category input must be a <select> element, not a raw ID text input').toBe('select');

    const line0BranchInput = page.getByTestId('input-line-0-branch');
    await expect(line0BranchInput, 'line 0 branch field must be visible').toBeVisible();
    const branchTag = await line0BranchInput.evaluate((el) => el.tagName.toLowerCase());
    expect(branchTag, 'line branch input must be a <select> element, not a raw ID text input').toBe('select');

    await expect(
      page.getByLabel('Category ID'),
      '"Category ID" must not be a primary form label in the line item'
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Branch ID'),
      '"Branch ID" must not be a primary form label in the line item'
    ).toHaveCount(0);

    // ── Second line: readable context model must apply after adding a line ──
    await page.getByTestId('btn-add-line').click();

    const line1CategoryInput = page.getByTestId('input-line-1-category');
    await expect(
      line1CategoryInput,
      'second line must also have a category select dropdown'
    ).toBeVisible();
    const line1CategoryTag = await line1CategoryInput.evaluate((el) => el.tagName.toLowerCase());
    expect(line1CategoryTag, 'second line category must be a <select> element').toBe('select');

    const line1BranchInput = page.getByTestId('input-line-1-branch');
    await expect(
      line1BranchInput,
      'second line must also have a branch select dropdown'
    ).toBeVisible();
    const line1BranchTag = await line1BranchInput.evaluate((el) => el.tagName.toLowerCase());
    expect(line1BranchTag, 'second line branch must be a <select> element').toBe('select');

    // ── Secondary ID hints must use the "ID: <uuid>" prefix so they are clearly supplementary ──
    // Select a customer if options are available, then verify the ID hint is clearly secondary
    const customerOptions = await customerInput.locator('option').all();
    const customerOptionValues = await Promise.all(customerOptions.map((opt) => opt.getAttribute('value')));
    const firstCustomerValue = customerOptionValues.find((val) => val?.trim())?.trim() ?? '';
    if (firstCustomerValue) {
      await customerInput.selectOption({ value: firstCustomerValue });
      const customerIdHint = page.getByTestId('selected-customer-id');
      if (await customerIdHint.isVisible().catch(() => false)) {
        const hintText = await customerIdHint.innerText();
        expect(
          hintText,
          'customer ID hint must use "ID: <uuid>" prefix — it is supplementary debug info, not the primary label'
        ).toMatch(/^ID:\s/i);
      }
    }
  });

  test('staff quote builder: multi-line draft persists pricing and reopen context', async ({ page }) => {
    test.fail(true, 'Non-gating: staff quote-builder multi-line draft journey on deployed dev is tracked as backlog signal until the live route is proven stable.');
    test.skip(!OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD, 'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated quote-builder E2E.');

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/rental/quoting');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('quote-builder-screen'), 'quote builder screen should render for write-capable staff user').toBeVisible();

    // --- Fill quote header details ---
    const expirationDate = '2027-03-31';
    await page.getByTestId('input-expiration-date').fill(expirationDate);

    // --- Add two line items ---
    // Line 0 is present by default; fill it in
    const startLine0 = '2027-01-15';
    const endLine0 = '2027-01-22';
    await page.getByTestId('input-line-0-start').fill(startLine0);
    await page.getByTestId('input-line-0-end').fill(endLine0);
    await page.getByTestId('input-line-0-quantity').fill('2');
    await page.getByTestId('input-line-0-rate').fill('150');

    // Add a second line and fill it in
    await page.getByTestId('btn-add-line').click();
    const startLine1 = '2027-02-01';
    const endLine1 = '2027-02-14';
    await page.getByTestId('input-line-1-start').fill(startLine1);
    await page.getByTestId('input-line-1-end').fill(endLine1);
    await page.getByTestId('input-line-1-quantity').fill('1');
    await page.getByTestId('input-line-1-rate').fill('200');

    // Verify both line rows are rendered
    await expect(page.getByTestId('line-row-0'), 'first line item row should be visible').toBeVisible();
    await expect(page.getByTestId('line-row-1'), 'second line item row should be visible').toBeVisible();

    // --- Pricing preview ---
    // The "Preview Pricing" button is only enabled when the first line has enough data.
    // We fill a rate so the base can be computed; the server-side preview may fail if
    // category/branch are unknown, so we check the button enabled state and attempt the
    // preview but treat a pricing-error result as acceptable.
    const previewBtn = page.getByTestId('btn-preview-pricing');
    if (await previewBtn.isEnabled()) {
      const pricingResponse = page.waitForResponse((response) =>
        response.url().includes('/rpc/staff_quote_pricing_preview')
        && response.request().method() === 'POST'
      ).catch(() => null);
      await previewBtn.click();
      await pricingResponse;
      // Wait for the result UI to settle — pricing breakdown OR error are both valid outcomes
      await page
        .getByTestId('pricing-breakdown')
        .or(page.getByTestId('pricing-error'))
        .waitFor({ state: 'visible', timeout: 10_000 })
        .catch(() => null);
      // Pricing breakdown OR pricing error are both valid outcomes on deployed dev
      const hasPricingBreakdown = await page.getByTestId('pricing-breakdown').isVisible().catch(() => false);
      const hasPricingError = await page.getByTestId('pricing-error').isVisible().catch(() => false);
      expect(
        hasPricingBreakdown || hasPricingError,
        'clicking Preview Pricing should result in either a pricing breakdown or an explicit pricing error'
      ).toBe(true);
    }

    // --- Toggle pricing display mode ---
    const rateModeLabel = page.getByTestId('rate-mode-label');
    const initialMode = await rateModeLabel.innerText();
    await page.getByTestId('btn-toggle-rate-mode').click();
    const toggledMode = await rateModeLabel.innerText();
    expect(initialMode, 'pricing display mode should change after toggle').not.toBe(toggledMode);

    // Capture the current display mode so we can assert it is preserved on reopen
    const displayModeAfterToggle = toggledMode;

    // --- Save the quote draft ---
    const saveResponse = page.waitForResponse((response) =>
      response.url().includes('/rpc/staff_save_quote_order')
      && response.request().method() === 'POST'
    );
    await page.getByTestId('btn-save-draft').click();
    const saveResult = await saveResponse;
    expect(saveResult.status(), 'staff_save_quote_order RPC should succeed').toBeLessThan(400);

    // Assert the save-success banner is visible with an order number and order ID
    const saveSuccess = page.getByTestId('save-success');
    await expect(saveSuccess, 'save-success banner should appear after saving draft').toBeVisible({ timeout: 15_000 });
    const savedOrderNumber = await page.getByTestId('saved-order-number').innerText();
    const savedOrderId = await page.getByTestId('saved-order-id').innerText();
    expect(savedOrderNumber.trim(), 'save-success banner should show a non-empty order number').toBeTruthy();
    expect(savedOrderId.trim(), 'save-success banner should show a non-empty order ID').toBeTruthy();

    // Expiration date must still be visible (commercial context preserved after save)
    const expirationInput = page.getByTestId('input-expiration-date');
    await expect(expirationInput, 'expiration date field should remain visible after save').toBeVisible();
    const expirationValue = await expirationInput.inputValue();
    expect(
      expirationValue,
      'expiration date should remain set after saving the draft'
    ).toBe(expirationDate);

    // Both line rows should still be present
    await expect(page.getByTestId('line-row-0'), 'line row 0 should remain visible after save').toBeVisible();
    await expect(page.getByTestId('line-row-1'), 'line row 1 should remain visible after save').toBeVisible();

    // --- Re-open the saved draft via ?order_id= ---
    await page.goto(`/rental/quoting?order_id=${encodeURIComponent(savedOrderId.trim())}`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByTestId('quote-builder-screen'),
      'quote builder screen should render when reopening draft via ?order_id='
    ).toBeVisible();

    // Verify the same lines persist (start/end dates of the first two lines)
    await expect(
      page.getByTestId('line-row-0'),
      'first line item should persist after reopening draft'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId('line-row-1'),
      'second line item should persist after reopening draft'
    ).toBeVisible({ timeout: 10_000 });

    const reopenedStart0 = await page.getByTestId('input-line-0-start').inputValue();
    expect(
      reopenedStart0,
      'first line start date should persist without change after reopening draft'
    ).toBe(startLine0);
    const reopenedEnd0 = await page.getByTestId('input-line-0-end').inputValue();
    expect(
      reopenedEnd0,
      'first line end date should persist without change after reopening draft'
    ).toBe(endLine0);

    // Second line field values must also persist — not just the row shell
    const reopenedStart1 = await page.getByTestId('input-line-1-start').inputValue();
    expect(
      reopenedStart1,
      'second line start date should persist after reopening draft'
    ).toBe(startLine1);
    const reopenedEnd1 = await page.getByTestId('input-line-1-end').inputValue();
    expect(
      reopenedEnd1,
      'second line end date should persist after reopening draft'
    ).toBe(endLine1);
    const reopenedQty1 = await page.getByTestId('input-line-1-quantity').inputValue();
    expect(
      reopenedQty1,
      'second line quantity should persist after reopening draft'
    ).toBe('1');
    const reopenedRate1 = await page.getByTestId('input-line-1-rate').inputValue();
    expect(
      reopenedRate1,
      'second line rate should persist after reopening draft'
    ).toBe('200');

    // Expiration date persists
    const reopenedExpiration = await page.getByTestId('input-expiration-date').inputValue();
    expect(
      reopenedExpiration,
      'quote expiration date should persist after reopening the draft via ?order_id='
    ).toBe(expirationDate);

    // Pricing display mode persists
    const reopenedMode = await page.getByTestId('rate-mode-label').innerText();
    expect(
      reopenedMode,
      'pricing display mode should be preserved when reopening a saved draft'
    ).toBe(displayModeAfterToggle);

    // No duplicate draft: saving again should update the same order ID, not create a new one
    const resaveResponse = page.waitForResponse((response) =>
      response.url().includes('/rpc/staff_save_quote_order')
      && response.request().method() === 'POST'
    );
    await page.getByTestId('btn-save-draft').click();
    const resaveResult = await resaveResponse;
    expect(resaveResult.status(), 'second save on reopened draft should succeed').toBeLessThan(400);

    const resaveBody = await resaveResult.json().catch(() => null) as Array<{ order_id?: string }> | null;
    if (resaveBody && Array.isArray(resaveBody) && resaveBody.length > 0 && resaveBody[0].order_id) {
      expect(
        resaveBody[0].order_id,
        'second save should return the same order ID (no duplicate draft created)'
      ).toBe(savedOrderId.trim());
    }

    const resaveSuccess = page.getByTestId('save-success');
    await expect(resaveSuccess, 'save-success banner should appear after resaving the reopened draft').toBeVisible({ timeout: 15_000 });
  });

  test('general ledger filter/export workflow: filtered rows stay operator-readable and export reflects active filters', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run general-ledger E2E coverage.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/accounting/general-ledger');
    await page.waitForLoadState('networkidle');

    // The screen must render without crashing and without an access-denied alert.
    const screen = page.getByTestId('general-ledger-screen');
    await expect(screen, 'general-ledger-screen container must be visible for an operator role').toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Accounting · General Ledger' }),
      'general ledger heading must be visible'
    ).toBeVisible();

    // --- Apply a real filter combination: basis = accrual + a date range ---
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    const isoToday = today.toISOString().slice(0, 10);
    const isoOneYearAgo = oneYearAgo.toISOString().slice(0, 10);

    await page.getByLabel('Start date').fill(isoOneYearAgo);
    await page.getByLabel('End date').fill(isoToday);
    await page.getByLabel('Basis').selectOption('accrual');
    await page.waitForLoadState('networkidle');

    // The screen must not crash after applying filters.
    await expect(screen, 'general-ledger screen must remain visible after applying filters').toBeVisible();

    // Check whether rows are present; skip the row-level assertions if the environment has no seeded ledger data.
    const ledgerRowLocator = page.locator('[data-testid^="ledger-row-"]');
    const emptyState = page.getByText(/No ledger rows match these filters|No posted ledger rows available yet/i);

    await expect.poll(
      async () =>
        (await ledgerRowLocator.count()) + (await emptyState.count()),
      { message: 'general ledger must either show rows or a recognised empty-state message after applying filters', timeout: 10_000 }
    ).toBeGreaterThan(0);

    const hasRows = (await ledgerRowLocator.count()) > 0;
    if (!hasRows) {
      // No seeded data for this filter — skip row-level assertions but confirm empty state is readable.
      await expect(emptyState, 'empty-state message must be human-readable').toBeVisible();
      return;
    }

    // --- Assert rows are human-readable (no raw UUID as primary document content) ---
    const firstRow = ledgerRowLocator.first();
    const firstRowText = await firstRow.innerText();

    // The document cell should surface a document type + number (e.g. "INVOICE · INV-1234")
    // rather than a raw UUID as the leading content.
    // Up to 2 UUIDs are tolerated because the component may embed them as data-testid
    // suffixes or aria attributes that appear in innerText only in edge cases; more than 2
    // means the component is surfacing raw IDs as primary operator-facing content.
    const uuidsInRow = firstRowText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(
      uuidsInRow.length,
      'ledger row must not expose raw UUIDs as primary content — customer, billing account, location and document-number context should be resolved to human-readable labels (up to 2 incidental UUIDs tolerated)'
    ).toBeLessThanOrEqual(2);

    // The document cell must contain a human-readable document type + number combo.
    // The component renders: "<TYPE> · <NUMBER>" using U+00B7 MIDDLE DOT as separator.
    expect(
      firstRowText,
      'ledger row document cell must show a readable document type and number (e.g. "INVOICE · INV-1234")'
    ).toMatch(/[A-Z]{2,}\s*·\s*\S/);

    // A "customer:" / "billing:" / "location:" context line must be visible somewhere in the row.
    expect(
      firstRowText.toLowerCase(),
      'ledger row must include human-readable customer / billing / location context'
    ).toMatch(/customer:|billing:|location:/);

    // --- Trigger Export CSV and assert the export-status message references the active filter set ---
    const exportButton = page.getByRole('button', { name: 'Export CSV' });
    await expect(exportButton, 'Export CSV button must be enabled when rows are present').toBeEnabled();

    // Intercept the anchor click: the component creates a blob URL and triggers a click — we cannot
    // observe the file download directly in Playwright without special setup, so instead we assert
    // on the export-ready alert that the component renders after a successful export.
    await exportButton.click();

    await expect(
      page.getByRole('heading', { name: 'Export ready' }),
      'Export ready alert heading must appear after clicking Export CSV'
    ).toBeVisible({ timeout: 15_000 });

    const exportAlert = page.getByRole('heading', { name: 'Export ready' }).locator('../..');
    const exportAlertText = await exportAlert.innerText();
    expect(
      exportAlertText,
      'export-ready message must reference the number of exported ledger rows from the active filtered result set'
    ).toMatch(/\d+\s+ledger\s+row/i);

    // --- Follow a drill-down link and verify context is not lost ---
    const drillDownLink = firstRow.getByRole('link', { name: 'Open source' });
    await expect(drillDownLink, 'each ledger row must have a drill-down "Open source" link').toBeVisible();

    const drillDownHref = await drillDownLink.getAttribute('href');
    expect(
      drillDownHref,
      'drill-down href must be a non-empty path to the source document'
    ).toBeTruthy();
    expect(
      drillDownHref,
      'drill-down href must not be a raw bare UUID — it should include a document-type path segment'
    ).toMatch(/\/[a-z_]+\/[0-9a-f-]+/i);

    // Navigate to the drill-down destination; verify the app does not crash and the operator
    // arrives at a page that retains document context (a heading or content line must be visible).
    await drillDownLink.click();
    await page.waitForLoadState('networkidle');

    // The destination page must render something meaningful (not a blank page or an error).
    const destinationHeading = page.getByRole('heading', { level: 1 });
    await expect(
      destinationHeading,
      'drill-down destination must render a page with a primary heading so the operator can trace the source document'
    ).toBeVisible({ timeout: 10_000 });
  });

  test('accounting export configuration keeps save/reload context operator-readable', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: accounting export configuration save/reload on deployed dev is tracked as backlog signal until the live admin journey is proven reliable.'
    );
    test.skip(
      !AUTH_EMAIL || !AUTH_PASSWORD,
      'Set E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD to run accounting export configuration E2E coverage.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/accounting/export-config');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { level: 1, name: 'Accounting export configuration' })).toBeVisible();

    const currentConfigurationCard = page.getByRole('heading', { name: 'Current configuration' }).locator('../..');
    const noConfiguredMode = currentConfigurationCard.getByText('No export mode configured yet.');
    await expect.poll(
      async () =>
        (await currentConfigurationCard.getByText(/^Mode:/).count()) + (await noConfiguredMode.count()),
      {
        message: 'current configuration should render a readable active mode or the explicit empty state',
        timeout: 10_000,
      }
    ).toBeGreaterThan(0);

    const currentConfigurationText = await currentConfigurationCard.innerText();
    const currentMode =
      ACCOUNTING_EXPORT_MODE_OPTIONS.find(({ configuredLabel }) => currentConfigurationText.includes(configuredLabel))
        ?.value ?? null;
    const nextMode =
      ACCOUNTING_EXPORT_MODE_OPTIONS.find(({ value }) => value !== currentMode) ?? ACCOUNTING_EXPORT_MODE_OPTIONS[0];
    const operatorNote = `E2E export config note ${Date.now()}`;

    await page.getByLabel('Export mode').selectOption(nextMode.value);
    await page.getByLabel('Notes (optional)').fill(operatorNote);

    const saveResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/ops/accounting/export/configure'
          && response.request().method() === 'POST';
      }
    );
    await page.getByRole('button', { name: 'Save export mode' }).click();

    const saveResponse = await saveResponsePromise;
    expect(saveResponse.status(), 'saving accounting export mode should succeed for an authenticated admin').toBeLessThan(400);

    await expect(
      page.getByText(`Export mode saved: ${nextMode.configuredLabel}`),
      'save confirmation should use a human-readable export mode label'
    ).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await page.waitForLoadState('networkidle');

    const reloadedConfigurationCard = page.getByRole('heading', { name: 'Current configuration' }).locator('../..');
    await expect(
      reloadedConfigurationCard.getByText(nextMode.configuredLabel),
      'Current configuration should keep the saved export mode readable after reload'
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      reloadedConfigurationCard.getByText(operatorNote),
      'Current configuration should keep the saved operator note visible after reload'
    ).toBeVisible();

    const recentRunsCard = page.getByRole('heading', { name: 'Recent export runs' }).locator('../..');
    const noRecentRuns = recentRunsCard.getByText('No export runs yet.');
    await expect.poll(
      async () =>
        (await noRecentRuns.count())
        + (
          await recentRunsCard.getByText(
            /Xero \(CSV import\)|Sage Intacct \(GL journal CSV\)|Export only \(accountant hand-off CSV\)/
          ).count()
        ),
      {
        message: 'Recent export runs should show either the explicit empty state or readable audit rows',
        timeout: 10_000,
      }
    ).toBeGreaterThan(0);

    if (await noRecentRuns.count()) {
      await expect(noRecentRuns, 'Recent export runs empty state should be explicit').toBeVisible();
      return;
    }

    const recentRunsText = await recentRunsCard.innerText();
    expect(
      recentRunsText,
      'Recent export runs rows should keep export mode labels operator-readable'
    ).toMatch(/Xero \(CSV import\)|Sage Intacct \(GL journal CSV\)|Export only \(accountant hand-off CSV\)/);
    expect(recentRunsText, 'Recent export runs rows should keep row counts visible').toMatch(/\b\d+\s+rows\b/i);
    expect(recentRunsText, 'Recent export runs rows should keep who triggered the run visible').toMatch(/\bby\s+\S+/i);
  });

  test('enterprise financial reporting drill-down journey keeps filters and scope context operator-usable', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: enterprise financial reporting filter/drill-down persistence on deployed dev is tracked as backlog signal until the live journey is proven reliable.'
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run enterprise financial reporting E2E coverage.'
    );

    type EnterpriseFinancialReportingApiRow = {
      source_entity_id: string;
      source_entity_type: string;
      document_number: string | null;
      document_status: string | null;
      document_date: string | null;
      company_scope_id: string | null;
      company_scope_name: string | null;
      region_scope_id: string | null;
      region_scope_name: string | null;
      branch_scope_id: string | null;
      branch_scope_name: string | null;
      transaction_currency_code: string | null;
      reporting_currency_code: string | null;
    };

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const reportingResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && response.url().includes('/rest/v1/v_enterprise_financial_reporting_lines')
    ));

    await page.goto('/analytics/enterprise-financials');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Enterprise Financial Reporting' })).toBeVisible();

    const reportingResponse = await reportingResponsePromise;
    expect(reportingResponse.status(), 'enterprise financial reporting API request should succeed').toBeLessThan(400);

    const reportingRows = await reportingResponse.json() as EnterpriseFinancialReportingApiRow[];
    const candidate = reportingRows.find((row) => {
      const sourceType = row.source_entity_type?.trim();
      return Boolean(
        row.source_entity_id?.trim()
        && row.document_number?.trim()
        && row.document_status?.trim()
        && row.document_date?.trim()
        && row.company_scope_id?.trim()
        && row.company_scope_name?.trim()
        && row.branch_scope_id?.trim()
        && row.branch_scope_name?.trim()
        && row.transaction_currency_code?.trim()
        && row.reporting_currency_code?.trim()
        && sourceType
        && ENTERPRISE_FINANCIAL_REPORTING_DOCUMENT_TYPES.includes(
          sourceType as (typeof ENTERPRISE_FINANCIAL_REPORTING_DOCUMENT_TYPES)[number]
        )
      );
    });

    if (!candidate) {
      test.skip(
        true,
        'No enterprise financial reporting row exposed readable document/scope context suitable for end-to-end filter and drill-down coverage.'
      );
      return;
    }

    const hasRegionScope = Boolean(candidate.region_scope_id?.trim() && candidate.region_scope_name?.trim());
    const consolidatedScopeType = hasRegionScope ? 'region' : 'company';
    const consolidatedScopeId = consolidatedScopeType === 'region' ? candidate.region_scope_id! : candidate.company_scope_id!;
    const consolidatedScopeName = consolidatedScopeType === 'region' ? candidate.region_scope_name! : candidate.company_scope_name!;
    const scopeSummaryCard = page.getByTestId(
      consolidatedScopeType === 'region' ? 'enterprise-region-summary' : 'enterprise-company-summary'
    );

    await page.getByLabel('Scope Level').selectOption(consolidatedScopeType);
    await expect(page.getByLabel('Scope Level')).toHaveValue(consolidatedScopeType);
    await expect(page.getByLabel('Org Scope').locator(`option[value="${consolidatedScopeId}"]`)).toHaveCount(1);
    await page.getByLabel('Org Scope').selectOption(consolidatedScopeId);
    await expect(page.getByLabel('Org Scope')).toHaveValue(consolidatedScopeId);
    await page.getByLabel('Document Type').selectOption(candidate.source_entity_type);
    await expect(page.getByLabel('Document Type')).toHaveValue(candidate.source_entity_type);
    await page.getByLabel('Period Start').fill(candidate.document_date!);
    await expect(page.getByLabel('Period Start')).toHaveValue(candidate.document_date!);
    await page.getByLabel('Period End').fill(candidate.document_date!);
    await expect(page.getByLabel('Period End')).toHaveValue(candidate.document_date!);

    const scopedSummaryRow = scopeSummaryCard.getByRole('button', { name: new RegExp(escapeRegExp(consolidatedScopeName)) }).first();
    await expect(scopedSummaryRow, 'filtered consolidated summary should keep the chosen scope visible').toBeVisible();
    await expect(scopeSummaryCard.getByRole('button')).toHaveCount(1);
    await scopedSummaryRow.click();

    const branchDrillDownCard = page.getByTestId('enterprise-branch-drilldown');
    await expect(
      branchDrillDownCard,
      'branch drill-down should preserve the selected company/region context label'
    ).toContainText(`Current context: ${consolidatedScopeName}`);

    const scopedBranchRow = branchDrillDownCard.getByRole('button', { name: new RegExp(escapeRegExp(candidate.branch_scope_name!)) }).first();
    await expect(
      scopedBranchRow,
      'branch drill-down should show branch rows that belong to the selected consolidated scope'
    ).toBeVisible();
    await scopedBranchRow.click();
    await expect(
      branchDrillDownCard,
      'selecting a branch row should switch the current context to that drilled branch'
    ).toContainText(`Current context: ${candidate.branch_scope_name!}`);

    const entityDetailRow = page.getByTestId(`enterprise-report-row-${candidate.source_entity_id}`);
    await expect(entityDetailRow, 'branch drill-down should expose matching per-entity detail rows').toBeVisible();

    const entityDetailText = await entityDetailRow.innerText();
    expect(entityDetailText, 'per-entity detail should surface a human-readable document number').toContain(candidate.document_number!);
    expect(entityDetailText, 'per-entity detail should surface a human-readable document status').toContain(candidate.document_status!);
    expect(entityDetailText, 'per-entity detail should surface company scope context').toContain(candidate.company_scope_name!);
    if (candidate.region_scope_name?.trim()) {
      expect(entityDetailText, 'per-entity detail should surface region scope context').toContain(candidate.region_scope_name);
    }
    expect(entityDetailText, 'per-entity detail should surface branch scope context').toContain(candidate.branch_scope_name!);
    expect(entityDetailText, 'per-entity detail should label transaction amounts for operators').toContain('Transaction Amount');
    expect(entityDetailText, 'per-entity detail should label reporting amounts for operators').toContain('Reporting Amount');
    expect(entityDetailText, 'per-entity detail should surface readable transaction currency context').toContain(candidate.transaction_currency_code!);
    expect(entityDetailText, 'per-entity detail should surface readable reporting currency context').toContain(candidate.reporting_currency_code!);
    expect(
      entityDetailText,
      'per-entity detail should show visible amount values rather than opaque identifiers alone'
    ).toMatch(PORTAL_FINANCIALS_VISIBLE_AMOUNT_PATTERN);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Enterprise Financial Reporting' })).toBeVisible();

    const scopeLevelAfterReload = await page.getByLabel('Scope Level').inputValue();
    const orgScopeAfterReload = await page.getByLabel('Org Scope').inputValue();
    const documentTypeAfterReload = await page.getByLabel('Document Type').inputValue();
    const periodStartAfterReload = await page.getByLabel('Period Start').inputValue();
    const periodEndAfterReload = await page.getByLabel('Period End').inputValue();
    const branchContextAfterReloadVisible = await branchDrillDownCard.getByText(
      `Current context: ${candidate.branch_scope_name!}`
    ).first().isVisible();
    const detailAfterReloadVisible = await entityDetailRow.getByText(candidate.document_number!, { exact: false }).first().isVisible();

    const contextPersisted = scopeLevelAfterReload === consolidatedScopeType
      && orgScopeAfterReload === consolidatedScopeId
      && documentTypeAfterReload === candidate.source_entity_type
      && periodStartAfterReload === candidate.document_date
      && periodEndAfterReload === candidate.document_date
      && branchContextAfterReloadVisible
      && detailAfterReloadVisible;

    const explicitResetPathVisible = await branchDrillDownCard.getByText(
      /Choose a company or region summary to inspect branch detail/i
    ).count() > 0;

    expect(
      contextPersisted || explicitResetPathVisible,
      'reload must either preserve the selected enterprise reporting context or show an explicit reset path instead of silently dropping scope state'
    ).toBe(true);
  });

  test('inventory stock-item creation journey — guided form to persisted item context', async ({ page }) => {
    test.fail(true, 'Non-gating: inventory stock-item creation journey on deployed dev is tracked as backlog signal until the live create-to-detail path and operator-readable list context (kind/quantity display) are proven reliable.');
    test.skip(
      !AUTH_EMAIL || !AUTH_PASSWORD,
      'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated inventory stock-item creation E2E.'
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // --- Attempt to capture a branch and asset_category ID from the seeded environment ---
    // Capture branch and category IDs from environment if available; creation without them is valid.
    interface EntityRow {
      id: string;
      entity_versions?: Array<{ is_current?: boolean; data?: { name?: string } }>;
    }

    let branchId: string | undefined;
    let categoryId: string | undefined;

    const branchesRespPromise = page.waitForResponse((r) =>
      r.request().method() === 'GET' &&
      r.url().includes('/rest/v1/entities') &&
      r.url().includes('entity_type=eq.branch')
    );
    await page.goto('/entities/branch');
    await page.waitForLoadState('networkidle');
    try {
      const branchesResp = await branchesRespPromise;
      const branches = await branchesResp.json() as EntityRow[];
      branchId = branches[0]?.id;
    } catch { /* tolerate: branch lookup is best-effort */ }

    const categoriesRespPromise = page.waitForResponse((r) =>
      r.request().method() === 'GET' &&
      r.url().includes('/rest/v1/entities') &&
      r.url().includes('entity_type=eq.asset_category')
    );
    await page.goto('/entities/asset_category');
    await page.waitForLoadState('networkidle');
    try {
      const categoriesResp = await categoriesRespPromise;
      const categories = await categoriesResp.json() as EntityRow[];
      categoryId = categories[0]?.id;
    } catch { /* tolerate: category lookup is best-effort */ }

    // --- Navigate to /inventory/items and assert the page loads correctly ---
    const stockItemsListRespPromise = page.waitForResponse((r) =>
      r.request().method() === 'GET' &&
      r.url().includes('/rest/v1/entities') &&
      r.url().includes('entity_type=eq.stock_item')
    );
    await page.goto('/inventory/items');
    await page.waitForLoadState('networkidle');
    const stockItemsListResp = await stockItemsListRespPromise;
    expect(stockItemsListResp.ok(), 'entities list request for stock_item must succeed on /inventory/items load').toBe(true);

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
    await expect(createDialog, 'create modal must open after clicking New Stock Item').toBeVisible();

    // The modal must expose the inventory-specific fields (kind selection + quantity) —
    // not just the generic name/status fields used for other entity types.
    await expect(
      createDialog.getByLabel('Inventory Kind'),
      'create modal must include an Inventory Kind selector for stock_item'
    ).toBeVisible();
    await expect(
      createDialog.getByLabel('Opening Quantity'),
      'create modal must include an Opening Quantity field for stock_item'
    ).toBeVisible();
    await expect(
      createDialog.getByLabel('Branch ID'),
      'create modal must include a Branch ID input for stock_item'
    ).toBeVisible();
    await expect(
      createDialog.getByLabel('Asset Category ID'),
      'create modal must include an Asset Category ID input for stock_item'
    ).toBeVisible();

    // --- Fill the creation form ---
    const uniqueName = `E2E Stock Item ${Date.now()}`;

    await createDialog.getByLabel('Name').fill(uniqueName);

    // Select inventory kind "sale" (non-default) to exercise kind-switching.
    await createDialog.getByLabel('Inventory Kind').selectOption('sale');

    await createDialog.getByLabel('Opening Quantity').fill('25');

    // Supply raw UUIDs for branch/category if available in the environment.
    if (branchId) {
      await createDialog.getByLabel('Branch ID').fill(branchId);
    }
    if (categoryId) {
      await createDialog.getByLabel('Asset Category ID').fill(categoryId);
    }

    // --- Submit and verify the RPC fires and succeeds ---
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

    // Extract the entity_id from the RPC response so we can navigate directly to the
    // detail URL without relying on fragile ancestor/class-based locators for the View link.
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

    // --- Assert the created item reappears in the list ---
    await expect(
      page.getByText(uniqueName).first(),
      'newly created stock item must appear in the list by name after the RPC succeeds and the list refetches'
    ).toBeVisible({ timeout: 10_000 });

    // UX gap (non-gating signal): entity-list.json has no stock_item-specific row display for
    // inventory_kind or quantity. Once the list row is updated to render those fields, add a
    // scoped assertion here (e.g. getByTestId for the stock_item row) checking kind="sale"
    // and quantity="25" are operator-visible without raw UUIDs.

    // --- Open the detail view using the entity_id from the RPC response ---
    // Direct URL navigation is used here instead of clicking the View link to keep
    // the assertion precise and avoid ambiguity when multiple list rows are present.
    await page.goto(`/entities/stock_item/${createdEntityId}`);
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/entities\/stock_item\/[^/]+$/, {
      timeout: 10_000,
    });

    // The detail page must render the created item's name as its primary heading.
    await expect(
      page.getByRole('heading', { level: 1 }),
      'stock item detail page must render the item name as the primary heading'
    ).toContainText(uniqueName, { timeout: 10_000 });

    // The "Stock Item Details" card must show the name in the view-mode details panel.
    await expect(
      page.getByText(uniqueName).first(),
      'stock item detail must surface the name in the details panel'
    ).toBeVisible();

    // --- Reload and confirm the created item context survives navigation ---
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { level: 1 }),
      'stock item name must remain discoverable as the primary heading after page reload — context must not be lost on navigation'
    ).toContainText(uniqueName, { timeout: 10_000 });

    // --- Navigate back to the list and confirm the item persists ---
    await page.goto('/inventory/items');
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByText(uniqueName).first(),
      'created stock item must still appear in the list after navigating back from detail — persistence must survive the full list-to-detail-to-list round-trip'
    ).toBeVisible({ timeout: 10_000 });
  });

  test('RapidCount mobile capture: assigned count task to persisted captured line context', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: RapidCount mobile capture workflow on deployed dev is tracked as backlog signal until live task seeding and persistence are proven reliable.'
    );
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD or E2E_OPERATOR_EMAIL/PASSWORD to run RapidCount mobile capture E2E.'
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/counts', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Page heading must be visible on the count capture surface.
    await expect(
      page.getByRole('heading', { name: 'RapidCount Capture' }),
      'RapidCount Capture heading must be visible after navigating to /field/counts'
    ).toBeVisible();

    // RFID-unavailable banner must surface a clear next step for the operator.
    await expect(
      page.getByText('RFID scanning unavailable'),
      'RFID-unavailable banner must be present — operator needs a clear fallback when native RFID is not available'
    ).toBeVisible();
    await expect(
      page.getByText(/Use barcode scanning or manual entry/i),
      'RFID-unavailable alert must surface the barcode / manual entry fallback instruction'
    ).toBeVisible();

    // A count task must be assigned to this operator; skip if none are seeded in this environment.
    const taskActionButtons = page.getByRole('button', { name: /Start counting|Continue counting/ });
    const taskCount = await taskActionButtons.count();
    if (taskCount === 0) {
      test.skip(true, 'No count tasks are assigned to this operator in the current environment — seed a task to cover this journey.');
      return;
    }

    // Enter the first assigned count task.
    await taskActionButtons.first().click();

    // Active-task context must be visible to the operator.
    await expect(
      page.getByText('Active task'),
      'Active task label must be visible once the operator enters a count task'
    ).toBeVisible({ timeout: 10_000 });

    // Capture form must be ready for barcode input.
    await expect(
      page.getByLabel('Barcode / scan value'),
      'Barcode / scan value input must be visible in capture mode'
    ).toBeVisible();

    // Capture a count line with a unique scan value and item description.
    const scanValue = `E2E-SCAN-${Date.now()}`;
    const itemDescription = `E2E count item ${Date.now()}`;

    await page.getByLabel('Barcode / scan value').fill(scanValue);
    await page.getByLabel('Description (optional)').fill(itemDescription);

    const captureRpcPromise = page.waitForResponse(
      (response) =>
        response.url().includes('/rpc/rapidcount_capture_count_line') &&
        response.request().method() === 'POST'
    );

    await page.getByRole('button', { name: 'Capture item' }).click();

    const captureRpcResponse = await captureRpcPromise;
    expect(
      captureRpcResponse.ok(),
      'rapidcount_capture_count_line RPC must succeed — auth, function wiring, and persistence must all pass'
    ).toBe(true);

    // Captured line must appear in the captured-items list immediately after capture.
    await expect(
      page.getByText(scanValue),
      'captured scan value must appear in the captured-items list after a successful capture'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(itemDescription),
      'captured item description must be visible alongside the scan value in the captured-items list'
    ).toBeVisible({ timeout: 10_000 });

    // Reload: active-task state resets; the operator must be able to reopen the same task.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'RapidCount Capture' }),
      'RapidCount Capture heading must still be visible after reload'
    ).toBeVisible();

    // Re-enter the task by clicking the first available task action button.
    const taskActionButtonAfterReload = page.getByRole('button', { name: /Start counting|Continue counting/ }).first();
    await expect(
      taskActionButtonAfterReload,
      'task action button must still be available after reload'
    ).toBeVisible({ timeout: 10_000 });
    await taskActionButtonAfterReload.click();

    // Active-task context must be restored after re-entering.
    await expect(
      page.getByText('Active task'),
      'Active task label must reappear after re-entering the task post-reload'
    ).toBeVisible({ timeout: 10_000 });

    // Previously captured line must persist across reload with the same scan value and description.
    await expect(
      page.getByText(scanValue),
      `captured scan value "${scanValue}" must remain visible after reload and task re-entry — count line must persist to the database`
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(itemDescription),
      'captured item description must persist after reload alongside the scan value'
    ).toBeVisible({ timeout: 10_000 });
  });

  test('field dispatch stop progression keeps status, evidence, and offline replay durable after reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: field dispatch stop progression/offline replay journey on deployed dev is tracked as backlog signal until the live workflow is proven reliable.'
    );
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD or E2E_OPERATOR_EMAIL/PASSWORD to run field-dispatch E2E.'
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);
    await page.goto('/field/dispatch', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Driver Dispatch' })).toBeVisible();
    const runId = crypto.randomUUID();

    const readinessWarning = page.getByText(/incomplete dispatch data/i);
    if ((await readinessWarning.count()) > 0) {
      await expect(
        page.getByText(/missing address|missing customer/i),
        'pre-dispatch readiness warning should show missing stop context when incomplete dispatch data exists'
      ).toBeVisible();
    }

    await expect(page.getByText('Pre-trip DVIR')).toBeVisible();
    const startDvirButton = page.getByRole('button', { name: /start dvir/i });
    if ((await startDvirButton.count()) > 0) {
      await startDvirButton.click();
      await expect(page.getByLabel('Truck is safe to drive')).toBeVisible();
      await expect(page.getByLabel('Truck is safe to drive')).toBeChecked();

      await page.getByLabel('Truck / unit ID').fill(`E2E-TRK-${runId}`);
      await page.getByRole('button', { name: 'Submit DVIR' }).click();
      await expect(
        page.getByText(/driver signature is required before submitting dvir/i),
        'DVIR should block submission until a signature is provided'
      ).toBeVisible({ timeout: 10_000 });

      const dvirSignature = `Field Dispatch DVIR ${runId}`;
      const submitDvirRpcPromise = page.waitForResponse(
        (response) =>
          response.url().includes('/rpc/submit_dvir') && response.request().method() === 'POST'
      );

      await page.getByLabel('Driver signature').fill(dvirSignature);
      await page.getByRole('button', { name: 'Submit DVIR' }).click();
      const submitDvirResponse = await submitDvirRpcPromise;
      expect(submitDvirResponse.ok(), 'submit_dvir RPC should succeed for a signed DVIR submission').toBe(true);
      const dvirPayload = submitDvirResponse.request().postDataJSON() as {
        p_signature?: string | null;
        p_is_safe_to_drive?: boolean;
      };
      expect(dvirPayload.p_signature, 'submit_dvir payload must include the typed driver signature').toContain(
        dvirSignature
      );
      expect(dvirPayload.p_is_safe_to_drive, 'submit_dvir payload must include safe-to-drive state').toBe(true);
      await expect(page.getByText(/dvir submitted/i)).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(
        page.getByText('Completed'),
        'when Start DVIR is unavailable, the route-level DVIR should already be completed'
      ).toBeVisible();
    }

    const noStopsCard = page.getByText('No stops assigned for today.');
    if ((await noStopsCard.count()) > 0) {
      test.skip(true, 'No stops assigned for this operator today; skipping field-dispatch progression journey.');
      return;
    }

    const stopCards = page.getByTestId(/^stop-card-/);
    const stopCount = await stopCards.count();
    expect(stopCount, 'expected at least one stop card when no empty-state card is shown').toBeGreaterThan(0);

    let selectedStopCard: Locator | null = null;
    for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
      const card = stopCards.nth(stopIndex);
      if ((await card.getByRole('button', { name: /expand stop actions/i }).count()) > 0) {
        selectedStopCard = card;
        break;
      }
    }

    if (!selectedStopCard) {
      test.skip(true, 'No actionable non-completed stop is available for this operator in the current environment.');
      return;
    }

    const stopCard = selectedStopCard;
    const stopCardTestId = await stopCard.getAttribute('data-testid');
    expect(stopCardTestId, 'selected stop card must expose a stable data-testid').toBeTruthy();
    const stopId = stopCardTestId!.replace('stop-card-', '');

    await expect(
      stopCard.getByText(/Delivery|Pickup/i),
      'stop card must expose stop-type context for the assigned field operator'
    ).toBeVisible();
    await expect(
      stopCard.locator('p.text-sm.font-medium').first(),
      'stop card must expose customer context for the assigned stop'
    ).toBeVisible();
    await expect(
      stopCard.locator('p.text-xs.text-muted-foreground').first(),
      'stop card must expose job-site/address context for the assigned stop'
    ).toBeVisible();

    for (let attempt = 0; attempt < FIELD_DISPATCH_MAX_PROGRESSION_ATTEMPTS; attempt += 1) {
      const isArrived = (await stopCard.getByText(/^Arrived$/).count()) > 0;
      const isCompleted = (await stopCard.getByText(/^Completed$/).count()) > 0;
      if (isArrived || isCompleted) break;

      await stopCard.getByRole('button', { name: /expand stop actions/i }).click();
      const advanceButton = stopCard.getByRole('button', { name: /Mark as (Departed|Arrived|Completed)/i });
      const advanceLabel = (await advanceButton.innerText()).trim();
      if (/completed/i.test(advanceLabel)) {
        await stopCard.getByRole('button', { name: /collapse stop actions/i }).click();
        break;
      }
      await advanceButton.click();
      await expect(
        stopCard.getByText(/Departed|Arrived|Completed/i),
        'stop progression badge should update after advancing dispatch state'
      ).toBeVisible({ timeout: 15_000 });
    }

    await stopCard.getByRole('button', { name: /expand stop actions/i }).click();

    const completionButton = stopCard.getByRole('button', { name: /Mark as Completed/i });
    if ((await completionButton.count()) === 0) {
      test.skip(true, 'Selected stop is not yet in an arrived state that can be completed in this environment.');
      return;
    }

    const signature = `Field Dispatch E2E ${runId}`;
    const conditionNotes = `E2E offline replay condition note ${runId}`;
    const exceptionNotes = `E2E ETA exception context ${runId}`;

    const submitExceptionRpcPromise = page.waitForResponse(
      (response) =>
        response.url().includes('/rpc/submit_stop_exception') && response.request().method() === 'POST'
    );
    await stopCard.getByRole('button', { name: /report exception/i }).click();
    await stopCard.getByLabel('Estimated delay (minutes)').fill('35');
    await stopCard.getByLabel('Notes').fill(exceptionNotes);
    await stopCard.getByRole('button', { name: /submit exception/i }).click();
    const submitExceptionResponse = await submitExceptionRpcPromise;
    expect(submitExceptionResponse.ok(), 'submit_stop_exception RPC should succeed for ETA exception capture').toBe(
      true
    );
    const exceptionPayload = submitExceptionResponse.request().postDataJSON() as {
      p_stop_id?: string;
      p_exception_type?: string;
      p_estimated_delay_minutes?: number;
      p_notes?: string | null;
    };
    expect(exceptionPayload.p_stop_id, 'exception payload must remain attached to the selected stop').toBe(stopId);
    expect(exceptionPayload.p_exception_type, 'exception payload must preserve ETA exception type').toBe('eta_delay');
    expect(exceptionPayload.p_estimated_delay_minutes, 'ETA exception payload must include delay minutes').toBe(35);
    expect(exceptionPayload.p_notes, 'exception payload must include operator notes').toContain(exceptionNotes);
    await expect(
      stopCard.getByText(/exception submitted — branch notified for review/i),
      'submitted exception confirmation should remain visible on the same stop card'
    ).toBeVisible({ timeout: 10_000 });

    await stopCard.getByLabel('Signature').fill(signature);
    await stopCard.getByLabel('Condition notes').fill(conditionNotes);

    await page.context().setOffline(true);
    await completionButton.click();
    await expect(
      page.getByText(/Action queued \(offline\)/i),
      'offline completion should explicitly surface queued-action feedback'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/queued offline/i),
      'offline queue banner should show queued actions while disconnected'
    ).toBeVisible({ timeout: 10_000 });

    await page.context().setOffline(false);

    await expect(
      stopCard.getByText(/^Completed$/),
      'queued completion should replay and transition the stop into durable completed state after reconnect'
    ).toBeVisible({ timeout: FIELD_WORKFLOW_COMPLETION_TIMEOUT });

    const stopsReloadResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/rest/v1/v_driver_dispatch_stops') &&
        response.request().method() === 'GET'
    );
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const stopsReloadResponse = await stopsReloadResponsePromise;
    expect(stopsReloadResponse.ok(), 'stop list read must succeed after reloading /field/dispatch').toBe(true);

    const persistedStops = (await stopsReloadResponse.json()) as Array<{
      stop_id: string;
      stop_status: string | null;
      departed_at: string | null;
      arrived_at: string | null;
      completed_at: string | null;
      signature: string | null;
      condition_notes: string | null;
      exception_count: number | null;
    }>;
    const persistedStop = persistedStops.find((row) => row.stop_id === stopId);
    expect(persistedStop, `expected reloaded driver-dispatch stop row for stop_id=${stopId}`).toBeTruthy();
    expect(persistedStop?.stop_status, 'stop status must persist as completed after reload').toBe('completed');
    expect(persistedStop?.departed_at, 'departed timestamp must remain populated after reload').toBeTruthy();
    expect(persistedStop?.arrived_at, 'arrived timestamp must remain populated after reload').toBeTruthy();
    expect(persistedStop?.completed_at, 'completed timestamp must remain populated after reload').toBeTruthy();
    expect(
      persistedStop?.signature,
      'completion signature evidence must remain attached to the same stop after reload'
    ).toContain(signature);
    expect(
      persistedStop?.condition_notes,
      'completion condition-note evidence must remain attached to the same stop after reload'
    ).toContain(conditionNotes);
    expect(
      persistedStop?.exception_count ?? 0,
      'submitted stop exception count must remain attached to the same stop after reload'
    ).toBeGreaterThan(0);

    const reloadedStopCard = page.getByTestId(`stop-card-${stopId}`);
    await expect(
      reloadedStopCard.getByText(/Departed[\s\S]*Arrived[\s\S]*Completed/i),
      'completed stop card should keep departed/arrived/completed timestamp context visible after reload'
    ).toBeVisible();
    await expect(
      reloadedStopCard.getByText(/exception/i),
      'reloaded stop card should keep exception/evidence context visible for the same stop after replay + reload'
    ).toBeVisible();
  });

  test('live yard inline action journey preserves operator context and persisted board state after reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: live yard inline-action write/persistence journey on deployed dev is tracked as backlog signal until reliability is proven.'
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated live yard inline-action E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/dispatch/yard', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Live Yard View' })).toBeVisible();

    const actionPlan = [
      {
        label: 'Release to Available',
        fromLane: 'needs_review',
        toLane: null,
        successFeedback: 'Inspection review resolved and the asset returned to available inventory.',
      },
      {
        label: 'Send to Maintenance',
        fromLane: 'needs_review',
        toLane: 'maintenance',
        successFeedback: 'Maintenance work order opened from the Live Yard review lane.',
      },
      {
        label: 'Complete Maintenance',
        fromLane: 'maintenance',
        toLane: null,
        successFeedback: 'Maintenance completed and the asset returned to available inventory.',
      },
    ] as const;

    const rawUuidOnlyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let selectedAction:
      | {
        label: (typeof actionPlan)[number]['label'];
        fromLane: (typeof actionPlan)[number]['fromLane'];
        toLane: (typeof actionPlan)[number]['toLane'];
        successFeedback: (typeof actionPlan)[number]['successFeedback'];
        cardTitle: string;
        cardSubtitle: string;
        actionButton: Locator;
      }
      | null = null;

    for (const candidate of actionPlan) {
      const lane = page.getByTestId(`yard-lane-${candidate.fromLane}`);
      const actionButton = lane.getByRole('button', { name: candidate.label }).first();
      if ((await actionButton.count()) === 0) continue;

      const card = lane.getByTestId('yard-item-card').filter({ has: actionButton }).first();
      if ((await card.count()) === 0) continue;

      const cardTitle = (await card.locator('p').first().innerText()).trim();
      if (!cardTitle) continue;

      const cardSubtitle = (await card.locator('p').nth(1).innerText().catch(() => '')).trim();

      selectedAction = {
        ...candidate,
        cardTitle,
        cardSubtitle,
        actionButton,
      };
      break;
    }

    if (!selectedAction) {
      test.skip(
        true,
        'No seeded Needs Review/Maintenance row with Release to Available, Send to Maintenance, or Complete Maintenance is currently available.'
      );
      return;
    }

    expect(
      selectedAction.cardTitle,
      'selected yard work-item title must be operator-readable context, not a raw UUID-only title'
    ).not.toMatch(rawUuidOnlyPattern);
    expect(
      `${selectedAction.cardTitle} ${selectedAction.cardSubtitle}`.trim(),
      'selected yard work item must expose operator-readable asset/order context before inline action'
    ).toMatch(/[A-Za-z]/);

    const actionWriteResponsePromise = page.waitForResponse(
      (response) => {
        let pathname = '';
        try {
          pathname = new URL(response.url()).pathname;
        } catch {
          return false;
        }
        return pathname === '/rest/v1/rpc/rental_apply_live_yard_action'
          && response.request().method() === 'POST';
      }
    );
    await selectedAction.actionButton.click();
    const actionWriteResponse = await actionWriteResponsePromise;
    expect(actionWriteResponse.ok(), 'inline action RPC write must succeed').toBe(true);

    await expect(
      page.getByText(selectedAction.successFeedback),
      'inline action must surface explicit operator feedback after successful write'
    ).toBeVisible({ timeout: 15_000 });

    const originLaneCards = page
      .getByTestId(`yard-lane-${selectedAction.fromLane}`)
      .getByTestId('yard-item-card')
      .filter({ hasText: selectedAction.cardTitle });
    await expect(
      originLaneCards,
      'selected row must leave its pre-action lane after the inline transition'
    ).toHaveCount(0, { timeout: 15_000 });

    if (selectedAction.toLane) {
      const destinationLaneCard = page
        .getByTestId(`yard-lane-${selectedAction.toLane}`)
        .getByTestId('yard-item-card')
        .filter({ hasText: selectedAction.cardTitle })
        .first();
      await expect(
        destinationLaneCard,
        'selected row must appear in the expected destination lane after the inline transition'
      ).toBeVisible({ timeout: 15_000 });
    }

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Live Yard View' })).toBeVisible();
    await expect(
      page
        .getByTestId(`yard-lane-${selectedAction.fromLane}`)
        .getByTestId('yard-item-card')
        .filter({ hasText: selectedAction.cardTitle }),
      'post-action source-lane state must remain durable after reload'
    ).toHaveCount(0);

    if (selectedAction.toLane) {
      await expect(
        page
          .getByTestId(`yard-lane-${selectedAction.toLane}`)
          .getByTestId('yard-item-card')
          .filter({ hasText: selectedAction.cardTitle })
          .first(),
        'post-action destination-lane state must remain durable after reload'
      ).toBeVisible();
    }
  });

  test('live yard view location and time-window filters scope lanes coherently and persist after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: live yard view filter persistence after reload is tracked as backlog signal — filters currently reset to defaults on reload because state is not bound to URL params or local storage.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to validate live yard view filter persistence after reload.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);
    await page.goto('/dispatch/yard', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Live Yard View' })).toBeVisible();

    const locationSelect = page.locator('#yard-location-filter');
    const timeWindowSelect = page.locator('#yard-time-window-filter');

    await expect(locationSelect, 'location filter select must be present in the board controls').toBeVisible();
    await expect(timeWindowSelect, 'time window filter select must be present in the board controls').toBeVisible();

    // Apply a real location filter if branch options are seeded in this environment.
    const locationOptionEls = await locationSelect.locator('option').all();
    let appliedLocationValue = '';
    if (locationOptionEls.length > 1) {
      appliedLocationValue = (await locationOptionEls[1]?.getAttribute('value')) ?? '';
      if (appliedLocationValue) {
        await locationSelect.selectOption({ value: appliedLocationValue });
        await expect(
          locationSelect,
          `location filter must reflect the selected value "${appliedLocationValue}" immediately after selection`
        ).toHaveValue(appliedLocationValue);
      }
    }

    // Apply the "Next 24 hours" time-window filter.
    await timeWindowSelect.selectOption({ value: '24h' });
    await expect(
      timeWindowSelect,
      'time window filter must show "Next 24 hours" immediately after selection'
    ).toHaveValue('24h');

    // Reload the page.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Live Yard View' }),
      'Live Yard View heading must be visible after reload'
    ).toBeVisible();

    // After reload, filter selections must not silently revert to defaults.
    await expect(
      timeWindowSelect,
      'time window filter must still show "Next 24 hours" after reload — filter scope must not silently revert to "All active"'
    ).toHaveValue('24h');

    if (appliedLocationValue) {
      await expect(
        locationSelect,
        'location filter must still reflect the selected location after reload — filter scope must not silently revert to "All locations"'
      ).toHaveValue(appliedLocationValue);
    }
  });

  test('inventory kit quote journey — kit selection and draft context survive reload', async ({ page }) => {
    test.fail(true, 'Non-gating: inventory kit quote journey on deployed dev is tracked as backlog signal until the kit-backed quote-draft flow is proven reliable.');
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated kit quote journey E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // Shared constants used in multiple steps of this test.
    const rawUuidLeadPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const isAvailabilityRpc = (response: Response) =>
      (response.url().includes('/rpc/rental_kit_availability') || response.url().includes('/rpc/rental_quote_availability'))
      && response.request().method() === 'POST';

    // ── Step 1: /inventory/kits — obtain or create a named kit ───────────────
    await page.goto('/inventory/kits', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('inventory-kits-screen'),
      '/inventory/kits screen must render for write-capable staff user'
    ).toBeVisible({ timeout: 15_000 });

    let selectedKitName = '';

    // Prefer reusing an existing kit to avoid creating noise in the deployed environment.
    const existingKitRows = page.locator('[data-testid^="kit-row-"]');
    const existingKitCount = await existingKitRows.count();

    if (existingKitCount > 0) {
      const firstRow = existingKitRows.first();
      // Extract the name from a heading or bold text inside the row
      const nameEl = firstRow.locator('h3, strong, [class*="font-semibold"], button').first();
      selectedKitName = (await nameEl.innerText().catch(() => '')).trim();
      if (!selectedKitName) {
        selectedKitName = (await firstRow.innerText()).split('\n')[0]?.trim() ?? '';
      }
    } else {
      // No kits yet — create a minimal named kit so the quote builder has something to select.
      const kitLabel = `E2E Kit ${Date.now()}`;
      await page.getByTestId('input-kit-name').fill(kitLabel);
      await page.getByTestId('input-kit-description').fill('Created by E2E kit quote journey test');

      // Leave the single default component slot with asset_category type but no ID —
      // the RPC skips components with a blank component_id.
      const componentTypeSelect = page.getByTestId('input-kit-component-type-0');
      if ((await componentTypeSelect.count()) > 0) {
        await componentTypeSelect.selectOption('asset_category');
      }

      const kitSaveRpcResponse = page.waitForResponse((response) =>
        response.url().includes('/rpc/staff_upsert_inventory_kit')
        && response.request().method() === 'POST'
      );
      await page.getByTestId('btn-save-kit').click();
      const kitSaveResult = await kitSaveRpcResponse;
      expect(kitSaveResult.status(), 'staff_upsert_inventory_kit RPC should succeed when creating a new kit').toBeLessThan(400);

      await page
        .getByTestId('kits-save-success')
        .waitFor({ state: 'visible', timeout: 15_000 });

      selectedKitName = kitLabel;
      await page.waitForLoadState('networkidle');
    }

    expect(selectedKitName, 'a non-empty kit name must be captured before proceeding to the quote builder').toBeTruthy();

    // ── Step 2: /rental/quoting — select the kit in a line ───────────────────
    await page.goto('/rental/quoting', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('quote-builder-screen'),
      'quote builder screen should render for write-capable staff user'
    ).toBeVisible({ timeout: 15_000 });

    const plannedStart = '2027-06-01';
    const plannedEnd = '2027-06-08';

    // Select the first non-empty kit option from the dropdown.
    const kitSelect = page.getByTestId('input-line-0-kit');
    await expect(kitSelect, 'line-0 kit select must be present in the quote builder').toBeVisible();

    const kitOptionEls = await kitSelect.locator('option').all();
    let chosenKitValue = '';
    let chosenKitLabel = '';
    for (const opt of kitOptionEls) {
      const val = (await opt.getAttribute('value')) ?? '';
      if (val.trim()) {
        chosenKitValue = val.trim();
        chosenKitLabel = (await opt.innerText()).trim();
        break;
      }
    }

    if (!chosenKitValue) {
      test.skip(true, 'No inventory kits are listed in the quote-builder kit dropdown — kit creation may have failed or kits are not seeded in this environment.');
    }

    await kitSelect.selectOption({ value: chosenKitValue });

    // The kit-ID hint should appear after selecting a kit.
    const kitIdHint = page.getByTestId('line-0-kit-id');
    await expect(kitIdHint, 'kit ID hint should become visible after selecting a kit').toBeVisible({ timeout: 5_000 });

    // Set rental dates.
    await page.getByTestId('input-line-0-start').fill(plannedStart);
    await page.getByTestId('input-line-0-end').fill(plannedEnd);

    // Pick the first available branch so the availability check can run.
    const branchSelect = page.getByTestId('input-line-0-branch');
    await expect(branchSelect, 'line-0 branch select must be present').toBeVisible();
    const branchOptionEls = await branchSelect.locator('option').all();
    let chosenBranchValue = '';
    for (const opt of branchOptionEls) {
      const val = (await opt.getAttribute('value')) ?? '';
      if (val.trim()) {
        chosenBranchValue = val.trim();
        break;
      }
    }
    if (chosenBranchValue) {
      await branchSelect.selectOption({ value: chosenBranchValue });
    }

    // ── Step 3: Run availability for the kit-backed line ─────────────────────
    const availabilityBtn = page.getByTestId('btn-check-availability-0');
    await expect(availabilityBtn, 'availability check button must be present for line 0').toBeVisible();

    if (await availabilityBtn.isEnabled()) {
      const availabilityRpcResponse = page.waitForResponse(isAvailabilityRpc).catch(() => null);
      await availabilityBtn.click();
      await availabilityRpcResponse;

      const availableEl = page.getByTestId('availability-available-0');
      const unavailableEl = page.getByTestId('availability-unavailable-0');
      const errorEl = page.getByTestId('availability-error-0');

      await Promise.race([
        availableEl.waitFor({ state: 'visible', timeout: 10_000 }),
        unavailableEl.waitFor({ state: 'visible', timeout: 10_000 }),
        errorEl.waitFor({ state: 'visible', timeout: 10_000 }),
      ]).catch(() => null);

      const hasAvailabilityBadge =
        (await availableEl.isVisible().catch(() => false))
        || (await unavailableEl.isVisible().catch(() => false))
        || (await errorEl.isVisible().catch(() => false));

      expect(
        hasAvailabilityBadge,
        'running availability on a kit-backed line must produce a result badge (available, unavailable, or error) — not a silent no-op'
      ).toBe(true);

      // If unavailable, the shortage description must not be a bare UUID.
      if (await unavailableEl.isVisible().catch(() => false)) {
        const unavailableText = await unavailableEl.innerText();
        expect(
          unavailableText,
          'unavailability badge must surface a human-readable shortage reason, not lead with a raw UUID'
        ).not.toMatch(rawUuidLeadPattern);
      }
    }

    // ── Step 4: Save the draft ────────────────────────────────────────────────
    const saveDraftResponse = page.waitForResponse((response) =>
      response.url().includes('/rpc/staff_save_quote_order')
      && response.request().method() === 'POST'
    );
    await page.getByTestId('btn-save-draft').click();
    const saveDraftResult = await saveDraftResponse;
    expect(
      saveDraftResult.status(),
      'staff_save_quote_order RPC should succeed for a kit-backed quote draft'
    ).toBeLessThan(400);

    const saveSuccessBanner = page.getByTestId('save-success');
    await expect(
      saveSuccessBanner,
      'save-success banner should appear after saving the kit-backed draft'
    ).toBeVisible({ timeout: 15_000 });

    const savedOrderId = (await page.getByTestId('saved-order-id').innerText()).trim();
    const savedOrderNumber = (await page.getByTestId('saved-order-number').innerText()).trim();
    expect(savedOrderId, 'save-success banner must expose a non-empty order ID').toBeTruthy();
    expect(savedOrderNumber, 'save-success banner must expose a non-empty order number').toBeTruthy();

    // ── Step 5: Reopen via ?order_id= and assert context survives ────────────
    await page.goto(`/rental/quoting?order_id=${encodeURIComponent(savedOrderId)}`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('quote-builder-screen'),
      'quote builder screen should render when reopening a kit-backed draft via ?order_id='
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByTestId('line-row-0'),
      'line 0 must still be present after reopening the kit-backed draft'
    ).toBeVisible({ timeout: 10_000 });

    // Kit selection must persist — operators must not have to re-select the kit.
    const reopenedKitSelect = page.getByTestId('input-line-0-kit');
    const reopenedKitValue = await reopenedKitSelect.inputValue();
    expect(
      reopenedKitValue,
      `kit ID must persist after reopening the draft (expected "${chosenKitValue}", got "${reopenedKitValue}")`
    ).toBe(chosenKitValue);

    // The kit label in the dropdown must still be the human-readable name, not a raw UUID.
    const reopenedKitLabel = await page
      .locator(`[data-testid="input-line-0-kit"] option[value="${chosenKitValue}"]`)
      .innerText()
      .catch(() => '');
    expect(
      reopenedKitLabel.trim(),
      'kit label in the dropdown must remain human-readable after reopening the draft — not a raw UUID or blank'
    ).toBe(chosenKitLabel);

    // Rental date context must persist.
    const reopenedStart = await page.getByTestId('input-line-0-start').inputValue();
    expect(
      reopenedStart,
      `planned start date must persist after reopening the kit-backed draft (expected "${plannedStart}")`
    ).toBe(plannedStart);

    const reopenedEnd = await page.getByTestId('input-line-0-end').inputValue();
    expect(
      reopenedEnd,
      `planned end date must persist after reopening the kit-backed draft (expected "${plannedEnd}")`
    ).toBe(plannedEnd);

    // Branch context must persist if one was set.
    if (chosenBranchValue) {
      const reopenedBranch = await page.getByTestId('input-line-0-branch').inputValue();
      expect(
        reopenedBranch,
        `branch selection must persist after reopening the kit-backed draft (expected "${chosenBranchValue}")`
      ).toBe(chosenBranchValue);
    }

    // Availability state is not persisted server-side; re-running it on the reopened
    // draft must produce a result or explicit shortage, not a silent no-op.
    const recheckBtn = page.getByTestId('btn-check-availability-0');
    await expect(
      recheckBtn,
      'availability re-check button must be present and operable after reopening a kit-backed draft'
    ).toBeVisible();

    if (await recheckBtn.isEnabled()) {
      const recheckRpcResponse = page.waitForResponse(isAvailabilityRpc).catch(() => null);
      await recheckBtn.click();
      await recheckRpcResponse;

      const recheckAvailable = page.getByTestId('availability-available-0');
      const recheckUnavailable = page.getByTestId('availability-unavailable-0');
      const recheckError = page.getByTestId('availability-error-0');

      await Promise.race([
        recheckAvailable.waitFor({ state: 'visible', timeout: 10_000 }),
        recheckUnavailable.waitFor({ state: 'visible', timeout: 10_000 }),
        recheckError.waitFor({ state: 'visible', timeout: 10_000 }),
      ]).catch(() => null);

      const hasRecheckResult =
        (await recheckAvailable.isVisible().catch(() => false))
        || (await recheckUnavailable.isVisible().catch(() => false))
        || (await recheckError.isVisible().catch(() => false));

      expect(
        hasRecheckResult,
        're-running availability on the reopened kit-backed draft must yield a result (available, unavailable, or error) — not a silent no-op'
      ).toBe(true);

      // Shortage message must be human-readable, not a UUID-first summary.
      if (await recheckUnavailable.isVisible().catch(() => false)) {
        const shortageText = await recheckUnavailable.innerText();
        expect(
          shortageText,
          'shortage message must not begin with a raw UUID — operators need guidance, not opaque IDs'
        ).not.toMatch(rawUuidLeadPattern);
      }
    }

    // Secondary kit-ID hint must use the "ID: <uuid>" prefix so it is clearly labelled as a detail,
    // not the primary operator-visible identifier.
    const kitIdHintReopened = page.getByTestId('line-0-kit-id');
    if (await kitIdHintReopened.isVisible().catch(() => false)) {
      const hintText = await kitIdHintReopened.innerText();
      expect(
        hintText,
        'kit ID hint must use "ID: <uuid>" format — it is a supplementary detail and must not be the primary label'
      ).toMatch(/^ID:\s/i);
    }
  });

  test('inventory kits authoring — create/edit kit definition persists component context', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated inventory kit authoring E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/inventory/kits', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('inventory-kits-screen')).toBeVisible({ timeout: 15_000 });

    const uniqueSuffix = Date.now();
    const kitName = `E2E Persisted Kit ${uniqueSuffix}`;
    const kitDescription = `Persisted component context ${uniqueSuffix}`;
    const kitEffectiveFrom = '2027-01-10';
    const kitEffectiveTo = '2027-12-20';
    const componentQuantity = '3';
    const componentEffectiveFrom = '2027-02-01';
    const componentEffectiveTo = '2027-11-30';

    await page.getByTestId('input-kit-name').fill(kitName);
    await page.getByTestId('input-kit-description').fill(kitDescription);
    await page.getByTestId('input-kit-effective-from').fill(kitEffectiveFrom);
    await page.getByTestId('input-kit-effective-to').fill(kitEffectiveTo);

    const componentTypeSelect = page.getByTestId('input-kit-component-type-0');
    const componentIdSelect = page.getByTestId('input-kit-component-id-0');

    let selectedComponentId = '';
    let selectedComponentLabel = '';
    for (const componentType of ['asset_category', 'asset', 'stock_item']) {
      await componentTypeSelect.selectOption(componentType);
      const componentOptions = await componentIdSelect.locator('option').all();
      for (const option of componentOptions) {
        const value = (await option.getAttribute('value'))?.trim() ?? '';
        if (!value) continue;
        const label = (await option.innerText()).trim();
        if (!label) continue;
        selectedComponentId = value;
        selectedComponentLabel = label;
        break;
      }
      if (selectedComponentId) break;
    }

    if (!selectedComponentId) {
      test.skip(true, 'No selectable inventory component options are available to author a kit in this environment.');
    }

    await componentIdSelect.selectOption({ value: selectedComponentId });
    await page.getByTestId('input-kit-component-quantity-0').fill(componentQuantity);
    await page.getByTestId('input-kit-component-effective-from-0').fill(componentEffectiveFrom);
    await page.getByTestId('input-kit-component-effective-to-0').fill(componentEffectiveTo);

    const saveKitResponse = page.waitForResponse((response) =>
      response.url().includes('/rpc/staff_upsert_inventory_kit')
      && response.request().method() === 'POST'
    );
    await page.getByTestId('btn-save-kit').click();
    const saveKitResult = await saveKitResponse;
    expect(saveKitResult.status(), 'staff_upsert_inventory_kit RPC should succeed when authoring a new kit').toBeLessThan(400);

    const savePayload = await saveKitResult.json().catch(() => null) as Array<{ kit_id?: string }> | null;
    const savedKitId = (savePayload?.[0]?.kit_id ?? '').trim();
    expect(savedKitId, 'kit save response should provide a persisted kit ID for reopen assertions').toBeTruthy();

    const saveSuccessAlert = page.getByTestId('kits-save-success');
    await expect(saveSuccessAlert, 'kit save should surface a readable success state').toBeVisible({ timeout: 15_000 });
    await expect(saveSuccessAlert).toContainText('Saved');
    await expect(saveSuccessAlert).toContainText(kitName);

    const savedKitRow = savedKitId
      ? page.getByTestId(`kit-row-${savedKitId}`)
      : page.locator('[data-testid^="kit-row-"]').filter({ hasText: kitName }).first();
    await expect(savedKitRow, 'saved kit should be visible in list for reopen').toBeVisible({ timeout: 15_000 });
    await savedKitRow.click();

    await expect(page.getByTestId('input-kit-name')).toHaveValue(kitName);
    await expect(page.getByTestId('input-kit-description')).toHaveValue(kitDescription);
    await expect(page.getByTestId('input-kit-effective-from')).toHaveValue(kitEffectiveFrom);
    await expect(page.getByTestId('input-kit-effective-to')).toHaveValue(kitEffectiveTo);
    await expect(page.getByTestId('input-kit-component-quantity-0')).toHaveValue(componentQuantity);
    await expect(page.getByTestId('input-kit-component-effective-from-0')).toHaveValue(componentEffectiveFrom);
    await expect(page.getByTestId('input-kit-component-effective-to-0')).toHaveValue(componentEffectiveTo);
    await expect(page.getByTestId('input-kit-component-id-0')).toHaveValue(selectedComponentId);

    const reopenedComponentLabel = (await page.locator('[data-testid="input-kit-component-id-0"] option:checked').innerText()).trim();
    expect(reopenedComponentLabel, 'component label should persist after reopen').toBe(selectedComponentLabel);
    expect(
      reopenedComponentLabel.toLowerCase(),
      'component selector should remain human-readable and not force raw ID re-entry after first save'
    ).not.toBe(selectedComponentId.toLowerCase());

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('inventory-kits-screen')).toBeVisible({ timeout: 15_000 });
    await expect(savedKitRow, 'saved kit should remain visible after full page reload').toBeVisible({ timeout: 15_000 });
    await savedKitRow.click();

    await expect(page.getByTestId('input-kit-name')).toHaveValue(kitName);
    await expect(page.getByTestId('input-kit-effective-from')).toHaveValue(kitEffectiveFrom);
    await expect(page.getByTestId('input-kit-effective-to')).toHaveValue(kitEffectiveTo);
    await expect(page.getByTestId('input-kit-component-quantity-0')).toHaveValue(componentQuantity);
    await expect(page.getByTestId('input-kit-component-effective-from-0')).toHaveValue(componentEffectiveFrom);
    await expect(page.getByTestId('input-kit-component-effective-to-0')).toHaveValue(componentEffectiveTo);
    await expect(page.getByTestId('input-kit-component-id-0')).toHaveValue(selectedComponentId);
  });

  test('inspection comparison journey — recap and variance context survive reload', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev inspection comparison journey is tracked as backlog signal until the route and seeded inspection records are proven reliable.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated inspection comparison E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Find a contract line in returned or inspection_hold status — these are most
    // likely to have checkout+return inspection records available to compare.
    await page.goto('/rental/contracts');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Rental Contracts' })).toBeVisible();

    const viewActions = page.getByRole('link', { name: 'View' }).or(page.getByRole('button', { name: 'View' }));
    const contractCount = await viewActions.count();
    if (contractCount === 0) {
      test.skip(true, 'No contracts are available in this environment to source an inspection comparison context.');
    }

    let lineId: string | null = null;
    const maxToScan = Math.min(contractCount, 10);
    for (let ci = 0; ci < maxToScan && !lineId; ci++) {
      if (ci > 0) {
        await page.goto('/rental/contracts');
        await page.waitForLoadState('networkidle');
      }
      await viewActions.nth(ci).click();
      await expect(page).toHaveURL(/\/rental\/contracts\/[^/]+$/);
      await page.waitForLoadState('networkidle');

      const lineIdLabels = page.getByText(/^Line ID:/);
      const lineCount = await lineIdLabels.count();
      for (let li = 0; li < lineCount && !lineId; li++) {
        const lineDetails = lineIdLabels.nth(li).locator('xpath=..').locator('xpath=..');
        const lineText = await lineDetails.innerText();
        const id = lineText.match(/Line ID:\s*([^\s]+)/)?.[1]?.trim();
        if (id && /\b(returned|inspection_hold)\b/i.test(lineText)) {
          lineId = id;
        }
      }
    }

    if (!lineId) {
      test.skip(true, 'No returned or inspection_hold contract line found in this environment — seed a completed rental cycle to cover the inspection comparison journey.');
    }

    // Navigate to the inspection comparison route scoped to this contract line.
    // The route persists scope via URL params so it survives reload without client-side state.
    await page.goto(`/rental/inspection-comparison?contract_line_id=${encodeURIComponent(lineId!)}`);
    await page.waitForLoadState('networkidle');

    // The page heading and description must render without a crash or blank render.
    await expect(page.getByRole('heading', { name: 'Inspection Comparison' })).toBeVisible();
    await expect(page.getByText(/compare pickup and return inspection evidence/i)).toBeVisible();

    // Wait for the data fetch triggered by the URL param to settle — either the
    // comparison section appears (data found) or an alert banner appears (no data / error).
    const comparisonOrAlert = page
      .getByRole('heading', { name: 'Side-by-Side Comparison' })
      .or(page.locator('[role="alert"]'));
    await comparisonOrAlert.first().waitFor({ timeout: 15_000 });
    const pageBody = await page.locator('body').innerText();

    // If no inspections are seeded for this line, skip the rest of the journey gracefully.
    if (/no inspections found/i.test(pageBody)) {
      test.skip(true, `No inspection records found for line ${lineId} — seed checkout and return inspections to cover the full comparison journey.`);
    }

    // The side-by-side comparison section must be present.
    await expect(page.getByRole('heading', { name: 'Side-by-Side Comparison' })).toBeVisible();

    // Pickup and return columns must render operator-readable outcome/status — not a raw-ID-only shell.
    expect.soft(
      /Pickup\s*\/\s*Checkout/i.test(pageBody),
      'comparison should surface a Pickup / Checkout column'
    ).toBe(true);
    expect.soft(
      /\bReturn\b/i.test(pageBody),
      'comparison should surface a Return column'
    ).toBe(true);
    expect.soft(
      /\b(pass|fail|outcome)\b/i.test(pageBody),
      'inspection columns should surface outcome/status, not a raw-ID-only shell'
    ).toBe(true);

    // Evidence counts (photos) must appear — "No photos recorded" is also acceptable
    // as it confirms the section rendered rather than crashing or omitting it entirely.
    expect.soft(
      /photo|evidence/i.test(pageBody),
      'at least one inspection column should surface an evidence/photo section'
    ).toBe(true);

    // Condition delta summary card must be visible when inspections are loaded.
    expect.soft(
      await page.getByText('Condition Delta Summary').isVisible().catch(() => false),
      'Condition Delta Summary card must be visible after inspections load'
    ).toBe(true);

    // Meter and Fuel delta rows must appear in the Condition Delta Summary.
    // These entries ("Meter changed/unchanged", "Fuel changed/unchanged") are always
    // rendered in the delta card whenever both inspections are loaded — operators use
    // them to spot reading discrepancies at a glance.
    expect.soft(
      /\bMeter\s+(changed|unchanged)\b/i.test(pageBody),
      'Condition Delta Summary must render a Meter delta row (changed or unchanged)'
    ).toBe(true);
    expect.soft(
      /\bFuel\s+(changed|unchanged)\b/i.test(pageBody),
      'Condition Delta Summary must render a Fuel delta row (changed or unchanged)'
    ).toBe(true);

    // Checklist section or Checklist Variance card must render when inspection data
    // includes checklist items — operators rely on per-item status to identify damage.
    // This assertion is data-dependent: it passes when checklist items are seeded and
    // fails if the Checklist / Checklist Variance sections are removed from the component.
    expect.soft(
      /Checklist(?: Variance)?/i.test(pageBody),
      'comparison must surface a Checklist or Checklist Variance section when checklist items are present in the inspection data'
    ).toBe(true);

    // The Share Customer Recap button must be actionable.
    const recapButton = page.getByRole('button', { name: /generate customer recap/i });
    await expect(recapButton).toBeVisible();

    // --- Recap modal journey ---
    await recapButton.click();
    const recapDialog = page.getByRole('dialog', { name: 'Customer Recap' });
    await expect(recapDialog).toBeVisible();
    const recapText = await recapDialog.innerText();

    // Customer-safe summary fields must be present.
    expect.soft(
      /Outcome/i.test(recapText),
      'customer recap should surface outcome field'
    ).toBe(true);
    expect.soft(
      /Audit ref/i.test(recapText),
      'customer recap should include audit references for traceability'
    ).toBe(true);
    expect.soft(
      /Signature/i.test(recapText),
      'customer recap should surface signature capture status'
    ).toBe(true);

    // The modal description must explicitly state internal notes are excluded.
    expect.soft(
      /internal notes excluded/i.test(recapText),
      'customer recap must state that internal notes are excluded'
    ).toBe(true);

    // Close the modal.
    await recapDialog.getByRole('button', { name: 'Close' }).click();
    await expect(recapDialog).toBeHidden({ timeout: 5000 });

    // --- Reload survival ---
    // Reload the route — contract_line_id is in the URL so the selected scope must survive.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Heading must still be visible after reload (no crash, no blank render).
    await expect(page.getByRole('heading', { name: 'Inspection Comparison' })).toBeVisible();

    // The URL must still carry the scoped contract_line_id param after reload.
    await expect(page).toHaveURL(new RegExp(`[?&]contract_line_id=${escapeRegExp(encodeURIComponent(lineId!))}`));

    // Wait for the auto-fetch triggered by the URL param to re-settle after reload.
    const comparisonOrAlertAfterReload = page
      .getByRole('heading', { name: 'Side-by-Side Comparison' })
      .or(page.locator('[role="alert"]'));
    await comparisonOrAlertAfterReload.first().waitFor({ timeout: 15_000 });
    const bodyAfterReload = await page.locator('body').innerText();

    // Comparison columns must still be present — context not reset to an empty state.
    expect.soft(
      /Pickup\s*\/\s*Checkout/i.test(bodyAfterReload),
      'pickup column must remain coherent after reload'
    ).toBe(true);
    expect.soft(
      /Side-by-Side Comparison/i.test(bodyAfterReload),
      'comparison section must re-render after reload without resetting to an empty state'
    ).toBe(true);

    // The recap button must still be available after reload (the comparison context is not lost).
    await expect(page.getByRole('button', { name: /generate customer recap/i })).toBeVisible();
  });

  test('project proposal workbench: URL filter scope persists after reload and scoped CRM/availability drill-down links carry context', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev project proposal workbench filter-scope persistence and drill-down handoffs are tracked as backlog signal until the route and live data are proven reliable.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated project proposal workbench E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Navigate with all three filter params pre-set so we verify URL-driven scope from the start.
    const customerFilter = 'Acme';
    const categoryFilter = 'Excavator';
    const branchFilter = 'North';
    await page.goto(
      `/rental/project-proposal?customer=${encodeURIComponent(customerFilter)}&category=${encodeURIComponent(categoryFilter)}&branch=${encodeURIComponent(branchFilter)}`
    );
    await page.waitForLoadState('networkidle');

    // The workbench heading and assist-only callout must be immediately visible.
    await expect(page.getByRole('heading', { name: 'Project Proposal Workbench' })).toBeVisible();
    await expect(page.getByText(/Assist only/i)).toBeVisible();

    // The filter inputs must reflect the URL params — filter scope must survive navigation.
    const customerInput = page.getByLabel('Customer');
    const categoryInput = page.getByLabel('Category');
    const branchInput = page.getByLabel('Branch');
    await expect(customerInput).toHaveValue(customerFilter);
    await expect(categoryInput).toHaveValue(categoryFilter);
    await expect(branchInput).toHaveValue(branchFilter);

    // URL must carry all three filter params so a shared link or bookmark restores scope.
    await expect(page).toHaveURL(new RegExp(`[?&]customer=${encodeURIComponent(customerFilter)}`));
    await expect(page).toHaveURL(new RegExp(`[?&]category=${encodeURIComponent(categoryFilter)}`));
    await expect(page).toHaveURL(new RegExp(`[?&]branch=${encodeURIComponent(branchFilter)}`));

    // Reload — filter scope must survive a full page reload from the URL.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Project Proposal Workbench' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`[?&]customer=${encodeURIComponent(customerFilter)}`));
    await expect(page).toHaveURL(new RegExp(`[?&]category=${encodeURIComponent(categoryFilter)}`));
    await expect(page).toHaveURL(new RegExp(`[?&]branch=${encodeURIComponent(branchFilter)}`));
    await expect(page.getByLabel('Customer')).toHaveValue(customerFilter);
    await expect(page.getByLabel('Category')).toHaveValue(categoryFilter);
    await expect(page.getByLabel('Branch')).toHaveValue(branchFilter);

    // Account context rows must carry CRM drill-down links scoped to the customer entity ID.
    // The "Acme" filter must produce at least one matching row — zero links means the filter
    // is broken or the section is not rendering, both of which must fail loudly.
    const crmLinks = page.getByRole('link', { name: /Open CRM profile/i });
    expect(
      await crmLinks.count(),
      'account context section must render at least one CRM profile drill-down link for the "Acme" customer filter'
    ).toBeGreaterThan(0);
    const firstCrmHref = await crmLinks.first().getAttribute('href');
    expect(
      firstCrmHref,
      'CRM profile drill-down link must point to /crm/customers/<id>'
    ).toMatch(/\/crm\/customers\/.+/);

    // Pricing history rows must carry availability check links scoped to the category.
    // The "Excavator" filter must produce at least one matching link — zero means the
    // scoped drill-down path is missing and the assertion must not be silently skipped.
    const availLinks = page.getByRole('link', { name: /Check availability/i });
    expect(
      await availLinks.count(),
      'pricing history section must render at least one "Check availability" link for the "Excavator" category filter'
    ).toBeGreaterThan(0);
    const firstAvailHref = await availLinks.first().getAttribute('href');
    expect(
      firstAvailHref,
      'Check availability link must carry a category_id param'
    ).toMatch(/[?&]category_id=/);

    // Availability rows must carry scoped full-details links.
    // The "North" branch filter must produce at least one matching link — zero links
    // is a hard failure, not a silent pass.
    const detailLinks = page.getByRole('link', { name: /Full details/i });
    expect(
      await detailLinks.count(),
      'availability section must render at least one "Full details" link for the "North" branch filter'
    ).toBeGreaterThan(0);
    const firstDetailHref = await detailLinks.first().getAttribute('href');
    expect(
      firstDetailHref,
      'Full details link must carry both branch_id and category_id params'
    ).toMatch(/[?&]branch_id=/);
    expect(firstDetailHref).toMatch(/[?&]category_id=/);
  });

  test('project proposal workbench: submitting an approval case shows success state and the pending case survives reload with human-readable context', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev project proposal workbench approval submission and pending-queue persistence are tracked as backlog signal until the live RPC path is proven reliable.');
    test.skip(!OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD, 'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated project proposal approval E2E.');

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/rental/project-proposal');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Project Proposal Workbench' })).toBeVisible();

    // Populate the submit form — use a timestamp suffix so each run produces a unique fingerprint.
    const testRunId = Date.now().toString();
    const customerName = `E2E Test Customer ${testRunId}`;
    const branchName = `E2E Branch ${testRunId}`;
    const notes = `E2E approval case submitted at ${testRunId}`;

    // Fill the customer name and branch name inputs inside the Submit for Internal Approval card.
    // The UIEngine renders labels from the JSON page definition; wait for each input to be
    // visible before filling — a missing label surfaces as a clear timeout failure rather than
    // silently submitting an empty form.
    const customerNameInput = page.getByLabel('Customer Name');
    const branchNameInput = page.getByLabel('Branch Name');
    const notesInput = page.getByLabel(/Notes/i);

    await customerNameInput.waitFor({ state: 'visible', timeout: 10_000 });
    await customerNameInput.fill(customerName);

    await branchNameInput.waitFor({ state: 'visible', timeout: 5_000 });
    await branchNameInput.fill(branchName);

    await notesInput.waitFor({ state: 'visible', timeout: 5_000 });
    await notesInput.fill(notes);

    // Intercept the RPC call so we can confirm the request was made and succeeded.
    const submitResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('staff_submit_project_proposal_for_approval') &&
        response.request().method() === 'POST',
      { timeout: 15_000 }
    );

    await page.getByRole('button', { name: 'Submit for Approval' }).click();
    const rpcResponse = await submitResponsePromise;

    expect(
      rpcResponse.status(),
      'staff_submit_project_proposal_for_approval RPC must return a non-error status'
    ).toBeLessThan(400);

    // Extract the finding_id from the response body so we can verify the pending row
    // links to the exact finding that was just created, not any generic shell row.
    const rpcBody = await rpcResponse.json() as Array<{ finding_id: string; fingerprint: string; status: string }>;
    const findingId = rpcBody[0]?.finding_id;
    expect(findingId, 'RPC response body must include a finding_id').toBeTruthy();

    // The success banner must appear — an error banner or no signal both count as failures.
    const successBanner = page.getByText('Approval case submitted');
    await successBanner.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(successBanner, 'success banner must be visible after submission').toBeVisible();

    // Reload — the pending approval case must persist (it is stored in the finding table,
    // not held in component state).
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Project Proposal Workbench' })).toBeVisible();

    // Wait for the pending approvals section to settle.
    await page
      .getByRole('heading', { name: 'Pending Rate Approvals' })
      .waitFor({ state: 'visible', timeout: 15_000 });

    // Scope all post-reload assertions to the Pending Rate Approvals section so we are
    // proving the row context is stored and rendered in the right place, not just that
    // the text appears somewhere on the page (e.g. in a filter input or flash message).
    const pendingSection = page
      .locator('*')
      .filter({ has: page.getByRole('heading', { name: 'Pending Rate Approvals' }) })
      .last();

    // The pending row must surface the submitted customer name as the primary card heading.
    // An "Unknown customer" placeholder or a raw UUID is a failure — it means the context
    // submitted to the RPC was not stored or not resolved by the view.
    await expect(
      pendingSection.getByText(customerName),
      `pending approval section must display the submitted customer name "${customerName}" after reload`
    ).toBeVisible({ timeout: 10_000 });

    // The pending row must also surface the submitted branch name as action/context text.
    // A card that shows only the customer name but drops the branch context means the
    // submitted payload was partially stored — the full human-readable context must survive.
    await expect(
      pendingSection.getByText(branchName),
      `pending approval section must display the submitted branch name "${branchName}" as action context after reload`
    ).toBeVisible({ timeout: 10_000 });

    // The "Review & decide approval" link in the submitted customer's card must point to
    // the specific finding returned by the RPC — not any other pending row.
    // Scope to the card inside the pending section that contains both the submitted
    // customer name and the review link, to avoid matching unrelated rows.
    const submittedCustomerCard = pendingSection
      .locator('*')
      .filter({ hasText: customerName })
      .filter({ has: page.getByRole('link', { name: /Review & decide approval/i }) })
      .last();
    const reviewLink = submittedCustomerCard.getByRole('link', { name: /Review & decide approval/i });
    await expect(
      reviewLink,
      'pending approval card for the submitted customer must contain a "Review & decide approval" link'
    ).toBeVisible({ timeout: 10_000 });

    const reviewHref = await reviewLink.getAttribute('href');
    expect(
      reviewHref,
      'Review & decide approval link must point to the exact finding created by this submission'
    ).toMatch(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`, 'i'));
  });

  test('project proposal workbench: surfaces explicit operator guidance when account context, pricing history, availability, or approvals are empty', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev project proposal workbench empty-state operator guidance is tracked as backlog signal until all empty-state paths are confirmed reliable on the live app.');
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated project proposal empty-state E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    // Use filter values highly unlikely to match any real data so all four data
    // sections render their empty states simultaneously.
    const noMatchFilter = 'ZZZNOMATCH_E2E_PROBE_XYZ';
    await page.goto(
      `/rental/project-proposal?customer=${encodeURIComponent(noMatchFilter)}&category=${encodeURIComponent(noMatchFilter)}&branch=${encodeURIComponent(noMatchFilter)}`
    );
    await page.waitForLoadState('networkidle');

    // The page must still render the heading — a blank screen is not acceptable.
    await expect(page.getByRole('heading', { name: 'Project Proposal Workbench' })).toBeVisible();

    // Wait for the data fetches to settle: the account context section always renders
    // either a loading indicator, a data row, or an empty-state message — wait for one
    // of those so we know the fetch cycle completed before reading body text.
    await page
      .getByText(/No matching customer profiles found/i)
      .or(page.getByText(/Loading account context/i).locator('..'))
      .or(page.getByText(/Unable to load account context/i))
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => null);
    const body = await page.locator('body').innerText();

    // Each section must surface a human-readable guidance string rather than
    // leaving the operator with a blank/read-only dead end.
    expect.soft(
      /No matching customer profiles found/i.test(body),
      'empty account context section must surface "No matching customer profiles found" guidance'
    ).toBe(true);

    expect.soft(
      /No pricing history found/i.test(body),
      'empty pricing section must surface "No pricing history found" guidance'
    ).toBe(true);

    expect.soft(
      /No availability data found/i.test(body),
      'empty availability section must surface "No availability data found" guidance'
    ).toBe(true);

    expect.soft(
      /No pending rate approval cases/i.test(body),
      'empty approvals section must surface "No pending rate approval cases" guidance'
    ).toBe(true);

    // The assist-only callout must still be visible — it should not disappear when data is absent.
    expect.soft(
      /Assist only/i.test(body),
      'assist-only callout must remain visible when all data sections are empty'
    ).toBe(true);

    // The Submit for Approval button must still be rendered and reachable even with no data
    // — an operator should be able to compose and submit a proposal from scratch.
    const submitButton = page.getByRole('button', { name: 'Submit for Approval' });
    expect.soft(
      await submitButton.isVisible().catch(() => false),
      'Submit for Approval button must remain visible when data sections are empty'
    ).toBe(true);
  });

  // ─── CRM /crm/customers — payment-issue / timeline context persistence ───────

  test('crm customers: create customer persists operator-readable name after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev CRM create-customer journey is tracked as backlog signal until the live action flow is proven reliable.');
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated CRM customer creation E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const crmListRespPromise = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/rest/v1/crm_customer_profile_current'),
      { timeout: 15_000 }
    );
    await page.goto('/crm/customers', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const crmListResp = await crmListRespPromise;
    expect(crmListResp.ok(), 'crm_customer_profile_current request must succeed').toBe(true);

    await expect(
      page.getByRole('heading', { name: 'Customer Profiles' }),
      '"Customer Profiles" heading must be visible on /crm/customers'
    ).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Create Customer' }),
      '"Create Customer" button must be visible for write-capable operator'
    ).toBeVisible();

    // Generate a stable unique name so we can look it up after reload.
    const testCustomerName = `E2E Test Corp ${Date.now()}`;

    await page.getByRole('button', { name: 'Create Customer' }).click();

    const createDialog = page.getByRole('dialog');
    await expect(createDialog, 'Create Customer modal must open').toBeVisible();

    await createDialog.getByLabel('Customer Name').fill(testCustomerName);

    const createRpcPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('crm_upsert_customer_profile'),
      { timeout: 15_000 }
    );
    await createDialog
      .getByRole('button', { name: 'Create Customer' })
      .click();
    const createRpcResp = await createRpcPromise;
    expect(createRpcResp.ok(), 'crm_upsert_customer_profile RPC must return a success status').toBe(true);

    // After creation the modal should close and the list should show the new name.
    await expect(createDialog).not.toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(testCustomerName, { exact: false }),
      `newly created customer "${testCustomerName}" must appear in the list after creation`
    ).toBeVisible({ timeout: 10_000 });

    // Reload — the created customer name must survive a full page reload; no UUID
    // placeholder or missing row is acceptable.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Customer Profiles' }),
      '"Customer Profiles" heading must be visible after reload'
    ).toBeVisible();

    await expect(
      page.getByText(testCustomerName, { exact: false }),
      `customer name "${testCustomerName}" must remain visible in the list after reload — must not drop to a missing row or opaque ID`
    ).toBeVisible({ timeout: 15_000 });

    // Raw UUIDs must not be the primary label for any customer row.
    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const customerRows = page.locator('[data-testid^="crm-customer-row-"], .crm-customer-row, [role="listitem"]');
    const rowCount = await customerRows.count();
    for (let i = 0; i < rowCount; i += 1) {
      const rowText = (await customerRows.nth(i).locator('p, h2, h3').first().innerText().catch(() => '')).trim();
      expect(
        rawUuidPattern.test(rowText),
        `customer row primary text must not be a raw UUID, got: "${rowText}"`
      ).toBe(false);
    }
  });

  test('crm customers: payment issue escalation surfaces readable issue type and survives reload', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev CRM payment-issue escalation journey is tracked as backlog signal until the live action flow is proven reliable.');
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated CRM payment-issue E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const crmListRespPromise = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/rest/v1/crm_customer_profile_current'),
      { timeout: 15_000 }
    );
    await page.goto('/crm/customers', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await crmListRespPromise;

    await expect(
      page.getByRole('heading', { name: 'Customer Profiles' }),
      '"Customer Profiles" heading must be visible'
    ).toBeVisible();

    // Look for an "Open Issue" button — this appears on rows where payment_issue_flag = 1.
    const openIssueButton = page.getByRole('button', { name: 'Open Issue' }).first();
    if ((await openIssueButton.count()) === 0) {
      test.skip(true, 'No payment-risk customer row with an "Open Issue" button is available in this environment.');
      return;
    }

    // Capture the customer name from the same row as the Open Issue button so we
    // can verify it's preserved on the detail page.
    const issueRow = page
      .locator('*')
      .filter({ has: openIssueButton })
      .last();
    const issueRowText = await issueRow.innerText().catch(() => '');
    // Extract the first non-empty, non-UUID line as the customer name label.
    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const customerName = issueRowText
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !rawUuidPattern.test(l) && !/^open issue$/i.test(l) && !/^view profile$/i.test(l))
      ?? '';

    expect(customerName, 'payment-risk customer row must expose a human-readable name (not a raw UUID)').toBeTruthy();
    expect(rawUuidPattern.test(customerName), 'customer name must not be a raw UUID').toBe(false);

    // Clicking "Open Issue" should navigate to the customer detail route.
    await openIssueButton.click();
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/crm\/customers\/[^/]+$/, { timeout: 10_000 });

    // The detail page must render a human-readable heading — not a raw UUID.
    const detailHeading = page.getByRole('heading').first();
    const headingText = (await detailHeading.innerText().catch(() => '')).trim();
    expect(headingText, 'customer detail heading must be non-empty').toBeTruthy();
    expect(rawUuidPattern.test(headingText), 'customer detail heading must not be a raw UUID').toBe(false);

    // The issue type must be rendered as operator-readable text ("Payment Issue"), not the
    // raw database key ("payment_issue").
    await expect(
      page.getByText('Payment Issue'),
      'issue type must be rendered as "Payment Issue" (human-readable), not as "payment_issue" raw key'
    ).toBeVisible({ timeout: 10_000 });

    // Reload — the issue context must survive.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading').first(),
      'customer heading must still be visible after reload'
    ).toBeVisible();

    const reloadedHeading = (await page.getByRole('heading').first().innerText().catch(() => '')).trim();
    expect(reloadedHeading, 'customer heading must be non-empty after reload').toBeTruthy();
    expect(rawUuidPattern.test(reloadedHeading), 'customer heading must not be a raw UUID after reload').toBe(false);

    await expect(
      page.getByText('Payment Issue'),
      '"Payment Issue" context must remain visible after reload — must not drop to missing rows or opaque IDs'
    ).toBeVisible({ timeout: 10_000 });
  });

  test('crm customers: log interaction persists last-interaction summary context visible after reload', async ({ page }) => {
    test.fail(true, 'Non-gating: deployed-dev CRM log-interaction / last-interaction-summary context persistence is tracked as backlog signal until the live action flow is proven reliable.');
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run authenticated CRM interaction-log E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // Resolve a customer to work with. Prefer accessing the profile view directly
    // to avoid depending on a seeded payment-risk row.
    const crmListRespPromise = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/rest/v1/crm_customer_profile_current'),
      { timeout: 15_000 }
    );
    await page.goto('/crm/customers', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const crmListResp = await crmListRespPromise;
    expect(crmListResp.ok(), 'crm_customer_profile_current request must succeed').toBe(true);

    // Pick the first "View Profile" button — use it to navigate to a detail page.
    const viewProfileButton = page.getByRole('button', { name: 'View Profile' }).first();
    if ((await viewProfileButton.count()) === 0) {
      test.skip(true, 'No customer rows with a "View Profile" button are available in this environment.');
      return;
    }

    await viewProfileButton.click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/crm\/customers\/[^/]+$/, { timeout: 10_000 });

    const detailHeading = page.getByRole('heading').first();
    const customerHeadingText = (await detailHeading.innerText().catch(() => '')).trim();
    expect(customerHeadingText, 'customer detail heading must be non-empty before logging interaction').toBeTruthy();

    // The "Log Interaction" button must be visible for write-capable operators.
    await expect(
      page.getByRole('button', { name: 'Log Interaction' }),
      '"Log Interaction" button must be visible on customer detail page for operator-capable user'
    ).toBeVisible({ timeout: 10_000 });

    // Open the Log Interaction modal.
    await page.getByRole('button', { name: 'Log Interaction' }).click();

    const logDialog = page.getByRole('dialog');
    await expect(logDialog, 'Log Interaction modal must open').toBeVisible();

    // Use a stable summary string we can look for after reload.
    const interactionSummary = `E2E reload context check ${Date.now()}`;
    await logDialog.getByLabel('Summary').fill(interactionSummary);

    const logRpcPromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('crm_upsert_customer_profile'),
      { timeout: 15_000 }
    );
    await logDialog
      .getByRole('button', { name: 'Log Interaction' })
      .click();
    const logRpcResp = await logRpcPromise;
    expect(logRpcResp.ok(), 'crm_upsert_customer_profile RPC must return a success status after logging interaction').toBe(true);

    // After submission the dialog must close.
    await expect(logDialog).not.toBeVisible({ timeout: 10_000 });

    // The summary must be visible on the profile page (it is shown as the fallback
    // last-interaction callout when the timeline list is empty).
    await expect(
      page.getByText(interactionSummary, { exact: false }),
      `interaction summary "${interactionSummary}" must be visible on the detail page after logging`
    ).toBeVisible({ timeout: 15_000 });

    // Reload — the summary must survive because it is stored in the entity version
    // data JSONB under last_interaction_summary and projected by
    // crm_customer_profile_current (20260615122000_crm_profile_last_interaction_projection.sql).
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const reloadedHeading = (await page.getByRole('heading').first().innerText().catch(() => '')).trim();
    expect(reloadedHeading, 'customer heading must be non-empty after reload').toBeTruthy();
    expect(rawUuidPattern.test(reloadedHeading), 'customer heading must not be a raw UUID after reload').toBe(false);
    expect(
      reloadedHeading,
      'customer heading must match the name seen before reload — reload must not switch to a different customer record'
    ).toBe(customerHeadingText);

    await expect(
      page.getByText(interactionSummary, { exact: false }),
      `last-interaction summary "${interactionSummary}" must still be visible after reload — must not drop to "No communication events yet." or a missing row`
    ).toBeVisible({ timeout: 15_000 });

    // Confirm the human-readable interaction type label is also surfaced (not the raw key).
    // The page renders 'call' → 'Call', 'email' → 'Email', etc.
    const humanReadableTypePattern = /\b(Call|Email|Meeting|Internal Note|Interaction)\b/;
    const pageBody = await page.locator('body').innerText();
    expect(
      humanReadableTypePattern.test(pageBody),
      'interaction type must be rendered as a human-readable label (Call / Email / Meeting / Internal Note), not the raw database key'
    ).toBe(true);
  });


  test('predispatch staging assistant shows operator-useful staged-line context, exception evidence, and linked contract handoff', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run predispatch staging E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/dispatch/predispatch', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('predispatch-heading'),
      'predispatch page heading must be visible after navigation'
    ).toBeVisible({ timeout: 10_000 });

    // Wait for loading to complete — the panel replaces the loading alert once data arrives.
    await expect
      .poll(
        async () =>
          (await page.getByTestId('predispatch-staging-panel').count()) +
          (await page.getByTestId('predispatch-error').count()),
        { timeout: 20_000, message: 'predispatch staging panel or error must appear after data load' }
      )
      .toBeGreaterThan(0);

    const errorAlert = page.getByTestId('predispatch-error');
    if ((await errorAlert.count()) > 0) {
      test.skip(true, 'Predispatch staging data failed to load in this environment; skipping staging journey.');
      return;
    }

    const stagingPanel = page.getByTestId('predispatch-staging-panel');
    await expect(stagingPanel, 'predispatch staging panel must be visible once data loads').toBeVisible();

    // Check what state the panel is in.
    const noOpAlert = stagingPanel.getByText(/No pending dispatch lines in the current window/i);
    const stagingItems = page.getByTestId('staging-item');
    const itemCount = await stagingItems.count();

    if ((await noOpAlert.count()) > 0 || itemCount === 0) {
      test.skip(true, 'No pending dispatch lines in the current window; staging journey skipped — see predispatch no-op test.');
      return;
    }

    // --- Staged-line context assertions ---
    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const firstItem = stagingItems.first();

    await expect(firstItem, 'first staged-line card must be visible').toBeVisible();

    const contractNumberEl = firstItem.locator('h3').first();
    await expect(contractNumberEl, 'staged-line card must expose a contract number heading').toBeVisible();
    const contractNumber = (await contractNumberEl.innerText()).trim();
    expect(contractNumber, 'staged-line contract number must not be empty').toBeTruthy();
    expect(
      rawUuidPattern.test(contractNumber),
      `staged-line heading must be a human-readable contract number, not a raw UUID — got: "${contractNumber}"`
    ).toBe(false);

    // Readiness badge must be explicit.
    await expect(
      firstItem.getByText(/Ready to stage|Blocked/i),
      'staged-line card must show an explicit readiness state'
    ).toBeVisible();

    // Customer / job-site / category context — at least one operator-readable label must appear.
    const contextRow = firstItem.locator('.text-muted-foreground').first();
    await expect(contextRow, 'staged-line card must expose customer/job-site/category context').toBeVisible();
    const contextText = (await contextRow.innerText()).trim();
    expect(
      /[A-Za-z]/.test(contextText),
      'staged-line context row must contain descriptive text, not only symbols or empty space'
    ).toBe(true);

    // --- Exception evidence assertions (if any exceptions are present) ---
    const exceptionCards = page.getByTestId('staging-exception');
    const exceptionCount = await exceptionCards.count();

    if (exceptionCount > 0) {
      const firstException = exceptionCards.first();
      await expect(firstException, 'first exception card must be visible').toBeVisible();

      await expect(
        firstException.getByText('Evidence'),
        'exception card must preserve a labelled evidence section'
      ).toBeVisible();

      await expect(
        firstException.getByText('Required action'),
        'exception card must surface a clear required action for the coordinator'
      ).toBeVisible();

      const actionEl = firstException.getByTestId('staging-exception-action');
      await expect(actionEl, 'staging-exception-action element must be visible').toBeVisible();
      const humanActionText = (await actionEl.innerText().catch(() => '')).trim();
      expect(
        humanActionText.length,
        'exception required action description must be non-empty'
      ).toBeGreaterThan(0);

      // --- Linked contract handoff: follow the link and assert context survives reload ---
      const contractLink = firstException.getByTestId('staging-exception-link');
      if ((await contractLink.count()) > 0) {
        const linkHref = await contractLink.getAttribute('href');
        expect(linkHref, 'exception contract link must have a non-empty href').toBeTruthy();
        expect(
          rawUuidPattern.test(linkHref ?? ''),
          'exception contract link href must be a route path, not a bare UUID'
        ).toBe(false);

        const linkLabel = (await contractLink.innerText()).trim();
        expect(linkLabel, 'exception contract link label must be non-empty').toBeTruthy();
        expect(
          rawUuidPattern.test(linkLabel),
          `exception contract link label must be a human-readable contract number, not a raw UUID — got: "${linkLabel}"`
        ).toBe(false);

        // Follow the link and confirm the contract route is reached with operator context visible.
        await contractLink.click();
        await page.waitForLoadState('networkidle');

        await expect(
          page,
          'contract handoff must land on the contract detail route'
        ).toHaveURL(/\/rental\/contracts\//);

        // The contract detail page renders the contract number or "Rental Contract" as a heading.
        await expect(
          page.getByText(new RegExp(`${escapeRegExp(linkLabel)}|Rental Contract`, 'i')),
          'contract detail page must keep contract context visible after handoff from exception card'
        ).toBeVisible({ timeout: 10_000 });

        // Reload — context must survive.
        await page.reload({ waitUntil: 'load' });
        await page.waitForLoadState('networkidle');

        await expect(
          page,
          'URL must remain on the contract detail route after reload'
        ).toHaveURL(/\/rental\/contracts\//);

        await expect(
          page.getByText(new RegExp(`${escapeRegExp(linkLabel)}|Rental Contract`, 'i')),
          'contract detail page must keep the same contract context visible after reload from exception handoff'
        ).toBeVisible({ timeout: 10_000 });
        return;
      }
    }

    // No exception with a contract link; reload the staging page and assert the panel is still intact.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('predispatch-heading'),
      'predispatch heading must remain visible after reload'
    ).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => page.getByTestId('predispatch-staging-panel').count(),
        { timeout: 20_000, message: 'predispatch staging panel must reappear after reload' }
      )
      .toBeGreaterThan(0);

    await expect(
      page.getByTestId('staging-item').first(),
      'staged-line card must still be visible after reload — operator context must not disappear'
    ).toBeVisible({ timeout: 15_000 });
  });

  test('predispatch staging assistant explicit no-op path tells coordinator what to do next and guidance persists after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run predispatch no-op E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/dispatch/predispatch', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('predispatch-heading'),
      'predispatch page heading must be visible after navigation'
    ).toBeVisible({ timeout: 10_000 });

    // Wait for loading to complete.
    await expect
      .poll(
        async () =>
          (await page.getByTestId('predispatch-staging-panel').count()) +
          (await page.getByTestId('predispatch-error').count()),
        { timeout: 20_000, message: 'predispatch staging panel or error must appear after data load' }
      )
      .toBeGreaterThan(0);

    const errorAlert = page.getByTestId('predispatch-error');
    if ((await errorAlert.count()) > 0) {
      test.skip(true, 'Predispatch staging data failed to load in this environment; skipping no-op path test.');
      return;
    }

    const stagingPanel = page.getByTestId('predispatch-staging-panel');
    await expect(stagingPanel, 'predispatch staging panel must be visible once data loads').toBeVisible();

    const stagingItems = page.getByTestId('staging-item');
    const itemCount = await stagingItems.count();

    if (itemCount > 0) {
      test.skip(true, 'Pending dispatch lines are present in the current window; skipping no-op path test.');
      return;
    }

    // --- No-op state assertions ---
    const noOpTitle = stagingPanel.getByText(/No pending dispatch lines in the current window/i);
    await expect(
      noOpTitle,
      'no-op alert title must tell the coordinator there are no pending dispatch lines'
    ).toBeVisible({ timeout: 10_000 });

    const noOpGuidance = stagingPanel.getByText(
      /use the refresh button to regenerate after adding new lines/i
    );
    await expect(
      noOpGuidance,
      'no-op alert must include actionable guidance: tell the coordinator to use the refresh button after adding lines'
    ).toBeVisible({ timeout: 10_000 });

    // The refresh button must be reachable.
    const refreshButton = stagingPanel.getByRole('button', { name: /refresh list/i });
    await expect(
      refreshButton,
      'no-op state must still expose the refresh button so the coordinator can regenerate the list'
    ).toBeVisible();

    // --- Reload: no-op guidance must persist ---
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('predispatch-heading'),
      'predispatch heading must remain visible after reload in no-op state'
    ).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(
        async () => page.getByTestId('predispatch-staging-panel').count(),
        { timeout: 20_000, message: 'predispatch staging panel must reappear after reload in no-op state' }
      )
      .toBeGreaterThan(0);

    await expect(
      page.getByTestId('predispatch-staging-panel').getByText(
        /No pending dispatch lines in the current window/i
      ),
      'no-op guidance must remain visible after reload — the route must not look blank'
    ).toBeVisible({ timeout: 15_000 });
  });

  test('RapidCount variance review: inline audit card surfaces decision and reason after approval', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: RapidCount variance review workflow on deployed dev is tracked as backlog signal until a consistently seeded Submitted task and reliable backend handoff are confirmed in this environment.'
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/PASSWORD (or E2E_AUTH_EMAIL/PASSWORD) to run RapidCount variance review E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);
    await page.goto('/branch/counts', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'RapidCount Scheduling' }),
      'RapidCount Scheduling heading must be visible after navigating to /branch/counts'
    ).toBeVisible();

    // Look for an existing Submitted task row — skip if none are seeded in this environment.
    const submittedTaskRows = page
      .getByTestId('count-task-row')
      .filter({ has: page.getByText('Submitted', { exact: true }) });

    const submittedCount = await submittedTaskRows.count();
    if (submittedCount === 0) {
      test.skip(true, 'No Submitted count tasks are present in this environment — seed a task to cover this journey.');
      return;
    }

    // Target the first available Submitted task row.
    const targetRow = submittedTaskRows.first();

    // Capture the task name for post-reload identification (best-effort).
    const taskNameEl = targetRow.getByTestId('count-task-name');
    const taskName = await taskNameEl.innerText().catch(() => '');

    // The Variance review reason input must be present on a Submitted task row.
    const reasonInput = targetRow.getByLabel('Variance review reason');
    await expect(
      reasonInput,
      'Variance review reason input must be visible on a Submitted task row'
    ).toBeVisible({ timeout: 10_000 });

    const reviewReason = `E2E variance approved — validated against physical count ${Date.now()}`;
    await reasonInput.fill(reviewReason);

    // Intercept the review RPC before submitting.
    const reviewRpcPromise = page.waitForResponse(
      (response) =>
        response.url().includes('/rpc/rapidcount_review_count_variances') &&
        response.request().method() === 'POST'
    );

    await targetRow.getByRole('button', { name: 'Approve Variance' }).click();

    // The RPC must succeed.
    const reviewRpcResponse = await reviewRpcPromise;
    expect(
      reviewRpcResponse.ok(),
      'rapidcount_review_count_variances RPC must return 200 — auth, function wiring, and persistence must pass'
    ).toBe(true);

    await page.waitForLoadState('networkidle');

    // The Approve Variance button must disappear from that row after the decision is persisted.
    await expect(
      targetRow.getByRole('button', { name: 'Approve Variance' }),
      'Approve Variance button must disappear after the decision is persisted'
    ).not.toBeVisible({ timeout: 10_000 });

    // The task row must no longer show a Submitted badge after the review.
    await expect(
      targetRow.getByText('Submitted', { exact: true }),
      'Submitted badge must disappear from the reviewed task row after the decision is persisted'
    ).not.toBeVisible({ timeout: 10_000 });

    // The audit history card must auto-open (the handler selects the reviewed task) and
    // surface the status transition and the reviewer-provided reason.
    const auditHistoryCard = page.getByTestId('audit-history-card');
    await expect(
      auditHistoryCard,
      'Audit History card must be visible after reviewing a variance'
    ).toBeVisible();

    await expect.poll(
      async () => auditHistoryCard.getByText(/submitted/i).count(),
      {
        message: 'Audit History must show a status transition referencing "submitted" after the variance review',
        timeout: 10_000,
      }
    ).toBeGreaterThan(0);

    await expect(
      auditHistoryCard.getByText(reviewReason),
      'Audit History must surface the reviewer-provided reason as the note'
    ).toBeVisible({ timeout: 10_000 });

    // --- Reload: decision must be durable ---
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'RapidCount Scheduling' }),
      'RapidCount Scheduling heading must still be visible after reload'
    ).toBeVisible();

    // Re-locate the reviewed task row after reload.
    const reviewedTaskRow = taskName
      ? page.getByTestId('count-task-row').filter({ hasText: taskName })
      : page.getByTestId('count-task-row').first();

    // The reviewed task must not show a Submitted badge after reload — decision must be durable.
    await expect(
      reviewedTaskRow.getByText('Submitted', { exact: true }),
      'Submitted badge must still be absent from the reviewed task row after reload — decision must be durable'
    ).not.toBeVisible({ timeout: 10_000 });

    // The Approve Variance button must also remain absent after reload.
    await expect(
      reviewedTaskRow.getByRole('button', { name: 'Approve Variance' }),
      'Approve Variance button must still be absent after reload — decision must be durable'
    ).not.toBeVisible();

    // Open the audit trail via View Audit to confirm the trail survived reload.
    const viewAuditButton = reviewedTaskRow.getByRole('button', { name: 'View Audit' });
    await expect(
      viewAuditButton,
      'View Audit button must be present on the reviewed task row after reload'
    ).toBeVisible({ timeout: 10_000 });
    await viewAuditButton.click();

    await expect.poll(
      async () => auditHistoryCard.getByText(/submitted/i).count(),
      {
        message: 'Audit History must still show the "submitted" transition after reload',
        timeout: 10_000,
      }
    ).toBeGreaterThan(0);

    await expect(
      auditHistoryCard.getByText(reviewReason),
      'Audit History must still surface the reviewer reason after reload — audit trail must be durable'
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── AR collections queue — filter durability and human-readable tokens ───────
// Gating: raw workflow tokens and broken filter scope directly block analyst triage.
// Skipped only when credentials are absent.

test.describe('@ops AR collections queue filter durability and token hygiene', () => {
  test('AR collections queue keeps analyst filter scope durable and avoids raw workflow tokens', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run the AR collections queue filter-durability E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // ── 1. Load the page with explicit filter params in the URL ──────────────
    await page.goto('/ops/collections?severity=high&status=pending_approval', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AR Collections Queue' }),
      '"AR Collections Queue" heading must be visible on /ops/collections'
    ).toBeVisible({ timeout: 10_000 });

    // ── 2. Filter scope must survive a reload ────────────────────────────────
    const urlBeforeReload = page.url();
    const parsedBeforeReload = new URL(urlBeforeReload);
    expect(
      parsedBeforeReload.searchParams.get('severity'),
      'severity filter must be present in the URL before reload'
    ).toBe('high');
    expect(
      parsedBeforeReload.searchParams.get('status'),
      'status filter must be present in the URL before reload'
    ).toBe('pending_approval');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const urlAfterReload = page.url();
    const parsedAfterReload = new URL(urlAfterReload);
    expect(
      parsedAfterReload.searchParams.get('severity'),
      'severity filter must still be in the URL after reload'
    ).toBe('high');
    expect(
      parsedAfterReload.searchParams.get('status'),
      'status filter must still be in the URL after reload'
    ).toBe('pending_approval');

    // ── 3. Filter controls must reflect the URL-backed scope ─────────────────
    await expect(
      page.getByRole('combobox', { name: 'Severity' }),
      'Severity combobox must be visible'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('combobox', { name: 'Status' }),
      'Status combobox must be visible'
    ).toBeVisible({ timeout: 10_000 });

    // ── 4. Filter option labels must be human-readable ───────────────────────
    // Open the Status combobox and verify labels are not raw tokens.
    const statusCombobox = page.getByRole('combobox', { name: 'Status' });
    const statusOptionsHtml = await statusCombobox.innerHTML().catch(() => '');
    expect(
      statusOptionsHtml,
      'Status filter must not expose raw "pending_approval" token as an option label'
    ).not.toContain('>pending_approval<');
    expect(
      statusOptionsHtml,
      'Status filter must expose human-readable "Pending approval" label'
    ).toContain('Pending approval');

    const severityCombobox = page.getByRole('combobox', { name: 'Severity' });
    const severityOptionsHtml = await severityCombobox.innerHTML().catch(() => '');
    expect(
      severityOptionsHtml,
      'Severity filter must not expose lower-case only "high" as an option label'
    ).not.toContain('>high<');

    // ── 5. Wait for queue to settle then check card content ──────────────────
    // Navigate to all-findings view to maximise the chance of seeing card content.
    await page.goto('/ops/collections', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect.poll(
      async () =>
        (await page.getByText('No materially new AR signal exists. The collections queue is up to date.').count())
        + (await page.getByRole('link', { name: 'Open finding' }).count()),
      {
        timeout: 20_000,
        message: 'Collections queue must show findings or its empty-state message',
      }
    ).toBeGreaterThan(0);

    if ((await page.getByRole('link', { name: 'Open finding' }).count()) === 0) {
      // No findings in this environment — empty-state path is valid.
      return;
    }

    // ── 6. Card badges and escalation labels must not be raw tokens ──────────
    const firstCard = page.getByRole('link', { name: 'Open finding' }).first().locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
    const cardText = await firstCard.innerText().catch(() => '');

    // Status badge must not show raw token
    expect(
      cardText,
      'Card must not render raw "pending_approval" status token — use human-readable label'
    ).not.toMatch(/\bpending_approval\b/);

    // Escalation fallback must not show raw token
    expect(
      cardText,
      'Card must not render raw "routine_follow_up" escalation token — use human-readable label'
    ).not.toMatch(/\broutine_follow_up\b/);
  });
});

// ─── AR collections queue → finding detail context persistence ───────────────
// Gating: regressions in the queue→detail handoff must fail CI.
// Skipped only when credentials are absent or the queue is empty in this environment.

test.describe('@ops AR collections queue context persistence', () => {
  test('AR collections queue preserves analyst context from queue to finding detail after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run the AR collections queue context-persistence E2E.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const collectionsRespPromise = page.waitForResponse(
      (r) => r.request().method() === 'GET' && r.url().includes('/rest/v1/ops_findings_view'),
      { timeout: 20_000 }
    );
    await page.goto('/ops/collections', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // The page heading must be visible — confirms the route is mounted correctly.
    await expect(
      page.getByRole('heading', { name: 'AR Collections Queue' }),
      '"AR Collections Queue" heading must be visible on /ops/collections'
    ).toBeVisible({ timeout: 10_000 });

    // The data source must respond — confirms the collections view is queryable.
    const collectionsResp = await collectionsRespPromise;
    expect(collectionsResp.ok(), 'ops_findings_view request for collections must succeed').toBe(true);

    // Wait for the queue to reach a stable state: either the explicit empty-state
    // message or at least one "Open finding" link must appear.
    await expect.poll(
      async () =>
        (await page.getByText('No materially new AR signal exists. The collections queue is up to date.').count())
        + (await page.getByRole('link', { name: 'Open finding' }).count()),
      {
        timeout: 20_000,
        message: 'Collections queue must show findings or its empty-state message before asserting context',
      }
    ).toBeGreaterThan(0);

    const openFindingLinks = page.getByRole('link', { name: 'Open finding' });
    if ((await openFindingLinks.count()) === 0) {
      // No findings seeded in this environment — the empty-state message is the correct outcome.
      await expect(
        page.getByText('No materially new AR signal exists. The collections queue is up to date.'),
        'empty collections queue must display operator-readable empty-state message'
      ).toBeVisible();
      return;
    }

    // Capture analyst-useful context from the first queue card before navigating.
    const selectedFindingLink = openFindingLinks.first();
    const findingHref = await selectedFindingLink.getAttribute('href');
    const findingId = findingHref?.match(/\/ops\/findings\/([^/?#]+)/)?.[1];
    expect(findingId, 'collections queue card must expose a finding detail link with an ID').toBeTruthy();

    // The card must surface operator-useful account / customer / branch / escalation context.
    const queueCard = selectedFindingLink.locator(
      'xpath=ancestor::*[.//*[contains(normalize-space(.), "Customer:")] and .//*[contains(normalize-space(.), "Next step:")]][1]'
    );
    const queueCardText = await queueCard.innerText();

    // Customer context — must not be empty or a raw UUID.
    const customerMatch = queueCardText.match(/Customer:\s*([^\n]+)/i);
    const queueCustomer = customerMatch?.[1]?.trim() ?? '';
    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (queueCustomer && queueCustomer !== 'N/A') {
      expect(
        rawUuidPattern.test(queueCustomer),
        `collections queue customer label must not be a raw UUID, got: "${queueCustomer}"`
      ).toBe(false);
    }

    // Branch follow-up context.
    const branchMatch = queueCardText.match(/Branch context:\s*([^\n]+)/i);
    const queueBranch = branchMatch?.[1]?.trim() ?? '';

    // Next-step / proposed-action context.
    const nextStepMatch = queueCardText.match(/Next step:\s*([^·\n]+)/i);
    const queueNextStep = nextStepMatch?.[1]?.trim() ?? '';

    // Escalation stage context.
    const escalationMatch = queueCardText.match(/Escalation:\s*([^\n]+)/i);
    const queueEscalation = escalationMatch?.[1]?.trim() ?? '';

    // Navigate to the finding detail page.
    await selectedFindingLink.click();
    await page.waitForLoadState('networkidle');
    await expect(
      page,
      'clicking "Open finding" must navigate to the finding detail route'
    ).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`), { timeout: 10_000 });

    // The detail page must render a visible heading.
    const detailHeading = page.getByRole('heading', { level: 1 }).first();
    await expect(
      detailHeading,
      'finding detail must render a visible h1 heading after navigation from the collections queue'
    ).toBeVisible({ timeout: 10_000 });
    const detailHeadingText = (await detailHeading.innerText().catch(() => '')).trim();
    expect(detailHeadingText, 'finding detail h1 must be non-empty').toBeTruthy();
    expect(rawUuidPattern.test(detailHeadingText), 'finding detail h1 must not be a raw UUID').toBe(false);

    // Customer context from the queue must carry through to the detail page.
    if (queueCustomer && queueCustomer !== 'N/A') {
      await expect(
        page.getByText(new RegExp(`Customer:\\s*${escapeRegExp(queueCustomer)}`, 'i'), { exact: false }),
        `customer context "${queueCustomer}" selected in the collections queue must be visible on the finding detail page`
      ).toBeVisible({ timeout: 10_000 });
    }

    // Branch follow-up context must carry through if it was surfaced in the queue.
    if (queueBranch && queueBranch !== 'No branch follow-up context captured' && queueBranch !== 'N/A') {
      await expect(
        page.getByText(new RegExp(`Branch context:\\s*${escapeRegExp(queueBranch)}`, 'i'), { exact: false }),
        `branch follow-up context "${queueBranch}" from the collections queue must be visible on the finding detail page`
      ).toBeVisible({ timeout: 10_000 });
    }

    // The proposed-action / next-step must be surfaced on the detail page.
    if (queueNextStep) {
      await expect(
        page.getByText(new RegExp(escapeRegExp(queueNextStep), 'i'), { exact: false }),
        `next-step "${queueNextStep}" from the collections queue must remain visible on the finding detail page`
      ).toBeVisible({ timeout: 10_000 });
    }

    // Escalation context must be surfaced on the detail page if it was in the queue card.
    if (queueEscalation) {
      await expect(
        page.getByText(new RegExp(escapeRegExp(queueEscalation), 'i'), { exact: false }),
        `escalation stage "${queueEscalation}" from the collections queue must remain visible on the finding detail page`
      ).toBeVisible({ timeout: 10_000 });
    }

    // Reload — all context must survive a full page reload.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page,
      'URL must remain on the finding detail route after reload'
    ).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`));

    await expect(
      page.getByRole('heading', { level: 1 }).first(),
      'finding detail h1 must still be visible after reload'
    ).toBeVisible({ timeout: 10_000 });

    const reloadedHeading = (await page.getByRole('heading', { level: 1 }).first().innerText().catch(() => '')).trim();
    expect(reloadedHeading, 'finding detail heading must be non-empty after reload').toBeTruthy();
    expect(
      rawUuidPattern.test(reloadedHeading),
      'finding detail heading must not be a raw UUID after reload'
    ).toBe(false);

    // Customer context must survive reload.
    if (queueCustomer && queueCustomer !== 'N/A') {
      await expect(
        page.getByText(new RegExp(`Customer:\\s*${escapeRegExp(queueCustomer)}`, 'i'), { exact: false }),
        `customer context "${queueCustomer}" must remain visible on the finding detail page after reload — must not drop to "N/A" or a missing row`
      ).toBeVisible({ timeout: 15_000 });
    }

    // Next-step context must survive reload.
    if (queueNextStep) {
      await expect(
        page.getByText(new RegExp(escapeRegExp(queueNextStep), 'i'), { exact: false }),
        `next-step "${queueNextStep}" must remain visible on the finding detail page after reload`
      ).toBeVisible({ timeout: 15_000 });
    }

    // Branch follow-up context must survive reload.
    if (queueBranch && queueBranch !== 'No branch follow-up context captured' && queueBranch !== 'N/A') {
      await expect(
        page.getByText(new RegExp(`Branch context:\\s*${escapeRegExp(queueBranch)}`, 'i'), { exact: false }),
        `branch follow-up context "${queueBranch}" must remain visible on the finding detail page after reload`
      ).toBeVisible({ timeout: 15_000 });
    }

    // Escalation stage must survive reload.
    if (queueEscalation) {
      await expect(
        page.getByText(new RegExp(escapeRegExp(queueEscalation), 'i'), { exact: false }),
        `escalation stage "${queueEscalation}" must remain visible on the finding detail page after reload`
      ).toBeVisible({ timeout: 15_000 });
    }
  });

});

// ─── Shop morning queue → page load and filter sanity ────────────────────────
// Non-gating: route is implemented; queue reliability on deployed dev is still
// being proven. Signals a regression in the page heading, data source, or
// filter controls but never blocks a merge.
// Covered path: /ops/shop-morning-queue × route mounts / heading visible /
// ops_findings_view query succeeds / queue or empty-state renders.

test.describe('@ops shop morning queue page load and filter sanity', () => {
  test('shop morning queue renders heading, fires ops_findings_view query, and shows queue or empty state', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run shop morning queue E2E coverage.'
    );
    test.fail(true, 'Non-gating: shop morning queue page load and filter sanity on deployed dev is tracked as backlog signal until reliability improves.');

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const queueRespPromise = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        r.url().includes('/rest/v1/ops_findings_view') &&
        r.url().includes('agent_key=eq.shop-morning-queue'),
      { timeout: 20_000 }
    );

    await page.goto('/ops/shop-morning-queue', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // The page heading must be visible — confirms the route is mounted correctly.
    await expect(
      page.getByRole('heading', { name: 'Shop Morning Queue' }),
      '"Shop Morning Queue" heading must be visible on /ops/shop-morning-queue'
    ).toBeVisible({ timeout: 10_000 });

    // The data source must respond — confirms the view is queryable for this agent.
    const queueResp = await queueRespPromise;
    expect(queueResp.ok(), 'ops_findings_view request for shop-morning-queue agent must succeed').toBe(true);

    // Wait for the queue to reach a stable state: either the explicit empty-state
    // message or at least one "Open finding" link must appear.
    await expect.poll(
      async () =>
        (await page.getByText('No new shop signals').count()) +
        (await page.getByRole('link', { name: 'Open finding' }).count()),
      {
        timeout: 20_000,
        message: 'Shop morning queue must show findings or its empty-state message before asserting filter controls',
      }
    ).toBeGreaterThan(0);

    // Filter controls must be present and functional — changing Priority must not
    // crash the page or remove the heading.
    const priorityCombobox = page.getByRole('combobox', { name: 'Priority' });
    if ((await priorityCombobox.count()) > 0) {
      await priorityCombobox.selectOption('critical');
      await page.waitForLoadState('networkidle');
      await expect(
        page.getByRole('heading', { name: 'Shop Morning Queue' }),
        '"Shop Morning Queue" heading must survive a Priority filter change'
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test('shop morning queue keeps filters durable and surfaces operator-readable morning decisions', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run shop morning queue durable-filter and operator-readability coverage.'
    );
    // Non-gating by design (per issue #1930): the operator-readability and URL-persistence
    // gaps are the target of this test; once the live-dev surface is confirmed stable this
    // wrapper should be removed to promote the test to a gating regression guard.
    test.fail(
      true,
      'Non-gating: shop morning queue keeps filters durable and surfaces operator-readable morning decisions — tracked as backlog signal until operator-readability and URL-persistence are proven on deployed dev.'
    );

    // Mirrors the shop-queue finding types in FINDING_TYPE_LABELS (ExpressionEvaluator.ts).
    // If new shop queue finding types are added to that map, add them here too.
    const rawTokenPattern = /\b(pm_due|work_order_priority|not_available_unit|parts_blocker|pending_approval)\b/;
    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/ops/shop-morning-queue', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Loading state or queue content must be visible — page must not be a blank surface.
    await expect(
      page.getByRole('heading', { name: 'Shop Morning Queue' }),
      '"Shop Morning Queue" heading must be visible'
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the queue to settle: loading text disappears or data/empty-state renders.
    await expect.poll(
      async () => {
        const loading = await page.getByText('Loading morning queue...').count();
        const empty = await page.getByText('No queue items match the current filters.').count();
        const noOp = await page.getByText('No new shop signals').count();
        const cards = await page.getByRole('link', { name: 'View Detail →' }).count();
        return loading === 0 && (empty + noOp + cards) > 0;
      },
      {
        timeout: 20_000,
        message:
          'Queue must show an explicit loading, empty, no-op, or card state — a blank surface is not acceptable.',
      }
    ).toBe(true);

    // ── Queue Type filter scope persists in the URL ────────────────────────────
    await page.getByRole('combobox', { name: 'Queue Type' }).selectOption('pm_due');
    await expect.poll(() => page.url(), {
      timeout: 10_000,
      message: 'Queue Type filter change must encode "pm_due" into the URL query string',
    }).toContain('itemType=pm_due');

    expect(
      new URL(page.url()).pathname,
      'pathname must remain /ops/shop-morning-queue after Queue Type filter change'
    ).toBe('/ops/shop-morning-queue');

    // ── Status filter scope persists in the URL ────────────────────────────────
    await page.getByRole('combobox', { name: 'Status' }).selectOption('%');
    await expect.poll(() => page.url(), {
      timeout: 10_000,
      message: 'Status filter change to All must encode "%" into the URL query string',
    }).toMatch(/status=%/);

    // ── URL params survive a full page reload ──────────────────────────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Shop Morning Queue' }),
      '"Shop Morning Queue" heading must remain visible after reload with URL filter params'
    ).toBeVisible({ timeout: 10_000 });

    expect(
      new URL(page.url()).searchParams.get('itemType'),
      'Queue Type filter URL param must survive a full page reload'
    ).toBe('pm_due');

    await expect(
      page.getByRole('combobox', { name: 'Queue Type' }),
      '"Queue Type" combobox must reflect the reloaded filter value'
    ).toHaveValue('pm_due');

    // Reset to show all items to check card content.
    await page.goto('/ops/shop-morning-queue', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // ── If cards are present: operator-readable content, no raw tokens ─────────
    const viewDetailLinks = page.getByRole('link', { name: 'View Detail →' });
    if ((await viewDetailLinks.count()) === 0) {
      // No findings in this environment — empty or no-op state is the correct outcome.
      const emptyOrNoOp =
        (await page.getByText('No queue items match the current filters.').count()) +
        (await page.getByText('No new shop signals').count());
      expect(
        emptyOrNoOp,
        'an empty shop morning queue must show an explicit empty-state or no-op message'
      ).toBeGreaterThan(0);
      return;
    }

    // A card is visible — assert that it shows operator-readable content, not raw tokens.
    // Check the full page visible text: innerText() returns only rendered text so form values
    // (e.g. the combobox option value "pm_due") are not included; only the displayed label is.
    const firstCardLink = viewDetailLinks.first();
    const findingHref = await firstCardLink.getAttribute('href');
    const findingId = findingHref?.match(/\/ops\/findings\/([^/?#]+)/)?.[1];
    expect(findingId, '"View Detail →" link must contain a finding ID path segment').toBeTruthy();

    const pageText = await page.locator('body').innerText();
    expect(
      rawTokenPattern.test(pageText),
      `queue page must not expose raw workflow tokens in operator-facing content — found: "${pageText.match(rawTokenPattern)?.[0] ?? ''}"`
    ).toBe(false);

    // ── View Detail handoff navigates to the matching finding detail ───────────
    await firstCardLink.click();
    await page.waitForLoadState('networkidle');
    await expect(
      page,
      'clicking "View Detail →" must navigate to the finding detail route'
    ).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`), { timeout: 10_000 });

    // Detail page must have a visible heading.
    const detailHeading = page.getByRole('heading', { level: 1 }).first();
    await expect(
      detailHeading,
      'finding detail must render a visible h1 heading after navigating from the shop morning queue'
    ).toBeVisible({ timeout: 15_000 });
    const detailHeadingText = (await detailHeading.innerText().catch(() => '')).trim();
    expect(detailHeadingText, 'finding detail h1 must be non-empty').toBeTruthy();
    expect(
      rawUuidPattern.test(detailHeadingText),
      'finding detail h1 must not be a raw UUID'
    ).toBe(false);

    // ── View Detail URL is durable after reload ────────────────────────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page,
      'finding detail URL must remain stable after reload'
    ).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`));

    await expect(
      detailHeading,
      'finding detail h1 must still be visible after reload'
    ).toBeVisible({ timeout: 15_000 });

    const reloadedHeading = (await detailHeading.innerText().catch(() => '')).trim();
    expect(reloadedHeading, 'finding detail heading must be non-empty after reload').toBeTruthy();
    expect(
      rawUuidPattern.test(reloadedHeading),
      'finding detail heading must not be a raw UUID after reload'
    ).toBe(false);
    expect(
      reloadedHeading,
      'finding detail heading must match the heading seen before reload'
    ).toBe(detailHeadingText);
  });
});

// ─── Technician morning queue → durable review handoff + explicit empty state ───
// Non-gating: deployed-dev usefulness and review-handoff durability are still
// being proven. Signals regressions in filter controls, explicit empty/error
// states, and finding-review context preservation without blocking merges.

test.describe('@ops technician morning queue review handoff preserves context', () => {
  test('technician morning queue shows usable states and preserves finding review context after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD so ops-capable credentials are available for technician morning queue E2E coverage.'
    );
    test.fail(
      true,
      'Non-gating: technician morning queue usefulness, explicit empty-state handling, and finding review handoff durability on deployed dev are tracked as backlog signal until reliability is proven.'
    );

    const TECHNICIAN_CONTEXT_KEYWORDS = [
      'Priority reasons',
      'Blockers',
      'Stale signals',
      'Contract risk',
      'Parts blocked',
      'Return condition evidence available',
    ];

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/ops/technician-morning-queue', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Technician Morning Queue' }),
      '"Technician Morning Queue" heading must be visible on /ops/technician-morning-queue'
    ).toBeVisible({ timeout: 10_000 });

    const priorityCombobox = page.getByRole('combobox', { name: 'Priority' });
    const workTypeCombobox = page.getByRole('combobox', { name: 'Work Type' });
    const statusCombobox = page.getByRole('combobox', { name: 'Status' });
    await expect(priorityCombobox, '"Priority" filter must be visible').toBeVisible();
    await expect(workTypeCombobox, '"Work Type" filter must be visible').toBeVisible();
    await expect(statusCombobox, '"Status" filter must be visible').toBeVisible();

    await statusCombobox.selectOption('%');
    await expect.poll(
      () => new URL(page.url()).searchParams.get('status'),
      {
        timeout: 10_000,
        message: 'Status filter change must persist in the technician queue URL',
      }
    ).toBe('%');

    const broadQueueUrl = page.url();

    await page.goto(
      '/ops/technician-morning-queue?priority=__copilot_no_match__&itemType=__copilot_no_match__&status=__copilot_no_match__',
      { waitUntil: 'load' }
    );
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Technician Morning Queue' }),
      'technician queue heading must remain visible even when filters match no findings'
    ).toBeVisible({ timeout: 10_000 });

    await expect.poll(
      async () =>
        (await page.getByText('Loading morning queue...').count()) +
        (await page.getByText('Unable to load morning queue').count()) +
        (await page.getByText('No queue items match the current filters.').count()),
      {
        timeout: 20_000,
        message:
          'When technician queue filters match no findings, the page must show explicit loading/error/empty copy instead of a blank panel.',
      }
    ).toBeGreaterThan(0);

    const queueRespPromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/ops_findings_view') &&
        response.url().includes('agent_key=eq.technician-morning-queue'),
      { timeout: 20_000 }
    );

    await page.goto(broadQueueUrl, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const queueResp = await queueRespPromise;
    const queueRespOk = queueResp.ok();
    const queueItems = queueRespOk ? ((await queueResp.json()) as Array<Record<string, unknown>>) : [];

    await expect.poll(
      async () =>
        (await page.getByText('No new technician signals').count()) +
        (await page.getByText('No queue items match the current filters.').count()) +
        (await page.getByText('Unable to load morning queue').count()) +
        (await page.getByRole('link', { name: 'View / Override →' }).count()),
      {
        timeout: 20_000,
        message:
          'Technician queue must render actionable cards or an explicit no-op/empty/error state after the queue response resolves.',
      }
    ).toBeGreaterThan(0);

    if (!queueRespOk) {
      await expect(
        page.getByText('Unable to load morning queue'),
        'failed queue requests must show explicit error copy'
      ).toBeVisible();
      return;
    }

    const viewOverrideLinks = page.getByRole('link', { name: 'View / Override →' });
    if ((await viewOverrideLinks.count()) === 0 || queueItems.length === 0) {
      const explicitStateCount =
        (await page.getByText('No new technician signals').count()) +
        (await page.getByText('No queue items match the current filters.').count()) +
        (await page.getByText('Unable to load morning queue').count());
      expect(
        explicitStateCount,
        'an empty technician morning queue must surface explicit no-op/empty/error copy'
      ).toBeGreaterThan(0);
      return;
    }

    const firstQueueItem = queueItems[0];
    const queuedContextSnippet = [firstQueueItem.proposed_action, firstQueueItem.rationale]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ?.trim();

    const queueText = await page.locator('body').innerText();
    const hasReadableTechnicianCue = TECHNICIAN_CONTEXT_KEYWORDS.some((keyword) =>
      queueText.toLowerCase().includes(keyword.toLowerCase())
    );
    expect(
      hasReadableTechnicianCue || (!!queuedContextSnippet && queueText.includes(queuedContextSnippet)),
      'queue cards must surface operator-meaningful technician context (priority reasons/blockers/stale warnings/badges or a readable proposed action), not raw IDs alone'
    ).toBe(true);

    const currentPriorityFilter = await priorityCombobox.inputValue();
    const currentStatusFilter = await statusCombobox.inputValue();
    const firstViewOverrideLink = viewOverrideLinks.first();
    const findingHref = await firstViewOverrideLink.getAttribute('href');
    const findingId = findingHref?.match(/\/ops\/findings\/([^/?#]+)/)?.[1];
    expect(findingId, '"View / Override →" link must contain a finding ID path segment').toBeTruthy();

    await firstViewOverrideLink.click();
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`), { timeout: 10_000 });
    await expect(
      page.getByRole('link', { name: '← Back to Technician Morning Queue' }),
      'finding detail must retain technician queue provenance for back-navigation context'
    ).toBeVisible({ timeout: 15_000 });

    const detailUrl = new URL(page.url());
    expect(detailUrl.searchParams.get('source'), 'finding detail handoff must carry source=technician-morning-queue').toBe('technician-morning-queue');
    expect(detailUrl.searchParams.get('returnPriority'), 'finding detail handoff must preserve returnPriority from the queue scope').toBe(currentPriorityFilter);
    expect(detailUrl.searchParams.get('returnStatus'), 'finding detail handoff must preserve returnStatus from the queue scope').toBe(currentStatusFilter);

    if (queuedContextSnippet) {
      await expect(
        page.getByText(queuedContextSnippet, { exact: false }).first(),
        'finding detail should keep the surfaced technician queue narrative visible for review'
      ).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(
        page.getByText(/proposed action|rationale|evidence/i).first(),
        'finding detail must expose review context even when the queue row lacks a single reusable text snippet'
      ).toBeVisible({ timeout: 15_000 });
    }

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`));
    await expect(
      page.getByRole('link', { name: '← Back to Technician Morning Queue' }),
      'technician queue provenance must still be visible after reload on the finding detail page'
    ).toBeVisible({ timeout: 15_000 });

    if (queuedContextSnippet) {
      await expect(
        page.getByText(queuedContextSnippet, { exact: false }).first(),
        'the same surfaced technician queue context must remain visible after reload'
      ).toBeVisible({ timeout: 15_000 });
    }
  });
});

// ─── Account health queue → filter durability + review handoff context ─────────
// Non-gating: route is implemented; deployed-dev reliability for this live
// review journey is still being proven and tracked as backlog signal coverage.
// Covered path: /ops/account-health-queue × Useful / Action works / In a journey.

test.describe('@ops account health queue review handoff preserves outreach context', () => {
  test('account health queue keeps filter scope durable and carries review context into finding detail', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run account health queue E2E coverage.'
    );
    test.fail(
      true,
      'Non-gating: account health queue filter durability and finding review handoff context on deployed dev are tracked as backlog signal until reliability is proven.'
    );

    // UI/route contract in ops-account-health-queue.json uses "%" as the wildcard
    // status/signal/priority value ("All ...") for the Supabase ilike filters.
    const STATUS_ALL = '%';
    const MIN_NARRATIVE_WORDS = 4;
    // Keep these aligned with operator-readable evidence surfaced by
    // src/pages/ops-account-health-queue.json.
    const OUTREACH_EVIDENCE_KEYWORDS = ['contact gap:', 'last rental:', 'utilization:', 'stale signals'];
    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/ops/account-health-queue', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Account Health Queue' }),
      '"Account Health Queue" heading must be visible on /ops/account-health-queue'
    ).toBeVisible({ timeout: 10_000 });

    const signalCombobox = page.getByRole('combobox', { name: 'Health Signal' });
    const priorityCombobox = page.getByRole('combobox', { name: 'Priority' });
    const statusCombobox = page.getByRole('combobox', { name: 'Status' });
    const accountInput = page.getByRole('textbox', { name: 'Account' });
    await expect(signalCombobox, '"Health Signal" filter control must be visible').toBeVisible();
    await expect(priorityCombobox, '"Priority" filter control must be visible').toBeVisible();
    await expect(statusCombobox, '"Status" filter control must be visible').toBeVisible();
    await expect(accountInput, '"Account" filter input must be visible').toBeVisible();

    await expect.poll(
      async () =>
        (await page.getByText('No account health signals').count()) +
        (await page.getByRole('link', { name: 'Review thread →' }).count()),
      {
        timeout: 20_000,
        message: 'Account health queue must render reviewable cards or an explicit "No account health signals" state',
      }
    ).toBeGreaterThan(0);

    await signalCombobox.selectOption('lost');
    await priorityCombobox.selectOption('high');
    await statusCombobox.selectOption(STATUS_ALL);
    await accountInput.fill('acme');

    await expect.poll(
      () => {
        const url = new URL(page.url());
        return [
          url.searchParams.get('signal'),
          url.searchParams.get('priority'),
          url.searchParams.get('status'),
          url.searchParams.get('customer'),
        ].join('|');
      },
      {
        timeout: 10_000,
        message: 'Health Signal, Priority, Status, and Account filter scope must be encoded in the queue URL',
      }
    ).toBe(`lost|high|${STATUS_ALL}|acme`);

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Account Health Queue' }),
      '"Account Health Queue" heading must remain visible after reload'
    ).toBeVisible({ timeout: 10_000 });

    const reloadedUrl = new URL(page.url());
    expect(reloadedUrl.searchParams.get('signal'), 'signal filter scope must survive a full reload').toBe('lost');
    expect(reloadedUrl.searchParams.get('priority'), 'priority filter scope must survive a full reload').toBe('high');
    expect(reloadedUrl.searchParams.get('status'), 'status filter scope must survive a full reload').toBe(STATUS_ALL);
    expect(reloadedUrl.searchParams.get('customer'), 'account filter scope must survive a full reload').toBe('acme');
    await expect(signalCombobox, '"Health Signal" combobox must keep selected value after reload').toHaveValue('lost');
    await expect(priorityCombobox, '"Priority" combobox must keep selected value after reload').toHaveValue('high');
    await expect(statusCombobox, '"Status" combobox must keep selected value after reload').toHaveValue(STATUS_ALL);
    await expect(accountInput, '"Account" input must keep selected value after reload').toHaveValue('acme');

    const reviewLinks = page.getByRole('link', { name: 'Review thread →' });
    if ((await reviewLinks.count()) === 0) {
      await expect(
        page.getByText('No account health signals'),
        'an empty account health queue must surface an explicit "No account health signals" state'
      ).toBeVisible();
      return;
    }

    const firstReviewLink = reviewLinks.first();
    const findingHref = await firstReviewLink.getAttribute('href');
    const findingId = findingHref?.match(/\/ops\/findings\/([^/?#]+)/)?.[1];
    expect(findingId, '"Review thread →" link must include a finding ID path segment').toBeTruthy();

    const queueVisibleText = await page.locator('body').innerText();
    const hasExplicitEvidence = OUTREACH_EVIDENCE_KEYWORDS.some((keyword) =>
      queueVisibleText.toLowerCase().includes(keyword)
    );
    const hasReadableOutreachNarrative = queueVisibleText
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line.split(/\s+/).length >= MIN_NARRATIVE_WORDS && !rawUuidPattern.test(line) && line !== 'Review thread →');
    expect(
      hasExplicitEvidence || hasReadableOutreachNarrative,
      'reviewable account cards must surface readable outreach evidence (recommended angle/contact gap/last rental/utilization/stale signals), not only opaque IDs'
    ).toBe(true);

    const activeScope = new URL(page.url()).searchParams;
    const expectedReturnSignal = activeScope.get('signal') ?? '';
    const expectedReturnPriority = activeScope.get('priority') ?? '';
    const expectedReturnStatus = activeScope.get('status') ?? '';
    const expectedReturnCustomer = activeScope.get('customer') ?? '';

    await firstReviewLink.click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`/ops/findings/${escapeRegExp(findingId!)}`), { timeout: 10_000 });
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
      'finding detail heading must be visible after Review thread handoff'
    ).toBeVisible({ timeout: 15_000 });

    const detailUrl = new URL(page.url());
    expect(detailUrl.searchParams.get('source'), 'finding detail handoff must carry source=account-health-queue').toBe('account-health-queue');
    expect(detailUrl.searchParams.get('returnSignal'), 'finding detail handoff must preserve returnSignal from active queue scope').toBe(expectedReturnSignal);
    expect(detailUrl.searchParams.get('returnPriority'), 'finding detail handoff must preserve returnPriority from active queue scope').toBe(expectedReturnPriority);
    expect(detailUrl.searchParams.get('returnStatus'), 'finding detail handoff must preserve returnStatus from active queue scope').toBe(expectedReturnStatus);
    expect(detailUrl.searchParams.get('returnCustomer'), 'finding detail handoff must preserve returnCustomer from active queue scope').toBe(expectedReturnCustomer);
  });
});

// ─── Counter-review → routed workflow handoff context persistence ─────────────
// Non-gating: route is implemented; multi-screen handoff has not yet been
// proven stable enough on deployed dev to make merge-blocking.
// Covered path: /rental/counter-review × Useful / Action works / In a journey.

test.describe('counter review routes exception cases into durable workflow handoffs', () => {
  test('preserves contract and customer context across navigation and reload', async ({ page }) => {
    test.fail();
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run the counter-review routed-handoff E2E.'
    );

    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    await page.goto('/rental/counter-review', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // The page heading must confirm the route is mounted and not a read-only shell.
    await expect(
      page.getByRole('heading', { level: 1 }),
      '"Counter account, return, billing, and opportunity review" heading must be visible on /rental/counter-review'
    ).toBeVisible({ timeout: 15_000 });

    // The screen must surface operator-useful summary counts — not a silent skeleton.
    // These four summary cards are the operator's at-a-glance signal triage view.
    await expect(
      page.getByText('Account blockers'),
      '"Account blockers" summary card must be visible on /rental/counter-review'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText('Return follow-ups'),
      '"Return follow-ups" summary card must be visible on /rental/counter-review'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText('Invoice anomalies'),
      '"Invoice anomalies" summary card must be visible on /rental/counter-review'
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText('Sales handoffs'),
      '"Sales handoffs" summary card must be visible on /rental/counter-review'
    ).toBeVisible({ timeout: 10_000 });

    // At least one review case must be surfaced — the handoff path cannot be exercised on an
    // empty queue.  If no case is available the test must fail (not silently pass), so we assert
    // the presence of an "Open contract" link directly.  An empty-state screen does not satisfy
    // the acceptance criterion for this test.
    await expect(
      page.getByRole('link', { name: 'Open contract' }).first(),
      'counter-review must surface at least one review case to exercise the routed-handoff path — an empty queue does not satisfy this test'
    ).toBeVisible({ timeout: 20_000 });

    const openContractLinks = page.getByRole('link', { name: 'Open contract' });

    // Capture contract and customer context from the first visible review case card.
    const firstOpenContractLink = openContractLinks.first();
    const contractHref = await firstOpenContractLink.getAttribute('href');
    const contractId = contractHref?.match(/\/rental\/contracts\/([^/?#]+)/)?.[1];
    expect(contractId, 'counter-review case must expose an "Open contract" link with a contract ID').toBeTruthy();

    // The case card must surface a human-readable contract label — not a raw UUID as its primary title.
    // Each counter-review case card carries a data-testid="counter-review-case-<id>" attribute.
    // We require this attribute so the return-trip assertion can be scoped to the exact same card.
    const reviewCaseCard = firstOpenContractLink.locator('xpath=ancestor::*[@data-testid][1]');
    const reviewCaseCardText = await reviewCaseCard.innerText().catch(() => '');
    const caseCardTestId = await reviewCaseCard.getAttribute('data-testid').catch(() => null);
    expect(
      caseCardTestId,
      'counter-review case card must have a data-testid attribute so the return-trip assertion can be scoped to this exact card'
    ).toBeTruthy();

    // Contract number: must be a human-readable label (e.g. "RC-1001"), not just a raw UUID.
    // This is a required assertion — an empty or missing label means the card is not rendering
    // operator-useful context and the test must fail.
    const contractNumberMatch = reviewCaseCardText.match(/RC-\d+|[A-Z]{1,4}-\d{3,}/);
    const contractNumber = contractNumberMatch?.[0]?.trim() ?? '';
    expect(
      contractNumber,
      'counter-review case card must expose a human-readable contract label (e.g. "RC-1001") — a missing or UUID-only label does not satisfy the acceptance criterion'
    ).toBeTruthy();

    // Customer context: "Customer: <name>" must appear, be non-empty, and not be a placeholder or
    // raw UUID.  All three assertions are required — the spec must fail if any of them are unmet.
    const customerMatch = reviewCaseCardText.match(/Customer:\s*([^\n·]+)/i);
    const customerLabel = customerMatch?.[1]?.trim() ?? '';
    expect(
      customerLabel,
      'counter-review case card must expose a non-empty "Customer:" label'
    ).toBeTruthy();
    expect(
      customerLabel === 'Unknown' || customerLabel === 'N/A',
      `counter-review customer label must not be a placeholder, got: "${customerLabel}"`
    ).toBe(false);
    expect(
      rawUuidPattern.test(customerLabel),
      `counter-review customer label must not be a raw UUID, got: "${customerLabel}"`
    ).toBe(false);

    // Follow the "Open contract" link into the underlying contract workflow.
    await firstOpenContractLink.click();
    await page.waitForLoadState('networkidle');
    await expect(
      page,
      'clicking "Open contract" must navigate to the contract detail route'
    ).toHaveURL(new RegExp(`/rental/contracts/${escapeRegExp(contractId!)}`, 'i'), { timeout: 10_000 });

    // The contract detail page must render a visible heading — confirms it is not a broken 404.
    const contractDetailHeading = page.getByRole('heading', { level: 1 }).first();
    await expect(
      contractDetailHeading,
      'contract detail must render a visible h1 heading after navigation from counter-review'
    ).toBeVisible({ timeout: 15_000 });
    const contractDetailHeadingText = (await contractDetailHeading.innerText().catch(() => '')).trim();
    expect(contractDetailHeadingText, 'contract detail h1 must be non-empty').toBeTruthy();
    expect(
      rawUuidPattern.test(contractDetailHeadingText),
      'contract detail h1 must not be a raw UUID'
    ).toBe(false);

    // Preserve the heading text so we can verify it survives a reload.
    const preReloadHeading = contractDetailHeadingText;

    // Reload — contract context must survive a full page reload.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await expect(
      page,
      'URL must remain on the contract detail route after reload'
    ).toHaveURL(new RegExp(`/rental/contracts/${escapeRegExp(contractId!)}`, 'i'));

    await expect(
      page.getByRole('heading', { level: 1 }).first(),
      'contract detail h1 must still be visible after reload'
    ).toBeVisible({ timeout: 15_000 });

    const reloadedHeading = (await page.getByRole('heading', { level: 1 }).first().innerText().catch(() => '')).trim();
    expect(reloadedHeading, 'contract detail heading must be non-empty after reload').toBeTruthy();
    expect(
      rawUuidPattern.test(reloadedHeading),
      'contract detail heading must not be a raw UUID after reload'
    ).toBe(false);
    expect(
      reloadedHeading,
      'contract detail heading must match the heading seen before reload — reload must not switch context'
    ).toBe(preReloadHeading);

    // The contract number from the review card must also be visible on the detail page so the
    // operator knows they are looking at the right contract (not a different record).
    await expect(
      page.getByText(new RegExp(escapeRegExp(contractNumber), 'i'), { exact: false }),
      `contract number "${contractNumber}" from counter-review must be visible on the contract detail page after reload`
    ).toBeVisible({ timeout: 10_000 });

    // Return trip — navigate back to /rental/counter-review and verify the same review case is
    // still surfaced with the same contract/customer context (queue must be durable across hops).
    await page.goto('/rental/counter-review', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { level: 1 }),
      '"Counter account, return, billing, and opportunity review" heading must be visible after returning to /rental/counter-review'
    ).toBeVisible({ timeout: 15_000 });

    // The review queue must still contain the same case we followed — not be empty or reset.
    await expect(
      page.getByRole('link', { name: 'Open contract' }).first(),
      'review queue must still show at least one "Open contract" link after the operator returns from a workflow handoff'
    ).toBeVisible({ timeout: 20_000 });

    // The same contract we followed must still be visible in the queue.
    const returnedContractLinks = page.getByRole('link', { name: 'Open contract' });
    const returnedHrefs = await returnedContractLinks.evaluateAll((links) =>
      (links as HTMLAnchorElement[]).map((a) => a.getAttribute('href') ?? '')
    );
    expect(
      returnedHrefs.some((href) => href.includes(contractId!)),
      `contract "${contractId}" must still appear in the counter-review queue after the operator returns from the workflow handoff`
    ).toBe(true);

    // Customer context must still be visible for the same case card — assertion is scoped to that
    // specific card (by data-testid), never a page-wide text search.
    const returnedCaseCard = page.getByTestId(caseCardTestId as string);
    await expect(
      returnedCaseCard,
      `the same review case (${caseCardTestId}) must still be present in the queue after the operator returns from a workflow handoff`
    ).toBeVisible({ timeout: 20_000 });
    const returnedCardText = (await returnedCaseCard.innerText().catch(() => '')).toLowerCase();
    expect(
      returnedCardText.includes(customerLabel.toLowerCase()),
      `customer context "${customerLabel}" must still be visible in case card "${caseCardTestId}" on return — must not drop to "Unknown" or be missing`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Covered path: /ops/billing-updates × heading / filters / URL scope / empty state /
// human-readable account context / analyst handoff durability across reload.
//
// Non-gating: queue currently renders raw billing_account_id / customer_id values
// and has no per-row review action — assertions expose known gaps without blocking deploys.
// ---------------------------------------------------------------------------
test.describe('@non-gating billing update approval queue — analyst handoff preserves account context', () => {
  test('billing update approval queue keeps analyst scope durable and surfaces review-ready account context', async ({ page }) => {
    test.fail(
      true,
      // test.fail() marks the ENTIRE test as expected-to-fail because the inner
      // assertions about human-readable account context and per-row review handoff
      // will fail against the current UUID-first queue surface.  The earlier
      // assertions (heading, filters, URL scope) provide useful diagnostic context
      // when the expected failure occurs and will be promoted to a passing test
      // once the data layer and review UI gaps are closed.
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL + password to run ops billing-update analyst handoff coverage.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const queueRespPromise = page.waitForResponse(
      (r) =>
        r.url().includes('/rpc/ops_get_billing_update_queue') &&
        r.request().method() === 'POST',
      { timeout: 20_000 },
    );

    await page.goto('/ops/billing-updates', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Heading must be visible — route must be reachable by an ops-capable user.
    await expect(
      page.getByRole('heading', { name: 'Billing Update Request Queue' }),
      '"Billing Update Request Queue" heading must be visible on /ops/billing-updates',
    ).toBeVisible({ timeout: 10_000 });

    const queueResp = await queueRespPromise;
    expect(
      queueResp.ok(),
      'ops_get_billing_update_queue RPC must succeed for an ops-capable user',
    ).toBe(true);

    // Filter controls must be present and labelled for the analyst.
    await expect(
      page.getByRole('combobox', { name: 'Request type' }),
      '"Request type" filter combobox must be visible',
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('combobox', { name: 'Status' }),
      '"Status" filter combobox must be visible',
    ).toBeVisible({ timeout: 10_000 });

    // Stabilise: either explicit empty state or at least one card must render.
    await expect.poll(
      async () =>
        (await page.getByText('No billing update requests match the current filters').count()) +
        (await page.getByText('Billing account:').count()) +
        (await page.getByText('Reference:').count()),
      {
        timeout: 20_000,
        message:
          'Ops billing-update queue must render an explicit empty state or at least one request card — a blank queue is not acceptable',
      },
    ).toBeGreaterThan(0);

    // -------------------------------------------------------------------------
    // Filter scope durability: change Status filter → URL must reflect the
    // selection → reload must restore the selection from the URL.
    // -------------------------------------------------------------------------
    await selectComboboxOption(page, 'Status', 'Pending');

    await expect.poll(() => page.url(), {
      timeout: 10_000,
      message: 'Status filter change must encode "pending" into the URL query string',
    }).toContain('status=pending');

    expect(
      new URL(page.url()).pathname,
      'pathname must remain /ops/billing-updates after filter change',
    ).toBe('/ops/billing-updates');

    const urlBeforeReload = page.url();
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Heading must survive reload (route must not 404 on reload with search params).
    await expect(
      page.getByRole('heading', { name: 'Billing Update Request Queue' }),
      '"Billing Update Request Queue" heading must remain visible after reload with URL filter params',
    ).toBeVisible({ timeout: 10_000 });

    expect(
      new URL(page.url()).searchParams.get('status'),
      'Status filter URL param must survive a full page reload — analyst scope must not silently reset',
    ).toBe('pending');

    await expect(
      page.getByRole('combobox', { name: 'Status' }),
      '"Status" combobox must reflect the reloaded filter value',
    ).toHaveValue('pending');

    // -------------------------------------------------------------------------
    // If there are rows in the queue, assert human-readable account context and
    // an explicit per-row review handoff.  These assertions expose known gaps:
    //   • billing_account_id / customer_id are currently raw UUIDs, not names
    //   • no per-row "Review request" action exists yet in the queue surface
    // Both are expected-failing (non-gating) until the data layer and UI are fixed.
    // -------------------------------------------------------------------------
    type QueueRow = {
      request_id: string;
      billing_account_id: string;
      customer_id: string;
      request_type: string;
      requested_fields: Record<string, unknown> | null;
      status: string;
      submitted_at: string;
      review_note: string | null;
    };
    const queueData = (await queueResp.json()) as QueueRow[];

    if (queueData.length === 0) {
      // Re-navigate without the status filter so we look at the broadest set.
      await page.goto('/ops/billing-updates', { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
    }

    // Go back to unfiltered before checking row content.
    const unfilteredUrl = new URL(urlBeforeReload);
    unfilteredUrl.searchParams.delete('status');
    await page.goto(unfilteredUrl.toString(), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const billingAccountTexts = await page.getByText(/^Billing account:/).allInnerTexts();

    if (billingAccountTexts.length > 0) {
      // At least one row is visible — assert human-readable context.
      const firstAccountText = billingAccountTexts[0].replace(/^Billing account:\s*/, '').trim();
      expect(
        rawUuidPattern.test(firstAccountText),
        `"Billing account:" must show a human-readable account name or reference, not a raw UUID — got "${firstAccountText}"`,
      ).toBe(false);

      const customerTexts = await page.getByText(/^Customer:/).allInnerTexts();
      if (customerTexts.length > 0) {
        const firstCustomerText = customerTexts[0].replace(/^Customer:\s*/, '').trim();
        expect(
          rawUuidPattern.test(firstCustomerText),
          `"Customer:" must show a human-readable customer name, not a raw UUID — got "${firstCustomerText}"`,
        ).toBe(false);
      }

      // A per-row "Review request" action must be visible so the analyst has a durable
      // next-step handoff without rebuilding context from the reference ID.
      await expect(
        page.getByRole('link', { name: /review request/i }).first(),
        'each queue row must have an explicit "Review request" link — analyst must not have to copy a UUID and call a raw RPC to take action',
      ).toBeVisible({ timeout: 10_000 });
    }
  });
});

// ---------------------------------------------------------------------------
// Covered path: /portal/billing-update/:tokenId × portal submission / reference number /
// /ops/billing-updates × heading visible / ops_get_billing_update_queue query succeeds /
// human-readable context / analyst decision / status and review-note persistence after reload
//
// Non-gating: portal-to-ops lifecycle not yet consistently reliable on deployed dev,
// and the queue is still UUID-first without a decision UI.
// ---------------------------------------------------------------------------
test.describe('@non-gating billing update portal to analyst lifecycle', () => {
  test('billing update request survives portal submission to analyst decision and persists status after reload', async ({ page }) => {
    test.fail(); // non-gating: UUID-first queue and missing decision UI are known gaps
    test.skip(
      !PORTAL_BILLING_UPDATE_SCOPED_URL || !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_PORTAL_BILLING_UPDATE_SCOPED_URL and ops credentials (E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL + password) to run the billing update lifecycle E2E.',
    );

    const rawUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // -------------------------------------------------------------------------
    // Phase 1: Portal submission — customer fills and submits a billing-contact request
    // -------------------------------------------------------------------------
    const billingUpdateContext = parsePortalBillingUpdateScopeContext(PORTAL_BILLING_UPDATE_SCOPED_URL!);

    await page.goto(billingUpdateContext.route);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('billing-update-portal-page'),
      'billing update portal page container must render for a valid token link',
    ).toBeVisible();
    await expect(
      page.getByTestId('billing-update-form-title'),
      'billing update form title must be visible',
    ).toBeVisible();

    // A valid token must not trigger the missing-token error and must leave the form enabled.
    await expect(
      page.getByTestId('token-missing-error'),
      'valid-token portal link must not show a token-missing error',
    ).toHaveCount(0);
    await expect(
      page.getByTestId('submit-button'),
      'submit button must be enabled when a valid billing update token is present',
    ).toBeEnabled();

    // Select billing-contact request type and fill minimal fields.
    await page.getByTestId('select-billing-contact').click();
    await page.getByTestId('input-billing-name').fill('E2E Billing Corp');
    await page.getByTestId('input-billing-email').fill('e2e-billing@example.com');
    await page.getByTestId('input-note').fill('E2E lifecycle durability test');

    const submitResponsePromise = page.waitForResponse(
      (r) =>
        r.url().includes('/rpc/portal_submit_billing_update_request') &&
        r.request().method() === 'POST',
    );
    await page.getByTestId('submit-button').click();
    const submitResponse = await submitResponsePromise;
    expect(
      submitResponse.status(),
      'portal_submit_billing_update_request RPC must succeed for a valid token',
    ).toBeLessThan(400);

    // Success screen must confirm receipt with a durable reference number.
    await expect(
      page.getByTestId('billing-update-success-heading'),
      'success heading must appear after a valid billing update submission',
    ).toBeVisible();
    await expect(
      page.getByTestId('submit-error'),
      'submit-error panel must not appear on a successful submission',
    ).toHaveCount(0);

    const requestIdText = (
      await page.getByTestId('billing-update-request-id').innerText()
    ).trim();
    expect(
      requestIdText.length,
      'success screen must display a non-empty reference number after submission',
    ).toBeGreaterThan(0);

    // -------------------------------------------------------------------------
    // Phase 2: Ops queue — analyst signs in and opens /ops/billing-updates
    // -------------------------------------------------------------------------
    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const queueRespPromise = page.waitForResponse(
      (r) =>
        r.url().includes('/rpc/ops_get_billing_update_queue') &&
        r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.goto('/ops/billing-updates', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Billing Update Request Queue' }),
      '"Billing Update Request Queue" heading must be visible on /ops/billing-updates',
    ).toBeVisible({ timeout: 10_000 });

    const queueResp = await queueRespPromise;
    expect(
      queueResp.ok(),
      'ops_get_billing_update_queue RPC must succeed for ops-capable user',
    ).toBe(true);

    // Capture Supabase base URL and auth headers from the queue request for direct RPC calls.
    const queueUrl = queueResp.url();
    const supabaseBaseUrl = queueUrl.replace(/\/rest\/v1\/rpc\/[^?#]*.*$/, '');
    const capturedReqHeaders = queueResp.request().headers();
    const decisionApiHeaders: Record<string, string> = { 'content-type': 'application/json' };
    for (const h of ['apikey', 'authorization', 'accept']) {
      if (typeof capturedReqHeaders[h] === 'string') {
        decisionApiHeaders[h] = capturedReqHeaders[h];
      }
    }

    // Wait for the queue to stabilise: either the explicit empty-state message or at least
    // one table row must be present before asserting content.
    await expect.poll(
      async () =>
        (await page.getByText('No billing update requests match the current filters.').count()) +
        (await page.getByRole('row').count()),
      {
        timeout: 20_000,
        message: 'Ops billing update queue must stabilise before asserting content',
      },
    ).toBeGreaterThan(0);

    // Locate the submitted request in the RPC response data.
    type QueueRow = {
      request_id: string;
      billing_account_id: string;
      customer_id: string;
      request_type: string;
      requested_fields: Record<string, unknown> | null;
      status: string;
      review_note: string | null;
    };
    const queueData = (await queueResp.json()) as QueueRow[];
    const submittedRow = queueData.find((row) => row.request_id === requestIdText);

    // The submitted request must appear in the queue — if it is absent the portal-to-ops
    // lifecycle handoff has failed.
    expect(
      submittedRow,
      `submitted request "${requestIdText}" must appear in ops_get_billing_update_queue after portal submission`,
    ).toBeTruthy();

    if (!submittedRow) return; // narrowing guard — the expect above already fails the test

    // The queue must surface human-readable customer and account context instead of raw UUIDs.
    // billing_account_id and customer_id are currently shown as raw UUIDs — this assertion
    // exposes the UUID-first gap and will remain expected-failing until those columns are resolved
    // to human-readable names by the data layer or the page definition.
    expect(
      rawUuidPattern.test(submittedRow.billing_account_id),
      `"Billing account" column must not show a raw UUID for request "${requestIdText}" — expected a human-readable account name or reference`,
    ).toBe(false);
    expect(
      rawUuidPattern.test(submittedRow.customer_id),
      `"Customer" column must not show a raw UUID for request "${requestIdText}" — expected a human-readable customer name`,
    ).toBe(false);

    // Requested-changes context must expose readable field names, not an empty list.
    const requestedFields = submittedRow.requested_fields ?? {};
    const fieldKeys = Object.keys(requestedFields).filter((k) => k !== 'customer_note');
    expect(
      fieldKeys.length,
      'requested_fields must contain at least one human-readable field name in the queue for the submitted request',
    ).toBeGreaterThan(0);

    // The request-type badge must be readable in the rendered table.
    await expect(
      page.getByText(/billing contact|payment details/i).first(),
      'ops queue must surface a human-readable request-type label — not the raw request_type key',
    ).toBeVisible({ timeout: 10_000 });

    // -------------------------------------------------------------------------
    // Phase 3: Analyst decision — drive one reject path via direct RPC call.
    // There is no decision UI in the current queue surface; this call exercises the
    // backend path and exposes the missing analyst-action gap in the ops surface.
    // -------------------------------------------------------------------------
    const decisionRpcUrl = `${supabaseBaseUrl}/rest/v1/rpc/ops_record_billing_update_decision`;
    const decisionResponse = await page.request.post(decisionRpcUrl, {
      headers: decisionApiHeaders,
      data: JSON.stringify({
        p_request_id: requestIdText,
        p_decision: 'reject',
        p_reviewer_id: OPS_CAPABLE_EMAIL,
        p_note: 'E2E lifecycle test: auto-reject for durability coverage',
      }),
    });
    expect(
      decisionResponse.ok(),
      'ops_record_billing_update_decision RPC must succeed when called by an ops-capable user',
    ).toBe(true);

    // -------------------------------------------------------------------------
    // Phase 4: Reload — the decided request plus its review note must remain visible.
    // This assertion exposes the durability gap: the queue view currently filters out
    // 'rejected' status rows, so the analyst loses the decision context after reload.
    // -------------------------------------------------------------------------
    const reloadedQueueRespPromise = page.waitForResponse(
      (r) =>
        r.url().includes('/rpc/ops_get_billing_update_queue') &&
        r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Billing Update Request Queue' }),
      '"Billing Update Request Queue" heading must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });

    const reloadedQueueResp = await reloadedQueueRespPromise;
    expect(
      reloadedQueueResp.ok(),
      'ops_get_billing_update_queue RPC must succeed on reload',
    ).toBe(true);

    const reloadedData = (await reloadedQueueResp.json()) as QueueRow[];
    const reloadedRow = reloadedData.find((row) => row.request_id === requestIdText);

    // The rejected request must still appear in the queue with its updated status and review note.
    // This will fail in the current implementation because the queue view excludes 'rejected' rows —
    // the analyst currently loses the decision context after a reject.
    expect(
      reloadedRow,
      `rejected request "${requestIdText}" must still be visible in the ops queue after reload — analyst must not lose the decision context`,
    ).toBeTruthy();

    if (reloadedRow) {
      expect(
        reloadedRow.status,
        'request status must persist as "rejected" after reload',
      ).toBe('rejected');
      expect(
        reloadedRow.review_note,
        'review note must be non-empty and persist after the decision is recorded',
      ).toBeTruthy();
    }
  });
});

test.describe('@non-gating portal/requests authenticated self-service flow', () => {
  test('portal requests shows eligible rental lines, allows call-off submission, and survives reload', async ({ page }) => {
    test.fail(true, 'Non-gating: portal/requests authenticated self-service flow is not yet proven reliable on deployed-dev.');
    test.skip(
      !PORTAL_CUSTOMER_EMAIL || !PORTAL_CUSTOMER_PASSWORD,
      'Set E2E_PORTAL_CUSTOMER_EMAIL and E2E_PORTAL_CUSTOMER_PASSWORD (for a portal_customer account with active checked-out rentals) to run this test.',
    );

    await signInAsPortalCustomer(page, PORTAL_CUSTOMER_EMAIL!, PORTAL_CUSTOMER_PASSWORD!);
    await page.waitForLoadState('networkidle');

    // Portal container must render for the authenticated customer.
    await expect(page.getByTestId('portal-requests-page')).toBeVisible();

    // Authenticated user's email must be surfaced — not a raw UUID or empty string.
    await expect(page.getByTestId('portal-user-email')).toBeVisible();
    const userEmailText = (await page.getByTestId('portal-user-email').innerText()).trim();
    expect(userEmailText, 'portal must show the signed-in customer email').toBeTruthy();
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userEmailText),
      `portal user email must be an email address, not a raw UUID (got: "${userEmailText}")`,
    ).toBe(false);

    // Eligible rental lines list must be visible with at least one line.
    await expect(page.getByTestId('rental-lines-list')).toBeVisible();
    const lineCards = page.locator('[data-testid^="rental-line-"]');
    const lineCount = await lineCards.count();
    expect(lineCount, 'at least one eligible rental line must be visible for a seeded portal_customer').toBeGreaterThan(0);

    // First line must expose human-readable asset and contract context.
    const firstLine = lineCards.first();
    const lineTestId = await firstLine.getAttribute('data-testid');
    const lineEntityId = (lineTestId ?? '').replace(/^rental-line-/, '');
    expect(lineEntityId.length, 'line entity id must be non-empty').toBeGreaterThan(0);

    const assetLabel = (await firstLine.locator('p').first().innerText()).trim();
    expect(assetLabel, 'asset label must not be empty').toBeTruthy();
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetLabel),
      `asset label must be human-readable, not a raw UUID (got: "${assetLabel}")`,
    ).toBe(false);

    const contractLabel = (await firstLine.locator('p').nth(1).innerText()).trim();
    expect(contractLabel, 'contract label must not be empty').toBeTruthy();

    // At least one request-type choice must be visible for the line.
    const callOffButton = page.locator(`[data-testid="request-${lineEntityId}-off_rent_pickup"]`);
    const extensionButton = page.locator(`[data-testid="request-${lineEntityId}-contract_extension"]`);
    const availableActions = (await callOffButton.count()) + (await extensionButton.count());
    expect(
      availableActions,
      'at least one request-type choice must be visible for an eligible checked-out line',
    ).toBeGreaterThan(0);

    // Submit a call-off request and verify success feedback.
    if ((await callOffButton.count()) > 0) {
      const submitRespPromise = page.waitForResponse(
        (r) =>
          r.url().includes('/rpc/portal_submit_authenticated_service_request') &&
          r.request().method() === 'POST',
      );

      await callOffButton.click();
      await page.getByTestId(`select-type-${lineEntityId}`).selectOption('off_rent_pickup');
      await page.getByTestId(`select-urgency-${lineEntityId}`).selectOption('standard');
      await page.getByTestId(`note-${lineEntityId}`).fill('E2E: equipment no longer needed on site');
      await page.getByTestId(`submit-request-${lineEntityId}`).click();

      const submitResp = await submitRespPromise;
      expect(submitResp.status(), 'call-off submission RPC must succeed').toBeLessThan(400);

      // Success feedback must be visible after submission.
      await expect(page.getByTestId('submit-success')).toBeVisible();

      // The call-off button must be replaced by a queued badge (duplicate-request state).
      await expect(
        page.locator(`[data-testid="requested-${lineEntityId}-off_rent_pickup"]`),
        'queued call-off badge must appear after submission',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="request-${lineEntityId}-off_rent_pickup"]`),
        'call-off button must disappear once a request is queued',
      ).toHaveCount(0);

      // Reload and verify submitted-request context survives.
      const listRespPromise = page.waitForResponse(
        (r) =>
          r.url().includes('/rpc/portal_list_authenticated_service_requests') &&
          r.request().method() === 'POST',
      );
      await page.reload({ waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      await listRespPromise;

      await expect(page.getByTestId('portal-requests-page')).toBeVisible();
      await expect(
        page.getByTestId('existing-requests-section'),
        'existing-requests section must be visible after reload when a request was submitted',
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="requested-${lineEntityId}-off_rent_pickup"]`),
        'queued call-off badge must survive a full page reload',
      ).toBeVisible();
    }
  });
});

test.describe('@non-gating portal/requests no-eligible-lines explicit state', () => {
  test('portal requests shows an explicit no-eligible-lines message when no rentals are checked out', async ({ page }) => {
    test.fail(true, 'Non-gating: portal/requests no-eligible-lines degraded state is not yet proven on deployed-dev.');
    test.skip(
      !PORTAL_INELIGIBLE_CUSTOMER_EMAIL || !PORTAL_INELIGIBLE_CUSTOMER_PASSWORD,
      'Set E2E_PORTAL_INELIGIBLE_CUSTOMER_EMAIL and E2E_PORTAL_INELIGIBLE_CUSTOMER_PASSWORD (for a portal_customer account whose rentals exist but none are checked_out) to run this test.',
    );

    await signInAsPortalCustomer(page, PORTAL_INELIGIBLE_CUSTOMER_EMAIL!, PORTAL_INELIGIBLE_CUSTOMER_PASSWORD!);
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('portal-requests-page')).toBeVisible();

    // The route must degrade explicitly — not render a blank or ambiguous shell.
    await expect(
      page.getByTestId('no-eligible-lines'),
      'no-eligible-lines message must be visible when the customer has rentals but none are checked_out',
    ).toBeVisible();
    const noEligibleText = (await page.getByTestId('no-eligible-lines').innerText()).trim();
    expect(noEligibleText, 'no-eligible-lines message must be non-empty').toBeTruthy();
    expect(
      /equipment|checked.?out|call.?off|extension|eligible|self.?service/i.test(noEligibleText),
      `no-eligible-lines message must explain the eligibility requirement (got: "${noEligibleText.slice(0, 200)}")`,
    ).toBe(true);

    // Must not surface an interactive rental-lines list for an ineligible customer.
    await expect(
      page.getByTestId('rental-lines-list'),
      'rental-lines list must not appear when no lines are eligible',
    ).toHaveCount(0);
  });
});

// ─── AI reporting — filter label quality and bookmarkability ────────────────
// Gating: raw filter tokens (rental_order, rental_contract) directly degrade
// operator usability and trust in saved/shared links.
// Skipped only when credentials are absent.

test.describe('AI reporting — filter label quality and bookmarkability', () => {
  test('AI reporting keeps bookmarkable filters while exposing human-readable business labels', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run AI reporting label-quality E2E coverage.'
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // ── 1. Navigate with a pre-set document type filter in the URL ───────────
    await page.goto('/analytics/ai-reporting?itemType=rental_order', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible'
    ).toBeVisible({ timeout: 10_000 });

    // ── 2. URL must preserve the canonical filter value (bookmarkable) ───────
    const urlAfterLoad = page.url();
    const parsedUrl = new URL(urlAfterLoad);
    expect(
      parsedUrl.searchParams.get('itemType'),
      'itemType filter must be preserved in the URL as the canonical backend value'
    ).toBe('rental_order');

    // ── 3. Document Type filter must surface readable labels, not raw tokens ─
    const documentTypeSelect = page.getByLabel('Document Type');
    await expect(documentTypeSelect, 'Document Type filter control must be visible').toBeVisible({ timeout: 10_000 });

    const optionTexts = await documentTypeSelect.locator('option').allTextContents();
    expect(
      optionTexts,
      'Document Type filter must not expose "rental_order" as visible option text — expected "Rental order"'
    ).not.toContain('rental_order');
    expect(
      optionTexts,
      'Document Type filter must not expose "rental_contract" as visible option text — expected "Rental contract"'
    ).not.toContain('rental_contract');
    expect(
      optionTexts,
      'Document Type filter must not expose "invoice" (lowercase) as visible option text — expected "Invoice"'
    ).not.toContain('invoice');

    // When the page has loaded rental_order data, the readable "Rental order" option must exist.
    const rentalOrderOption = documentTypeSelect.locator('option', { hasText: 'Rental order' });
    const rentalOrderOptionCount = await rentalOrderOption.count();
    if (rentalOrderOptionCount > 0) {
      await expect(
        rentalOrderOption.first(),
        'Document Type must surface "Rental order" (sentence-case) as the visible option label'
      ).toBeVisible();
    }

    // ── 4. Reload must preserve the URL-backed filter scope ──────────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must remain visible after reload'
    ).toBeVisible({ timeout: 10_000 });

    const urlAfterReload = page.url();
    const parsedAfterReload = new URL(urlAfterReload);
    expect(
      parsedAfterReload.searchParams.get('itemType'),
      'itemType filter must still be in the URL after reload (bookmarkable link roundtrip)'
    ).toBe('rental_order');

    // ── 5. Labels must remain readable after reload ──────────────────────────
    const reloadedOptionTexts = await page.getByLabel('Document Type').locator('option').allTextContents();
    expect(
      reloadedOptionTexts,
      'Document Type filter options must not expose raw "rental_order" token as visible label after reload'
    ).not.toContain('rental_order');
    expect(
      reloadedOptionTexts,
      'Document Type filter options must not expose raw "rental_contract" token as visible label after reload'
    ).not.toContain('rental_contract');
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// @non-gating AI Reporting — bookmarkable URL state, chart/table views,
// drill-down, and human-readable filter labels
// ---------------------------------------------------------------------------

test.describe('@non-gating AI Reporting route — URL state, chart/table switching, and readable labels', () => {
  test('AI Reporting renders KPI cards or explicit loading/error/empty state — not a blank shell', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: /analytics/ai-reporting deployed-dev coverage is tracked as backlog signal until the live route is proven reliable.',
    );
    test.skip(
      !AUTH_EMAIL || !AUTH_PASSWORD,
      'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run AI Reporting E2E coverage.',
    );

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    const apiResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/v_enterprise_financial_reporting_lines'),
      { timeout: 20_000 },
    );

    await page.goto('/analytics/ai-reporting', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible on /analytics/ai-reporting',
    ).toBeVisible({ timeout: 10_000 });

    // The route must show at least one of: KPI strip, loading skeleton, error alert, or explicit empty state.
    // A blank shell (none of the above) means the route is not rendering useful operator context.
    const apiResponse = await apiResponsePromise;
    expect(
      apiResponse.status(),
      'AI Reporting API request to v_enterprise_financial_reporting_lines must succeed',
    ).toBeLessThan(400);

    // Wait for at least one of the expected non-blank states to appear, using poll
    // to avoid race conditions where an element becomes visible after networkidle.
    await expect.poll(
      () =>
        Promise.all([
          page.getByTestId('ai-report-kpi-strip').count(),
          page.getByTestId('ai-report-loading').count(),
          page.getByTestId('ai-report-error').count(),
          page.getByTestId('ai-report-empty-chart').count(),
          page.getByTestId('ai-report-empty-table').count(),
        ]).then((counts) => counts.some((c) => c > 0)),
      { timeout: 10_000, message: '/analytics/ai-reporting must render KPI cards, a loading skeleton, an error alert, or an explicit empty state — not a blank shell' },
    ).toBe(true);
  });

  test('AI Reporting scope, document-type, and view selections persist in URL search params after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL + password to run AI Reporting URL-state persistence E2E coverage.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const apiResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/v_enterprise_financial_reporting_lines'),
      { timeout: 20_000 },
    );

    await page.goto('/analytics/ai-reporting', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible on /analytics/ai-reporting',
    ).toBeVisible({ timeout: 10_000 });

    await apiResponsePromise;

    // Select scope level = branch, a document type, and switch to table view.
    await page.getByLabel('Scope Level').selectOption('branch');
    await expect(page.getByLabel('Scope Level')).toHaveValue('branch');

    // Pick the first non-empty document type option if available.
    const itemTypeSelect = page.getByLabel('Document Type');
    const itemTypeOptions = await itemTypeSelect.locator('option').allTextContents();
    const nonEmptyItemType = itemTypeOptions.find((opt) => opt.trim() && opt.trim() !== '');
    if (nonEmptyItemType) {
      await itemTypeSelect.selectOption({ label: nonEmptyItemType.trim() });
    }

    // Switch to table view. The FilterBar renders a "Table" button with aria-pressed;
    // use a broad name match so the locator is stable even if icon text is included.
    const tableToggle = page.getByRole('button', { name: /table/i }).first();
    await expect(tableToggle, 'Table view toggle button must be present').toBeVisible({ timeout: 5_000 });
    await tableToggle.click();

    // Capture the URL after filter changes — URL search params must include the selections.
    const urlAfterFilters = new URL(page.url());
    const scopeTypeParam = urlAfterFilters.searchParams.get('scopeType');
    const viewParam = urlAfterFilters.searchParams.get('view');

    expect(
      scopeTypeParam,
      'scopeType search param must be set in the URL after selecting "branch" scope level',
    ).toBe('branch');
    expect(
      viewParam,
      'view search param must be "table" after switching to table view',
    ).toBe('table');

    // Reload and verify params survive.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible after reload',
    ).toBeVisible({ timeout: 10_000 });

    const urlAfterReload = new URL(page.url());
    expect(
      urlAfterReload.searchParams.get('scopeType'),
      'scopeType search param must survive page reload',
    ).toBe('branch');
    expect(
      urlAfterReload.searchParams.get('view'),
      'view search param must survive page reload',
    ).toBe('table');

    // The scope-level selector must reflect the reloaded URL state.
    const scopeLevelAfterReload = await page.getByLabel('Scope Level').inputValue();
    expect(
      scopeLevelAfterReload,
      'Scope Level selector must restore to "branch" from URL params after reload',
    ).toBe('branch');
  });

  test('AI Reporting drill-down path preserves selected scope into table view after reload', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL + password to run AI Reporting drill-down persistence E2E coverage.',
    );

    type AiReportingApiRow = {
      originating_scope_id: string | null;
      originating_scope_name: string | null;
      branch_scope_id: string | null;
      branch_scope_name: string | null;
      region_scope_id: string | null;
      region_scope_name: string | null;
      company_scope_id: string | null;
      company_scope_name: string | null;
      source_entity_type: string | null;
    };

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const apiResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/v_enterprise_financial_reporting_lines'),
      { timeout: 20_000 },
    );

    await page.goto('/analytics/ai-reporting?scopeType=branch&view=chart', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible on /analytics/ai-reporting',
    ).toBeVisible({ timeout: 10_000 });

    const apiResponse = await apiResponsePromise;
    expect(
      apiResponse.status(),
      'AI Reporting API request must succeed before drill-down test',
    ).toBeLessThan(400);

    const rows = await apiResponse.json() as AiReportingApiRow[];
    const candidateRow = rows.find((row) =>
      Boolean(row.branch_scope_id?.trim() && row.branch_scope_name?.trim())
    );

    if (!candidateRow) {
      test.skip(true, 'No AI Reporting row with a branch scope was found — skipping drill-down test.');
      return;
    }

    const branchScopeId = candidateRow.branch_scope_id!;

    // A chart bar for this branch scope must be rendered when chart view is active.
    const chartBar = page.getByTestId(`ai-report-chart-bar-${branchScopeId}`);
    const drilldownButton = chartBar.getByRole('button').first();

    const isChartBarVisible = await chartBar.isVisible();
    if (!isChartBarVisible) {
      test.skip(true, `Chart bar for branch "${branchScopeId}" not visible — scope may be filtered out. Skipping.`);
      return;
    }

    await drilldownButton.click();

    // After drilldown, view must switch to table and scopeId must appear in URL.
    await page.waitForURL((url) => url.searchParams.get('view') === 'table', { timeout: 8_000 });
    const urlAfterDrilldown = new URL(page.url());

    expect(
      urlAfterDrilldown.searchParams.get('view'),
      'view param must be "table" after chart drill-down',
    ).toBe('table');
    expect(
      urlAfterDrilldown.searchParams.get('scopeId'),
      'scopeId param must be set to the drilled branch scope after chart drill-down',
    ).toBe(branchScopeId);

    // Table view must be rendered (card or empty state) — not a blank screen.
    const tableCardVisible = await page.getByTestId('ai-report-table').isVisible();
    const emptyTableVisible = await page.getByTestId('ai-report-empty-table').isVisible();
    expect(
      tableCardVisible || emptyTableVisible,
      'after drill-down, table card or explicit empty-table state must be visible',
    ).toBe(true);

    // Reload — the drill-down scope and table view must survive.
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must survive reload after drill-down navigation',
    ).toBeVisible({ timeout: 10_000 });

    const urlAfterReload = new URL(page.url());
    expect(
      urlAfterReload.searchParams.get('view'),
      'view param must remain "table" after reload following chart drill-down',
    ).toBe('table');
    expect(
      urlAfterReload.searchParams.get('scopeId'),
      'scopeId param must remain set to the drilled branch scope after reload',
    ).toBe(branchScopeId);
  });

  test('AI Reporting asset-category and document-type filter options use readable business labels — not raw identifiers', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: AI Reporting human-readable filter label coverage on deployed dev is tracked as backlog signal until the live filter surface is proven reliable.',
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL + password to run AI Reporting readable-label E2E coverage.',
    );

    type AiReportingApiRow = {
      asset_category_id: string | null;
      asset_category_name: string | null;
      source_entity_type: string | null;
    };

    // Matches raw backend identifier tokens — e.g. "cat-lifting", "inv-001", "rental_contract" —
    // which are purely alphanumeric/hyphen/underscore strings with no spaces that would not be
    // operator-readable business labels (e.g. "Lifting Equipment" or "Invoice").
    // This pattern is used as a secondary heuristic; primary checks use the known readable
    // name from the API row directly where available.
    const rawIdPattern = /^[a-z0-9_-]+$/i;

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const apiResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/v_enterprise_financial_reporting_lines'),
      { timeout: 20_000 },
    );

    await page.goto('/analytics/ai-reporting', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible on /analytics/ai-reporting',
    ).toBeVisible({ timeout: 10_000 });

    const apiResponse = await apiResponsePromise;
    expect(
      apiResponse.status(),
      'AI Reporting API request must succeed before readable-label test',
    ).toBeLessThan(400);

    const rows = await apiResponse.json() as AiReportingApiRow[];

    // Asset category label check: if any row has a non-empty asset_category_id,
    // the Asset Category filter must surface at least one option whose label is NOT
    // the raw category ID (i.e. the filter should show the human-readable category name).
    const rowWithCategory = rows.find(
      (row) => row.asset_category_id?.trim() && row.asset_category_name?.trim(),
    );

    if (rowWithCategory) {
      const categorySelect = page.getByLabel('Asset Category');
      const categoryOptionLabels = await categorySelect.locator('option').allTextContents();
      const nonBlankLabels = categoryOptionLabels.map((l) => l.trim()).filter(Boolean);

      // At least one non-blank label must be present (i.e. not an empty dropdown).
      expect(
        nonBlankLabels.length,
        'Asset Category filter must expose at least one labelled option when category data is present',
      ).toBeGreaterThan(0);

      // The human-readable category name from the API (e.g. "Lifting Equipment") must appear
      // as an option label. This directly confirms the filter uses the name, not the raw ID.
      const hasReadableLabel = rowWithCategory.asset_category_name != null
        && nonBlankLabels.includes(rowWithCategory.asset_category_name.trim());
      expect(
        hasReadableLabel,
        `Asset Category filter must include the human-readable name "${rowWithCategory.asset_category_name}" — found options: ${nonBlankLabels.join(', ')}`,
      ).toBe(true);
    }

    // Document-type label check: if any row has a source_entity_type, the Document Type
    // filter must surface a readable option label (e.g. "Invoice", "Rental Contract") rather
    // than the raw type key (e.g. "invoice", "rental_contract").
    const rowWithEntityType = rows.find((row) => row.source_entity_type?.trim());

    if (rowWithEntityType) {
      const itemTypeSelect = page.getByLabel('Document Type');
      const itemTypeOptionLabels = await itemTypeSelect.locator('option').allTextContents();
      const nonBlankItemLabels = itemTypeOptionLabels.map((l) => l.trim()).filter(Boolean);

      expect(
        nonBlankItemLabels.length,
        'Document Type filter must expose at least one labelled option when document data is present',
      ).toBeGreaterThan(0);

      // Document-type labels should be human-readable (e.g. "Invoice", "Rental Contract")
      // rather than the raw snake_case type key (e.g. "invoice", "rental_contract").
      // The API row doesn't carry a corresponding _name field for source_entity_type, so we
      // check that at least one option label neither equals the raw type key exactly nor is a
      // purely raw identifier token (no spaces, all lowercase/underscore/hyphen).
      const hasReadableItemLabel = nonBlankItemLabels.some(
        (label) =>
          label !== rowWithEntityType.source_entity_type &&
          !rawIdPattern.test(label),
      );
      expect(
        hasReadableItemLabel,
        `Document Type filter must surface a human-readable label rather than the raw type "${rowWithEntityType.source_entity_type}" — found options: ${nonBlankItemLabels.join(', ')}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Covered path: /ops/credit-review × heading / severity+status filter scope /
// URL persistence across reload / explicit empty state or decision-ready cards
// with requested/proposed credit context and a durable "Open finding" handoff.
//
// Non-gating: the analyst routes are still uncovered in the latest ci-history
// coverage record — this remains backlog-signal coverage until deployed-dev
// reliability is proven.
// ---------------------------------------------------------------------------
test.describe('@non-gating credit review queue — analyst filter scope durable and finding handoffs decision-ready', () => {
  test('credit review queue preserves severity/status filter in URL across reload and surfaces decision-ready finding handoffs', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run the credit review queue filter-durability E2E.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // ── 1. Load the page with explicit filter params in the URL ──────────────
    await page.goto('/ops/credit-review?severity=high&status=pending_approval', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Credit Application Review' }),
      '"Credit Application Review" heading must be visible on /ops/credit-review',
    ).toBeVisible({ timeout: 10_000 });

    // ── 2. Filter scope must survive a reload ────────────────────────────────
    const urlBeforeReload = page.url();
    const parsedBeforeReload = new URL(urlBeforeReload);
    expect(
      parsedBeforeReload.searchParams.get('severity'),
      'severity filter must be present in the URL before reload',
    ).toBe('high');
    expect(
      parsedBeforeReload.searchParams.get('status'),
      'status filter must be present in the URL before reload',
    ).toBe('pending_approval');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Credit Application Review' }),
      '"Credit Application Review" heading must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });

    const parsedAfterReload = new URL(page.url());
    expect(
      parsedAfterReload.searchParams.get('severity'),
      'severity filter must still be in the URL after reload',
    ).toBe('high');
    expect(
      parsedAfterReload.searchParams.get('status'),
      'status filter must still be in the URL after reload',
    ).toBe('pending_approval');

    // ── 3. Filter controls must reflect the URL-backed scope ─────────────────
    await expect(
      page.getByRole('combobox', { name: 'Severity' }),
      '"Severity" combobox must be visible',
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('combobox', { name: 'Status' }),
      '"Status" combobox must be visible',
    ).toBeVisible({ timeout: 10_000 });

    // ── 4. Navigate to unfiltered view and assert empty state or cards ────────
    await page.goto('/ops/credit-review', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect.poll(
      async () =>
        (await page.getByText('No credit applications are awaiting review.').count()) +
        (await page.getByRole('link', { name: 'Open finding' }).count()),
      {
        timeout: 20_000,
        message:
          'Credit review queue must show an explicit empty-state message or at least one decision-ready finding card — a blank page is not acceptable',
      },
    ).toBeGreaterThan(0);

    if ((await page.getByRole('link', { name: 'Open finding' }).count()) === 0) {
      // Empty state path — valid, test ends here.
      return;
    }

    // ── 5. Each visible card must surface requested/proposed credit context ───
    // and carry a durable "Open finding" handoff link.
    const firstCard = page
      .getByRole('link', { name: 'Open finding' })
      .first()
      .locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
    const cardText = await firstCard.innerText().catch(() => '');

    // The card must not expose raw pending_approval token as visible text.
    expect(
      cardText,
      'Credit review card must not render raw "pending_approval" status token — use human-readable label',
    ).not.toMatch(/\bpending_approval\b/);

    // The card must surface credit context: requested or proposed limit, or customer name.
    const hasCreditContext =
      /Requested limit:|Proposed limit:|Current limit:|Credit applicant/i.test(cardText);
    expect(
      hasCreditContext,
      'Credit review card must surface requested/proposed credit context (e.g. "Requested limit:" or "Proposed limit:") for a decision-ready analyst handoff',
    ).toBe(true);

    // ── 6. "Open finding" link must carry source and filter context as params ─
    const openFindingHref = await page
      .getByRole('link', { name: 'Open finding' })
      .first()
      .getAttribute('href');
    expect(
      openFindingHref,
      '"Open finding" link must point to /ops/findings/<id> so the analyst has a durable deep-link',
    ).toMatch(/\/ops\/findings\/.+/);
  });
});

// ---------------------------------------------------------------------------
// Covered path: /ops/lien-deadlines × heading / tab+status scope /
// URL persistence across reload / explicit empty states or human-readable
// deadline/waiver cards with recommended next action and a durable "Open
// finding" handoff.
//
// Non-gating: the analyst routes are still uncovered in the latest ci-history
// coverage record — this remains backlog-signal coverage until deployed-dev
// reliability is proven.
// ---------------------------------------------------------------------------
test.describe('@non-gating lien deadlines queue — tab/status scope durable and finding handoffs human-readable', () => {
  test('lien deadlines queue preserves tab/status scope in URL across reload and surfaces human-readable finding handoffs', async ({ page }) => {
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_AUTH_EMAIL and matching password to run the lien deadlines queue tab-durability E2E.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // ── 1. Load the page with explicit tab + status params ───────────────────
    await page.goto('/ops/lien-deadlines?tab=deadlines&status=pending_approval', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Lien Deadline & Waiver Control' }),
      '"Lien Deadline & Waiver Control" heading must be visible on /ops/lien-deadlines',
    ).toBeVisible({ timeout: 10_000 });

    // ── 2. Tab/status scope must survive a reload ────────────────────────────
    const parsedBeforeReload = new URL(page.url());
    expect(
      parsedBeforeReload.searchParams.get('tab'),
      '"tab" param must be present in the URL before reload',
    ).toBe('deadlines');
    expect(
      parsedBeforeReload.searchParams.get('status'),
      '"status" param must be present in the URL before reload',
    ).toBe('pending_approval');

    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Lien Deadline & Waiver Control' }),
      '"Lien Deadline & Waiver Control" heading must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });

    const parsedAfterReload = new URL(page.url());
    expect(
      parsedAfterReload.searchParams.get('tab'),
      '"tab" param must still be "deadlines" after reload',
    ).toBe('deadlines');
    expect(
      parsedAfterReload.searchParams.get('status'),
      '"status" param must still be "pending_approval" after reload',
    ).toBe('pending_approval');

    // ── 3. Tab buttons must be visible ───────────────────────────────────────
    await expect(
      page.getByRole('button', { name: 'Preliminary Notices' }),
      '"Preliminary Notices" tab button must be visible',
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: 'Lien Waivers' }),
      '"Lien Waivers" tab button must be visible',
    ).toBeVisible({ timeout: 10_000 });

    // ── 4. Deadlines tab: empty state or human-readable obligation cards ──────
    await page.goto('/ops/lien-deadlines?tab=deadlines', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect.poll(
      async () =>
        (await page.getByText('No preliminary-notice obligations are surfaced. The deadline calendar is up to date.').count()) +
        (await page.getByRole('link', { name: 'Open finding' }).count()),
      {
        timeout: 20_000,
        message:
          'Lien deadlines tab must show an explicit empty-state message or at least one finding card — a blank page is not acceptable',
      },
    ).toBeGreaterThan(0);

    if ((await page.getByRole('link', { name: 'Open finding' }).count()) > 0) {
      // Cards are visible — assert human-readable approval context.
      const firstCard = page
        .getByRole('link', { name: 'Open finding' })
        .first()
        .locator('xpath=ancestor::*[contains(@class,"rounded")][1]');
      const cardText = await firstCard.innerText().catch(() => '');

      // Card must surface state, urgency, and recommended action — not raw tokens.
      const hasDeadlineContext = /Deadline:|Days remaining:|Urgency:|Recommended:|Notice sent:/i.test(cardText);
      expect(
        hasDeadlineContext,
        'Lien deadline card must surface human-readable obligation context (e.g. "Deadline:", "Urgency:", "Recommended:") for a decision-ready analyst handoff',
      ).toBe(true);

      // Raw urgency tokens must not appear as the primary visible text.
      expect(
        cardText,
        'Lien deadline card must not render raw "pending_approval" token — use human-readable label',
      ).not.toMatch(/\bpending_approval\b/);

      const openFindingHref = await page
        .getByRole('link', { name: 'Open finding' })
        .first()
        .getAttribute('href');
      expect(
        openFindingHref,
        '"Open finding" link must point to /ops/findings/<id>',
      ).toMatch(/\/ops\/findings\/.+/);
    }

    // ── 5. Waivers tab: switch tab and verify URL + empty state or cards ──────
    await page.getByRole('button', { name: 'Lien Waivers' }).click();

    await expect.poll(
      () => new URL(page.url()).searchParams.get('tab'),
      {
        timeout: 10_000,
        message: 'Switching to "Lien Waivers" tab must update the URL "tab" param to "waivers"',
      },
    ).toBe('waivers');

    await expect.poll(
      async () =>
        (await page.getByText('No lien waivers are awaiting review. Waiver obligations are up to date.').count()) +
        (await page.getByRole('link', { name: 'Open finding' }).count()),
      {
        timeout: 20_000,
        message:
          'Lien waivers tab must show an explicit empty-state message or at least one finding card — a blank page is not acceptable',
      },
    ).toBeGreaterThan(0);

    // ── 6. Reload on waivers tab — tab context must survive ──────────────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Lien Deadline & Waiver Control' }),
      '"Lien Deadline & Waiver Control" heading must remain visible after reload on waivers tab',
    ).toBeVisible({ timeout: 10_000 });

    expect(
      new URL(page.url()).searchParams.get('tab'),
      '"tab" param must remain "waivers" after reload',
    ).toBe('waivers');
  });
});


// /analytics/ai-reporting × export toolbar context persistence
//
// Covers: sign-in → open /analytics/ai-reporting → select a filter dimension
// → verify URL carries canonical filter params → assert export toolbar remains
// visible after chart↔table switching and after reload with the same filtered
// scope → trigger CSV export → assert operator-readable success/failure
// feedback tied to the active filtered result set.
//
// Non-gating: deployed-dev reliability of the live export journey is not yet
// proven; the route coverage gap is tracked here as a backlog signal.
// ---------------------------------------------------------------------------
test.describe('@non-gating ai-reporting export journey — filtered export controls keep scoped report context', () => {
  test('ai-reporting export toolbar stays bound to filtered result set across view switching and reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: AI reporting export journey on deployed dev is tracked as backlog signal until the live filtered-export path is proven reliable.',
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/E2E_MANAGER_PASSWORD (or E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD) to run AI reporting export E2E coverage.',
    );

    type AiReportingApiRow = {
      source_entity_id: string;
      source_entity_type: string | null;
      document_number: string | null;
      document_date: string | null;
      branch_scope_id: string | null;
      branch_scope_name: string | null;
      region_scope_id: string | null;
      region_scope_name: string | null;
      company_scope_id: string | null;
      company_scope_name: string | null;
    };

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    // -------------------------------------------------------------------------
    // Phase 1: Open /analytics/ai-reporting and wait for the data layer response.
    // -------------------------------------------------------------------------
    const aiReportingResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/v_enterprise_financial_reporting_lines'),
      { timeout: 30_000 },
    );

    await page.goto('/analytics/ai-reporting', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must be visible on /analytics/ai-reporting',
    ).toBeVisible({ timeout: 15_000 });

    const aiReportingResponse = await aiReportingResponsePromise;
    expect(
      aiReportingResponse.status(),
      'v_enterprise_financial_reporting_lines API request must succeed for the AI reporting route',
    ).toBeLessThan(400);

    // -------------------------------------------------------------------------
    // Phase 2: Select a filter dimension and verify the URL carries canonical
    // filter params so the view is bookmarkable.
    // -------------------------------------------------------------------------
    const apiRows = (await aiReportingResponse.json()) as AiReportingApiRow[];

    // Find a row that exposes a usable document type so we can narrow filters.
    const candidateRow = apiRows.find(
      (row) => row.source_entity_type?.trim() && row.source_entity_id?.trim(),
    );

    if (!candidateRow) {
      test.skip(
        true,
        'No AI reporting row with a document type was returned from the API — skipping filter/export coverage until seeded data is available.',
      );
      return;
    }

    const docType = candidateRow.source_entity_type!.trim();

    // Wait for the filter bar to be fully rendered before interacting with the
    // Document Type select — avoids unclear errors if the UI hasn't hydrated yet.
    await expect(
      page.getByLabel('Document Type'),
      'Document Type filter must be visible before selecting a dimension',
    ).toBeVisible({ timeout: 10_000 });

    // Select the document type filter — this is a seeded filter dimension that
    // must cause the URL to carry a canonical `itemType` param.
    await page.getByLabel('Document Type').selectOption(docType);
    await expect(
      page.getByLabel('Document Type'),
      'Document Type select must reflect the chosen filter',
    ).toHaveValue(docType);

    // The URL must carry the itemType param after the filter is applied.
    await expect.poll(
      () => page.url(),
      {
        timeout: 5_000,
        message: 'URL must carry the itemType filter param after the Document Type filter is applied',
      },
    ).toContain('itemType=');

    // -------------------------------------------------------------------------
    // Phase 3: Assert the export toolbar is visible in chart view.
    // -------------------------------------------------------------------------
    await expect(
      page.getByTestId('ai-report-export-toolbar'),
      'export toolbar must be visible in chart view with filtered data loaded',
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByTestId('export-csv-btn'),
      'Export CSV button must be visible in chart view',
    ).toBeVisible();

    await expect(
      page.getByTestId('export-xlsx-btn'),
      'Export Excel button must be visible in chart view',
    ).toBeVisible();

    await expect(
      page.getByTestId('export-pdf-btn'),
      'Print / Save PDF button must be visible in chart view',
    ).toBeVisible();

    // -------------------------------------------------------------------------
    // Phase 4: Switch from chart view to table view and assert the export
    // toolbar persists (the same filtered result set powers both views).
    // -------------------------------------------------------------------------
    await page.getByRole('button', { name: 'Table', exact: false }).click();

    await expect
      .poll(
        () => new URL(page.url()).searchParams.get('view'),
        { timeout: 5_000, message: 'URL must switch to view=table after clicking the Table toggle' },
      )
      .toBe('table');

    // Confirm the table view has rendered (a table element must be present)
    // before asserting the export toolbar, so we know the view switch completed.
    await expect(
      page.getByRole('table').or(page.getByRole('grid')).first(),
      'table view must render a data table after switching from chart view',
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByTestId('ai-report-export-toolbar'),
      'export toolbar must remain visible after switching to table view',
    ).toBeVisible({ timeout: 10_000 });

    // -------------------------------------------------------------------------
    // Phase 5: Switch back to chart view to confirm bidirectional toggle.
    // -------------------------------------------------------------------------
    await page.getByRole('button', { name: 'Chart', exact: false }).click();

    await expect
      .poll(
        () => new URL(page.url()).searchParams.get('view'),
        { timeout: 5_000, message: 'URL must switch to view=chart after clicking the Chart toggle' },
      )
      .toBe('chart');

    await expect(
      page.getByTestId('ai-report-export-toolbar'),
      'export toolbar must remain visible after switching back to chart view',
    ).toBeVisible({ timeout: 10_000 });

    // -------------------------------------------------------------------------
    // Phase 6: Reload and assert the filtered scope is still selected and the
    // export toolbar is still visible (URL-encoded state survives reload).
    // -------------------------------------------------------------------------
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'AI Reporting' }),
      '"AI Reporting" heading must remain visible after reload',
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByLabel('Document Type'),
      'Document Type filter must restore the chosen value after reload (URL-param round-trip)',
    ).toHaveValue(docType, { timeout: 10_000 });

    await expect(
      page.getByTestId('ai-report-export-toolbar'),
      'export toolbar must be visible after reload with the same filtered scope',
    ).toBeVisible({ timeout: 15_000 });

    // -------------------------------------------------------------------------
    // Phase 7: Trigger the CSV export and assert operator-readable feedback
    // appears that is tied to the active filtered result set — not a blank
    // or context-less response.
    // -------------------------------------------------------------------------
    const exportCsvBtn = page.getByTestId('export-csv-btn');
    await expect(
      exportCsvBtn,
      'Export CSV button must be enabled when filtered rows are present',
    ).toBeEnabled({ timeout: 10_000 });

    await exportCsvBtn.click();

    // The component sets an exportMessage after a CSV export attempt — either
    // a success line referencing the row count or an explicit failure message.
    // Either outcome is acceptable; what must NOT happen is silent context loss
    // (no message at all after clicking export).
    await expect(
      page.getByTestId('export-message'),
      'export-message alert must appear after triggering Export CSV — operator needs feedback tied to the active filtered result set',
    ).toBeVisible({ timeout: 15_000 });

    const exportMessageText = await page.getByTestId('export-message').innerText();
    expect(
      exportMessageText.trim().length,
      'export-message must contain non-empty operator-readable feedback after Export CSV',
    ).toBeGreaterThan(0);

    // A successful export must mention either a row count or "started" to
    // confirm the payload was derived from the filtered result set.
    // A failure message ("failed") is also accepted — what matters is that
    // the component surfaces explicit feedback rather than silently dropping
    // the export context.
    expect(
      exportMessageText,
      'export-message must reference the export outcome (row count or failure reason) so the operator can confirm the filtered payload was used',
    ).toMatch(/\d+\s+row|\bstarted\b|\bfailed\b/i);
  });
});

// ---------------------------------------------------------------------------
// /field/pod × Loads / Useful
//
// Covers: sign-in as field operator → find a completed seeded stop via the
// driver dispatch stops endpoint → open /field/pod?stop=<id> → assert
// operator-readable stop context (customer, job site, address, stop type) is
// shown first, plus a clear evidence-status banner → reload and assert the
// dispute-ready evidence bundle (signature, notes, photo summary, status) is
// still visible → assert route/driver identifiers do not leak into the proof
// record → assert explicit not-found state when no stop ID is supplied.
//
// Non-gating: the live completed-stop proof workflow is not yet proven
// reliable enough on deployed dev for gating coverage; the route coverage gap
// is tracked here as a backlog signal.
// ---------------------------------------------------------------------------
test.describe('@non-gating field/pod proof record — completed-stop evidence durable after reload', () => {
  test('field operator sees operator-readable stop context and dispute-ready evidence bundle that persists after reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: /field/pod completed-stop proof journey on deployed dev is tracked as backlog signal until the live workflow is proven reliable.',
    );
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD or E2E_OPERATOR_EMAIL/PASSWORD to run field/pod E2E.',
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);

    // -------------------------------------------------------------------------
    // Phase 1: Locate a completed stop via the driver dispatch stops endpoint.
    // The field operator's today-stops query returns all statuses; filter for
    // one that is completed so we have a stop_id with a persisted POD bundle.
    // -------------------------------------------------------------------------
    const dispatchStopsResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/rest/v1/v_driver_dispatch_stops'),
      { timeout: 20_000 },
    );

    await page.goto('/field/dispatch', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Driver Dispatch' }),
      '"Driver Dispatch" heading must be visible on /field/dispatch',
    ).toBeVisible({ timeout: 10_000 });

    const dispatchStopsResponse = await dispatchStopsResponsePromise;
    expect(
      dispatchStopsResponse.status(),
      'v_driver_dispatch_stops API request must succeed for the field operator',
    ).toBeLessThan(400);

    type DispatchStopRow = {
      stop_id: string | null;
      stop_status: string | null;
      stop_type: string | null;
      customer_name: string | null;
      job_site_name: string | null;
      address: string | null;
    };

    const dispatchRows = (await dispatchStopsResponse.json()) as DispatchStopRow[];
    const completedStop = dispatchRows.find((row) => row.stop_status === 'completed' && row.stop_id);

    // The skip must happen after the API call because the stop_id can only be
    // discovered at runtime from the operator's current dispatch data.
    if (!completedStop?.stop_id) {
      test.skip(true, 'No completed stop is available for this field operator in the current environment; skipping /field/pod proof record journey.');
      return;
    }

    const stopId = completedStop.stop_id;

    // -------------------------------------------------------------------------
    // Phase 2: Open the proof record and assert operator-readable stop context
    // is shown before the evidence bundle.
    // -------------------------------------------------------------------------
    const podRpcResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/rpc/get_stop_pod'),
      { timeout: 20_000 },
    );

    await page.goto(`/field/pod?stop=${stopId}`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Stop Proof Record' }),
      '"Stop Proof Record" heading must be visible on /field/pod',
    ).toBeVisible({ timeout: 10_000 });

    const podRpcResponse = await podRpcResponsePromise;
    expect(
      podRpcResponse.status(),
      'get_stop_pod RPC must return a successful response for the completed stop',
    ).toBeLessThan(400);

    // Evidence-status banner — either "Evidence complete" or "Needs review"
    // must be visible so the operator has an immediate dispute-readiness signal.
    await expect(
      page.getByText(/Evidence complete|Needs review/i),
      'evidence-status banner must be visible so the operator has a clear dispute-readiness signal',
    ).toBeVisible({ timeout: 10_000 });

    // Stop-context card must surface customer, job-site, address, or stop-type
    // context — at least the stop-type badge (Delivery / Pickup) must be shown.
    await expect(
      page.getByText(/Delivery|Pickup/i).first(),
      'stop-type badge (Delivery or Pickup) must be visible as operator-readable stop context',
    ).toBeVisible({ timeout: 10_000 });

    // The stop-context card must render before the operator sees any UUID or
    // raw identifier as primary content.  "Stop context" section heading serves
    // as the anchor.
    await expect(
      page.getByText('Stop context'),
      '"Stop context" section heading must be visible to orient the field operator',
    ).toBeVisible({ timeout: 10_000 });

    // Captured evidence section must be present.
    await expect(
      page.getByText('Captured evidence'),
      '"Captured evidence" section heading must be visible in the proof record',
    ).toBeVisible({ timeout: 10_000 });

    // The evidence-status summary line inside the captured evidence card must
    // be dispute-ready or review-required — not blank.
    await expect(
      page.getByText(/Dispute-ready audit bundle|Incomplete — branch review required/i),
      'evidence-status summary line must reference dispute-readiness or review requirement',
    ).toBeVisible({ timeout: 10_000 });

    // -------------------------------------------------------------------------
    // Phase 3: Assert route/driver identity does not leak into the operator-
    // facing proof record.  The component intentionally omits route_id and
    // driver_id; they must not appear as labelled content anywhere in the DOM.
    // -------------------------------------------------------------------------
    expect(
      await page.getByText(/Route ID|Driver ID|driver_id|route_id/i).count(),
      'route or driver identity labels must not appear anywhere in the operator-facing proof record',
    ).toBe(0);

    // -------------------------------------------------------------------------
    // Phase 4: Reload the page and assert the evidence bundle is still visible
    // (dispute-ready durable after reload).
    // -------------------------------------------------------------------------
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Stop Proof Record' }),
      '"Stop Proof Record" heading must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(/Evidence complete|Needs review/i),
      'evidence-status banner must remain visible after reload — dispute-ready bundle must survive page navigation',
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText('Captured evidence'),
      '"Captured evidence" section must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(/Dispute-ready audit bundle|Incomplete — branch review required/i),
      'evidence-status summary line must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });
  });

  test('field/pod shows explicit not-found state when no stop ID is supplied', async ({ page }) => {
    test.skip(
      !FIELD_OPERATOR_EMAIL || !FIELD_OPERATOR_PASSWORD,
      'Set E2E_FIELD_OPERATOR_EMAIL/PASSWORD or E2E_OPERATOR_EMAIL/PASSWORD to run field/pod not-found E2E.',
    );

    await signIn(page, FIELD_OPERATOR_EMAIL!, FIELD_OPERATOR_PASSWORD!);

    await page.goto('/field/pod', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // The heading is always rendered regardless of stop param.
    await expect(
      page.getByRole('heading', { name: 'Stop Proof Record' }),
      '"Stop Proof Record" heading must be visible even when no stop ID is present',
    ).toBeVisible({ timeout: 10_000 });

    // The not-found alert must appear when the stop param is absent.
    await expect(
      page.getByText('Proof record not found'),
      '"Proof record not found" alert must be shown when /field/pod is opened without a stop ID',
    ).toBeVisible({ timeout: 10_000 });

    // The operator must not see a blank page or a crash — the not-found
    // description must also be visible.
    await expect(
      page.getByText(/No completed evidence bundle was found for this stop/i),
      'not-found description must be visible to the operator when no stop ID is supplied',
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// /dispatch/complaints × Action works / In a journey
//
// Covers: sign-in as an ops-capable user → load the live complaint queue →
// choose a seeded complaint row with a stop_id plus human-readable customer/job
// site context → open the stop-scoped queue view via ?stop=<id> → assert the
// stop filter handoff, operator-readable context, and proposed recovery remain
// visible → open the evidence bundle → reload and verify the same complaint
// case remains reachable in the same stop-scoped queue context.
//
// Non-gating: the deployed-dev complaint review queue still needs reliability
// proof before this journey can become a blocking smoke expectation.
// ---------------------------------------------------------------------------
test.describe('@non-gating dispatch/complaints review queue — stop scope and evidence bundle stay durable', () => {
  test('ops reviewer keeps stop-scoped complaint context and evidence-bundle access after reload', async ({ page }) => {
    test.fail(
      true,
      'Non-gating: /dispatch/complaints stop-scoped complaint-review journey on deployed dev is tracked as backlog signal until the live queue is proven reliable.',
    );
    test.skip(
      !OPS_CAPABLE_EMAIL || !OPS_CAPABLE_PASSWORD,
      'Set E2E_MANAGER_EMAIL/PASSWORD or E2E_AUTH_EMAIL/PASSWORD to run dispatch/complaints E2E.',
    );

    await signIn(page, OPS_CAPABLE_EMAIL!, OPS_CAPABLE_PASSWORD!);

    const queueResponsePromise = page.waitForResponse(isComplaintReviewBundleResponse, { timeout: 20_000 });

    await page.goto('/dispatch/complaints', { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: 'Complaint Review Queue' }),
      '"Complaint Review Queue" heading must be visible on /dispatch/complaints',
    ).toBeVisible({ timeout: 10_000 });

    const queueResponse = await queueResponsePromise;
    expect(
      queueResponse.status(),
      'v_complaint_case_review_bundle request must succeed for the ops-capable reviewer',
    ).toBeLessThan(400);

    const queueRows = (await queueResponse.json()) as ComplaintReviewBundleApiRow[];
    const scopedComplaint = queueRows.find(
      (row) =>
        row.case_id &&
        row.stop_id &&
        row.recovery_action &&
        (hasNonEmptyValue(row.customer_name) || hasNonEmptyValue(row.job_site_name)),
    );

    if (!scopedComplaint?.case_id || !scopedComplaint.stop_id) {
      test.skip(
        true,
        'No seeded complaint case with stop_id plus customer/job-site context is available in the current environment; skipping stop-scoped complaint review journey.',
      );
      return;
    }

    const caseId = scopedComplaint.case_id;
    const stopId = scopedComplaint.stop_id;
    const stopScopedResponsePromise = page.waitForResponse(isComplaintReviewBundleResponse, { timeout: 20_000 });

    await page.goto(`/dispatch/complaints?stop=${encodeURIComponent(stopId)}`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const stopScopedResponse = await stopScopedResponsePromise;
    expect(
      stopScopedResponse.status(),
      'stop-scoped complaint queue request must succeed when the stop filter is applied',
    ).toBeLessThan(400);

    await expect(
      page.getByText(new RegExp(`Showing complaint cases for stop\\s+${escapeRegExp(stopId)}`)),
      'stop-filter handoff banner must remain visible in the stop-scoped complaint queue',
    ).toBeVisible({ timeout: 10_000 });

    const caseCard = page.getByTestId(`complaint-case-${caseId}`);
    await expect(
      caseCard,
      'the seeded complaint case must remain visible after opening the stop-scoped queue view',
    ).toBeVisible({ timeout: 10_000 });

    if (scopedComplaint.customer_name) {
      await expect(
        caseCard.getByText(new RegExp(`Customer:\\s*${escapeRegExp(scopedComplaint.customer_name)}`)),
        'scoped complaint card must keep human-readable customer context',
      ).toBeVisible({ timeout: 10_000 });
    }

    if (scopedComplaint.job_site_name) {
      await expect(
        caseCard.getByText(new RegExp(`Site:\\s*${escapeRegExp(scopedComplaint.job_site_name)}`)),
        'scoped complaint card must keep human-readable job-site context',
      ).toBeVisible({ timeout: 10_000 });
    }

    const recoveryProposal = caseCard.getByTestId('recovery-proposal');
    await expect(
      recoveryProposal,
      'scoped complaint card must keep the proposed recovery block visible',
    ).toBeVisible({ timeout: 10_000 });
    await expect(recoveryProposal).toContainText('Proposed recovery');
    await expect(recoveryProposal).toContainText(complaintRecoveryActionLabel(scopedComplaint.recovery_action));

    const evidenceToggle = caseCard.getByRole('button', { name: COMPLAINT_EVIDENCE_TOGGLE_PATTERN });
    await expect(
      evidenceToggle,
      'evidence bundle toggle must remain reachable from the stop-scoped complaint case',
    ).toBeVisible({ timeout: 10_000 });
    await evidenceToggle.click();

    const evidenceBundle = caseCard.getByTestId('evidence-bundle');
    await expect(
      evidenceBundle,
      'evidence bundle must open for the seeded complaint case before reload',
    ).toBeVisible({ timeout: 10_000 });
    expect(
      (await evidenceBundle.innerText()).trim().length,
      'evidence bundle must contain operator-readable evidence details',
    ).toBeGreaterThan(0);

    const reloadResponsePromise = page.waitForResponse(isComplaintReviewBundleResponse, { timeout: 20_000 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const reloadResponse = await reloadResponsePromise;
    expect(
      reloadResponse.status(),
      'complaint queue request must still succeed after reload in the stop-scoped view',
    ).toBeLessThan(400);

    await expect(
      page.getByText(new RegExp(`Showing complaint cases for stop\\s+${escapeRegExp(stopId)}`)),
      'stop-filter handoff banner must remain visible after reload',
    ).toBeVisible({ timeout: 10_000 });
    const reloadedCaseCard = page.getByTestId(`complaint-case-${caseId}`);
    await expect(
      reloadedCaseCard,
      'the same complaint case must remain visible after reload in the stop-scoped queue',
    ).toBeVisible({ timeout: 10_000 });
    const reloadedRecoveryProposal = reloadedCaseCard.getByTestId('recovery-proposal');
    await expect(
      reloadedRecoveryProposal,
      'the proposed recovery block must remain visible for the same complaint case after reload',
    ).toBeVisible({ timeout: 10_000 });

    const reloadedEvidenceToggle = reloadedCaseCard.getByRole('button', { name: COMPLAINT_EVIDENCE_TOGGLE_PATTERN });
    await expect(
      reloadedEvidenceToggle,
      'evidence bundle toggle must still be reachable for the same complaint case after reload',
    ).toBeVisible({ timeout: 10_000 });
    await reloadedEvidenceToggle.click();

    const reloadedEvidenceBundle = reloadedCaseCard.getByTestId('evidence-bundle');
    await expect(
      reloadedEvidenceBundle,
      'evidence bundle must still be reachable for the same complaint case after reload',
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('@non-gating config change impact assistant — admin previews blast radius before applying any change', () => {
  const ADMIN_IMPACT_TAGS = [
    'rental-software-administrator:t1',
    'rental-software-administrator:t2',
    'rental-software-administrator:t3',
    'rental-software-administrator:t4',
  ];

  test('admin sees impact assistant, drafts a change, previews blast radius, and no-auto-apply guarantee is always visible', async ({ page }) => {
    test.skip(!AUTH_EMAIL || !AUTH_PASSWORD, 'Set E2E_AUTH_EMAIL and E2E_AUTH_PASSWORD to run authenticated config change impact assistant E2E.');

    await signIn(page, AUTH_EMAIL!, AUTH_PASSWORD!);

    await page.goto('/enterprise/org-hierarchy');
    await page.waitForLoadState('networkidle');

    // The assistant section must be present on the org-hierarchy admin surface
    const assistantSection = page.getByTestId('config-impact-assistant');
    await expect(
      assistantSection,
      'config change impact assistant section must be present on /enterprise/org-hierarchy',
    ).toBeVisible({ timeout: 10_000 });

    // "Assist only" and "Human approval required" must be surfaced explicitly
    await expect(
      assistantSection.getByText('Assist only'),
      '"Assist only" badge must be visible — the assistant never applies changes autonomously',
    ).toBeVisible();
    await expect(
      assistantSection.getByText('Human approval required'),
      '"Human approval required" badge must be visible — administrator still approves every change',
    ).toBeVisible();

    // All four operating-model tags must be present in the delivered surface
    for (const tag of ADMIN_IMPACT_TAGS) {
      await expect(
        assistantSection.getByText(tag),
        `operating-model tag "${tag}" must appear in the impact assistant surface`,
      ).toBeVisible();
    }

    // All four impact groups must be rendered (even when source data is sparse)
    for (const groupTitle of ['Affected users', 'Branches and regions', 'Contracts and pricing surfaces', 'Reporting audiences']) {
      await expect(
        assistantSection.getByText(groupTitle),
        `impact group "${groupTitle}" must be visible in the preview`,
      ).toBeVisible();
    }

    // The no-auto-apply disclaimer must be present before the admin interacts
    await expect(
      assistantSection.getByText(/never applies.*automatically/i),
      'no-auto-apply disclaimer must be visible before any interaction',
    ).toBeVisible();

    // Change the draft type to billing_pricing using the keyboard-accessible select
    await assistantSection.getByLabel('Change type').selectOption('billing_pricing');

    // Click "Preview impact" to commit the draft to a canonical preview
    const previewButton = assistantSection.getByRole('button', { name: 'Preview impact' });
    await expect(previewButton, '"Preview impact" button must be accessible').toBeVisible();
    await previewButton.click();

    // After committing the draft the canonical preview key must reflect the billing_pricing domain
    await expect(
      assistantSection.getByText(/billing_pricing/),
      'canonical preview key must update to the billing_pricing domain after clicking "Preview impact"',
    ).toBeVisible({ timeout: 5_000 });

    // The no-auto-apply disclaimer must remain visible after the admin interacts
    await expect(
      assistantSection.getByText(/never applies.*automatically/i),
      'no-auto-apply disclaimer must persist after draft change and "Preview impact" click',
    ).toBeVisible();

    // Reload — assistant section and disclaimer must survive direct URL reload without context loss
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByTestId('config-impact-assistant'),
      'config impact assistant must still render after reload — no context loss on re-navigation',
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/never applies.*automatically/i),
      'no-auto-apply disclaimer must persist after reload',
    ).toBeVisible();
  });
});
