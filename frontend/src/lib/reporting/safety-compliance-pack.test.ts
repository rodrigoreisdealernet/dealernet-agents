import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSafetyAuditFindings,
  buildSafetyCorrectiveActions,
  buildSafetyLeadershipKpiPack,
} from './safety-compliance-pack';

describe('safety compliance pack helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects overdue, repeat, and evidence-gap audit findings', () => {
    const findings = buildSafetyAuditFindings([
      {
        id: 'finding-1',
        contract_id: 'contract-1',
        contract_label: 'North Branch Audit',
        finding_type: 'missing_guardrail',
        severity: 'high',
        status: 'pending_approval',
        evidence: [{ id: 'ev-1' }],
        created_at: '2026-05-20T12:00:00Z',
      },
      {
        id: 'finding-2',
        contract_id: 'contract-1',
        contract_label: 'North Branch Audit',
        finding_type: 'missing_guardrail',
        severity: 'medium',
        status: 'pending_approval',
        evidence: [],
        created_at: '2026-06-10T12:00:00Z',
      },
      {
        id: 'finding-3',
        contract_id: 'contract-2',
        contract_label: 'South Branch Audit',
        finding_type: 'late_toolbox_talk',
        severity: 'low',
        status: 'approved',
        evidence: [{ id: 'ev-2' }],
        created_at: '2026-05-01T12:00:00Z',
      },
    ]);

    expect(findings[0]).toMatchObject({
      isOverdue: true,
      isRepeatFinding: true,
      evidenceGapReason: null,
      auditPath: '/ops/audit/contract-1',
    });
    expect(findings[1]).toMatchObject({
      isOverdue: false,
      isRepeatFinding: true,
      evidenceGapReason: 'evidence checklist missing or empty',
    });
    expect(findings[2].isOverdue).toBe(false);
  });

  it('detects overdue and repeated corrective-action blockers with source gaps', () => {
    const actions = buildSafetyCorrectiveActions([
      {
        relationship_id: 'rel-1',
        project_id: 'project-1',
        project_name: 'Forklift refresher rollout',
        asset_id: 'asset-1',
        asset_name: 'Forklift 1',
        assigned_at: '2026-05-20T10:00:00Z',
        blocked: true,
        blockers: [
          {
            code: 'missing_labor_certification',
            reason: 'Labor certification forklift_level_2 is required.',
          },
        ],
        blocker_count: 1,
        readiness_state: 'blocked',
        requirements: { labor_certifications: ['forklift_level_2'] },
        evaluated_at: '2026-06-18T08:00:00Z',
      },
      {
        relationship_id: 'rel-2',
        project_id: 'project-2',
        project_name: 'Forklift refresher rollout - East',
        asset_id: 'asset-2',
        asset_name: 'Forklift 2',
        assigned_at: '2026-06-10T10:00:00Z',
        blocked: true,
        blockers: [
          {
            code: 'missing_labor_certification',
            reason: 'Labor certification forklift_level_2 is required.',
          },
        ],
        blocker_count: 1,
        readiness_state: 'blocked',
        requirements: { labor_certifications: ['forklift_level_2'] },
        evaluated_at: '2026-06-18T08:00:00Z',
      },
      {
        relationship_id: 'rel-3',
        project_id: null,
        project_name: 'Incomplete source',
        asset_id: null,
        asset_name: null,
        assigned_at: '2026-05-25T10:00:00Z',
        blocked: true,
        blockers: [],
        blocker_count: 0,
        readiness_state: 'blocked',
        requirements: null,
        evaluated_at: null,
      },
    ]);

    expect(actions[0]).toMatchObject({
      isOverdue: true,
      hasRepeatBlocker: true,
      evidenceGapReason: null,
      projectPath: '/entities/project/project-1',
      assetPath: '/entities/asset/asset-1',
    });
    expect(actions[1].hasRepeatBlocker).toBe(true);
    expect(actions[2].evidenceGapReason).toBe('training/certification requirement payload missing');
  });

  it('builds KPI rollups, source-gap handling, and approval-gated focus areas', () => {
    const pack = buildSafetyLeadershipKpiPack(
      [
        {
          id: 'finding-1',
          contract_id: 'contract-1',
          contract_label: 'North Branch Audit',
          finding_type: 'missing_guardrail',
          status: 'pending_approval',
          evidence: [],
          created_at: '2026-05-20T12:00:00Z',
        },
        {
          id: 'finding-2',
          contract_id: 'contract-1',
          contract_label: 'North Branch Audit',
          finding_type: 'missing_guardrail',
          status: 'pending_approval',
          evidence: [{ id: 'ev-2' }],
          created_at: '2026-06-10T12:00:00Z',
        },
      ],
      [
        {
          relationship_id: 'rel-1',
          project_id: 'project-1',
          project_name: 'Forklift refresher rollout',
          asset_id: 'asset-1',
          asset_name: 'Forklift 1',
          assigned_at: '2026-05-20T10:00:00Z',
          blocked: true,
          blockers: [
            {
              code: 'missing_labor_certification',
              reason: 'Labor certification forklift_level_2 is required.',
            },
          ],
          blocker_count: 1,
          readiness_state: 'blocked',
          requirements: { labor_certifications: ['forklift_level_2'] },
          evaluated_at: '2026-06-18T08:00:00Z',
        },
      ],
      [
        {
          total_routes: 12,
          eld_violation_count: 2,
        },
      ],
      [
        {
          line_id: 'line-1',
          asset_name: 'Truck 1',
          driver_log_status: 'out_of_hours',
          eld_compliance_status: 'violation',
          updated_at: '2026-06-19T08:00:00Z',
        },
        {
          line_id: 'line-2',
          asset_name: 'Truck 2',
          driver_log_status: 'missing',
          eld_compliance_status: 'warning',
          updated_at: null,
        },
      ],
    );

    expect(pack).toMatchObject({
      openAuditFindings: 2,
      overdueFindings: 1,
      repeatFindings: 2,
      evidenceGapFindings: 1,
      blockedCorrectiveActions: 1,
      overdueCorrectiveActions: 1,
      blockedTrainingOrCertificationItems: 1,
      hosOutOfHoursCount: 1,
      hosMissingLogCount: 1,
      eldViolationCount: 2,
    });
    expect(pack.sourceExceptions).toContain(
      'Incident / OSHA rollup source is not connected yet — preserve the incident section as a draft and require human review before publishing.',
    );
    expect(pack.sourceExceptions).toContain(
      'At least one driver-behavior exception is missing a freshness timestamp.',
    );
    expect(pack.focusAreas.length).toBeGreaterThanOrEqual(3);
    expect(pack.focusAreas.every((focusArea) => focusArea.requiresHumanDecision)).toBe(true);
    expect(pack.focusAreas[0].sourceLinks.length).toBeGreaterThan(0);
  });
});
