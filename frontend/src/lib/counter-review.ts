export const COUNTER_REVIEW_TAGS = [
  'rental-counter-coordinator:t3',
  'rental-counter-coordinator:t4',
  'rental-counter-coordinator:t6',
  'rental-counter-coordinator:t7',
] as const;

type CounterReviewTag = (typeof COUNTER_REVIEW_TAGS)[number];

type Severity = 'blocking' | 'warning' | 'opportunity';

type CurrentDataRecord = Record<string, unknown>;

interface EntityVersionRow {
  data?: CurrentDataRecord;
}

export interface CurrentEntityRow {
  id: string;
  created_at?: string;
  entity_versions?: EntityVersionRow[];
}

export interface CustomerProfileRow {
  entity_id: string;
  name?: string | null;
  tier?: string | null;
  balance?: number | string | null;
  credit_limit?: number | string | null;
  avg_days_to_pay?: number | string | null;
  payment_issue_flag?: number | string | boolean | null;
  data?: CurrentDataRecord | null;
}

export interface CustomerIssueRow {
  issue_entity_id: string;
  customer_id?: string | null;
  billing_account_id?: string | null;
  issue_type?: string | null;
  status?: string | null;
  severity?: string | null;
  resolution_notes?: string | null;
  opened_at?: string | null;
  data?: CurrentDataRecord | null;
}

export interface CommunicationTimelineRow {
  timeline_event_id: string;
  customer_id?: string | null;
  billing_account_id?: string | null;
  occurred_at?: string | null;
  interaction_type?: string | null;
  interaction_label?: string | null;
  summary?: string | null;
  linked_entity_id?: string | null;
  linked_entity_type?: string | null;
}

export interface ContractLineRow {
  entity_id: string;
  contract_id?: string | null;
  asset_id?: string | null;
  status?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  data?: CurrentDataRecord | null;
}

export interface CounterReviewEvidence {
  label: string;
  value: string;
}

export interface CounterReviewSignal {
  code: string;
  title: string;
  summary: string;
  severity: Severity;
  humanAction: string;
  evidence: CounterReviewEvidence[];
  routeLabel: string;
  routeHref: string;
  tags: CounterReviewTag[];
  reviewMode?: 'draft' | 'history';
}

export interface CounterReviewCase {
  id: string;
  contractId?: string;
  customerId?: string;
  contractNumber: string;
  contractStatus: string;
  customerName: string;
  accountSignals: CounterReviewSignal[];
  returnSignals: CounterReviewSignal[];
  invoiceSignals: CounterReviewSignal[];
  salesSignals: CounterReviewSignal[];
}

interface ContractRecord {
  id: string;
  createdAt: string | null;
  contractNumber: string;
  status: string;
  customerId: string | null;
  billingAccountId: string | null;
  jobSiteId: string | null;
  data: CurrentDataRecord;
}

interface InvoiceRecord {
  id: string;
  createdAt: string | null;
  invoiceNumber: string;
  status: string;
  contractId: string | null;
  customerId: string | null;
  billingAccountId: string | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  billingExceptionReason: string | null;
  data: CurrentDataRecord;
}

export interface BuildCounterReviewCasesInput {
  contracts?: CurrentEntityRow[] | null;
  invoices?: CurrentEntityRow[] | null;
  customerProfiles?: CustomerProfileRow[] | null;
  customerIssues?: CustomerIssueRow[] | null;
  communicationTimeline?: CommunicationTimelineRow[] | null;
  contractLines?: ContractLineRow[] | null;
}

const OPEN_ISSUE_STATUSES = new Set(['open', 'pending', 'blocked', 'escalated', 'hold', 'on_hold']);
const SALES_SUMMARY_PATTERN = /(project|phase|shutdown|turnaround|rollout|expansion|campus|multi[-\s]?site|relationship|bid package|outside sales)/i;
const DAMAGE_PATTERN = /(damage|damaged|dent|broken|leak|missing|crack|service|repair)/i;
const BILLING_STATUSES_FOR_REVIEW = new Set(['draft', 'pending']);
const SLOW_PAY_THRESHOLD_DAYS = 60;
const INVOICE_TOTAL_TOLERANCE = 0.001;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
  }
  return false;
}

function asRecord(value: unknown): CurrentDataRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as CurrentDataRecord
    : {};
}

function currentData(row: CurrentEntityRow | null | undefined): CurrentDataRecord {
  return asRecord(row?.entity_versions?.[0]?.data);
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return 'missing';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function parseDate(value: string | null | undefined): number | null {
  const normalized = asString(value);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeContract(row: CurrentEntityRow): ContractRecord {
  const data = currentData(row);
  return {
    id: row.id,
    createdAt: row.created_at || null,
    contractNumber: asString(data.contract_number) || asString(data.name) || row.id,
    status: asString(data.status) || 'pending_execution',
    customerId: asString(data.customer_id) || null,
    billingAccountId: asString(data.billing_account_id) || null,
    jobSiteId: asString(data.job_site_id) || null,
    data,
  };
}

function normalizeInvoice(row: CurrentEntityRow): InvoiceRecord {
  const data = currentData(row);
  return {
    id: row.id,
    createdAt: row.created_at || null,
    invoiceNumber: asString(data.invoice_number) || `INV-${row.id.slice(0, 8)}`,
    status: asString(data.status) || 'draft',
    contractId: asString(data.contract_id) || null,
    customerId: asString(data.customer_id) || null,
    billingAccountId: asString(data.billing_account_id) || null,
    billingPeriodStart: asString(data.billing_period_start) || null,
    billingPeriodEnd: asString(data.billing_period_end) || null,
    subtotal: asNumber(data.subtotal),
    tax: asNumber(data.tax),
    total: asNumber(data.total),
    billingExceptionReason: asString(data.billing_exception_reason) || null,
    data,
  };
}

function summarizeIssue(issue: CustomerIssueRow): string {
  const type = asString(issue.issue_type) || 'payment issue';
  const severity = asString(issue.severity) || 'medium';
  return `${type.replace(/_/g, ' ')} (${severity})`;
}

function buildAccountSignals(
  contract: ContractRecord,
  customer: CustomerProfileRow | undefined,
  issues: CustomerIssueRow[],
): CounterReviewSignal[] {
  const signals: CounterReviewSignal[] = [];
  const openIssues = issues.filter((issue) => OPEN_ISSUE_STATUSES.has(asString(issue.status).toLowerCase()));
  const profileData = asRecord(customer?.data);
  const balance = asNumber(customer?.balance);
  const creditLimit = asNumber(customer?.credit_limit);
  const avgDaysToPay = asNumber(customer?.avg_days_to_pay);
  const apHoldFlag = asBoolean(customer?.payment_issue_flag) || asBoolean(profileData.ap_hold);

  if (!customer) {
    signals.push({
      code: 'missing_customer_profile',
      title: 'Missing account profile',
      summary: 'The contract is missing a reusable customer account record, so credit and AP-hold checks cannot be cleared in-system.',
      severity: 'warning',
      humanAction: 'Pause confirmation and route the contract through the manual exception path until the customer account is linked.',
      evidence: [
        { label: 'Contract', value: contract.contractNumber },
        { label: 'Customer ID', value: contract.customerId || 'missing' },
      ],
      routeLabel: 'Open contract',
      routeHref: `/rental/contracts/${contract.id}`,
      tags: ['rental-counter-coordinator:t3'],
    });
    return signals;
  }

  if (!contract.billingAccountId) {
    signals.push({
      code: 'missing_billing_account',
      title: 'Missing billing account input',
      summary: 'A billing account is required before the counter can clear the booking for customer-facing confirmation.',
      severity: 'warning',
      humanAction: 'Capture or confirm the billing account before moving past the counter review.',
      evidence: [
        { label: 'Contract', value: contract.contractNumber },
        { label: 'Customer', value: customer.name || customer.entity_id },
      ],
      routeLabel: 'Open contract',
      routeHref: `/rental/contracts/${contract.id}`,
      tags: ['rental-counter-coordinator:t3'],
    });
  }

  if (apHoldFlag || openIssues.some((issue) => /payment|hold|credit/i.test(asString(issue.issue_type)))) {
    signals.push({
      code: 'ap_hold_or_payment_issue',
      title: 'AP-hold or payment blocker detected',
      summary: 'Existing account-standing signals show the customer should not be cleared without a human credit review.',
      severity: 'blocking',
      humanAction: 'Hold confirmation and escalate to credit or branch leadership with the linked source evidence.',
      evidence: [
        { label: 'Customer', value: customer.name || customer.entity_id },
        { label: 'Payment issue flag', value: apHoldFlag ? 'set' : 'clear' },
        { label: 'Open issue', value: openIssues[0] ? summarizeIssue(openIssues[0]) : 'payment history flag' },
      ],
      routeLabel: 'Open customer profile',
      routeHref: `/crm/customers/${customer.entity_id}`,
      tags: ['rental-counter-coordinator:t3'],
    });
  }

  if (creditLimit == null || balance == null) {
    signals.push({
      code: 'missing_credit_inputs',
      title: 'Missing credit-limit inputs',
      summary: 'Required account-standing inputs are incomplete, so the review cannot produce a clean disposition.',
      severity: 'warning',
      humanAction: 'Call out the missing balance or credit-limit context and fall back to the manual account-check path.',
      evidence: [
        { label: 'Balance', value: formatMoney(balance) },
        { label: 'Credit limit', value: formatMoney(creditLimit) },
      ],
      routeLabel: 'Open customer profile',
      routeHref: `/crm/customers/${customer.entity_id}`,
      tags: ['rental-counter-coordinator:t3'],
    });
  } else if (balance > creditLimit) {
    signals.push({
      code: 'credit_limit_breached',
      title: 'Credit-limit blocker surfaced',
      summary: 'Current exposure exceeds the approved credit limit for this customer.',
      severity: 'blocking',
      humanAction: 'Escalate before confirming the booking; do not override the exposure issue from the counter.',
      evidence: [
        { label: 'Balance', value: formatMoney(balance) },
        { label: 'Credit limit', value: formatMoney(creditLimit) },
      ],
      routeLabel: 'Open customer profile',
      routeHref: `/crm/customers/${customer.entity_id}`,
      tags: ['rental-counter-coordinator:t3'],
    });
  } else if (avgDaysToPay != null && avgDaysToPay >= SLOW_PAY_THRESHOLD_DAYS) {
    signals.push({
      code: 'slow_pay_trend',
      title: 'Slow-pay trend worth checking',
      summary: 'Payment history does not hard-block the booking, but the aging trend suggests a manual account check.',
      severity: 'warning',
      humanAction: 'Confirm recent payment history before promising rate or availability changes.',
      evidence: [
        { label: 'Average days to pay', value: `${avgDaysToPay}` },
        { label: 'Balance', value: formatMoney(balance) },
      ],
      routeLabel: 'Open customer profile',
      routeHref: `/crm/customers/${customer.entity_id}`,
      tags: ['rental-counter-coordinator:t3'],
    });
  }

  return signals;
}

function collectMissingAttachments(data: CurrentDataRecord): string[] {
  const raw = data.missing_attachments;
  if (Array.isArray(raw)) {
    return raw.map((item) => asString(item)).filter(Boolean);
  }
  const single = asString(raw);
  return single ? [single] : [];
}

function buildReturnSignals(lines: ContractLineRow[]): CounterReviewSignal[] {
  return lines.flatMap((line) => {
    const data = asRecord(line.data);
    const status = asString(line.status || data.status).toLowerCase();
    const outcome = asString(data.condition_outcome || data.outcome).toLowerCase();
    const notes = asString(data.return_notes || data.notes || data.damage_notes);
    const resultingStatus = asString(data.resulting_asset_status).toLowerCase();
    const missingAttachments = collectMissingAttachments(data);
    const serviceFollowUp = outcome === 'fail' || DAMAGE_PATTERN.test(notes) || resultingStatus === 'on_inspection_hold';
    const yardFollowUp = missingAttachments.length > 0;
    const hasException = status === 'returned' && (serviceFollowUp || yardFollowUp || !outcome);

    if (!hasException) {
      return [];
    }

    if (!outcome) {
      return [{
        code: 'missing_return_evidence',
        title: 'Return evidence is incomplete',
        summary: 'The return is recorded, but the condition outcome was not captured for downstream yard or service review.',
        severity: 'warning',
        humanAction: 'Capture return condition details before closing the contract or routing the unit onward.',
        evidence: [
          { label: 'Contract line', value: line.entity_id },
          { label: 'Asset', value: asString(line.asset_id) || 'missing' },
          { label: 'Return date', value: asString(line.actual_end) || 'missing' },
        ],
        routeLabel: 'Open returns check-in',
        routeHref: `/rental/returns?asset_id=${encodeURIComponent(asString(line.asset_id) || '')}`,
        tags: ['rental-counter-coordinator:t6'],
      }];
    }

    return [{
      code: serviceFollowUp ? 'service_follow_up' : 'yard_follow_up',
      title: serviceFollowUp ? 'Route to service follow-up' : 'Route to yard follow-up',
      summary: serviceFollowUp
        ? 'Return evidence suggests damage, a missing inspection pass, or a hold condition that needs service review before the asset is released.'
        : 'Missing attachments or load-out discrepancies should be routed to the yard before the contract is closed.',
      severity: serviceFollowUp ? 'blocking' : 'warning',
      humanAction: serviceFollowUp
        ? 'Keep the unit on hold and send the evidence to service for disposition.'
        : 'Attach the missing-attachment evidence to a yard follow-up before the unit is re-rented.',
      evidence: [
        { label: 'Contract line', value: line.entity_id },
        { label: 'Asset', value: asString(line.asset_id) || 'missing' },
        { label: 'Condition outcome', value: outcome },
        { label: 'Return notes', value: notes || 'none recorded' },
        ...(missingAttachments.length > 0
          ? [{ label: 'Missing attachments', value: missingAttachments.join(', ') }]
          : []),
      ],
      routeLabel: 'Open returns check-in',
      routeHref: `/rental/returns?asset_id=${encodeURIComponent(asString(line.asset_id) || '')}`,
      tags: ['rental-counter-coordinator:t6'],
    }];
  });
}

function buildInvoiceSignals(contract: ContractRecord, invoices: InvoiceRecord[], lines: ContractLineRow[]): CounterReviewSignal[] {
  const signals: CounterReviewSignal[] = [];
  const latestInvoice = invoices[0];

  if (!latestInvoice && contract.status === 'closed') {
    signals.push({
      code: 'missing_closeout_invoice',
      title: 'Draft closeout review is missing',
      summary: 'The contract is closed, but no invoice draft or pre-release review is attached for billing confirmation.',
      severity: 'warning',
      humanAction: 'Create or locate the draft invoice review before any customer-facing release is considered.',
      evidence: [
        { label: 'Contract', value: contract.contractNumber },
        { label: 'Contract status', value: contract.status },
      ],
      routeLabel: 'Open contract',
      routeHref: `/rental/contracts/${contract.id}`,
      tags: ['rental-counter-coordinator:t7'],
      reviewMode: 'draft',
    });
    return signals;
  }

  if (!latestInvoice) {
    return signals;
  }

  if (!latestInvoice.billingAccountId || !latestInvoice.billingPeriodStart || !latestInvoice.billingPeriodEnd || latestInvoice.total == null) {
    signals.push({
      code: 'missing_invoice_inputs',
      title: 'Draft invoice inputs are incomplete',
      summary: 'Billing review cannot render a clean closeout draft because required account or period inputs are missing.',
      severity: 'warning',
      humanAction: 'Keep the invoice in draft/pre-release review and call out the missing inputs explicitly.',
      evidence: [
        { label: 'Invoice', value: latestInvoice.invoiceNumber },
        { label: 'Billing account', value: latestInvoice.billingAccountId || 'missing' },
        { label: 'Billing period', value: `${latestInvoice.billingPeriodStart || 'missing'} → ${latestInvoice.billingPeriodEnd || 'missing'}` },
        { label: 'Total', value: formatMoney(latestInvoice.total) },
      ],
      routeLabel: 'Open invoice record',
      routeHref: `/entities/invoice/${latestInvoice.id}`,
      tags: ['rental-counter-coordinator:t7'],
      reviewMode: 'draft',
    });
  }

  if (
    latestInvoice.subtotal != null
    && latestInvoice.tax != null
    && latestInvoice.total != null
    && Math.abs((latestInvoice.subtotal + latestInvoice.tax) - latestInvoice.total) > INVOICE_TOTAL_TOLERANCE
  ) {
    signals.push({
      code: 'invoice_total_mismatch',
      title: 'Invoice total mismatch surfaced',
      summary: 'The subtotal and tax do not reconcile to the draft invoice total.',
      severity: 'warning',
      humanAction: 'Resolve the math anomaly before a human approves customer-facing release.',
      evidence: [
        { label: 'Subtotal', value: formatMoney(latestInvoice.subtotal) },
        { label: 'Tax', value: formatMoney(latestInvoice.tax) },
        { label: 'Total', value: formatMoney(latestInvoice.total) },
      ],
      routeLabel: 'Open invoice record',
      routeHref: `/entities/invoice/${latestInvoice.id}`,
      tags: ['rental-counter-coordinator:t7'],
      reviewMode: 'draft',
    });
  }

  if (latestInvoice.billingExceptionReason) {
    signals.push({
      code: 'billing_exception_reason',
      title: 'Existing billing anomaly requires review',
      summary: latestInvoice.billingExceptionReason,
      severity: 'warning',
      humanAction: 'Keep the closeout invoice in draft/pre-release review until billing resolves the documented exception.',
      evidence: [
        { label: 'Invoice', value: latestInvoice.invoiceNumber },
        { label: 'Recorded exception', value: latestInvoice.billingExceptionReason },
      ],
      routeLabel: 'Open invoice record',
      routeHref: `/entities/invoice/${latestInvoice.id}`,
      tags: ['rental-counter-coordinator:t7'],
      reviewMode: 'draft',
    });
  }

  const billingPeriodEnd = parseDate(latestInvoice.billingPeriodEnd);
  const billedPastReturn = lines.find((line) => {
    const actualEnd = parseDate(line.actual_end || asString(asRecord(line.data).actual_end) || null);
    return actualEnd != null && billingPeriodEnd != null && actualEnd < billingPeriodEnd;
  });

  if (billedPastReturn) {
    signals.push({
      code: 'billing_past_return',
      title: 'Billing extends past recorded return',
      summary: 'The draft billing period closes after the asset return date, so the invoice needs manual anomaly review.',
      severity: 'warning',
      humanAction: 'Review the billed duration against the recorded return before release.',
      evidence: [
        { label: 'Invoice', value: latestInvoice.invoiceNumber },
        { label: 'Billing period end', value: latestInvoice.billingPeriodEnd || 'missing' },
        { label: 'Returned line', value: `${billedPastReturn.entity_id} on ${asString(billedPastReturn.actual_end) || 'missing date'}` },
      ],
      routeLabel: 'Open contract',
      routeHref: `/rental/contracts/${contract.id}`,
      tags: ['rental-counter-coordinator:t7'],
      reviewMode: 'draft',
    });
  }

  if (!BILLING_STATUSES_FOR_REVIEW.has(latestInvoice.status.toLowerCase())) {
    signals.push({
      code: 'released_invoice_history',
      title: 'Use as release history only',
      summary: `Invoice ${latestInvoice.invoiceNumber} is already ${latestInvoice.status}; this screen remains a pre-release review surface and cannot release or override billing decisions.`,
      severity: 'warning',
      humanAction: 'Treat the record as source evidence and coordinate any corrective action through billing.',
      evidence: [
        { label: 'Invoice status', value: latestInvoice.status },
      ],
      routeLabel: 'Open invoice record',
      routeHref: `/entities/invoice/${latestInvoice.id}`,
      tags: ['rental-counter-coordinator:t7'],
      reviewMode: 'history',
    });
  }

  return signals;
}

function buildSalesSignals(
  contract: ContractRecord,
  customer: CustomerProfileRow | undefined,
  timeline: CommunicationTimelineRow[],
  activeContractCount: number,
): CounterReviewSignal[] {
  if (!customer) {
    return [];
  }

  const profileSummary = asString(asRecord(customer.data).last_interaction_summary);
  const relevantHistory = timeline.filter((row) => {
    const linkedContractId = asString(row.linked_entity_id);
    return row.customer_id === customer.entity_id && (!linkedContractId || linkedContractId === contract.id);
  });

  const matchedHistory = relevantHistory.filter((row) => SALES_SUMMARY_PATTERN.test(asString(row.summary)));
  const hasProfileLead = SALES_SUMMARY_PATTERN.test(profileSummary);
  const tier = asString(customer.tier).toLowerCase();
  const strategicCustomer = tier === 'strategic' || tier === 'enterprise';

  if (!matchedHistory.length && !hasProfileLead && !strategicCustomer) {
    return [];
  }

  const leadSource = matchedHistory[0];
  const supportingContext = leadSource
    ? asString(leadSource.summary)
    : profileSummary || `${customer.name || customer.entity_id} is tagged ${customer.tier || 'standard'}`;

  return [{
    code: 'outside_sales_handoff',
    title: 'Outside-sales handoff suggested',
    summary: 'Customer-history context suggests this request may be project-scale or relationship-led rather than a purely transactional counter order.',
    severity: 'opportunity',
    humanAction: 'Route to outside sales with the linked history context; do not reassign automatically from the counter.',
    evidence: [
      { label: 'Customer history', value: supportingContext },
      { label: 'Recent interaction', value: leadSource ? `${leadSource.interaction_label || leadSource.interaction_type || 'History'} on ${leadSource.occurred_at || 'unknown date'}` : 'profile history summary' },
      { label: 'Active contracts in play', value: `${activeContractCount}` },
    ],
    routeLabel: 'Open customer profile',
    routeHref: `/crm/customers/${customer.entity_id}`,
    tags: ['rental-counter-coordinator:t4'],
  }];
}

export function buildCounterReviewCases(input: BuildCounterReviewCasesInput): CounterReviewCase[] {
  const contracts = (input.contracts || []).map(normalizeContract);
  const invoices = (input.invoices || []).map(normalizeInvoice);
  const customerProfiles = new Map((input.customerProfiles || []).map((profile) => [profile.entity_id, profile]));
  const issuesByCustomer = new Map<string, CustomerIssueRow[]>();
  for (const issue of input.customerIssues || []) {
    const customerId = asString(issue.customer_id);
    if (!customerId) continue;
    const issues = issuesByCustomer.get(customerId) || [];
    issues.push(issue);
    issuesByCustomer.set(customerId, issues);
  }

  const timelineByCustomer = new Map<string, CommunicationTimelineRow[]>();
  for (const row of input.communicationTimeline || []) {
    const customerId = asString(row.customer_id);
    if (!customerId) continue;
    const timeline = timelineByCustomer.get(customerId) || [];
    timeline.push(row);
    timelineByCustomer.set(customerId, timeline);
  }

  const linesByContract = new Map<string, ContractLineRow[]>();
  for (const line of input.contractLines || []) {
    const contractId = asString(line.contract_id);
    if (!contractId) continue;
    const lines = linesByContract.get(contractId) || [];
    lines.push(line);
    linesByContract.set(contractId, lines);
  }

  const invoicesByContract = new Map<string, InvoiceRecord[]>();
  for (const invoice of invoices) {
    const contractId = invoice.contractId;
    if (!contractId) continue;
    const contractInvoices = invoicesByContract.get(contractId) || [];
    contractInvoices.push(invoice);
    invoicesByContract.set(contractId, contractInvoices);
  }

  for (const rows of invoicesByContract.values()) {
    rows.sort((left, right) => (parseDate(right.createdAt) || 0) - (parseDate(left.createdAt) || 0));
  }

  const activeContractsByCustomer = new Map<string, number>();
  for (const contract of contracts) {
    if (!contract.customerId) continue;
    if (!['pending_execution', 'active', 'closed'].includes(contract.status)) continue;
    activeContractsByCustomer.set(contract.customerId, (activeContractsByCustomer.get(contract.customerId) || 0) + 1);
  }

  const cases = contracts.map<CounterReviewCase | null>((contract) => {
    const customer = contract.customerId ? customerProfiles.get(contract.customerId) : undefined;
    const accountSignals = buildAccountSignals(contract, customer, issuesByCustomer.get(contract.customerId || '') || []);
    const returnSignals = buildReturnSignals(linesByContract.get(contract.id) || []);
    const invoiceSignals = buildInvoiceSignals(contract, invoicesByContract.get(contract.id) || [], linesByContract.get(contract.id) || []);
    const salesSignals = buildSalesSignals(
      contract,
      customer,
      timelineByCustomer.get(contract.customerId || '') || [],
      activeContractsByCustomer.get(contract.customerId || '') || 0,
    );

    if (!accountSignals.length && !returnSignals.length && !invoiceSignals.length && !salesSignals.length) {
      return null;
    }

    return {
      id: contract.id,
      contractId: contract.id,
      customerId: contract.customerId || undefined,
      contractNumber: contract.contractNumber,
      contractStatus: contract.status,
      customerName: customer?.name || contract.customerId || 'Unknown customer',
      accountSignals,
      returnSignals,
      invoiceSignals,
      salesSignals,
    } satisfies CounterReviewCase;
  }).filter((value): value is CounterReviewCase => value !== null);

  cases.sort((left, right) => {
    const leftBlocking = left.accountSignals.concat(left.returnSignals, left.invoiceSignals).some((signal) => signal.severity === 'blocking') ? 1 : 0;
    const rightBlocking = right.accountSignals.concat(right.returnSignals, right.invoiceSignals).some((signal) => signal.severity === 'blocking') ? 1 : 0;
    if (leftBlocking !== rightBlocking) {
      return rightBlocking - leftBlocking;
    }
    const leftSignalCount = left.accountSignals.length + left.returnSignals.length + left.invoiceSignals.length + left.salesSignals.length;
    const rightSignalCount = right.accountSignals.length + right.returnSignals.length + right.invoiceSignals.length + right.salesSignals.length;
    return rightSignalCount - leftSignalCount;
  });

  return cases;
}
