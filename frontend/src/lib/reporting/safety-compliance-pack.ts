import type { DataSourceDefinition } from '@/engine/types';

export const SAFETY_COMPLIANCE_PACK_TAGS = [
  'safety-compliance-manager:t5',
  'safety-compliance-manager:t8',
] as const;

const OPEN_FINDING_STATUS = 'pending_approval';
export const INCIDENT_SOURCE_GAP_EXCEPTION =
  'Incident / OSHA rollup source is not connected yet — preserve the incident section as a draft and require human review before publishing.';
const FINDING_OVERDUE_DAYS = 14;
const CORRECTIVE_ACTION_OVERDUE_DAYS = 14;
const TRAINING_OR_CERTIFICATION_BLOCKER_CODES = new Set([
  'missing_labor_certification',
  'expired_labor_certification',
  'missing_labor_readiness_flag',
]);

export interface SafetyAuditFindingRow {
  id?: string | null;
  agent_key?: string | null;
  contract_id?: string | null;
  contract_label?: string | null;
  customer_name?: string | null;
  finding_type?: string | null;
  severity?: string | null;
  status?: string | null;
  evidence?: unknown;
  proposed_action?: string | null;
  created_at?: string | null;
}

export interface SafetyCorrectiveActionRow {
  relationship_id?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  asset_id?: string | null;
  asset_name?: string | null;
  assigned_at?: string | null;
  requirement_source?: string | null;
  requirements?: unknown;
  blocked?: boolean | null;
  blockers?: unknown;
  blocker_count?: number | null;
  readiness_state?: string | null;
  evaluated_at?: string | null;
}

export interface DriverBehaviorSummaryRow {
  total_routes?: number | null;
  missing_driver_count?: number | null;
  overdue_count?: number | null;
  eld_warning_count?: number | null;
  eld_violation_count?: number | null;
  stale_position_count?: number | null;
}

export interface DriverBehaviorExceptionRow {
  line_id?: string | null;
  assigned_driver?: string | null;
  assigned_truck?: string | null;
  asset_name?: string | null;
  branch_id?: string | null;
  driver_log_status?: string | null;
  eld_compliance_status?: string | null;
  updated_at?: string | null;
}

export interface SafetyAuditFindingItem {
  id: string;
  findingType: string;
  severity: string;
  status: string;
  scopeLabel: string;
  customerName: string | null;
  detectedAt: string | null;
  proposedAction: string | null;
  isOverdue: boolean;
  isRepeatFinding: boolean;
  evidenceGapReason: string | null;
  findingPath: string;
  auditPath: string | null;
}

export interface SafetyCorrectiveActionItem {
  id: string;
  projectName: string;
  assetName: string;
  assignedAt: string | null;
  blockerCount: number;
  blockerCodes: string[];
  blockerSummary: string[];
  readinessState: string;
  isOverdue: boolean;
  hasRepeatBlocker: boolean;
  evidenceGapReason: string | null;
  projectPath: string | null;
  assetPath: string | null;
}

export interface SafetyFocusArea {
  id: string;
  title: string;
  summary: string;
  sourceLinks: Array<{ label: string; href: string }>;
  requiresHumanDecision: true;
  decisionNote: string;
}

export interface SafetyLeadershipKpiPack {
  openAuditFindings: number;
  overdueFindings: number;
  repeatFindings: number;
  evidenceGapFindings: number;
  blockedCorrectiveActions: number;
  overdueCorrectiveActions: number;
  blockedTrainingOrCertificationItems: number;
  hosOutOfHoursCount: number;
  hosMissingLogCount: number;
  eldViolationCount: number;
  sourceExceptions: string[];
  focusAreas: SafetyFocusArea[];
}

export const SAFETY_COMPLIANCE_PACK_SOURCES: Record<string, DataSourceDefinition> = {
  audit_findings: {
    type: 'supabase',
    table: 'ops_findings_view',
    select:
      'id, agent_key, contract_id, contract_label, customer_name, finding_type, severity, status, evidence, proposed_action, created_at',
    filters: [{ field: 'agent_key', op: 'eq', value: 'fleet-auditor' }],
    order: [
      { column: 'created_at', ascending: false },
      { column: 'delta', ascending: false },
    ],
    limit: 25,
  },
  corrective_action_candidates: {
    type: 'supabase',
    table: 'v_project_equipment_readiness_current',
    select:
      'relationship_id, project_id, project_name, asset_id, asset_name, assigned_at, requirement_source, requirements, blocked, blockers, blocker_count, readiness_state, evaluated_at',
    order: [
      { column: 'assigned_at', ascending: true },
      { column: 'blocker_count', ascending: false },
    ],
    limit: 25,
  },
  driver_behavior_summary: {
    type: 'supabase',
    table: 'v_transport_efficiency_summary',
    select:
      'total_routes, missing_driver_count, overdue_count, eld_warning_count, eld_violation_count, stale_position_count',
    limit: 1,
  },
  driver_behavior_exceptions: {
    type: 'supabase',
    table: 'v_dispatch_route_live',
    select:
      'line_id, assigned_driver, assigned_truck, asset_name, branch_id, driver_log_status, eld_compliance_status, updated_at',
    filters: [
      { field: 'driver_log_status', op: 'in', value: ['out_of_hours', 'missing'] },
    ],
    order: [{ column: 'updated_at', ascending: false }],
    limit: 20,
  },
};

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? null : numeric;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function daysAgo(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return (now - timestamp) / (1000 * 60 * 60 * 24);
}

function parseEvidenceItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function blockerDetails(value: unknown): Array<{ code: string; reason: string }> {
  return asArray<unknown>(value).map((blocker) => {
    if (!isObject(blocker)) {
      return { code: 'unknown_blocker', reason: String(blocker ?? 'Unknown blocker') };
    }
    return {
      code: typeof blocker.code === 'string' && blocker.code ? blocker.code : 'unknown_blocker',
      reason:
        typeof blocker.reason === 'string' && blocker.reason
          ? blocker.reason
          : 'Blocker reason missing',
    };
  });
}

export function buildSafetyAuditFindings(rows: unknown, now = Date.now()): SafetyAuditFindingItem[] {
  const findings = asArray<SafetyAuditFindingRow>(rows);
  const repeatCounts = new Map<string, number>();

  for (const row of findings) {
    const key = `${row.contract_label || row.contract_id || 'unknown-scope'}::${row.finding_type || 'unknown-finding'}`;
    repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
  }

  return findings.map((row, index) => {
    const repeatKey = `${row.contract_label || row.contract_id || 'unknown-scope'}::${row.finding_type || 'unknown-finding'}`;
    const evidenceItems = parseEvidenceItems(row.evidence);
    const evidenceGapReason =
      evidenceItems.length === 0 ? 'evidence checklist missing or empty' : null;
    const overdueDays = daysAgo(row.created_at, now);
    const isOverdue =
      row.status === OPEN_FINDING_STATUS &&
      overdueDays !== null &&
      overdueDays >= FINDING_OVERDUE_DAYS;

    return {
      id: row.id || `audit-finding-${index}`,
      findingType: row.finding_type || 'Audit finding',
      severity: row.severity || 'unknown',
      status: row.status || 'unknown',
      scopeLabel: row.contract_label || row.contract_id || 'Unscoped audit finding',
      customerName: row.customer_name || null,
      detectedAt: row.created_at || null,
      proposedAction: row.proposed_action || null,
      isOverdue,
      isRepeatFinding: (repeatCounts.get(repeatKey) || 0) > 1,
      evidenceGapReason,
      findingPath: `/ops/findings/${encodeURIComponent(row.id || `audit-finding-${index}`)}`,
      auditPath: row.contract_id ? `/ops/audit/${encodeURIComponent(row.contract_id)}` : null,
    };
  });
}

export function buildSafetyCorrectiveActions(
  rows: unknown,
  now = Date.now(),
): SafetyCorrectiveActionItem[] {
  const actionableRows = asArray<SafetyCorrectiveActionRow>(rows).filter(
    (row) => row.blocked || row.readiness_state === 'blocked',
  );
  const blockerCounts = new Map<string, number>();

  for (const row of actionableRows) {
    for (const blocker of blockerDetails(row.blockers)) {
      blockerCounts.set(blocker.code, (blockerCounts.get(blocker.code) || 0) + 1);
    }
  }

  return actionableRows.map((row, index) => {
    const blockers = blockerDetails(row.blockers);
    const overdueDays = daysAgo(row.assigned_at, now);
    const repeatBlocker = blockers.some((blocker) => (blockerCounts.get(blocker.code) || 0) > 1);
    const hasRequirementObject = isObject(row.requirements);
    let evidenceGapReason: string | null = null;
    if (!hasRequirementObject) {
      evidenceGapReason = 'training/certification requirement payload missing';
    } else if (blockers.length === 0) {
      evidenceGapReason = 'blocked corrective action is missing blocker detail';
    } else if (!row.evaluated_at) {
      evidenceGapReason = 'corrective action freshness timestamp missing';
    }

    return {
      id: row.relationship_id || `corrective-action-${index}`,
      projectName: row.project_name || 'Unknown project',
      assetName: row.asset_name || row.asset_id || 'Unknown asset',
      assignedAt: row.assigned_at || null,
      blockerCount: asNumber(row.blocker_count) || blockers.length,
      blockerCodes: blockers.map((blocker) => blocker.code),
      blockerSummary: blockers.map((blocker) => blocker.reason),
      readinessState: row.readiness_state || (row.blocked ? 'blocked' : 'unknown'),
      isOverdue:
        (row.blocked || row.readiness_state === 'blocked') &&
        overdueDays !== null && overdueDays >= CORRECTIVE_ACTION_OVERDUE_DAYS,
      hasRepeatBlocker: repeatBlocker,
      evidenceGapReason,
      projectPath: row.project_id ? `/entities/project/${encodeURIComponent(row.project_id)}` : null,
      assetPath: row.asset_id ? `/entities/asset/${encodeURIComponent(row.asset_id)}` : null,
    };
  });
}

function trainingOrCertificationBlockerCount(actions: SafetyCorrectiveActionItem[]): number {
  return actions.filter((action) =>
    action.blockerCodes.some((code) =>
      TRAINING_OR_CERTIFICATION_BLOCKER_CODES.has(code),
    ),
  ).length;
}

export function buildSafetyLeadershipKpiPack(
  auditFindingRows: unknown,
  correctiveActionRows: unknown,
  driverBehaviorSummaryRows: unknown,
  driverBehaviorExceptionRows: unknown,
  now = Date.now(),
): SafetyLeadershipKpiPack {
  const findings = buildSafetyAuditFindings(auditFindingRows, now);
  const correctiveActions = buildSafetyCorrectiveActions(correctiveActionRows, now);
  const driverBehaviorSummary = asArray<DriverBehaviorSummaryRow>(driverBehaviorSummaryRows)[0] || {};
  const driverBehaviorExceptions = asArray<DriverBehaviorExceptionRow>(driverBehaviorExceptionRows);

  const hosOutOfHoursCount = driverBehaviorExceptions.filter(
    (row) => row.driver_log_status === 'out_of_hours',
  ).length;
  const hosMissingLogCount = driverBehaviorExceptions.filter(
    (row) => row.driver_log_status === 'missing',
  ).length;
  const eldViolationCount =
    asNumber(driverBehaviorSummary.eld_violation_count) ??
    driverBehaviorExceptions.filter((row) => row.eld_compliance_status === 'violation').length;

  const sourceExceptions: string[] = [
    INCIDENT_SOURCE_GAP_EXCEPTION,
  ];

  if (findings.length === 0) {
    sourceExceptions.push('Audit findings source returned no rows — verify the audit feed is current.');
  }
  if (correctiveActions.length === 0) {
    sourceExceptions.push('Corrective action source returned no blocked rows — confirm whether readiness blockers have been resolved or the source is stale.');
  }
  if (asArray<DriverBehaviorSummaryRow>(driverBehaviorSummaryRows).length === 0) {
    sourceExceptions.push('Driver-behavior summary source returned no rows — HOS and ELD totals may be incomplete.');
  }
  if (driverBehaviorExceptions.some((row) => !row.updated_at)) {
    sourceExceptions.push('At least one driver-behavior exception is missing a freshness timestamp.');
  }

  const focusAreas: SafetyFocusArea[] = [];
  const overdueFindings = findings.filter((finding) => finding.isOverdue);
  const repeatFindings = findings.filter((finding) => finding.isRepeatFinding);
  const overdueCorrectiveActions = correctiveActions.filter((action) => action.isOverdue);

  if (overdueFindings.length > 0) {
    focusAreas.push({
      id: 'audit-overdue-findings',
      title: 'Escalate overdue audit findings for review',
      summary: `${overdueFindings.length} audit finding${overdueFindings.length === 1 ? '' : 's'} have been open longer than ${FINDING_OVERDUE_DAYS} days.`,
      sourceLinks: overdueFindings.slice(0, 3).map((finding) => ({
        label: `${finding.scopeLabel} — ${finding.findingType}`,
        href: finding.findingPath,
      })),
      requiresHumanDecision: true,
      decisionNote:
        'Escalation severity and final finding disposition remain explicit human decisions.',
    });
  }

  if (overdueCorrectiveActions.length > 0 || repeatFindings.length > 0) {
    focusAreas.push({
      id: 'repeat-gap-follow-up',
      title: 'Prioritize repeat gaps and overdue corrective actions',
      summary: `${repeatFindings.length} repeat finding${repeatFindings.length === 1 ? '' : 's'} and ${overdueCorrectiveActions.length} overdue corrective action${overdueCorrectiveActions.length === 1 ? '' : 's'} need manager follow-up.`,
      sourceLinks: [
        ...repeatFindings.slice(0, 2).map((finding) => ({
          label: `${finding.scopeLabel} repeat finding`,
          href: finding.findingPath,
        })),
        ...overdueCorrectiveActions.slice(0, 2).flatMap((action) =>
          action.projectPath
            ? [{ label: `${action.projectName} corrective action`, href: action.projectPath }]
            : [],
        ),
      ],
      requiresHumanDecision: true,
      decisionNote:
        'Corrective-action closure and repeat-gap escalation stay human-approved.',
    });
  }

  if (hosOutOfHoursCount > 0 || eldViolationCount > 0 || hosMissingLogCount > 0) {
    focusAreas.push({
      id: 'driver-behavior-review',
      title: 'Review HOS and driver-behavior exceptions before branch escalation',
      summary: `${hosOutOfHoursCount} out-of-hours log${hosOutOfHoursCount === 1 ? '' : 's'}, ${hosMissingLogCount} missing log${hosMissingLogCount === 1 ? '' : 's'}, and ${eldViolationCount} ELD violation${eldViolationCount === 1 ? '' : 's'} are in scope.`,
      sourceLinks: driverBehaviorExceptions.slice(0, 3).flatMap((row) =>
        row.line_id
          ? [
              {
                label: `${row.asset_name || row.line_id} driver-behavior case`,
                href: `/entities/rental_contract_line/${encodeURIComponent(row.line_id)}`,
              },
            ]
          : [],
      ),
      requiresHumanDecision: true,
      decisionNote:
        'Driver or branch escalation severity remains a human judgment call.',
    });
  }

  return {
    openAuditFindings: findings.filter((finding) => finding.status === OPEN_FINDING_STATUS).length,
    overdueFindings: overdueFindings.length,
    repeatFindings: repeatFindings.length,
    evidenceGapFindings: findings.filter((finding) => finding.evidenceGapReason).length,
    blockedCorrectiveActions: correctiveActions.length,
    overdueCorrectiveActions: overdueCorrectiveActions.length,
    blockedTrainingOrCertificationItems: trainingOrCertificationBlockerCount(correctiveActions),
    hosOutOfHoursCount,
    hosMissingLogCount,
    eldViolationCount,
    sourceExceptions,
    focusAreas,
  };
}
