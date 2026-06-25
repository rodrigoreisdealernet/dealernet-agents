import { describe, expect, it } from 'vitest';
import {
  buildComplianceReadinessQueue,
  filterExceptions,
  COMPLIANCE_READINESS_TAGS,
} from './compliance-readiness-queue';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDriverQual(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'driver-001',
    person_name: 'Alice Smith',
    branch_id: 'branch-north',
    branch_name: 'North Yard',
    equipment_class: 'CDL Class A',
    qualification_type: 'Annual review',
    expiry_date: null,
    status: 'expired',
    cited_rule: '49 CFR 391',
    evidence_ref: 'DQ-2024-001',
    ...overrides,
  };
}

function makeHosException(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'driver-002',
    person_name: 'Bob Jones',
    branch_id: 'branch-south',
    branch_name: 'South Depot',
    equipment_class: 'CDL Class B',
    violation_type: '11-hour driving limit exceeded',
    violation_date: '2026-06-10',
    cited_rule: '49 CFR 395',
    evidence_ref: 'ELD-2026-0610',
    severity: 'critical',
    ...overrides,
  };
}

function makeOperatorCert(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'op-001',
    person_name: 'Carol White',
    branch_id: 'branch-east',
    branch_name: 'East Branch',
    equipment_class: 'Forklift',
    certification_type: 'OSHA forklift operator',
    expiry_date: null,
    status: 'expired',
    cited_rule: 'OSHA 29 CFR 1910.178',
    evidence_ref: 'CERT-OP-2024-015',
    ...overrides,
  };
}

function makeTrainingRecord(overrides: Record<string, unknown> = {}) {
  return {
    person_id: 'emp-001',
    person_name: 'Dave Brown',
    branch_id: 'branch-west',
    branch_name: 'West Branch',
    equipment_class: 'Crane',
    training_type: 'Annual rigging safety',
    due_date: null,
    status: 'overdue',
    cited_rule: 'Internal training policy',
    evidence_ref: 'LMS-2024-099',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildComplianceReadinessQueue — exception classification
// ---------------------------------------------------------------------------

describe('buildComplianceReadinessQueue', () => {
  it('returns noOp when all inputs are empty', () => {
    const result = buildComplianceReadinessQueue({});
    expect(result.noOp).toBe(true);
    expect(result.exceptions).toHaveLength(0);
    expect(result.tags).toEqual(COMPLIANCE_READINESS_TAGS);
    expect(result.summary).toEqual({ blocking: 0, follow_up: 0, reminder: 0 });
  });

  it('returns noOp when no records match exception windows', () => {
    // Cert with far future expiry — should not trigger
    const futureDateStr = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      today: '2026-06-19',
      operatorCerts: [
        makeOperatorCert({ status: 'active', expiry_date: futureDateStr }),
      ],
    });
    expect(result.noOp).toBe(true);
  });

  // ── DOT qualification exceptions ──────────────────────────────────────────

  it('classifies an expired DOT qualification as blocking with requiresHumanApproval', () => {
    const result = buildComplianceReadinessQueue({
      today: '2026-06-19',
      driverQualifications: [makeDriverQual({ status: 'expired' })],
    });
    expect(result.noOp).toBe(false);
    expect(result.exceptions).toHaveLength(1);
    const ex = result.exceptions[0];
    expect(ex.code).toBe('dot_qualification_expired');
    expect(ex.exceptionType).toBe('dot_qualification');
    expect(ex.recommendation).toBe('blocking');
    expect(ex.requiresHumanApproval).toBe(true);
    expect(ex.personName).toBe('Alice Smith');
    expect(ex.branchName).toBe('North Yard');
    expect(ex.equipmentClass).toBe('CDL Class A');
    expect(ex.citedRule).toBe('49 CFR 391');
    expect(ex.tags).toContain('safety-compliance-manager:t2');
  });

  it('classifies a DOT qualification expiring within 30 days as follow_up (not blocking)', () => {
    const expiryDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      driverQualifications: [
        makeDriverQual({ status: 'active', expiry_date: expiryDate }),
      ],
    });
    expect(result.exceptions).toHaveLength(1);
    const ex = result.exceptions[0];
    expect(ex.code).toBe('dot_qualification_expiring');
    expect(ex.recommendation).toBe('follow_up');
    expect(ex.requiresHumanApproval).toBe(false);
  });

  it('skips a DOT qualification with expiry beyond the 30-day window', () => {
    const futureDateStr = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      driverQualifications: [
        makeDriverQual({ status: 'active', expiry_date: futureDateStr }),
      ],
    });
    expect(result.exceptions).toHaveLength(0);
  });

  // ── HOS exceptions ────────────────────────────────────────────────────────

  it('classifies a critical HOS breach as blocking with requiresHumanApproval', () => {
    const result = buildComplianceReadinessQueue({
      today: '2026-06-19',
      hosExceptions: [makeHosException({ severity: 'critical' })],
    });
    const ex = result.exceptions[0];
    expect(ex.code).toBe('hos_breach');
    expect(ex.exceptionType).toBe('hos');
    expect(ex.recommendation).toBe('blocking');
    expect(ex.requiresHumanApproval).toBe(true);
    expect(ex.personName).toBe('Bob Jones');
    expect(ex.branchName).toBe('South Depot');
    expect(ex.citedRule).toBe('49 CFR 395');
    expect(ex.tags).toContain('safety-compliance-manager:t4');
  });

  it('classifies a non-critical HOS breach as follow_up without requiring human approval', () => {
    const result = buildComplianceReadinessQueue({
      hosExceptions: [makeHosException({ severity: 'warning' })],
    });
    const ex = result.exceptions[0];
    expect(ex.recommendation).toBe('follow_up');
    expect(ex.requiresHumanApproval).toBe(false);
  });

  // ── Operator certification exceptions ─────────────────────────────────────

  it('classifies an expired operator cert as blocking', () => {
    const result = buildComplianceReadinessQueue({
      today: '2026-06-19',
      operatorCerts: [makeOperatorCert({ status: 'expired' })],
    });
    const ex = result.exceptions[0];
    expect(ex.code).toBe('operator_cert_expired');
    expect(ex.exceptionType).toBe('operator_cert');
    expect(ex.recommendation).toBe('blocking');
    expect(ex.requiresHumanApproval).toBe(true);
    expect(ex.personName).toBe('Carol White');
    expect(ex.branchName).toBe('East Branch');
    expect(ex.equipmentClass).toBe('Forklift');
    expect(ex.tags).toContain('safety-compliance-manager:t4');
  });

  it('classifies a cert expiring within 30 days as follow_up', () => {
    const expiryDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      operatorCerts: [
        makeOperatorCert({ status: 'active', expiry_date: expiryDate }),
      ],
    });
    const ex = result.exceptions[0];
    expect(ex.code).toBe('operator_cert_expiring');
    expect(ex.recommendation).toBe('follow_up');
    expect(ex.requiresHumanApproval).toBe(false);
  });

  // ── Training exceptions ───────────────────────────────────────────────────

  it('classifies overdue training as follow_up and does not require human approval', () => {
    const result = buildComplianceReadinessQueue({
      today: '2026-06-19',
      trainingRecords: [makeTrainingRecord({ status: 'overdue' })],
    });
    const ex = result.exceptions[0];
    expect(ex.code).toBe('training_overdue');
    expect(ex.exceptionType).toBe('training');
    expect(ex.recommendation).toBe('follow_up');
    expect(ex.requiresHumanApproval).toBe(false);
    expect(ex.personName).toBe('Dave Brown');
    expect(ex.tags).toContain('safety-compliance-manager:t7');
  });

  it('classifies training due within 30 days as reminder', () => {
    const dueDate = new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      trainingRecords: [
        makeTrainingRecord({ status: 'scheduled', due_date: dueDate }),
      ],
    });
    const ex = result.exceptions[0];
    expect(ex.code).toBe('training_due_soon');
    expect(ex.recommendation).toBe('reminder');
    expect(ex.requiresHumanApproval).toBe(false);
  });

  it('skips training records due beyond 30 days', () => {
    const dueDate = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      trainingRecords: [
        makeTrainingRecord({ status: 'scheduled', due_date: dueDate }),
      ],
    });
    expect(result.exceptions).toHaveLength(0);
  });

  // ── Expiry-window boundary ────────────────────────────────────────────────

  it('treats exactly-30-days-out expiry as expiring (within window)', () => {
    const today = '2026-06-19';
    const expiryDate = new Date(new Date(today).getTime() + 30 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      today,
      operatorCerts: [makeOperatorCert({ status: 'active', expiry_date: expiryDate })],
    });
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].code).toBe('operator_cert_expiring');
  });

  // ── Sort order: blocking first ────────────────────────────────────────────

  it('sorts blocking exceptions before follow_up and reminder', () => {
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      driverQualifications: [makeDriverQual({ status: 'active', expiry_date: soon })], // follow_up
      hosExceptions: [makeHosException({ severity: 'critical' })], // blocking
      trainingRecords: [makeTrainingRecord({ status: 'overdue' })], // follow_up
    });
    expect(result.exceptions[0].recommendation).toBe('blocking');
  });

  // ── Evidence completeness ─────────────────────────────────────────────────

  it('attaches all required evidence fields to a DOT qualification exception', () => {
    const result = buildComplianceReadinessQueue({
      today: '2026-06-19',
      driverQualifications: [makeDriverQual()],
    });
    const ev = result.exceptions[0].evidence;
    const labels = ev.map((e) => e.label);
    expect(labels).toContain('Person');
    expect(labels).toContain('Branch');
    expect(labels).toContain('Qualification type');
    expect(labels).toContain('Equipment class');
    expect(labels).toContain('Cited rule');
    expect(labels).toContain('Evidence ref');
  });

  // ── Summary counts ────────────────────────────────────────────────────────

  it('reports accurate summary counts across mixed exception types', () => {
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const result = buildComplianceReadinessQueue({
      driverQualifications: [makeDriverQual({ status: 'expired' })], // blocking
      hosExceptions: [makeHosException({ severity: 'critical' })], // blocking
      operatorCerts: [makeOperatorCert({ status: 'active', expiry_date: soon })], // follow_up
      trainingRecords: [makeTrainingRecord({ status: 'overdue' })], // follow_up
    });
    expect(result.summary.blocking).toBe(2);
    expect(result.summary.follow_up).toBe(2);
    expect(result.summary.reminder).toBe(0);
  });

  // ── Graceful handling of missing/unknown person_id ────────────────────────

  it('skips rows with no person_id', () => {
    const result = buildComplianceReadinessQueue({
      driverQualifications: [makeDriverQual({ person_id: '' })],
    });
    expect(result.exceptions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterExceptions
// ---------------------------------------------------------------------------

describe('filterExceptions', () => {
  const baseExceptions = [
    {
      id: 'ex-1',
      code: 'dot_qualification_expired' as const,
      exceptionType: 'dot_qualification' as const,
      personId: 'p1',
      personName: 'Alice Smith',
      branchId: 'b1',
      branchName: 'North Yard',
      equipmentClass: 'CDL',
      dueDate: null,
      citedRule: '49 CFR 391',
      recommendation: 'blocking' as const,
      requiresHumanApproval: true,
      humanAction: 'Action needed.',
      evidence: [],
      tags: ['safety-compliance-manager:t2'] as const,
    },
    {
      id: 'ex-2',
      code: 'training_overdue' as const,
      exceptionType: 'training' as const,
      personId: 'p2',
      personName: 'Bob Jones',
      branchId: 'b2',
      branchName: 'South Depot',
      equipmentClass: 'Forklift',
      dueDate: null,
      citedRule: 'Policy',
      recommendation: 'follow_up' as const,
      requiresHumanApproval: false,
      humanAction: 'Schedule training.',
      evidence: [],
      tags: ['safety-compliance-manager:t7'] as const,
    },
  ];

  it('returns all exceptions when filters are all wildcard', () => {
    expect(filterExceptions(baseExceptions, {})).toHaveLength(2);
  });

  it('filters by exceptionType', () => {
    const result = filterExceptions(baseExceptions, { exceptionType: 'training' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ex-2');
  });

  it('filters by recommendation', () => {
    const result = filterExceptions(baseExceptions, { recommendation: 'blocking' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ex-1');
  });

  it('filters by person name (case-insensitive substring)', () => {
    const result = filterExceptions(baseExceptions, { person: 'alice' });
    expect(result).toHaveLength(1);
    expect(result[0].personName).toBe('Alice Smith');
  });

  it('filters by branchId', () => {
    const result = filterExceptions(baseExceptions, { branch: 'b2' });
    expect(result).toHaveLength(1);
    expect(result[0].branchId).toBe('b2');
  });

  it('returns empty array when no exceptions match combined filters', () => {
    const result = filterExceptions(baseExceptions, { exceptionType: 'hos', recommendation: 'blocking' });
    expect(result).toHaveLength(0);
  });

  it('ignores wildcard (%) as a no-op filter', () => {
    const result = filterExceptions(baseExceptions, { exceptionType: '%', recommendation: '%' });
    expect(result).toHaveLength(2);
  });
});
