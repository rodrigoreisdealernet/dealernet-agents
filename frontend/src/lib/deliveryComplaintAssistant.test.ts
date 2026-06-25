import { describe, expect, it } from 'vitest';
import {
  buildDeliveryComplaintCase,
  COMPLAINT_ASSISTANT_TAGS,
  type StopSignal,
  type RouteSignal,
  type PodSignal,
  type ExceptionSignal,
} from './deliveryComplaintAssistant';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullStop: StopSignal = {
  stopId: 'stop-uuid-001',
  stopType: 'delivery',
  stopStatus: 'completed',
  customerName: 'Acme Construction',
  jobSiteName: 'Acme Site A',
  address: '100 Main St',
  contractLineId: 'line-uuid-001',
  assetId: 'asset-abc',
  stopNotes: 'Customer requested morning delivery window.',
  departedAt: '2026-06-17T08:00:00Z',
  arrivedAt: '2026-06-17T09:15:00Z',
  completedAt: '2026-06-17T09:30:00Z',
};

const fullRoute: RouteSignal = {
  routeId: 'route-uuid-001',
  routeDate: '2026-06-17',
  routeStatus: 'completed',
};

const completePod: PodSignal = {
  evidenceStatus: 'complete',
  signature: 'J. Smith',
  conditionNotes: 'Equipment delivered in good condition.',
  photoPaths: ['photo1.jpg', 'photo2.jpg'],
  completedAt: '2026-06-17T09:30:00Z',
};

const incompletePod: PodSignal = {
  evidenceStatus: 'needs_review',
  signature: null,
  conditionNotes: null,
  photoPaths: [],
  completedAt: '2026-06-17T09:30:00Z',
};

const openException: ExceptionSignal = {
  exceptionType: 'eta_delay',
  notes: 'Traffic delay on I-90',
  estimatedDelayMinutes: 45,
  submittedAt: '2026-06-17T08:30:00Z',
  resolvedAt: null,
};

const resolvedException: ExceptionSignal = {
  exceptionType: 'eta_delay',
  notes: 'Resolved',
  estimatedDelayMinutes: 20,
  submittedAt: '2026-06-17T07:00:00Z',
  resolvedAt: '2026-06-17T07:30:00Z',
};

// ---------------------------------------------------------------------------
// Operating-model tags
// ---------------------------------------------------------------------------

describe('COMPLAINT_ASSISTANT_TAGS', () => {
  it('includes market-logistics-dispatcher:t1', () => {
    expect(COMPLAINT_ASSISTANT_TAGS).toContain('market-logistics-dispatcher:t1');
  });
});

// ---------------------------------------------------------------------------
// Evidence assembly — full evidence path
// ---------------------------------------------------------------------------

describe('buildDeliveryComplaintCase — full evidence', () => {
  it('assembles a packaged case when all evidence is present and POD is complete', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    expect(result.evidenceStatus).toBe('packaged');
    expect(result.recoveryAction).toBe('document_service_failure');
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.tags).toEqual(COMPLAINT_ASSISTANT_TAGS);
  });

  it('sets threadKey to a deterministic compound of stopId and complaintType', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    expect(result.threadKey).toBe('complaint::stop-uuid-001::late_delivery');
  });

  it('includes stop timeline in evidence', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    const stopEvidence = result.evidence.find((e) => e.label === 'Stop timeline');
    expect(stopEvidence).toBeDefined();
    expect(stopEvidence?.detail).toContain('Acme Construction');
    expect(stopEvidence?.detail).toContain('100 Main St');
    expect(stopEvidence?.detail).toContain('departed');
  });

  it('includes route context in evidence', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    const routeEvidence = result.evidence.find((e) => e.label === 'Route context');
    expect(routeEvidence).toBeDefined();
    expect(routeEvidence?.detail).toContain('route-uuid-001');
    expect(routeEvidence?.detail).toContain('2026-06-17');
  });

  it('includes POD evidence when present', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    const podEvidence = result.evidence.find((e) => e.label === 'Proof-of-delivery evidence');
    expect(podEvidence).toBeDefined();
    expect(podEvidence?.detail).toContain('signature captured');
    expect(podEvidence?.detail).toContain('2 photos');
  });

  it('includes branch notes when stop notes are present', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    const notesEvidence = result.evidence.find((e) => e.label === 'Branch / stop notes');
    expect(notesEvidence).toBeDefined();
    expect(notesEvidence?.detail).toContain('morning delivery window');
  });
});

// ---------------------------------------------------------------------------
// Update deduplication — thread key stability
// ---------------------------------------------------------------------------

describe('buildDeliveryComplaintCase — deduplication', () => {
  it('produces the same threadKey for repeated calls with the same stop + type', () => {
    const first = buildDeliveryComplaintCase({
      complaintType: 'missed_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });

    const second = buildDeliveryComplaintCase({
      complaintType: 'missed_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
      complaintNarrative: 'Customer called again — driver never showed.',
    });

    expect(first.threadKey).toBe(second.threadKey);
  });

  it('produces different threadKeys for different complaint types on the same stop', () => {
    const late = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
    });
    const missed = buildDeliveryComplaintCase({
      complaintType: 'missed_delivery',
      stop: fullStop,
      route: fullRoute,
    });

    expect(late.threadKey).not.toBe(missed.threadKey);
  });
});

// ---------------------------------------------------------------------------
// Recovery routing — recovery action proposals
// ---------------------------------------------------------------------------

describe('buildDeliveryComplaintCase — recovery routing', () => {
  it('proposes re_run_required for missed_delivery', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'missed_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });
    expect(result.recoveryAction).toBe('re_run_required');
  });

  it('proposes escalate_branch_manager for damage_on_delivery', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'damage_on_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });
    expect(result.recoveryAction).toBe('escalate_branch_manager');
  });

  it('proposes branch_follow_up when POD is incomplete', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: incompletePod,
    });
    expect(result.recoveryAction).toBe('branch_follow_up');
    expect(result.evidenceStatus).toBe('ambiguous');
  });

  it('proposes branch_follow_up when there are open exceptions', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
      exceptions: [openException],
    });
    expect(result.recoveryAction).toBe('branch_follow_up');
  });

  it('resolved exceptions are excluded from open exception count', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
      exceptions: [resolvedException],
    });
    expect(result.recoveryAction).toBe('document_service_failure');
    expect(result.evidenceStatus).toBe('packaged');
  });
});

// ---------------------------------------------------------------------------
// Ambiguity escalation — fails closed on incomplete evidence
// ---------------------------------------------------------------------------

describe('buildDeliveryComplaintCase — ambiguity escalation', () => {
  it('escalates to dispatcher when stop evidence is missing', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: null,
      route: fullRoute,
    });

    expect(result.recoveryAction).toBe('escalate_dispatcher');
    expect(result.evidenceStatus).toBe('incomplete');
    expect(result.requiresHumanApproval).toBe(true);
  });

  it('escalates to dispatcher when route evidence is missing', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'missed_delivery',
      stop: fullStop,
      route: null,
    });

    expect(result.recoveryAction).toBe('escalate_dispatcher');
    expect(result.evidenceStatus).toBe('incomplete');
  });

  it('includes ambiguity uncertainty evidence item when stop is missing', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: null,
      route: fullRoute,
    });

    const uncertain = result.evidence.filter((e) => e.source === 'uncertainty');
    expect(uncertain.length).toBeGreaterThan(0);
    expect(uncertain.some((e) => /dispatcher must review/i.test(e.detail))).toBe(true);
  });

  it('marks evidence as ambiguous when POD is absent but stop + route are present', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: null,
    });

    expect(result.evidenceStatus).toBe('ambiguous');
    expect(result.recoveryAction).toBe('branch_follow_up');

    const podEvidence = result.evidence.find((e) => e.label === 'Proof-of-delivery evidence');
    expect(podEvidence?.detail).toMatch(/no proof-of-delivery bundle/i);
  });

  it('recommendation mentions human approval gate in all paths', () => {
    const packed = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
    });
    const ambiguous = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: incompletePod,
    });
    const incomplete = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: null,
      route: null,
    });

    // All three cases should gate on human approval
    expect(packed.requiresHumanApproval).toBe(true);
    expect(ambiguous.requiresHumanApproval).toBe(true);
    expect(incomplete.requiresHumanApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Open exception evidence threading
// ---------------------------------------------------------------------------

describe('buildDeliveryComplaintCase — exception evidence', () => {
  it('includes open exception details in evidence', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
      exceptions: [openException],
    });

    const excEvidence = result.evidence.find((e) => e.source === 'exception');
    expect(excEvidence).toBeDefined();
    expect(excEvidence?.detail).toContain('eta delay');
    expect(excEvidence?.label).toContain('1');
  });

  it('does not add exception evidence when all exceptions are resolved', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'late_delivery',
      stop: fullStop,
      route: fullRoute,
      pod: completePod,
      exceptions: [resolvedException],
    });

    const excEvidence = result.evidence.find((e) => e.source === 'exception');
    expect(excEvidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Asset / contract identifiers
// ---------------------------------------------------------------------------

describe('buildDeliveryComplaintCase — asset / contract evidence', () => {
  it('includes asset and contract line reference when present', () => {
    const result = buildDeliveryComplaintCase({
      complaintType: 'incorrect_delivery',
      stop: fullStop,
      route: fullRoute,
    });

    const assetEvidence = result.evidence.find((e) => e.label === 'Asset / contract reference');
    expect(assetEvidence).toBeDefined();
    expect(assetEvidence?.detail).toContain('asset-abc');
    expect(assetEvidence?.detail).toContain('line-uuid-001');
  });
});
