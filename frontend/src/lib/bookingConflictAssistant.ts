export const OPERATING_MODEL_TAGS = [
  'rental-counter-coordinator:t1',
  'rental-counter-coordinator:t2',
  'rental-counter-coordinator:t5',
  'rental-counter-coordinator:t8',
] as const;

type ConflictPriority = 'blocking' | 'review' | 'warning' | 'no_op';
type ConflictStatus = 'conflict' | 'follow_up' | 'uncertain' | 'no_op';
type ConflictWorkflow = 'booking' | 'delivery_window' | 'extension' | 'dispatch' | 'no_op';
type EvidenceSource =
  | 'availability'
  | 'return'
  | 'maintenance'
  | 'open_contract'
  | 'route'
  | 'telemetry'
  | 'capacity'
  | 'uncertainty';

export interface ConflictAssistantEvidence {
  source: EvidenceSource;
  label: string;
  detail: string;
}

export interface ConflictAssistantItem {
  id: string;
  workflow: ConflictWorkflow;
  priority: ConflictPriority;
  status: ConflictStatus;
  title: string;
  summary: string;
  recommendation: string;
  requiresHumanApproval: boolean;
  orderId?: string;
  contractId?: string;
  lineId?: string;
  evidence: ConflictAssistantEvidence[];
}

export interface ConflictAssistantResult {
  items: ConflictAssistantItem[];
  noOp: boolean;
  tags: readonly string[];
}

interface QuoteAvailabilitySignal {
  line_entity_id?: unknown;
  order_id?: unknown;
  branch_id?: unknown;
  asset_category_id?: unknown;
  requested_quantity?: unknown;
  planned_start?: unknown;
  planned_end?: unknown;
  available_quantity?: unknown;
  is_available?: unknown;
  shortage_quantity?: unknown;
  shortage_reason?: unknown;
  alternatives?: unknown;
}

interface ContractSignal {
  id?: unknown;
  entity_versions?: unknown;
}

interface ContractLineSignal {
  entity_id?: unknown;
  contract_id?: unknown;
  status?: unknown;
  asset_id?: unknown;
  category_id?: unknown;
  actual_start?: unknown;
  actual_end?: unknown;
  data?: unknown;
}

interface AvailabilitySignal {
  branch_id?: unknown;
  branch_name?: unknown;
  asset_category_id?: unknown;
  asset_category_name?: unknown;
  available_assets?: unknown;
  unavailable_assets?: unknown;
  maintenance_due_assets?: unknown;
  maintenance_overdue_assets?: unknown;
}

type LooseRecord = Record<string, unknown>;

const EXTENSION_LOOKAHEAD_DAYS = 2;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysUntil(value: string | undefined, today: string): number | null {
  const target = parseDate(value);
  const baseline = parseDate(today);
  if (!target || !baseline) return null;
  return Math.floor((target.getTime() - baseline.getTime()) / MS_PER_DAY);
}

function labelFromIdentifier(value: string | undefined, fallback: string): string {
  return value || fallback;
}

function availabilityLabel(row: AvailabilitySignal | undefined): string | undefined {
  if (!row) return undefined;
  return [asString(row.branch_name) || asString(row.branch_id), asString(row.asset_category_name) || asString(row.asset_category_id)]
    .filter(Boolean)
    .join(' · ');
}

function findAvailabilitySignal(
  availability: AvailabilitySignal[],
  branchId: string | undefined,
  categoryId: string | undefined,
): AvailabilitySignal | undefined {
  return availability.find((row) =>
    asString(row.branch_id) === branchId && asString(row.asset_category_id) === categoryId
  );
}

function buildMaintenanceEvidence(row: AvailabilitySignal | undefined): ConflictAssistantEvidence[] {
  if (!row) return [];
  const due = asNumber(row.maintenance_due_assets) ?? 0;
  const overdue = asNumber(row.maintenance_overdue_assets) ?? 0;
  if (due <= 0 && overdue <= 0) return [];
  return [{
    source: 'maintenance',
    label: 'Maintenance readiness',
    detail: `${availabilityLabel(row) || 'Branch availability'} reports ${due} due and ${overdue} overdue units.`,
  }];
}

function buildNoOpResult(summary: string): ConflictAssistantResult {
  return {
    noOp: true,
    tags: OPERATING_MODEL_TAGS,
    items: [{
      id: 'no-op',
      workflow: 'no_op',
      priority: 'no_op',
      status: 'no_op',
      title: 'No materially new branch conflict',
      summary,
      recommendation: 'Human approval still governs any booking, release, or extension decision.',
      requiresHumanApproval: true,
      evidence: [{
        source: 'open_contract',
        label: 'Assistant state',
        detail: 'The current signals do not show a new booking, delivery-window, return, or extension exception that needs branch follow-up.',
      }],
    }],
  };
}

function sortItems(items: ConflictAssistantItem[]): ConflictAssistantItem[] {
  const rank: Record<ConflictPriority, number> = {
    blocking: 0,
    review: 1,
    warning: 2,
    no_op: 3,
  };
  return [...items].sort((left, right) => {
    const priorityDelta = rank[left.priority] - rank[right.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return left.title.localeCompare(right.title);
  });
}

export function buildBookingConflictAssistant(input: {
  orderId?: string;
  quoteAvailability?: unknown;
  availability?: unknown;
}): ConflictAssistantResult {
  const quoteSignals = asArray(input.quoteAvailability) as QuoteAvailabilitySignal[];
  const availabilitySignals = asArray(input.availability) as AvailabilitySignal[];

  const items = quoteSignals.flatMap<ConflictAssistantItem>((signal) => {
    if (asBoolean(signal.is_available) !== false) return [];

    const lineId = asString(signal.line_entity_id);
    const categoryId = asString(signal.asset_category_id);
    const branchId = asString(signal.branch_id);
    const requested = asNumber(signal.requested_quantity) ?? 0;
    const available = asNumber(signal.available_quantity) ?? 0;
    const shortage = asNumber(signal.shortage_quantity) ?? Math.max(requested - available, 0);
    const plannedStart = asString(signal.planned_start);
    const plannedEnd = asString(signal.planned_end);
    const alternatives = asArray(signal.alternatives).map((value) => asRecord(value)).filter(Boolean) as LooseRecord[];
    const availabilitySignal = findAvailabilitySignal(availabilitySignals, branchId, categoryId);

    const evidence: ConflictAssistantEvidence[] = [{
      source: 'availability',
      label: 'Availability check',
      detail: `Line ${labelFromIdentifier(lineId, 'unknown')} requests ${requested} from ${plannedStart || 'unknown'} to ${plannedEnd || 'unknown'}; only ${available} are currently free (shortage ${shortage}).`,
    }];

    evidence.push(...buildMaintenanceEvidence(availabilitySignal));

    if (alternatives.length > 0) {
      const topAlternative = alternatives[0];
      evidence.push({
        source: 'availability',
        label: 'Suggested follow-up',
        detail: `${asString(topAlternative.asset_category_name) || categoryId || 'Category'} @ ${asString(topAlternative.branch_name) || asString(topAlternative.branch_id) || 'alternate branch'} shows ${asNumber(topAlternative.available_quantity) ?? 0} available.`,
      });
    }

    return [{
      id: `booking-${lineId || categoryId || 'signal'}`,
      workflow: 'booking',
      priority: 'blocking',
      status: 'conflict',
      title: `Availability conflict for ${labelFromIdentifier(categoryId, 'requested equipment')}`,
      summary: 'Review follow-ups before confirming the quote or moving the order toward release.',
      recommendation: alternatives.length > 0
        ? 'Review the alternate branch/category recommendation with the counter coordinator before confirming the quote.'
        : 'Coordinate with the branch before confirming the quote or promising equipment availability.',
      requiresHumanApproval: true,
      orderId: input.orderId || asString(signal.order_id),
      lineId,
      evidence,
    }];
  });

  if (items.length === 0) {
    return buildNoOpResult('Current quote availability signals do not show a materially new booking conflict.');
  }

  return {
    items: sortItems(items),
    noOp: false,
    tags: OPERATING_MODEL_TAGS,
  };
}

function contractVersionData(contract: ContractSignal | null): LooseRecord | null {
  const version = asRecord(asArray(contract?.entity_versions)[0]);
  return asRecord(version?.data);
}

export function buildOpenContractConflictQueue(input: {
  contracts?: unknown;
  lines?: unknown;
  availability?: unknown;
  today?: string;
}): ConflictAssistantResult {
  const contracts = asArray(input.contracts) as ContractSignal[];
  const lines = asArray(input.lines) as ContractLineSignal[];
  const availabilitySignals = asArray(input.availability) as AvailabilitySignal[];
  const today = input.today || new Date().toISOString().slice(0, 10);

  const contractById = new Map<string, ContractSignal>();
  contracts.forEach((contract) => {
    const contractId = asString(contract.id);
    if (contractId) contractById.set(contractId, contract);
  });

  const items = lines.flatMap<ConflictAssistantItem>((line) => {
    const contractId = asString(line.contract_id);
    if (!contractId) return [];

    const contract = contractById.get(contractId) || null;
    const contractData = contractVersionData(contract);
    const contractNumber = asString(contractData?.contract_number) || contractId;
    const branchId = asString(contractData?.branch_id);
    const orderId = asString(contractData?.order_id);
    const status = asString(line.status);
    const lineId = asString(line.entity_id);
    const categoryId = asString(line.category_id);
    const assetId = asString(line.asset_id);
    const lineData = asRecord(line.data);
    const plannedStart = asString(lineData?.planned_start);
    const plannedEnd = asString(lineData?.planned_end);
    const actualEnd = asString(line.actual_end);
    const availabilitySignal = findAvailabilitySignal(availabilitySignals, branchId, categoryId);

    if (status === 'pending_execution') {
      const daysToStart = daysUntil(plannedStart, today);
      if (daysToStart === null || daysToStart > EXTENSION_LOOKAHEAD_DAYS) return [];

      const evidence: ConflictAssistantEvidence[] = [{
        source: 'open_contract',
        label: 'Open contract signal',
        detail: `${contractNumber} line ${labelFromIdentifier(lineId, 'unknown')} is still pending execution for ${plannedStart || 'an upcoming delivery window'}${assetId ? ` with asset ${assetId}` : ' without an assigned asset'}.`,
      }];
      if (availabilitySignal) {
        evidence.push({
          source: 'availability',
          label: 'Branch availability',
          detail: `${availabilityLabel(availabilitySignal) || 'Current branch/category'} has ${asNumber(availabilitySignal.available_assets) ?? 0} available and ${asNumber(availabilitySignal.unavailable_assets) ?? 0} unavailable units.`,
        });
      }
      evidence.push(...buildMaintenanceEvidence(availabilitySignal));

      return [{
        id: `delivery-${contractId}-${lineId || 'line'}`,
        workflow: 'delivery_window',
        priority: daysToStart < 0 ? 'blocking' : 'review',
        status: 'follow_up',
        title: `Delivery-window follow-up for ${contractNumber}`,
        summary: 'This open contract needs a release-readiness review before a delivery promise is reinforced.',
        recommendation: 'Confirm branch readiness, asset assignment, and supporting evidence before releasing this contract.',
        requiresHumanApproval: true,
        contractId,
        orderId,
        lineId,
        evidence,
      }];
    }

    if (status === 'checked_out' && !actualEnd) {
      const daysToEnd = daysUntil(plannedEnd, today);
      if (daysToEnd === null || daysToEnd > EXTENSION_LOOKAHEAD_DAYS) return [];

      const evidence: ConflictAssistantEvidence[] = [{
        source: 'return',
        label: 'Return / extension signal',
        detail: `${contractNumber} line ${labelFromIdentifier(lineId, 'unknown')} is checked out${assetId ? ` on asset ${assetId}` : ''} and is due back ${plannedEnd || 'soon'}, but no actual return is posted yet.`,
      }];

      let priority: ConflictPriority = daysToEnd < 0 ? 'blocking' : 'review';
      let statusLabel: ConflictStatus = 'follow_up';
      let recommendation = 'Review downstream impact before promising a new end date; the counter coordinator must approve any customer-facing extension.';

      if (availabilitySignal) {
        const availableAssets = asNumber(availabilitySignal.available_assets) ?? 0;
        evidence.push({
          source: 'availability',
          label: 'Downstream availability',
          detail: `${availabilityLabel(availabilitySignal) || 'Current branch/category'} shows ${availableAssets} currently available units.`,
        });
        evidence.push(...buildMaintenanceEvidence(availabilitySignal));
        if (availableAssets <= 0) {
          priority = 'blocking';
          statusLabel = 'conflict';
          recommendation = 'No free capacity is visible for this branch/category. Coordinate with the branch before promising any extension.';
        }
      } else {
        evidence.push({
          source: 'uncertainty',
          label: 'Availability confidence',
          detail: 'Current branch coverage is incomplete for this line, so a coordinator should verify branch availability manually before discussing any extension.',
        });
        statusLabel = 'uncertain';
        recommendation = 'Escalate to manual branch coordination before changing the promised end date.';
      }

      return [{
        id: `extension-${contractId}-${lineId || 'line'}`,
        workflow: 'extension',
        priority,
        status: statusLabel,
        title: `Extension review for ${contractNumber}`,
        summary: 'Surface downstream return and extension risk before a new end date is promised.',
        recommendation,
        requiresHumanApproval: true,
        contractId,
        orderId,
        lineId,
        evidence,
      }];
    }

    return [];
  });

  if (items.length === 0) {
    return buildNoOpResult('The open-contract queue does not currently show a materially new delivery-window, return, or extension conflict.');
  }

  return {
    items: sortItems(items),
    noOp: false,
    tags: OPERATING_MODEL_TAGS,
  };
}
