/**
 * Compliance Readiness Queue Route
 *
 * Safety & Compliance Manager queue for DOT qualification exceptions, HOS
 * breaches, expiring operator certifications, and overdue training /
 * recertification follow-up.
 *
 * Human-approval boundary: any blocking or status-changing action requires
 * explicit human approval — this surface only proposes; it never mutates.
 * Fallback when context is missing: item surfaces in a review-needed state
 * with the missing credential or conflicting fact highlighted.
 *
 * Filters are retained in the URL so drill-down context and queue scope
 * survive navigation and page refresh.
 *
 * Operating-model tags:
 *   safety-compliance-manager:t2 (DOT qualification oversight)
 *   safety-compliance-manager:t4 (HOS / operator certification)
 *   safety-compliance-manager:t7 (training currency)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';
import {
  buildComplianceReadinessQueue,
  filterExceptions,
  COMPLIANCE_READINESS_TAGS,
} from '@/lib/compliance-readiness-queue';
import type {
  ComplianceReadinessException,
  ComplianceReadinessResult,
  RecommendationType,
  DriverQualificationRow,
  HosExceptionRow,
  OperatorCertRow,
  TrainingRow,
} from '@/lib/compliance-readiness-queue';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

export const Route = createFileRoute('/ops/compliance-readiness-queue')({
  validateSearch: (search: Record<string, unknown>) => ({
    branch: readFilterParam(search.branch),
    exceptionType: readFilterParam(search.exceptionType),
    recommendation: readFilterParam(search.recommendation),
    person: readFilterParam(search.person),
  }),
  component: ComplianceReadinessQueuePage,
});

// ---------------------------------------------------------------------------
// Supabase data fetchers
// — These fetch from views / tables that will be wired up as the backend
//   matures. They fall back gracefully to empty arrays on error.
// ---------------------------------------------------------------------------

const DRIVER_QUAL_SELECT = [
  'person_id',
  'person_name',
  'branch_id',
  'branch_name',
  'equipment_class',
  'qualification_type',
  'expiry_date',
  'status',
  'cited_rule',
  'evidence_ref',
].join(', ');

const HOS_SELECT = [
  'person_id',
  'person_name',
  'branch_id',
  'branch_name',
  'equipment_class',
  'violation_type',
  'violation_date',
  'cited_rule',
  'evidence_ref',
  'severity',
].join(', ');

const CERT_SELECT = [
  'person_id',
  'person_name',
  'branch_id',
  'branch_name',
  'equipment_class',
  'certification_type',
  'expiry_date',
  'status',
  'cited_rule',
  'evidence_ref',
].join(', ');

const TRAINING_SELECT = [
  'person_id',
  'person_name',
  'branch_id',
  'branch_name',
  'equipment_class',
  'training_type',
  'due_date',
  'status',
  'cited_rule',
  'evidence_ref',
].join(', ');

async function fetchDriverQualifications(): Promise<DriverQualificationRow[]> {
  const { data, error } = await supabase
    .from('v_driver_qualification_exceptions')
    .select(DRIVER_QUAL_SELECT);
  if (error) throw new Error(error.message || 'Unable to load driver qualification data.');
  return (data ?? []) as DriverQualificationRow[];
}

async function fetchHosExceptions(): Promise<HosExceptionRow[]> {
  const { data, error } = await supabase
    .from('v_hos_exceptions_current')
    .select(HOS_SELECT);
  if (error) throw new Error(error.message || 'Unable to load HOS exceptions.');
  return (data ?? []) as HosExceptionRow[];
}

async function fetchOperatorCerts(): Promise<OperatorCertRow[]> {
  const { data, error } = await supabase
    .from('v_operator_cert_exceptions')
    .select(CERT_SELECT);
  if (error) throw new Error(error.message || 'Unable to load operator certification data.');
  return (data ?? []) as OperatorCertRow[];
}

async function fetchTrainingRecords(): Promise<TrainingRow[]> {
  const { data, error } = await supabase
    .from('v_training_compliance_exceptions')
    .select(TRAINING_SELECT);
  if (error) throw new Error(error.message || 'Unable to load training records.');
  return (data ?? []) as TrainingRow[];
}

// ---------------------------------------------------------------------------
// Badge / label helpers
// ---------------------------------------------------------------------------

function recommendationBadge(rec: RecommendationType): {
  variant: 'destructive' | 'secondary' | 'outline';
  label: string;
} {
  switch (rec) {
    case 'blocking':
      return { variant: 'destructive', label: 'Blocking' };
    case 'follow_up':
      return { variant: 'secondary', label: 'Follow-up' };
    default:
      return { variant: 'outline', label: 'Reminder' };
  }
}

const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  dot_qualification: 'DOT Qualification',
  hos: 'HOS / ELD',
  operator_cert: 'Operator Cert',
  training: 'Training',
};

// ---------------------------------------------------------------------------
// Exception card component
// ---------------------------------------------------------------------------

function ExceptionCard({ exception: ex }: { exception: ComplianceReadinessException }) {
  const [expanded, setExpanded] = useState(false);
  const badge = recommendationBadge(ex.recommendation);

  return (
    <div
      className={[
        'rounded-lg border p-4 space-y-3',
        ex.recommendation === 'blocking' ? 'border-destructive/60 bg-destructive/5' : '',
      ].join(' ')}
      data-testid="compliance-exception-card"
    >
      {/* Header row */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold" data-testid="exception-person-name">
              {ex.personName}
            </span>
            <Badge variant={badge.variant} data-testid="exception-recommendation-badge">
              {badge.label}
            </Badge>
            {ex.requiresHumanApproval && (
              <Badge variant="outline" className="border-destructive text-destructive" data-testid="exception-approval-badge">
                Requires human approval
              </Badge>
            )}
            <Badge variant="outline">{EXCEPTION_TYPE_LABELS[ex.exceptionType] ?? ex.exceptionType}</Badge>
          </div>
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span data-testid="exception-branch">{ex.branchName}</span>
            {ex.equipmentClass && <span>· {ex.equipmentClass}</span>}
            {ex.dueDate && (
              <span data-testid="exception-due-date">
                · Due {new Date(ex.dueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 text-sm text-primary underline-offset-4 hover:underline text-left"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="exception-drill-down-toggle"
        >
          {expanded ? 'Hide detail' : 'View detail'}
        </button>
      </div>

      {/* Cited rule summary line */}
      <p className="text-xs text-muted-foreground" data-testid="exception-cited-rule">
        {ex.citedRule}
      </p>

      {/* Drill-down detail — evidence + required action */}
      {expanded && (
        <div className="space-y-3 pt-1" data-testid="exception-detail-panel">
          <div>
            <p className="text-sm font-medium mb-1">Evidence</p>
            <ul className="space-y-1 text-sm text-muted-foreground" data-testid="exception-evidence-list">
              {ex.evidence.map((ev, idx) => (
                <li key={`${ex.id}-ev-${idx}`}>
                  <span className="font-medium text-foreground">{ev.label}:</span>{' '}
                  {ev.value}
                </li>
              ))}
            </ul>
          </div>
          <Alert
            variant={ex.requiresHumanApproval ? 'destructive' : 'default'}
            data-testid="exception-action-alert"
          >
            <AlertTitle>
              {ex.requiresHumanApproval ? 'Human approval required' : 'Recommended action'}
            </AlertTitle>
            <AlertDescription data-testid="exception-human-action">
              {ex.humanAction}
            </AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter row component
// ---------------------------------------------------------------------------

const EXCEPTION_TYPE_OPTIONS = [
  { value: '%', label: 'All types' },
  { value: 'dot_qualification', label: 'DOT Qualification' },
  { value: 'hos', label: 'HOS / ELD' },
  { value: 'operator_cert', label: 'Operator Cert' },
  { value: 'training', label: 'Training' },
];

const RECOMMENDATION_OPTIONS = [
  { value: '%', label: 'All recommendations' },
  { value: 'blocking', label: 'Blocking' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'reminder', label: 'Reminder' },
];

interface FilterRowProps {
  branch: string;
  exceptionType: string;
  recommendation: string;
  person: string;
  onChange: (next: { branch: string; exceptionType: string; recommendation: string; person: string }) => void;
}

function FilterRow({ branch, exceptionType, recommendation, person, onChange }: FilterRowProps) {
  return (
    <div
      className="flex flex-wrap gap-4 items-end"
      data-testid="compliance-filter-row"
      role="search"
      aria-label="Filter compliance exceptions"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="filter-branch" className="text-xs">Branch</Label>
        <input
          id="filter-branch"
          type="text"
          value={branch === '%' ? '' : branch}
          placeholder="Filter by branch…"
          onChange={(e) => {
            const v = e.target.value.trim();
            onChange({ branch: v || '%', exceptionType, recommendation, person });
          }}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm w-44"
          data-testid="filter-branch"
          aria-label="Filter by branch name"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="filter-exception-type" className="text-xs">Exception type</Label>
        <select
          id="filter-exception-type"
          value={exceptionType}
          onChange={(e) => onChange({ branch, exceptionType: e.target.value, recommendation, person })}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          data-testid="filter-exception-type"
          aria-label="Filter by exception type"
        >
          {EXCEPTION_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="filter-recommendation" className="text-xs">Recommendation</Label>
        <select
          id="filter-recommendation"
          value={recommendation}
          onChange={(e) => onChange({ branch, exceptionType, recommendation: e.target.value, person })}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
          data-testid="filter-recommendation"
          aria-label="Filter by recommendation type"
        >
          {RECOMMENDATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="filter-person" className="text-xs">Person</Label>
        <input
          id="filter-person"
          type="text"
          value={person === '%' ? '' : person}
          placeholder="Filter by name…"
          onChange={(e) => {
            const v = e.target.value.trim();
            onChange({ branch, exceptionType, recommendation, person: v || '%' });
          }}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm w-44"
          data-testid="filter-person"
          aria-label="Filter by person name"
        />
      </div>

      {(branch !== '%' || exceptionType !== '%' || recommendation !== '%' || person !== '%') && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ branch: '%', exceptionType: '%', recommendation: '%', person: '%' })}
          data-testid="filter-clear-button"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main queue panel
// ---------------------------------------------------------------------------

interface QueuePanelProps {
  result: ComplianceReadinessResult;
  filters: { branch: string; exceptionType: string; recommendation: string; person: string };
  onFiltersChange: (next: { branch: string; exceptionType: string; recommendation: string; person: string }) => void;
  onRefresh: () => void;
  isLoading: boolean;
}

function QueuePanel({ result, filters, onFiltersChange, onRefresh, isLoading }: QueuePanelProps) {
  const visible = filterExceptions(result.exceptions, filters);

  return (
    <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="compliance-queue-panel">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle>Compliance Readiness Queue</CardTitle>
              <CardDescription>
                Driver and operator readiness exceptions with affected person, branch, equipment
                class, due date, cited rule, and linked evidence. Blocking recommendations require
                explicit human approval before any dispatch or status change.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {COMPLIANCE_READINESS_TAGS.map((tag) => (
                <Badge key={tag} variant="outline">{tag}</Badge>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isLoading}
                data-testid="refresh-button"
              >
                {isLoading ? 'Refreshing…' : 'Refresh queue'}
              </Button>
            </div>
          </div>

          {/* Summary badges */}
          {!result.noOp && (
            <div className="flex flex-wrap gap-2 pt-2" data-testid="queue-summary-badges">
              <Badge variant="outline">{result.exceptions.length} exception{result.exceptions.length !== 1 ? 's' : ''}</Badge>
              {result.summary.blocking > 0 && (
                <Badge variant="destructive" data-testid="summary-blocking-badge">
                  {result.summary.blocking} blocking
                </Badge>
              )}
              {result.summary.follow_up > 0 && (
                <Badge variant="secondary" data-testid="summary-follow-up-badge">
                  {result.summary.follow_up} follow-up
                </Badge>
              )}
              {result.summary.reminder > 0 && (
                <Badge variant="outline" data-testid="summary-reminder-badge">
                  {result.summary.reminder} reminder
                </Badge>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Filter row */}
          <FilterRow {...filters} onChange={onFiltersChange} />

          {/* No-op state */}
          {result.noOp && (
            <Alert data-testid="compliance-no-op">
              <AlertTitle>No compliance exceptions found</AlertTitle>
              <AlertDescription>
                No materially new DOT qualification, HOS, operator certification, or training
                exceptions were identified. Use the refresh button to re-run the check.
              </AlertDescription>
            </Alert>
          )}

          {/* Filtered empty state */}
          {!result.noOp && visible.length === 0 && (
            <Alert data-testid="compliance-filter-empty">
              <AlertTitle>No exceptions match the current filters</AlertTitle>
              <AlertDescription>
                Adjust or clear the filters to see the full queue.
              </AlertDescription>
            </Alert>
          )}

          {/* Exception list */}
          {visible.length > 0 && (
            <div className="space-y-3" data-testid="compliance-exception-list">
              {visible.map((ex) => (
                <ExceptionCard key={ex.id} exception={ex} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen — handles data fetching and state
// ---------------------------------------------------------------------------

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface ComplianceReadinessQueueScreenProps {
  branch?: string;
  exceptionType?: string;
  recommendation?: string;
  person?: string;
  onStateChange?: (state: { branch: string; exceptionType: string; recommendation: string; person: string }) => void;
}

export function ComplianceReadinessQueueScreen({
  branch = '%',
  exceptionType = '%',
  recommendation = '%',
  person = '%',
  onStateChange,
}: ComplianceReadinessQueueScreenProps = {}) {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [driverQuals, setDriverQuals] = useState<DriverQualificationRow[]>([]);
  const [hosExceptions, setHosExceptions] = useState<HosExceptionRow[]>([]);
  const [operatorCerts, setOperatorCerts] = useState<OperatorCertRow[]>([]);
  const [trainingRecords, setTrainingRecords] = useState<TrainingRow[]>([]);

  const load = useCallback(async () => {
    setLoadState('loading');
    setErrorMessage(null);
    try {
      const [quals, hos, certs, training] = await Promise.all([
        fetchDriverQualifications(),
        fetchHosExceptions(),
        fetchOperatorCerts(),
        fetchTrainingRecords(),
      ]);
      setDriverQuals(quals);
      setHosExceptions(hos);
      setOperatorCerts(certs);
      setTrainingRecords(training);
      setLoadState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unexpected error loading compliance data.');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const result = useMemo(
    () => buildComplianceReadinessQueue({
      driverQualifications: driverQuals,
      hosExceptions,
      operatorCerts,
      trainingRecords,
    }),
    [driverQuals, hosExceptions, operatorCerts, trainingRecords],
  );

  const filters = useMemo(
    () => ({ branch, exceptionType, recommendation, person }),
    [branch, exceptionType, recommendation, person],
  );

  const handleFiltersChange = useCallback(
    (next: { branch: string; exceptionType: string; recommendation: string; person: string }) => {
      onStateChange?.(next);
    },
    [onStateChange],
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="compliance-queue-heading">
            Driver & Operator Compliance Readiness
          </h1>
          <p className="text-sm text-muted-foreground">
            DOT qualification exceptions, HOS breaches, expiring operator certifications, and
            overdue training. Blocking recommendations require human approval before any
            dispatch or status change.
          </p>
        </div>

        {loadState === 'loading' && (
          <Alert data-testid="compliance-loading">
            <AlertDescription>
              Loading compliance signals from qualification, HOS, certification, and training records…
            </AlertDescription>
          </Alert>
        )}

        {loadState === 'error' && errorMessage && (
          <Alert variant="destructive" data-testid="compliance-error">
            <AlertTitle>Unable to load compliance data</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {loadState === 'ready' && (
          <QueuePanel
            result={result}
            filters={filters}
            onFiltersChange={handleFiltersChange}
            onRefresh={load}
            isLoading={false}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route page — syncs filters to URL search params
// ---------------------------------------------------------------------------

function ComplianceReadinessQueuePage() {
  const { branch, exceptionType, recommendation, person } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (next: { branch: string; exceptionType: string; recommendation: string; person: string }) => {
      void navigate({
        search: {
          branch: next.branch,
          exceptionType: next.exceptionType,
          recommendation: next.recommendation,
          person: next.person,
        },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <ComplianceReadinessQueueScreen
      branch={branch}
      exceptionType={exceptionType}
      recommendation={recommendation}
      person={person}
      onStateChange={handleStateChange}
    />
  );
}
