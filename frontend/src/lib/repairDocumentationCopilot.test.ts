import { describe, expect, it } from 'vitest';
import {
  buildRepairDocumentationPacket,
  REPAIR_COPILOT_TAGS,
  type WorkOrderSignal,
  type ServiceHistoryRecord,
} from './repairDocumentationCopilot';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workOrder: WorkOrderSignal = {
  maintenanceRecordId: 'wo-uuid-001',
  name: 'WO-2026-001 — Hydraulic leak repair',
  maintenanceType: 'corrective',
  workOrderStatus: 'in_progress',
  assetId: 'asset-uuid-001',
  technicianId: 'tech-uuid-001',
  openedAt: '2026-06-19T08:00:00Z',
};

const priorFaultInspection: ServiceHistoryRecord = {
  serviceRecordId: 'insp-uuid-001',
  serviceRecordType: 'inspection',
  serviceName: 'Return inspection — check-in',
  serviceType: 'check_in',
  outcome: 'fail',
  status: 'fail',
  openedAt: '2026-06-10T09:00:00Z',
  completedAt: '2026-06-10T09:15:00Z',
  serviceSortAt: '2026-06-10T09:15:00Z',
};

const priorFaultMaintenance: ServiceHistoryRecord = {
  serviceRecordId: 'wo-uuid-prev',
  serviceRecordType: 'maintenance',
  serviceName: 'WO-2026-000 — Hydraulic hose replacement',
  serviceType: 'corrective',
  outcome: 'open',
  status: 'open',
  openedAt: '2026-05-15T08:00:00Z',
  completedAt: null,
  downtimeMinutes: 240,
  serviceSortAt: '2026-05-15T08:00:00Z',
};

const completedMaintenance: ServiceHistoryRecord = {
  serviceRecordId: 'wo-uuid-old',
  serviceRecordType: 'maintenance',
  serviceName: 'WO-2026-PM01 — 250-hour PM',
  serviceType: 'preventive',
  outcome: 'completed',
  status: 'completed',
  openedAt: '2026-04-01T08:00:00Z',
  completedAt: '2026-04-01T16:00:00Z',
  downtimeMinutes: 180,
  costSummary: 'parts: $220, labor: $150',
  serviceSortAt: '2026-04-01T16:00:00Z',
};

// ---------------------------------------------------------------------------
// Operating-model tags
// ---------------------------------------------------------------------------

describe('REPAIR_COPILOT_TAGS', () => {
  it('includes all expected service-technician operating-model tags', () => {
    expect(REPAIR_COPILOT_TAGS).toContain('service-technician:t3');
    expect(REPAIR_COPILOT_TAGS).toContain('service-technician:t4');
    expect(REPAIR_COPILOT_TAGS).toContain('service-technician:t7');
  });
});

// ---------------------------------------------------------------------------
// History assembly
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — history assembly', () => {
  it('sets assetId and workOrderId from the work order signal', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [],
    });

    expect(result.assetId).toBe('asset-uuid-001');
    expect(result.workOrderId).toBe('wo-uuid-001');
    expect(result.workOrderName).toBe('WO-2026-001 — Hydraulic leak repair');
    expect(result.maintenanceType).toBe('corrective');
  });

  it('assembles prior faults from failed inspections and open maintenance records', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [priorFaultInspection, priorFaultMaintenance, completedMaintenance],
    });

    expect(result.priorFaults).toHaveLength(2);
    const ids = result.priorFaults.map((f) => f.serviceRecordId);
    expect(ids).toContain('insp-uuid-001');
    expect(ids).toContain('wo-uuid-prev');
  });

  it('excludes completed/passing records from prior faults', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance],
    });

    expect(result.priorFaults).toHaveLength(0);
  });

  it('records fault source as inspection or maintenance correctly', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [priorFaultInspection, priorFaultMaintenance],
    });

    const inspFault = result.priorFaults.find((f) => f.serviceRecordId === 'insp-uuid-001');
    const maintFault = result.priorFaults.find((f) => f.serviceRecordId === 'wo-uuid-prev');

    expect(inspFault?.source).toBe('inspection');
    expect(maintFault?.source).toBe('maintenance');
  });

  it('computes service history summary totals correctly', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [priorFaultMaintenance, completedMaintenance, priorFaultInspection],
    });

    expect(result.serviceHistorySummary.totalEvents).toBe(3);
    // Only records within last 90 days with fault outcome are counted as recent faults
    expect(result.serviceHistorySummary.recentFaultCount).toBeGreaterThan(0);
    // Total downtime minutes from maintenance records
    expect(result.serviceHistorySummary.totalDowntimeMinutes).toBeGreaterThanOrEqual(240);
  });

  it('sets lastServiceAt to the most recent service record', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance, priorFaultInspection, priorFaultMaintenance],
    });

    // priorFaultInspection serviceSortAt is 2026-06-10 — most recent
    expect(result.serviceHistorySummary.lastServiceAt).toContain('2026-06-10');
  });

  it('handles empty service history gracefully', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [],
    });

    expect(result.priorFaults).toHaveLength(0);
    expect(result.serviceHistorySummary.totalEvents).toBe(0);
    expect(result.serviceHistorySummary.lastServiceAt).toBeNull();
  });

  it('handles undefined service history gracefully', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    expect(result.priorFaults).toHaveLength(0);
    expect(result.serviceHistorySummary.totalEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structured documentation prompts
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — documentation prompts', () => {
  it('returns prompts for fault_description, repair_action, and labor_hours as required fields', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    const requiredFields = result.documentationPrompts
      .filter((p) => p.required)
      .map((p) => p.field);

    expect(requiredFields).toContain('fault_description');
    expect(requiredFields).toContain('repair_action');
    expect(requiredFields).toContain('labor_hours');
  });

  it('includes escalation_reason and escalation_notes prompts for human selection', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    const fields = result.documentationPrompts.map((p) => p.field);
    expect(fields).toContain('escalation_reason');
    expect(fields).toContain('escalation_notes');
  });

  it('promotes parts_used to required on field-service path', () => {
    const fieldResult = buildRepairDocumentationPacket({
      workOrder,
      servicePath: 'field',
    });

    const partsPrompt = fieldResult.documentationPrompts.find((p) => p.field === 'parts_used');
    expect(partsPrompt?.required).toBe(true);
  });

  it('keeps parts_used optional on shop-service path', () => {
    const shopResult = buildRepairDocumentationPacket({
      workOrder,
      servicePath: 'shop',
    });

    const partsPrompt = shopResult.documentationPrompts.find((p) => p.field === 'parts_used');
    expect(partsPrompt?.required).toBe(false);
  });

  it('field and shop paths contain the same set of prompt field names', () => {
    const fieldFields = buildRepairDocumentationPacket({ workOrder, servicePath: 'field' })
      .documentationPrompts.map((p) => p.field)
      .sort();

    const shopFields = buildRepairDocumentationPacket({ workOrder, servicePath: 'shop' })
      .documentationPrompts.map((p) => p.field)
      .sort();

    expect(fieldFields).toEqual(shopFields);
  });
});

// ---------------------------------------------------------------------------
// Escalation options — first-class outcome
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — escalation options', () => {
  it('includes escalation options covering all first-class reasons', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    const reasons = result.escalationOptions.map((o) => o.reason);
    expect(reasons).toContain('none');
    expect(reasons).toContain('exceeds_branch_skill');
    expect(reasons).toContain('exceeds_authorization_limit');
    expect(reasons).toContain('exceeds_time_available');
    expect(reasons).toContain('parts_unavailable');
    expect(reasons).toContain('safety_concern');
    expect(reasons).toContain('oem_specialist_required');
  });

  it('includes human-readable labels and descriptions for all escalation options', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    for (const option of result.escalationOptions) {
      expect(typeof option.label).toBe('string');
      expect(option.label.length).toBeGreaterThan(0);
      expect(typeof option.description).toBe('string');
      expect(option.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Human disposition gate
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — human disposition gate', () => {
  it('always sets requiresHumanDisposition to true regardless of evidence completeness', () => {
    const fullResult = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance],
    });
    const emptyResult = buildRepairDocumentationPacket({ workOrder });
    const noWOResult = buildRepairDocumentationPacket({
      workOrder: null,
    });

    expect(fullResult.requiresHumanDisposition).toBe(true);
    expect(emptyResult.requiresHumanDisposition).toBe(true);
    expect(noWOResult.requiresHumanDisposition).toBe(true);
  });

  it('recommendation always mentions that the technician must confirm findings', () => {
    const withHistory = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance],
    });
    const withoutHistory = buildRepairDocumentationPacket({ workOrder });

    expect(withHistory.recommendation.toLowerCase()).toMatch(/technician must confirm/);
    expect(withoutHistory.recommendation.toLowerCase()).toMatch(/human technician must confirm/);
  });
});

// ---------------------------------------------------------------------------
// Evidence status
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — evidence status', () => {
  it('returns complete evidence status when work order and history are present', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance],
    });

    expect(result.evidenceStatus).toBe('complete');
  });

  it('returns partial evidence status when work order is present but history is empty', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [],
    });

    expect(result.evidenceStatus).toBe('partial');
  });

  it('returns missing evidence status when work order is absent', () => {
    const result = buildRepairDocumentationPacket({
      workOrder: null,
      serviceHistory: [completedMaintenance],
    });

    expect(result.evidenceStatus).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// Packet key deduplication
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — deduplication', () => {
  it('produces the same packetKey for repeated calls with the same work order id', () => {
    const first = buildRepairDocumentationPacket({ workOrder });
    const second = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance],
    });

    expect(first.packetKey).toBe(second.packetKey);
    expect(first.packetKey).toBe('repair-doc::wo-uuid-001');
  });

  it('produces a unique packetKey when work order is absent', () => {
    const first = buildRepairDocumentationPacket({ workOrder: null });
    const second = buildRepairDocumentationPacket({ workOrder: null });

    // Both should be unique anon keys
    expect(first.packetKey).toMatch(/^repair-doc::anon-/);
    expect(second.packetKey).toMatch(/^repair-doc::anon-/);
    expect(first.packetKey).not.toBe(second.packetKey);
  });
});

// ---------------------------------------------------------------------------
// Service-path parity
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — field/shop path parity', () => {
  it('defaults to shop service path when not specified', () => {
    const result = buildRepairDocumentationPacket({ workOrder });
    expect(result.servicePath).toBe('shop');
  });

  it('respects explicit field service path', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      servicePath: 'field',
    });
    expect(result.servicePath).toBe('field');
  });

  it('field service recommendation mentions field-service path documentation requirements', () => {
    const result = buildRepairDocumentationPacket({
      workOrder,
      serviceHistory: [completedMaintenance],
      servicePath: 'field',
    });

    expect(result.recommendation.toLowerCase()).toContain('field-service path');
  });
});

// ---------------------------------------------------------------------------
// Required-field validation — documentation prompt contract
// ---------------------------------------------------------------------------

describe('buildRepairDocumentationPacket — required-field validation contract', () => {
  it('all required prompts have non-empty hint text', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    const requiredPrompts = result.documentationPrompts.filter((p) => p.required);
    for (const prompt of requiredPrompts) {
      expect(prompt.hint.length).toBeGreaterThan(0);
    }
  });

  it('all prompts have unique field names', () => {
    const result = buildRepairDocumentationPacket({ workOrder });

    const fields = result.documentationPrompts.map((p) => p.field);
    const unique = new Set(fields);
    expect(unique.size).toBe(fields.length);
  });
});
