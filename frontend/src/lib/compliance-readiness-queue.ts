/**
 * Compliance Readiness Queue — business logic
 *
 * Classifies driver and operator compliance exceptions from raw qualification,
 * HOS, certification, training, and branch-assignment records. Distinguishes
 * reminder / follow-up recommendations from blocking or disqualifying ones.
 * Any blocking or status-changing action is flagged as requiring explicit
 * human approval; no mutations are performed here.
 *
 * Operating-model tags:
 *   safety-compliance-manager:t2  (DOT qualification oversight)
 *   safety-compliance-manager:t4  (HOS / operator certification tracking)
 *   safety-compliance-manager:t7  (training currency / recertification)
 */

export const COMPLIANCE_READINESS_TAGS = [
  'safety-compliance-manager:t2',
  'safety-compliance-manager:t4',
  'safety-compliance-manager:t7',
] as const;

type ComplianceTag = (typeof COMPLIANCE_READINESS_TAGS)[number];

/** How urgent/severe the recommended action is. */
export type RecommendationType = 'reminder' | 'follow_up' | 'blocking';

/** Canonical exception codes used by the classification engine. */
export type ExceptionCode =
  | 'dot_qualification_expired'
  | 'dot_qualification_expiring'
  | 'hos_breach'
  | 'operator_cert_expired'
  | 'operator_cert_expiring'
  | 'training_overdue'
  | 'training_due_soon';

export interface ComplianceEvidence {
  label: string;
  value: string;
}

export interface ComplianceReadinessException {
  id: string;
  code: ExceptionCode;
  /** Human-readable label for the exception type, suitable for filter chips. */
  exceptionType: 'dot_qualification' | 'hos' | 'operator_cert' | 'training';
  personId: string;
  personName: string;
  branchId: string;
  branchName: string;
  equipmentClass: string;
  /** ISO-8601 date string of the relevant due / expiry / breach date. */
  dueDate: string | null;
  /** Regulatory rule or internal policy citation. */
  citedRule: string;
  recommendation: RecommendationType;
  /**
   * True for blocking and disqualifying recommendations — the human must
   * explicitly approve any status-changing or dispatch-blocking action.
   */
  requiresHumanApproval: boolean;
  /** Prose describing the required human action. */
  humanAction: string;
  /** Supporting facts retained for drill-down context. */
  evidence: ComplianceEvidence[];
  tags: readonly ComplianceTag[];
}

export interface ComplianceReadinessResult {
  exceptions: ComplianceReadinessException[];
  /** True when there are no materially new compliance signals. */
  noOp: boolean;
  tags: readonly string[];
  /** Counts by recommendation type for header summary. */
  summary: {
    blocking: number;
    follow_up: number;
    reminder: number;
  };
}

// ---------------------------------------------------------------------------
// Raw input row types — the caller fetches rows; this module only classifies.
// ---------------------------------------------------------------------------

export interface DriverQualificationRow {
  person_id?: unknown;
  person_name?: unknown;
  branch_id?: unknown;
  branch_name?: unknown;
  equipment_class?: unknown;
  qualification_type?: unknown;
  expiry_date?: unknown;
  status?: unknown;
  cited_rule?: unknown;
  evidence_ref?: unknown;
}

export interface HosExceptionRow {
  person_id?: unknown;
  person_name?: unknown;
  branch_id?: unknown;
  branch_name?: unknown;
  equipment_class?: unknown;
  violation_type?: unknown;
  violation_date?: unknown;
  cited_rule?: unknown;
  evidence_ref?: unknown;
  severity?: unknown;
}

export interface OperatorCertRow {
  person_id?: unknown;
  person_name?: unknown;
  branch_id?: unknown;
  branch_name?: unknown;
  equipment_class?: unknown;
  certification_type?: unknown;
  expiry_date?: unknown;
  status?: unknown;
  cited_rule?: unknown;
  evidence_ref?: unknown;
}

export interface TrainingRow {
  person_id?: unknown;
  person_name?: unknown;
  branch_id?: unknown;
  branch_name?: unknown;
  equipment_class?: unknown;
  training_type?: unknown;
  due_date?: unknown;
  status?: unknown;
  cited_rule?: unknown;
  evidence_ref?: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type LooseRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function asRecord(value: unknown): LooseRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseDate(value: unknown): Date | null {
  const s = asString(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysUntil(date: Date, today: Date): number {
  const ms = date.getTime() - today.getTime();
  return Math.ceil(ms / (1_000 * 60 * 60 * 24));
}

function formatDate(value: unknown): string {
  const d = parseDate(value);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown';
}

const EXPIRY_WARNING_DAYS = 30;
const TRAINING_WARNING_DAYS = 30;

function exceptionId(code: ExceptionCode, personId: string, suffix?: string): string {
  return `compliance-${code}-${personId}${suffix ? `-${suffix}` : ''}`;
}

// ---------------------------------------------------------------------------
// DOT qualification exception builders
// ---------------------------------------------------------------------------

function buildDotQualificationExceptions(
  rows: DriverQualificationRow[],
  today: Date,
): ComplianceReadinessException[] {
  const exceptions: ComplianceReadinessException[] = [];

  for (const row of rows) {
    const personId = asString(row.person_id);
    if (!personId) continue;

    const personName = asString(row.person_name) || `Driver ${personId.slice(-6).toUpperCase()}`;
    const branchId = asString(row.branch_id);
    const branchName = asString(row.branch_name) || branchId || 'Unknown branch';
    const equipmentClass = asString(row.equipment_class) || 'CDL fleet';
    const qualType = asString(row.qualification_type) || 'DOT qualification file';
    const expiryDate = parseDate(row.expiry_date);
    const status = asString(row.status).toLowerCase();
    const citedRule = asString(row.cited_rule) || '49 CFR 391 — Driver Qualification Files';
    const evidenceRef = asString(row.evidence_ref);

    const expired = status === 'expired' || (expiryDate !== null && daysUntil(expiryDate, today) < 0);
    const expiringSoon = !expired && expiryDate !== null && daysUntil(expiryDate, today) <= EXPIRY_WARNING_DAYS;

    if (!expired && !expiringSoon) continue;

    const code: ExceptionCode = expired ? 'dot_qualification_expired' : 'dot_qualification_expiring';
    const recommendation: RecommendationType = expired ? 'blocking' : 'follow_up';
    const dueDate = expiryDate ? expiryDate.toISOString().slice(0, 10) : null;

    const evidence: ComplianceEvidence[] = [
      { label: 'Person', value: personName },
      { label: 'Branch', value: branchName },
      { label: 'Qualification type', value: qualType },
      { label: 'Equipment class', value: equipmentClass },
      { label: 'Expiry date', value: formatDate(row.expiry_date) },
      { label: 'Status', value: expired ? 'Expired — dispatch blocked' : `Expiring in ${daysUntil(expiryDate!, today)} day(s)` },
      { label: 'Cited rule', value: citedRule },
    ];
    if (evidenceRef) evidence.push({ label: 'Evidence ref', value: evidenceRef });

    exceptions.push({
      id: exceptionId(code, personId, qualType),
      code,
      exceptionType: 'dot_qualification',
      personId,
      personName,
      branchId,
      branchName,
      equipmentClass,
      dueDate,
      citedRule,
      recommendation,
      requiresHumanApproval: recommendation === 'blocking',
      humanAction: expired
        ? 'Review the driver qualification file and confirm current eligibility before authorizing any dispatch. Corrective action or temporary removal from CDL duties requires manager sign-off.'
        : 'Schedule renewal of the qualification file before expiry. Flag the driver for branch manager awareness; no dispatch block yet unless documentation lapses.',
      evidence,
      tags: ['safety-compliance-manager:t2'],
    });
  }

  return exceptions;
}

// ---------------------------------------------------------------------------
// HOS exception builders
// ---------------------------------------------------------------------------

function buildHosExceptions(
  rows: HosExceptionRow[],
  today: Date,
): ComplianceReadinessException[] {
  const exceptions: ComplianceReadinessException[] = [];

  for (const row of rows) {
    const personId = asString(row.person_id);
    if (!personId) continue;

    const personName = asString(row.person_name) || `Driver ${personId.slice(-6).toUpperCase()}`;
    const branchId = asString(row.branch_id);
    const branchName = asString(row.branch_name) || branchId || 'Unknown branch';
    const equipmentClass = asString(row.equipment_class) || 'CDL fleet';
    const violationType = asString(row.violation_type) || 'HOS violation';
    const violationDate = parseDate(row.violation_date);
    const citedRule = asString(row.cited_rule) || '49 CFR 395 — Hours of Service';
    const evidenceRef = asString(row.evidence_ref);
    const severity = asString(row.severity).toLowerCase();

    const dueDate = violationDate ? violationDate.toISOString().slice(0, 10) : today.toISOString().slice(0, 10);
    const recommendation: RecommendationType = severity === 'critical' ? 'blocking' : 'follow_up';

    const evidence: ComplianceEvidence[] = [
      { label: 'Person', value: personName },
      { label: 'Branch', value: branchName },
      { label: 'Equipment class', value: equipmentClass },
      { label: 'Violation type', value: violationType },
      { label: 'Violation date', value: formatDate(row.violation_date) || 'recent' },
      { label: 'Severity', value: severity || 'unclassified' },
      { label: 'Cited rule', value: citedRule },
    ];
    if (evidenceRef) evidence.push({ label: 'ELD / log ref', value: evidenceRef });

    exceptions.push({
      id: exceptionId('hos_breach', personId, violationDate?.toISOString().slice(0, 10) ?? 'recent'),
      code: 'hos_breach',
      exceptionType: 'hos',
      personId,
      personName,
      branchId,
      branchName,
      equipmentClass,
      dueDate,
      citedRule,
      recommendation,
      requiresHumanApproval: recommendation === 'blocking',
      humanAction: recommendation === 'blocking'
        ? 'Suspend CDL dispatch for this driver until the HOS violation is reviewed and cleared. Reinstatement requires explicit manager approval.'
        : 'Review the HOS exception with the driver and branch manager. Document corrective action and monitor the next log cycle.',
      evidence,
      tags: ['safety-compliance-manager:t4'],
    });
  }

  return exceptions;
}

// ---------------------------------------------------------------------------
// Operator certification exception builders
// ---------------------------------------------------------------------------

function buildOperatorCertExceptions(
  rows: OperatorCertRow[],
  today: Date,
): ComplianceReadinessException[] {
  const exceptions: ComplianceReadinessException[] = [];

  for (const row of rows) {
    const personId = asString(row.person_id);
    if (!personId) continue;

    const personName = asString(row.person_name) || `Operator ${personId.slice(-6).toUpperCase()}`;
    const branchId = asString(row.branch_id);
    const branchName = asString(row.branch_name) || branchId || 'Unknown branch';
    const equipmentClass = asString(row.equipment_class) || 'Regulated equipment';
    const certType = asString(row.certification_type) || 'Operator certification';
    const expiryDate = parseDate(row.expiry_date);
    const status = asString(row.status).toLowerCase();
    const citedRule = asString(row.cited_rule) || 'OSHA 29 CFR 1910.178 / 1926.1427 — Operator Certification';
    const evidenceRef = asString(row.evidence_ref);

    const expired = status === 'expired' || (expiryDate !== null && daysUntil(expiryDate, today) < 0);
    const expiringSoon = !expired && expiryDate !== null && daysUntil(expiryDate, today) <= EXPIRY_WARNING_DAYS;

    if (!expired && !expiringSoon) continue;

    const code: ExceptionCode = expired ? 'operator_cert_expired' : 'operator_cert_expiring';
    const recommendation: RecommendationType = expired ? 'blocking' : 'follow_up';
    const dueDate = expiryDate ? expiryDate.toISOString().slice(0, 10) : null;

    const evidence: ComplianceEvidence[] = [
      { label: 'Person', value: personName },
      { label: 'Branch', value: branchName },
      { label: 'Certification type', value: certType },
      { label: 'Equipment class', value: equipmentClass },
      { label: 'Expiry date', value: formatDate(row.expiry_date) },
      {
        label: 'Status',
        value: expired
          ? 'Expired — operator must not use regulated equipment'
          : `Expiring in ${daysUntil(expiryDate!, today)} day(s)`,
      },
      { label: 'Cited rule', value: citedRule },
    ];
    if (evidenceRef) evidence.push({ label: 'Certification ref', value: evidenceRef });

    exceptions.push({
      id: exceptionId(code, personId, certType),
      code,
      exceptionType: 'operator_cert',
      personId,
      personName,
      branchId,
      branchName,
      equipmentClass,
      dueDate,
      citedRule,
      recommendation,
      requiresHumanApproval: recommendation === 'blocking',
      humanAction: expired
        ? 'Remove operator from regulated equipment assignments immediately. Recertification and manager sign-off required before reinstatement.'
        : 'Schedule recertification before expiry. Alert the branch manager; no assignment block yet unless certification lapses.',
      evidence,
      tags: ['safety-compliance-manager:t4'],
    });
  }

  return exceptions;
}

// ---------------------------------------------------------------------------
// Training exception builders
// ---------------------------------------------------------------------------

function buildTrainingExceptions(
  rows: TrainingRow[],
  today: Date,
): ComplianceReadinessException[] {
  const exceptions: ComplianceReadinessException[] = [];

  for (const row of rows) {
    const personId = asString(row.person_id);
    if (!personId) continue;

    const personName = asString(row.person_name) || `Employee ${personId.slice(-6).toUpperCase()}`;
    const branchId = asString(row.branch_id);
    const branchName = asString(row.branch_name) || branchId || 'Unknown branch';
    const equipmentClass = asString(row.equipment_class) || 'General safety';
    const trainingType = asString(row.training_type) || 'Required training';
    const dueDate = parseDate(row.due_date);
    const status = asString(row.status).toLowerCase();
    const citedRule = asString(row.cited_rule) || 'Internal training policy / OSHA recordkeeping';
    const evidenceRef = asString(row.evidence_ref);

    const overdue = status === 'overdue' || (dueDate !== null && daysUntil(dueDate, today) < 0);
    const dueSoon = !overdue && dueDate !== null && daysUntil(dueDate, today) <= TRAINING_WARNING_DAYS;

    if (!overdue && !dueSoon) continue;

    const code: ExceptionCode = overdue ? 'training_overdue' : 'training_due_soon';
    const recommendation: RecommendationType = overdue ? 'follow_up' : 'reminder';
    const dueDateStr = dueDate ? dueDate.toISOString().slice(0, 10) : null;

    const evidence: ComplianceEvidence[] = [
      { label: 'Person', value: personName },
      { label: 'Branch', value: branchName },
      { label: 'Training type', value: trainingType },
      { label: 'Equipment class', value: equipmentClass },
      { label: 'Due date', value: formatDate(row.due_date) },
      {
        label: 'Status',
        value: overdue
          ? 'Overdue — corrective follow-up required'
          : `Due in ${daysUntil(dueDate!, today)} day(s)`,
      },
      { label: 'Cited rule', value: citedRule },
    ];
    if (evidenceRef) evidence.push({ label: 'Training record ref', value: evidenceRef });

    exceptions.push({
      id: exceptionId(code, personId, trainingType),
      code,
      exceptionType: 'training',
      personId,
      personName,
      branchId,
      branchName,
      equipmentClass,
      dueDate: dueDateStr,
      citedRule,
      recommendation,
      requiresHumanApproval: false,
      humanAction: overdue
        ? 'Follow up with the employee and their branch manager to schedule overdue training. Document completion in the LMS and the compliance record.'
        : 'Send a reminder to schedule training before the due date. No operational block yet; monitor and escalate if the deadline passes.',
      evidence,
      tags: ['safety-compliance-manager:t7'],
    });
  }

  return exceptions;
}

// ---------------------------------------------------------------------------
// Sort order: blocking first, then follow_up, then reminder; within tier by dueDate asc
// ---------------------------------------------------------------------------

const RECOMMENDATION_RANK: Record<RecommendationType, number> = {
  blocking: 0,
  follow_up: 1,
  reminder: 2,
};

function sortExceptions(exceptions: ComplianceReadinessException[]): ComplianceReadinessException[] {
  return [...exceptions].sort((a, b) => {
    const rankDiff = RECOMMENDATION_RANK[a.recommendation] - RECOMMENDATION_RANK[b.recommendation];
    if (rankDiff !== 0) return rankDiff;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.personName.localeCompare(b.personName);
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function buildComplianceReadinessQueue(input: {
  driverQualifications?: unknown;
  hosExceptions?: unknown;
  operatorCerts?: unknown;
  trainingRecords?: unknown;
  today?: string;
}): ComplianceReadinessResult {
  const today = input.today ? (parseDate(input.today) ?? new Date()) : new Date();

  const driverQualRows = asArray(input.driverQualifications) as DriverQualificationRow[];
  const hosRows = asArray(input.hosExceptions) as HosExceptionRow[];
  const certRows = asArray(input.operatorCerts) as OperatorCertRow[];
  const trainingRows = asArray(input.trainingRecords) as TrainingRow[];

  const exceptions = sortExceptions([
    ...buildDotQualificationExceptions(driverQualRows, today),
    ...buildHosExceptions(hosRows, today),
    ...buildOperatorCertExceptions(certRows, today),
    ...buildTrainingExceptions(trainingRows, today),
  ]);

  if (exceptions.length === 0) {
    return {
      exceptions: [],
      noOp: true,
      tags: COMPLIANCE_READINESS_TAGS,
      summary: { blocking: 0, follow_up: 0, reminder: 0 },
    };
  }

  const summary = {
    blocking: exceptions.filter((e) => e.recommendation === 'blocking').length,
    follow_up: exceptions.filter((e) => e.recommendation === 'follow_up').length,
    reminder: exceptions.filter((e) => e.recommendation === 'reminder').length,
  };

  return { exceptions, noOp: false, tags: COMPLIANCE_READINESS_TAGS, summary };
}

// ---------------------------------------------------------------------------
// Filter helpers — used by the route to apply URL-driven filters client-side
// ---------------------------------------------------------------------------

export function filterExceptions(
  exceptions: ComplianceReadinessException[],
  filters: {
    branch?: string;
    exceptionType?: string;
    recommendation?: string;
    person?: string;
  },
): ComplianceReadinessException[] {
  const { branch, exceptionType, recommendation, person } = filters;

  return exceptions.filter((ex) => {
    if (branch && branch !== '%' && ex.branchId !== branch && ex.branchName !== branch) return false;
    if (exceptionType && exceptionType !== '%' && ex.exceptionType !== exceptionType) return false;
    if (recommendation && recommendation !== '%' && ex.recommendation !== recommendation) return false;
    if (person && person !== '%' && !ex.personName.toLowerCase().includes(person.toLowerCase())) return false;
    return true;
  });
}

// Re-export asRecord for use by the route when extracting row data from unknown sources
export { asRecord };
