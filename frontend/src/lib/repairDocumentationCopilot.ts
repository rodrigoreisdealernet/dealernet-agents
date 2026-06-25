/**
 * Repair Documentation Copilot
 *
 * Assembles asset service history, prior faults, and structured note prompts so
 * technicians can record labor, parts, findings, and escalation decisions in one
 * pass — without re-entering the same facts in multiple places.
 *
 * Design:
 *   - Assist mode only — no diagnosis, escalation decision, or repair completion
 *     is ever made automatically. The technician remains the disposition boundary.
 *   - When asset history is absent or ambiguous the copilot presents raw history
 *     slots and empty structured prompts rather than inferred conclusions.
 *   - Escalation beyond branch skill, time, or authorization limits is a first-class
 *     outcome, not a free-text convention.
 *   - Field-service and shop-service paths share the same minimum evidence contract;
 *     path-specific differences are additive.
 *
 * Operating-model tags: service-technician:t3, service-technician:t4, service-technician:t7
 */

export const REPAIR_COPILOT_TAGS = [
  'service-technician:t3',
  'service-technician:t4',
  'service-technician:t7',
] as const;

// ---------------------------------------------------------------------------
// Types — input signals
// ---------------------------------------------------------------------------

export type ServicePath = 'field' | 'shop';

export type EscalationReason =
  | 'exceeds_branch_skill'
  | 'exceeds_authorization_limit'
  | 'exceeds_time_available'
  | 'parts_unavailable'
  | 'safety_concern'
  | 'oem_specialist_required'
  | 'none';

export type WorkOrderStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_parts'
  | 'waiting_approval'
  | 'escalated'
  | 'completed'
  | 'cancelled';

export interface WorkOrderSignal {
  maintenanceRecordId?: unknown;
  name?: unknown;
  maintenanceType?: unknown;
  workOrderStatus?: unknown;
  assetId?: unknown;
  notes?: unknown;
  technicianId?: unknown;
  openedAt?: unknown;
  completedAt?: unknown;
  availabilityImpact?: unknown;
  blockingReason?: unknown;
}

export interface ServiceHistoryRecord {
  serviceRecordId?: unknown;
  serviceRecordType?: unknown;
  serviceName?: unknown;
  serviceType?: unknown;
  outcome?: unknown;
  status?: unknown;
  openedAt?: unknown;
  completedAt?: unknown;
  costSummary?: unknown;
  downtimeMinutes?: unknown;
  serviceSortAt?: unknown;
}

// ---------------------------------------------------------------------------
// Types — output
// ---------------------------------------------------------------------------

export type EvidenceStatus = 'complete' | 'partial' | 'missing';

export type DocumentationPromptField =
  | 'fault_description'
  | 'repair_action'
  | 'labor_hours'
  | 'parts_used'
  | 'parts_needed'
  | 'technician_findings'
  | 'escalation_reason'
  | 'escalation_notes';

export interface DocumentationPrompt {
  field: DocumentationPromptField;
  label: string;
  required: boolean;
  hint: string;
}

export interface PriorFaultRecord {
  serviceRecordId: string;
  serviceType: string;
  label: string;
  outcome: string;
  occurredAt: string;
  source: 'maintenance' | 'inspection';
}

export interface ServiceHistorySummary {
  totalEvents: number;
  recentFaultCount: number;
  lastServiceAt: string | null;
  lastServiceType: string | null;
  lastServiceOutcome: string | null;
  totalDowntimeMinutes: number;
}

export interface EscalationOption {
  reason: EscalationReason;
  label: string;
  description: string;
}

export interface RepairDocumentationPacket {
  /** Deterministic key for deduplication — scoped to the work order. */
  packetKey: string;
  assetId: string | null;
  workOrderId: string | null;
  workOrderName: string | null;
  maintenanceType: string | null;
  servicePath: ServicePath;
  evidenceStatus: EvidenceStatus;
  priorFaults: PriorFaultRecord[];
  serviceHistorySummary: ServiceHistorySummary;
  documentationPrompts: DocumentationPrompt[];
  escalationOptions: EscalationOption[];
  recommendation: string;
  /** Always true — technician owns disposition, completion, and certification. */
  requiresHumanDisposition: true;
  tags: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function formatDatetime(iso: string | undefined): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function packetKey(workOrderId: string): string {
  return `repair-doc::${workOrderId}`;
}

// ---------------------------------------------------------------------------
// Structured documentation prompts
// ---------------------------------------------------------------------------

function buildDocumentationPrompts(servicePath: ServicePath): DocumentationPrompt[] {
  const shared: DocumentationPrompt[] = [
    {
      field: 'fault_description',
      label: 'Fault description',
      required: true,
      hint: 'Describe the symptom or fault as found. Include sensory observations (noise, leak, error code). Do not infer a cause.',
    },
    {
      field: 'repair_action',
      label: 'Repair action taken',
      required: true,
      hint: 'Describe the work performed. What was replaced, adjusted, or cleaned? Note any deviations from OEM procedure.',
    },
    {
      field: 'labor_hours',
      label: 'Labor hours',
      required: true,
      hint: 'Total technician hours charged to this work order.',
    },
    {
      field: 'parts_used',
      label: 'Parts used',
      required: false,
      hint: 'List part numbers and descriptions of components consumed. Leave blank if no parts were used.',
    },
    {
      field: 'parts_needed',
      label: 'Parts still needed',
      required: false,
      hint: 'List any outstanding parts required to complete the repair. Used to set waiting_parts status.',
    },
    {
      field: 'technician_findings',
      label: 'Technician findings',
      required: false,
      hint: 'Additional observations about equipment condition, deferred items, or recommended follow-up.',
    },
    {
      field: 'escalation_reason',
      label: 'Escalation reason',
      required: false,
      hint: 'Select a reason if this repair exceeds branch skill, time, or authorization. Required when escalation status is set.',
    },
    {
      field: 'escalation_notes',
      label: 'Escalation notes',
      required: false,
      hint: 'Describe the escalation scope — what was attempted, what is still needed, and who to hand off to.',
    },
  ];

  if (servicePath === 'field') {
    // Field service: parts_used and escalation_notes are promoted to required
    // because field documentation cannot be supplemented at a shop terminal.
    return shared.map((p) =>
      p.field === 'parts_used' || p.field === 'technician_findings'
        ? { ...p, required: true }
        : p
    );
  }

  // Shop service: all shared prompts as-is.
  return shared;
}

// ---------------------------------------------------------------------------
// Escalation options — first-class, not free-text
// ---------------------------------------------------------------------------

function buildEscalationOptions(): EscalationOption[] {
  return [
    {
      reason: 'none',
      label: 'No escalation — repair completed at branch',
      description: 'All repair work is complete and within branch skill and authorization.',
    },
    {
      reason: 'exceeds_branch_skill',
      label: 'Exceeds branch skill',
      description: 'This fault requires specialist knowledge or certification not available at this branch.',
    },
    {
      reason: 'exceeds_authorization_limit',
      label: 'Exceeds authorization limit',
      description: 'Repair cost or scope exceeds branch authorization. Manager or regional approval required.',
    },
    {
      reason: 'exceeds_time_available',
      label: 'Exceeds time available',
      description: 'Repair cannot be completed within branch scheduling constraints. Work order must be transferred or deferred.',
    },
    {
      reason: 'parts_unavailable',
      label: 'Parts unavailable',
      description: 'Required parts are not in stock. Work order is on hold pending parts procurement.',
    },
    {
      reason: 'safety_concern',
      label: 'Safety concern identified',
      description: 'A safety issue was identified that requires management review before the unit is returned to service.',
    },
    {
      reason: 'oem_specialist_required',
      label: 'OEM / specialist required',
      description: 'Manufacturer or third-party specialist intervention is required to complete the repair.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Prior fault assembly
// ---------------------------------------------------------------------------

const RECENT_FAULT_WINDOW_DAYS = 90;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function isFaultOutcome(outcome: string | undefined): boolean {
  if (!outcome) return false;
  const o = outcome.toLowerCase();
  return o === 'fail' || o === 'failed' || o === 'fault' || o === 'open' || o === 'in_progress';
}

function isRecentRecord(serviceSortAt: string | undefined): boolean {
  if (!serviceSortAt) return false;
  const t = new Date(serviceSortAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= RECENT_FAULT_WINDOW_DAYS * MS_PER_DAY;
}

function buildPriorFaults(records: ServiceHistoryRecord[]): PriorFaultRecord[] {
  const faults: PriorFaultRecord[] = [];
  for (const rec of records) {
    const id = asString(rec.serviceRecordId);
    const outcome = asString(rec.outcome) ?? asString(rec.status);
    if (!id || !isFaultOutcome(outcome)) continue;
    const serviceType = asString(rec.serviceType) ?? asString(rec.serviceRecordType) ?? 'unknown';
    const label = asString(rec.serviceName) ?? `${serviceType} service`;
    const occurredAt = asString(rec.serviceSortAt) ?? asString(rec.openedAt) ?? '';
    const recordType = asString(rec.serviceRecordType) === 'inspection' ? 'inspection' : 'maintenance';
    faults.push({
      serviceRecordId: id,
      serviceType,
      label,
      outcome: outcome ?? 'unknown',
      occurredAt: formatDatetime(occurredAt || undefined),
      source: recordType,
    });
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Service history summary
// ---------------------------------------------------------------------------

function buildServiceHistorySummary(records: ServiceHistoryRecord[]): ServiceHistorySummary {
  const total = records.length;
  const recentFaults = records.filter((r) => {
    const outcome = asString(r.outcome) ?? asString(r.status);
    return isFaultOutcome(outcome) && isRecentRecord(asString(r.serviceSortAt) ?? asString(r.openedAt));
  }).length;

  const sorted = [...records].sort((a, b) => {
    const ta = new Date(asString(a.serviceSortAt) ?? '').getTime();
    const tb = new Date(asString(b.serviceSortAt) ?? '').getTime();
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });

  const last = sorted[0];
  const lastServiceAt = last ? (asString(last.serviceSortAt) ?? asString(last.completedAt) ?? asString(last.openedAt) ?? null) : null;
  const lastServiceType = last ? (asString(last.serviceType) ?? asString(last.serviceRecordType) ?? null) : null;
  const lastServiceOutcome = last ? (asString(last.outcome) ?? asString(last.status) ?? null) : null;

  const totalDowntimeMinutes = records.reduce((acc, r) => {
    const dm = asNumber(r.downtimeMinutes);
    return acc + (dm ?? 0);
  }, 0);

  return {
    totalEvents: total,
    recentFaultCount: recentFaults,
    lastServiceAt: lastServiceAt ? formatDatetime(lastServiceAt) : null,
    lastServiceType,
    lastServiceOutcome,
    totalDowntimeMinutes,
  };
}

// ---------------------------------------------------------------------------
// Evidence status
// ---------------------------------------------------------------------------

function deriveEvidenceStatus(
  hasWorkOrder: boolean,
  serviceHistoryCount: number,
): EvidenceStatus {
  if (!hasWorkOrder) return 'missing';
  if (serviceHistoryCount === 0) return 'partial';
  return 'complete';
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

function buildRecommendation(
  evidenceStatus: EvidenceStatus,
  priorFaultCount: number,
  servicePath: ServicePath,
): string {
  if (evidenceStatus === 'missing') {
    return 'Work order data is missing. Verify the work order reference and reload before recording documentation.';
  }
  if (evidenceStatus === 'partial') {
    return `No prior service history found for this asset. Complete the documentation prompts based on direct inspection. Human technician must confirm diagnosis and disposition.${servicePath === 'field' ? ' Field-service path: ensure all parts and findings are captured before leaving the site.' : ''}`;
  }
  const faultNote =
    priorFaultCount > 0
      ? ` ${priorFaultCount} prior fault${priorFaultCount !== 1 ? 's' : ''} found in the last ${RECENT_FAULT_WINDOW_DAYS} days — review the history panel before documenting to avoid repeating prior diagnosis steps.`
      : ' No recent faults found in history.';
  return `History assembled.${faultNote} Complete all required documentation prompts. Select an escalation reason if this repair exceeds branch skill, time, or authorization limits. The technician must confirm all findings — the system never auto-closes or auto-certifies a repair.${servicePath === 'field' ? ' Field-service path: record parts and technician findings before closing the mobile session.' : ''}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildRepairDocumentationPacket(input: {
  workOrder?: WorkOrderSignal | null;
  serviceHistory?: ServiceHistoryRecord[];
  servicePath?: ServicePath;
}): RepairDocumentationPacket {
  const wo = input.workOrder ?? null;
  const records = asArray<ServiceHistoryRecord>(input.serviceHistory);
  const servicePath: ServicePath = input.servicePath ?? 'shop';

  const workOrderId = asString(wo?.maintenanceRecordId) ?? null;
  const assetId = asString(wo?.assetId) ?? null;
  const workOrderName = asString(wo?.name) ?? null;
  const maintenanceType = asString(wo?.maintenanceType) ?? null;

  const hasWorkOrder = !!wo && !!workOrderId;
  const priorFaults = buildPriorFaults(records);
  const serviceHistorySummary = buildServiceHistorySummary(records);
  const evidenceStatus = deriveEvidenceStatus(hasWorkOrder, records.length);
  const documentationPrompts = buildDocumentationPrompts(servicePath);
  const escalationOptions = buildEscalationOptions();
  const recommendation = buildRecommendation(evidenceStatus, priorFaults.length, servicePath);

  return {
    packetKey: workOrderId ? packetKey(workOrderId) : `repair-doc::anon-${crypto.randomUUID()}`,
    assetId,
    workOrderId,
    workOrderName,
    maintenanceType,
    servicePath,
    evidenceStatus,
    priorFaults,
    serviceHistorySummary,
    documentationPrompts,
    escalationOptions,
    recommendation,
    requiresHumanDisposition: true,
    tags: REPAIR_COPILOT_TAGS,
  };
}
