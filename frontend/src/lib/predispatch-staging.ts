export const PREDISPATCH_STAGING_TAGS = [
  'yard-logistics-coordinator:t2',
  'yard-logistics-coordinator:t4',
] as const;

type PredispatchTag = (typeof PREDISPATCH_STAGING_TAGS)[number];

type ExceptionSeverity = 'blocking' | 'warning';

type ExceptionCode =
  | 'missing_contact'
  | 'missing_address'
  | 'missing_delivery_instructions'
  | 'contract_not_ready'
  | 'yard_not_staged';

export interface StagingEvidence {
  label: string;
  value: string;
}

export interface StagingException {
  id: string;
  code: ExceptionCode;
  title: string;
  summary: string;
  severity: ExceptionSeverity;
  humanAction: string;
  evidence: StagingEvidence[];
  contractId: string | null;
  /** null for contract-scoped exceptions; asset ID for yard-scoped (yard_not_staged) exceptions */
  assetId: string | null;
  contractNumber: string;
  routeHref: string;
  tags: PredispatchTag[];
}

export interface StagingItem {
  id: string;
  contractId: string | null;
  contractNumber: string;
  assetId: string | null;
  assetName: string | null;
  categoryName: string | null;
  customerName: string | null;
  jobSiteName: string | null;
  scheduledAt: string | null;
  dispatchWindow: string | null;
  branchId: string | null;
  readyToStage: boolean;
  exceptionCount: number;
  routeHref: string;
}

export interface PredispatchStagingResult {
  items: StagingItem[];
  exceptions: StagingException[];
  noOp: boolean;
  tags: readonly string[];
}

export interface DispatchLineRow {
  entity_id?: unknown;
  contract_id?: unknown;
  asset_id?: unknown;
  category_id?: unknown;
  status?: unknown;
  actual_start?: unknown;
  actual_end?: unknown;
  data?: unknown;
}

export interface ContractSignalRow {
  id?: unknown;
  entity_versions?: unknown;
}

export interface YardReadinessRow {
  activity_id?: unknown;
  lane_key?: unknown;
  contract_id?: unknown;
  contract_line_id?: unknown;
  asset_id?: unknown;
  asset_name?: unknown;
  asset_category_name?: unknown;
  job_site_id?: unknown;
  job_site_name?: unknown;
  customer_name?: unknown;
  branch_id?: unknown;
  scheduled_start_at?: unknown;
  sort_at?: unknown;
}

type LooseRecord = Record<string, unknown>;

const DISPATCH_WINDOW_DAYS = 2;
const MS_PER_DAY = 1_000 * 60 * 60 * 24;
const DISPATCH_READY_STATUSES = new Set(['active', 'confirmed', 'pending_execution']);

function asString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function asRecord(value: unknown): LooseRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWithinWindow(scheduledAt: string | undefined, today: string): boolean {
  if (!scheduledAt) return true;
  const target = parseDate(scheduledAt);
  const baseline = parseDate(today);
  if (!target || !baseline) return true;
  const diffMs = target.getTime() - baseline.getTime();
  return diffMs >= 0 && diffMs <= DISPATCH_WINDOW_DAYS * MS_PER_DAY;
}

function contractVersionData(contract: ContractSignalRow | undefined): LooseRecord {
  if (!contract) return {};
  const versions = asArray(contract.entity_versions) as Array<{ is_current?: unknown; data?: unknown }>;
  // Prefer the row explicitly marked is_current; fall back to the first version if none is flagged.
  const current = versions.find((v) => v.is_current === true) ?? versions[0];
  return asRecord(current?.data);
}

function dedupeKey(contractId: string, code: ExceptionCode): string {
  return `${contractId}::${code}`;
}

function buildExceptionId(contractId: string, lineId: string, code: ExceptionCode): string {
  return `exception-${code}-${contractId || lineId}`;
}

function buildStagingItemId(lineId: string, contractId: string): string {
  // lineId is always non-empty here (the loop guard enforces it); contractId
  // is kept as a parameter only for documentation clarity.
  return `staging-${lineId || contractId}`;
}

function buildNoOpResult(): PredispatchStagingResult {
  return {
    items: [],
    exceptions: [],
    noOp: true,
    tags: PREDISPATCH_STAGING_TAGS,
  };
}

function buildContactExceptions(
  lineId: string,
  contractId: string,
  contractNumber: string,
  data: LooseRecord,
  seen: Set<string>,
): StagingException[] {
  const key = dedupeKey(contractId, 'missing_contact');
  if (seen.has(key)) return [];
  const hasContact = asString(data.contact_name) || asString(data.delivery_contact);
  if (hasContact) return [];
  seen.add(key);
  return [{
    id: buildExceptionId(contractId, lineId, 'missing_contact'),
    code: 'missing_contact',
    title: 'Missing delivery contact',
    summary: 'No delivery contact is recorded on the contract. The yard cannot confirm site readiness or coordinate arrival without a contact.',
    severity: 'blocking',
    humanAction: 'Capture the site contact name and phone before releasing this run to staging.',
    evidence: [
      { label: 'Contract', value: contractNumber },
      { label: 'Contact name', value: asString(data.contact_name) || 'missing' },
      { label: 'Delivery contact', value: asString(data.delivery_contact) || 'missing' },
    ],
    contractId,
    assetId: null,
    contractNumber,
    routeHref: `/rental/contracts/${contractId}`,
    tags: ['yard-logistics-coordinator:t2'],
  }];
}

function buildAddressExceptions(
  lineId: string,
  contractId: string,
  contractNumber: string,
  data: LooseRecord,
  seen: Set<string>,
): StagingException[] {
  const key = dedupeKey(contractId, 'missing_address');
  if (seen.has(key)) return [];
  const hasAddress = asString(data.job_site_id) || asString(data.delivery_address) || asString(data.delivery_city);
  if (hasAddress) return [];
  seen.add(key);
  return [{
    id: buildExceptionId(contractId, lineId, 'missing_address'),
    code: 'missing_address',
    title: 'Missing delivery address',
    summary: 'No delivery address or job site is linked to the contract. The driver cannot be dispatched without a confirmed destination.',
    severity: 'blocking',
    humanAction: 'Link the job site or enter a confirmed delivery address before staging.',
    evidence: [
      { label: 'Contract', value: contractNumber },
      { label: 'Job site ID', value: asString(data.job_site_id) || 'missing' },
      { label: 'Delivery address', value: asString(data.delivery_address) || 'missing' },
    ],
    contractId,
    assetId: null,
    contractNumber,
    routeHref: `/rental/contracts/${contractId}`,
    tags: ['yard-logistics-coordinator:t2'],
  }];
}

function buildInstructionsExceptions(
  lineId: string,
  contractId: string,
  contractNumber: string,
  data: LooseRecord,
  seen: Set<string>,
): StagingException[] {
  const key = dedupeKey(contractId, 'missing_delivery_instructions');
  if (seen.has(key)) return [];
  const hasInstructions = asString(data.delivery_instructions) || asString(data.notes) || asString(data.special_instructions);
  if (hasInstructions) return [];
  seen.add(key);
  return [{
    id: buildExceptionId(contractId, lineId, 'missing_delivery_instructions'),
    code: 'missing_delivery_instructions',
    title: 'Missing delivery instructions',
    summary: 'No delivery instructions are recorded. The driver may arrive at the site without the context needed for a safe, on-time drop.',
    severity: 'warning',
    humanAction: 'Add site access notes, offload instructions, or hazard warnings before releasing to staging.',
    evidence: [
      { label: 'Contract', value: contractNumber },
      { label: 'Instructions', value: 'none recorded' },
    ],
    contractId,
    assetId: null,
    contractNumber,
    routeHref: `/rental/contracts/${contractId}`,
    tags: ['yard-logistics-coordinator:t2'],
  }];
}

function buildContractReadinessExceptions(
  lineId: string,
  contractId: string,
  contractNumber: string,
  data: LooseRecord,
  seen: Set<string>,
): StagingException[] {
  const key = dedupeKey(contractId, 'contract_not_ready');
  if (seen.has(key)) return [];
  const contractStatus = asString(data.status).toLowerCase();
  if (DISPATCH_READY_STATUSES.has(contractStatus) || !contractStatus) return [];
  seen.add(key);
  return [{
    id: buildExceptionId(contractId, lineId, 'contract_not_ready'),
    code: 'contract_not_ready',
    title: 'Contract not in dispatch-ready status',
    summary: `The contract is in status "${contractStatus}", which is not cleared for dispatch. Equipment must not be staged until the contract reaches an active or confirmed state.`,
    severity: 'blocking',
    humanAction: 'Resolve the contract status discrepancy before releasing equipment to the staging area.',
    evidence: [
      { label: 'Contract', value: contractNumber },
      { label: 'Current status', value: contractStatus || 'missing' },
      { label: 'Required status', value: Array.from(DISPATCH_READY_STATUSES).join(', ') },
    ],
    contractId,
    assetId: null,
    contractNumber,
    routeHref: `/rental/contracts/${contractId}`,
    tags: ['yard-logistics-coordinator:t4'],
  }];
}

function buildYardReadinessExceptions(
  lineId: string,
  contractId: string,
  contractNumber: string,
  assetId: string | undefined,
  yardGoingOut: Set<string>,
  seen: Set<string>,
): StagingException[] {
  if (!assetId) return [];
  // Dedupe per-asset (not per-contract) so a second unstaged asset on the
  // same contract still surfaces its own warning.
  const key = `${assetId}::yard_not_staged`;
  if (seen.has(key)) return [];
  if (yardGoingOut.has(assetId)) return [];
  seen.add(key);
  return [{
    id: buildExceptionId(assetId, lineId, 'yard_not_staged'),
    code: 'yard_not_staged',
    title: 'Asset not yet staged in the yard',
    summary: 'The asset assigned to this contract line is not showing as "going out" in the live yard board. Yard staging must be confirmed before the run is released.',
    severity: 'warning',
    humanAction: 'Confirm the asset is physically staged and update the yard board before releasing this line.',
    evidence: [
      { label: 'Contract', value: contractNumber },
      { label: 'Asset ID', value: assetId },
      { label: 'Yard board status', value: 'not in going_out lane' },
    ],
    contractId,
    assetId,
    contractNumber,
    routeHref: `/rental/contracts/${contractId}`,
    tags: ['yard-logistics-coordinator:t4'],
  }];
}

export function buildPredispatchStagingList(input: {
  dispatchLines?: unknown;
  contracts?: unknown;
  yardReadiness?: unknown;
  today?: string;
}): PredispatchStagingResult {
  const lines = asArray(input.dispatchLines) as DispatchLineRow[];
  const contractRows = asArray(input.contracts) as ContractSignalRow[];
  const yardRows = asArray(input.yardReadiness) as YardReadinessRow[];
  const today = input.today || new Date().toISOString().slice(0, 10);

  if (lines.length === 0 && contractRows.length === 0) {
    return buildNoOpResult();
  }

  const contractById = new Map<string, ContractSignalRow>();
  contractRows.forEach((row) => {
    const id = asString(row.id);
    if (id) contractById.set(id, row);
  });

  const yardGoingOut = new Set<string>();
  yardRows.forEach((row) => {
    if (asString(row.lane_key) === 'going_out') {
      const assetId = asString(row.asset_id);
      if (assetId) yardGoingOut.add(assetId);
    }
  });

  const seenExceptions = new Set<string>();
  const seenStagingItems = new Set<string>();
  const allExceptions: StagingException[] = [];
  const allItems: StagingItem[] = [];

  for (const line of lines) {
    const lineId = asString(line.entity_id);
    const contractId = asString(line.contract_id);
    // Skip rows with no line identifier — without entity_id we cannot produce
    // a unique per-line item key regardless of contractId.
    if (!lineId) continue;

    const lineData = asRecord(line.data);
    const lineStatus = asString(line.status || lineData.status).toLowerCase();
    const plannedStart = asString(lineData.planned_start || lineData.scheduled_start_at);

    if (!isWithinWindow(plannedStart || undefined, today)) continue;

    const contract = contractId ? contractById.get(contractId) : undefined;
    const contractData = contractVersionData(contract);
    const contractNumber = asString(contractData.contract_number)
      || (contractId ? `RC-${contractId.slice(-6).toUpperCase()}` : `LN-${lineId.slice(-6).toUpperCase()}`);
    const assetId = asString(line.asset_id || lineData.asset_id) || undefined;
    const categoryName = asString(lineData.category_name || lineData.asset_category_name) || null;

    const exceptions: StagingException[] = [
      ...buildContactExceptions(lineId, contractId, contractNumber, contractData, seenExceptions),
      ...buildAddressExceptions(lineId, contractId, contractNumber, contractData, seenExceptions),
      ...buildInstructionsExceptions(lineId, contractId, contractNumber, contractData, seenExceptions),
      ...buildContractReadinessExceptions(lineId, contractId, contractNumber, contractData, seenExceptions),
      ...buildYardReadinessExceptions(lineId, contractId, contractNumber, assetId, yardGoingOut, seenExceptions),
    ];

    allExceptions.push(...exceptions);

    // Key each staging item by dispatch line so two lines on the same contract
    // each appear as independent entries in the staging queue.
    const itemKey = buildStagingItemId(lineId, contractId);
    if (!seenStagingItems.has(itemKey)) {
      seenStagingItems.add(itemKey);

      allItems.push({
        id: itemKey,
        contractId: contractId || null,
        contractNumber,
        assetId: assetId || null,
        assetName: asString(lineData.asset_name) || null,
        categoryName,
        customerName: asString(contractData.customer_name || lineData.customer_name) || null,
        jobSiteName: asString(contractData.job_site_name || lineData.job_site_name) || null,
        scheduledAt: plannedStart || null,
        dispatchWindow: today,
        branchId: asString(contractData.branch_id || lineData.branch_id) || null,
        // readyToStage and exceptionCount are recomputed in the post-loop pass
        // once all exceptions (including those from subsequent lines) are known.
        readyToStage: true,
        exceptionCount: 0,
        routeHref: contractId ? `/rental/contracts/${contractId}` : '#',
      });
    }

    if (lineStatus === 'returned' || lineStatus === 'closed') {
      continue;
    }
  }

  // Post-loop: recompute readyToStage and exceptionCount for each item using
  // the full exception list. Contract-scoped exceptions (contact/address/etc.)
  // have assetId === null and apply to every line on that contract.
  // Yard exceptions have assetId set and apply only to the matching line/asset,
  // so a sibling line's yard_not_staged warning does not inflate another item's count.
  for (const item of allItems) {
    const relevant = allExceptions.filter(
      (e) => e.contractId === item.contractId && (e.assetId === null || e.assetId === item.assetId),
    );
    item.exceptionCount = relevant.length;
    item.readyToStage = !relevant.some((e) => e.severity === 'blocking');
  }

  if (allItems.length === 0 && allExceptions.length === 0) {
    return buildNoOpResult();
  }

  const sortedExceptions = [...allExceptions].sort((a, b) => {
    const rank: Record<ExceptionSeverity, number> = { blocking: 0, warning: 1 };
    return rank[a.severity] - rank[b.severity] || a.contractNumber.localeCompare(b.contractNumber);
  });

  const sortedItems = [...allItems].sort((a, b) => {
    if (!a.readyToStage && b.readyToStage) return -1;
    if (a.readyToStage && !b.readyToStage) return 1;
    return a.contractNumber.localeCompare(b.contractNumber);
  });

  return {
    items: sortedItems,
    exceptions: sortedExceptions,
    noOp: false,
    tags: PREDISPATCH_STAGING_TAGS,
  };
}
