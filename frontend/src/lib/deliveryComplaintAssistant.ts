/**
 * Delivery Complaint Assistant
 *
 * Assembles a reviewer-ready complaint case from route timeline, stop state,
 * branch / contract notes, and proof-of-delivery evidence.  Proposes the
 * likely recovery owner and next action while preserving all underlying
 * evidence for human review.
 *
 * Design:
 *   - assist mode only — no automatic customer promise, credit, or status
 *     disposition is ever produced.
 *   - When route or POD evidence is incomplete or ambiguous, the assistant
 *     escalates to 'escalate_dispatcher' rather than guessing.
 *   - Repeated calls for the same (stopId, complaintType) pair are idempotent;
 *     callers should collapse updates into the existing open thread via
 *     upsert_complaint_case rather than creating siblings.
 *
 * Operating-model tag: market-logistics-dispatcher:t1
 */

export const COMPLAINT_ASSISTANT_TAGS = [
  'market-logistics-dispatcher:t1',
] as const;

// ---------------------------------------------------------------------------
// Types — input signals
// ---------------------------------------------------------------------------

export type ComplaintType =
  | 'missed_delivery'
  | 'late_delivery'
  | 'incorrect_delivery'
  | 'missed_pickup'
  | 'late_pickup'
  | 'incorrect_pickup'
  | 'damage_on_delivery'
  | 'damage_on_pickup'
  | 'other';

export type RecoveryAction =
  | 'pending_review'
  | 're_run_required'
  | 'branch_follow_up'
  | 'escalate_dispatcher'
  | 'escalate_branch_manager'
  | 'document_service_failure'
  | 'resolved';

export type EvidenceStatus = 'packaged' | 'ambiguous' | 'incomplete';

export interface StopSignal {
  stopId?: unknown;
  stopType?: unknown;
  stopStatus?: unknown;
  customerName?: unknown;
  jobSiteName?: unknown;
  address?: unknown;
  contractLineId?: unknown;
  assetId?: unknown;
  stopNotes?: unknown;
  departedAt?: unknown;
  arrivedAt?: unknown;
  completedAt?: unknown;
}

export interface RouteSignal {
  routeId?: unknown;
  routeDate?: unknown;
  routeStatus?: unknown;
  driverId?: unknown;
}

export interface PodSignal {
  evidenceStatus?: unknown;
  signature?: unknown;
  conditionNotes?: unknown;
  photoPaths?: unknown;
  completedAt?: unknown;
}

export interface ExceptionSignal {
  exceptionType?: unknown;
  notes?: unknown;
  photoPaths?: unknown;
  estimatedDelayMinutes?: unknown;
  submittedAt?: unknown;
  resolvedAt?: unknown;
}

// ---------------------------------------------------------------------------
// Types — output
// ---------------------------------------------------------------------------

export type ComplaintEvidenceSource =
  | 'stop'
  | 'route'
  | 'pod'
  | 'exception'
  | 'notes'
  | 'uncertainty';

export interface ComplaintEvidence {
  source: ComplaintEvidenceSource;
  label: string;
  detail: string;
}

export interface ComplaintCaseResult {
  /** Deterministic id derived from stopId + complaintType for deduplication. */
  threadKey: string;
  complaintType: ComplaintType;
  recoveryAction: RecoveryAction;
  recoveryOwner: string;
  evidenceStatus: EvidenceStatus;
  title: string;
  summary: string;
  recommendation: string;
  requiresHumanApproval: true;
  evidence: ComplaintEvidence[];
  tags: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function formatDatetime(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function threadKey(stopId: string, complaintType: string): string {
  return `complaint::${stopId}::${complaintType}`;
}

function complaintLabel(type: ComplaintType): string {
  const labels: Record<ComplaintType, string> = {
    missed_delivery: 'Missed delivery',
    late_delivery: 'Late delivery',
    incorrect_delivery: 'Incorrect delivery',
    missed_pickup: 'Missed pickup',
    late_pickup: 'Late pickup',
    incorrect_pickup: 'Incorrect pickup',
    damage_on_delivery: 'Damage on delivery',
    damage_on_pickup: 'Damage on pickup',
    other: 'Complaint',
  };
  return labels[type] ?? 'Complaint';
}

function proposeRecoveryOwner(
  complaintType: ComplaintType,
  routeStatus: string | undefined,
  podEvidenceStatus: string | undefined,
): string {
  if (complaintType === 'missed_delivery' || complaintType === 'missed_pickup') {
    return 'Branch logistics coordinator — schedule re-run';
  }
  if (complaintType === 'damage_on_delivery' || complaintType === 'damage_on_pickup') {
    return 'Branch manager — damage assessment and recovery';
  }
  if (complaintType === 'late_delivery' || complaintType === 'late_pickup') {
    return 'Market Logistics Dispatcher — route review and ETA follow-up';
  }
  if (complaintType === 'incorrect_delivery' || complaintType === 'incorrect_pickup') {
    return 'Branch logistics coordinator — asset reconciliation';
  }
  if (routeStatus === 'completed' && !podEvidenceStatus) {
    return 'Branch manager — incomplete proof follow-up';
  }
  return 'Market Logistics Dispatcher — triage and route';
}

function proposeRecoveryAction(
  complaintType: ComplaintType,
  hasStop: boolean,
  hasRoute: boolean,
  hasPod: boolean,
  podComplete: boolean,
  openExceptions: number,
): RecoveryAction {
  // If the evidence base is too thin, escalate rather than guess.
  if (!hasStop || !hasRoute) {
    return 'escalate_dispatcher';
  }

  if (complaintType === 'missed_delivery' || complaintType === 'missed_pickup') {
    return 're_run_required';
  }
  if (complaintType === 'damage_on_delivery' || complaintType === 'damage_on_pickup') {
    return 'escalate_branch_manager';
  }
  if (!hasPod || !podComplete) {
    // POD is missing or incomplete — cannot close without review.
    return 'branch_follow_up';
  }
  if (openExceptions > 0) {
    return 'branch_follow_up';
  }
  return 'document_service_failure';
}

function deriveEvidenceStatus(
  hasStop: boolean,
  hasRoute: boolean,
  hasPod: boolean,
  podComplete: boolean,
  openExceptions: number,
): EvidenceStatus {
  if (!hasStop || !hasRoute) {
    return 'incomplete';
  }
  if (!hasPod || !podComplete || openExceptions > 0) {
    return 'ambiguous';
  }
  return 'packaged';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildDeliveryComplaintCase(input: {
  complaintType: ComplaintType;
  stop?: StopSignal | null;
  route?: RouteSignal | null;
  pod?: PodSignal | null;
  exceptions?: ExceptionSignal[];
  complaintNarrative?: string;
}): ComplaintCaseResult {
  const { complaintType } = input;
  const stop = input.stop ?? null;
  const route = input.route ?? null;
  const pod = input.pod ?? null;
  const exceptions = input.exceptions ?? [];

  const stopId = asString(stop?.stopId);
  const stopType = asString(stop?.stopType);
  const stopStatus = asString(stop?.stopStatus);
  const customerName = asString(stop?.customerName);
  const jobSiteName = asString(stop?.jobSiteName);
  const address = asString(stop?.address);
  const contractLineId = asString(stop?.contractLineId);
  const assetId = asString(stop?.assetId);
  const stopNotes = asString(stop?.stopNotes);
  const departedAt = asString(stop?.departedAt);
  const arrivedAt = asString(stop?.arrivedAt);
  const completedAt = asString(stop?.completedAt);

  const routeId = asString(route?.routeId);
  const routeDate = asString(route?.routeDate);
  const routeStatus = asString(route?.routeStatus);

  const podEvidenceStatus = asString(pod?.evidenceStatus);
  const podSignature = asString(pod?.signature);
  const podConditionNotes = asString(pod?.conditionNotes);
  const podPhotoPaths = asArray(pod?.photoPaths) as string[];
  const podCompletedAt = asString(pod?.completedAt);

  const openExceptions = exceptions.filter(
    (e) => !asString(e.resolvedAt),
  );

  const hasStop = !!stop && !!stopId;
  const hasRoute = !!route && !!routeId;
  const hasPod = !!pod && !!podEvidenceStatus;
  const podComplete = podEvidenceStatus === 'complete';

  const evidenceStatus = deriveEvidenceStatus(hasStop, hasRoute, hasPod, podComplete, openExceptions.length);
  const recoveryAction = proposeRecoveryAction(complaintType, hasStop, hasRoute, hasPod, podComplete, openExceptions.length);
  const recoveryOwner = proposeRecoveryOwner(complaintType, routeStatus, podEvidenceStatus);

  const label = complaintLabel(complaintType);
  const customerLabel = customerName || jobSiteName || contractLineId || stopId || 'stop';

  const evidence: ComplaintEvidence[] = [];

  // Stop / route timeline evidence
  if (hasStop) {
    const timeline: string[] = [];
    if (departedAt) timeline.push(`departed ${formatDatetime(departedAt)}`);
    if (arrivedAt) timeline.push(`arrived ${formatDatetime(arrivedAt)}`);
    if (completedAt) timeline.push(`completed ${formatDatetime(completedAt)}`);
    evidence.push({
      source: 'stop',
      label: 'Stop timeline',
      detail: [
        `${stopType ?? 'stop'} at ${address ?? jobSiteName ?? 'unknown address'} for ${customerName ?? 'unknown customer'}`,
        timeline.length > 0 ? `(${timeline.join(', ')})` : '(no timestamps recorded)',
        stopStatus ? `— status: ${stopStatus}` : '',
      ].filter(Boolean).join(' '),
    });
  } else {
    evidence.push({
      source: 'uncertainty',
      label: 'Stop evidence',
      detail: 'No stop record could be matched to this complaint. The dispatcher must confirm the stop reference before routing.',
    });
  }

  if (hasRoute) {
    evidence.push({
      source: 'route',
      label: 'Route context',
      detail: `Route ${routeId} on ${routeDate ?? 'unknown date'} — status: ${routeStatus ?? 'unknown'}.`,
    });
  } else {
    evidence.push({
      source: 'uncertainty',
      label: 'Route evidence',
      detail: 'No route record was found for this stop. Evidence is incomplete — the dispatcher must verify the route reference.',
    });
  }

  // Stop notes (branch notes read model)
  if (stopNotes) {
    evidence.push({
      source: 'notes',
      label: 'Branch / stop notes',
      detail: stopNotes,
    });
  }

  // POD evidence
  if (hasPod) {
    const podParts: string[] = [];
    if (podSignature) podParts.push(`signature captured`);
    else podParts.push(`no signature`);
    if (podPhotoPaths.length > 0) podParts.push(`${podPhotoPaths.length} photo${podPhotoPaths.length !== 1 ? 's' : ''}`);
    else podParts.push(`no photos`);
    if (podConditionNotes) podParts.push(`condition notes present`);
    if (podCompletedAt) podParts.push(`completed ${formatDatetime(podCompletedAt)}`);
    evidence.push({
      source: 'pod',
      label: 'Proof-of-delivery evidence',
      detail: `${podEvidenceStatus === 'complete' ? 'Complete' : 'Needs review'}: ${podParts.join(', ')}.`,
    });
  } else {
    evidence.push({
      source: 'uncertainty',
      label: 'Proof-of-delivery evidence',
      detail: 'No proof-of-delivery bundle exists for this stop. Complaint cannot be fully packaged until POD evidence is captured or absence confirmed.',
    });
  }

  // Asset / contract identifiers
  if (assetId || contractLineId) {
    evidence.push({
      source: 'stop',
      label: 'Asset / contract reference',
      detail: [
        assetId ? `asset ${assetId}` : null,
        contractLineId ? `contract line ${contractLineId}` : null,
      ].filter(Boolean).join(', '),
    });
  }

  // Open exception threads
  if (openExceptions.length > 0) {
    const exceptionSummary = openExceptions.map((e) => {
      const type = asString(e.exceptionType) ?? 'exception';
      const delay = asNumber(e.estimatedDelayMinutes);
      const at = asString(e.submittedAt);
      const parts = [type.replace(/_/g, ' ')];
      if (delay) parts.push(`estimated delay ${delay} min`);
      if (at) parts.push(`submitted ${formatDatetime(at)}`);
      return parts.join(' — ');
    });
    evidence.push({
      source: 'exception',
      label: `Open exceptions (${openExceptions.length})`,
      detail: exceptionSummary.join('; '),
    });
  }

  // Ambiguity escalation signal
  if (evidenceStatus === 'incomplete') {
    evidence.push({
      source: 'uncertainty',
      label: 'Ambiguity escalation',
      detail: 'Stop or route evidence is missing. The system cannot determine which stop, route state, or delivery artifact is authoritative — dispatcher must review before routing.',
    });
  } else if (evidenceStatus === 'ambiguous') {
    evidence.push({
      source: 'uncertainty',
      label: 'Evidence gap',
      detail: 'POD evidence is missing, incomplete, or open exceptions remain unresolved. The complaint bundle is provisionally assembled but the dispatcher must confirm completeness before routing recovery.',
    });
  }

  // Recovery path
  evidence.push({
    source: 'route',
    label: 'Proposed recovery path',
    detail: recoveryOwner,
  });

  let recommendation: string;
  if (evidenceStatus === 'incomplete') {
    recommendation = 'Stop or route evidence is missing. Verify the stop and route reference first, then reassemble the complaint bundle.';
  } else if (evidenceStatus === 'ambiguous') {
    recommendation = `POD or exception evidence is incomplete. Confirm the evidence base with the branch before routing recovery. Any customer promise, credit, or status change requires human approval.`;
  } else {
    recommendation = `Evidence is packaged. Proposed recovery owner: ${recoveryOwner}. Human approval is required before any customer-facing promise, credit, damage, or status-changing disposition.`;
  }

  return {
    threadKey: stopId ? threadKey(stopId, complaintType) : `complaint::anon-${crypto.randomUUID()}::${complaintType}`,
    complaintType,
    recoveryAction,
    recoveryOwner,
    evidenceStatus,
    title: `${label} — ${customerLabel}`,
    summary: `Delivery complaint case for ${complaintType.replace(/_/g, ' ')} at ${address ?? jobSiteName ?? 'unknown address'}${customerName ? ` (${customerName})` : ''}.`,
    recommendation,
    requiresHumanApproval: true,
    evidence,
    tags: COMPLAINT_ASSISTANT_TAGS,
  };
}
