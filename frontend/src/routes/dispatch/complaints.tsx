/**
 * Delivery Complaint Review Route
 *
 * Dispatcher-facing surface for complaint intake and recovery routing.
 * Assembles delivery/pickup timestamps, route changes, branch notes,
 * proof-of-delivery artifacts, and proposed recovery paths into one
 * reviewer-ready complaint case.
 *
 * Access:
 *   branch_manager / admin — full read and complaint case creation
 *
 * Design:
 *   assist only — no automatic promise, credit, or status disposition.
 *   Repeated updates for the same (stop, complaint_type) collapse into
 *   one open thread via upsert_complaint_case.
 *   If evidence is incomplete, the assistant escalates rather than guessing.
 *
 * Operating-model tag: market-logistics-dispatcher:t1
 */

import { useCallback, useEffect, useState } from 'react';
import { createFileRoute, useSearch } from '@tanstack/react-router';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileSearch,
  MapPin,
  Package,
  RefreshCw,
  Shield,
  Truck,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/auth/AuthContext';
import { supabase } from '@/data/supabase';
import {
  buildDeliveryComplaintCase,
  type ComplaintCaseResult,
  type ComplaintType,
  type StopSignal,
  type RouteSignal,
  type PodSignal,
  type ExceptionSignal,
} from '@/lib/deliveryComplaintAssistant';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/dispatch/complaints')({
  component: DeliveryComplaintsPage,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export type ComplaintCaseRow = {
  caseId: string;
  stopId: string;
  complaintType: ComplaintType;
  complaintNarrative: string | null;
  recoveryAction: string;
  recoveryOwner: string | null;
  evidenceStatus: string;
  requiresHumanReview: boolean;
  caseCreatedAt: string;
  caseUpdatedAt: string;
  stopType: string | null;
  stopStatus: string | null;
  customerName: string | null;
  jobSiteName: string | null;
  address: string | null;
  contractLineId: string | null;
  assetId: string | null;
  stopNotes: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  stopCompletedAt: string | null;
  routeId: string | null;
  routeDate: string | null;
  routeStatus: string | null;
  podEvidenceStatus: string | null;
  podSignature: string | null;
  podPhotoPaths: string[];
  podConditionNotes: string | null;
  podCompletedAt: string | null;
  openExceptionCount: number;
  assistantCase: ComplaintCaseResult | null;
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const BUNDLE_SELECT = [
  'case_id',
  'stop_id',
  'complaint_type',
  'complaint_narrative',
  'recovery_action',
  'recovery_owner',
  'evidence_status',
  'requires_human_review',
  'case_created_at',
  'case_updated_at',
  'stop_type',
  'stop_status',
  'customer_name',
  'job_site_name',
  'address',
  'contract_line_id',
  'asset_id',
  'stop_notes',
  'departed_at',
  'arrived_at',
  'stop_completed_at',
  'route_id',
  'route_date',
  'route_status',
  'pod_evidence_status',
  'pod_signature',
  'pod_photo_paths',
  'pod_condition_notes',
  'pod_completed_at',
  'open_exception_count',
].join(', ');

function rawToRow(raw: Record<string, unknown>): ComplaintCaseRow {
  const asStr = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  const asInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  const asStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];

  const stopId = asStr(raw.stop_id) ?? '';
  const complaintType = (asStr(raw.complaint_type) ?? 'other') as ComplaintType;
  const stopType = asStr(raw.stop_type);
  const routeId = asStr(raw.route_id);
  const routeDate = asStr(raw.route_date);
  const routeStatus = asStr(raw.route_status);
  const podEvidenceStatus = asStr(raw.pod_evidence_status);
  const podPhotoPaths = asStrArr(raw.pod_photo_paths);
  const openExceptionCount = asInt(raw.open_exception_count);

  const stop: StopSignal = {
    stopId,
    stopType,
    stopStatus: asStr(raw.stop_status),
    customerName: asStr(raw.customer_name),
    jobSiteName: asStr(raw.job_site_name),
    address: asStr(raw.address),
    contractLineId: asStr(raw.contract_line_id),
    assetId: asStr(raw.asset_id),
    stopNotes: asStr(raw.stop_notes),
    departedAt: asStr(raw.departed_at),
    arrivedAt: asStr(raw.arrived_at),
    completedAt: asStr(raw.stop_completed_at),
  };
  const route: RouteSignal | null = routeId
    ? { routeId, routeDate, routeStatus }
    : null;
  const pod: PodSignal | null = podEvidenceStatus
    ? {
        evidenceStatus: podEvidenceStatus,
        signature: asStr(raw.pod_signature),
        conditionNotes: asStr(raw.pod_condition_notes),
        photoPaths: podPhotoPaths,
        completedAt: asStr(raw.pod_completed_at),
      }
    : null;

  const assistantCase = buildDeliveryComplaintCase({
    complaintType,
    stop: stopId ? stop : null,
    route,
    pod,
    exceptions:
      openExceptionCount > 0
        ? [{ exceptionType: 'open', resolvedAt: null }] as ExceptionSignal[]
        : [],
  });

  return {
    caseId: asStr(raw.case_id) ?? '',
    stopId,
    complaintType,
    complaintNarrative: asStr(raw.complaint_narrative),
    recoveryAction: asStr(raw.recovery_action) ?? 'pending_review',
    recoveryOwner: asStr(raw.recovery_owner),
    evidenceStatus: asStr(raw.evidence_status) ?? 'incomplete',
    requiresHumanReview: raw.requires_human_review === true,
    caseCreatedAt: asStr(raw.case_created_at) ?? '',
    caseUpdatedAt: asStr(raw.case_updated_at) ?? '',
    stopType,
    stopStatus: asStr(raw.stop_status),
    customerName: asStr(raw.customer_name),
    jobSiteName: asStr(raw.job_site_name),
    address: asStr(raw.address),
    contractLineId: asStr(raw.contract_line_id),
    assetId: asStr(raw.asset_id),
    stopNotes: asStr(raw.stop_notes),
    departedAt: asStr(raw.departed_at),
    arrivedAt: asStr(raw.arrived_at),
    stopCompletedAt: asStr(raw.stop_completed_at),
    routeId,
    routeDate,
    routeStatus,
    podEvidenceStatus,
    podSignature: asStr(raw.pod_signature),
    podPhotoPaths,
    podConditionNotes: asStr(raw.pod_condition_notes),
    podCompletedAt: asStr(raw.pod_completed_at),
    openExceptionCount,
    assistantCase,
  };
}

export async function fetchComplaintCases(): Promise<ComplaintCaseRow[]> {
  const { data, error } = await supabase
    .from('v_complaint_case_review_bundle')
    .select(BUNDLE_SELECT)
    .order('case_created_at', { ascending: false });
  if (error) throw new Error(error.message || 'Unable to load complaint cases.');
  return ((data ?? []) as Record<string, unknown>[]).map(rawToRow);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDatetime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function evidenceStatusBadge(status: string) {
  if (status === 'packaged') {
    return (
      <Badge className="bg-green-100 text-green-800 hover:bg-green-100" data-testid="badge-packaged">
        Evidence packaged
      </Badge>
    );
  }
  if (status === 'ambiguous') {
    return (
      <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100" data-testid="badge-ambiguous">
        Evidence ambiguous
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-100 text-red-800 hover:bg-red-100" data-testid="badge-incomplete">
      Evidence incomplete
    </Badge>
  );
}

function recoveryActionLabel(action: string): string {
  const labels: Record<string, string> = {
    pending_review: 'Pending dispatcher review',
    're_run_required': 'Re-run required',
    branch_follow_up: 'Branch follow-up required',
    escalate_dispatcher: 'Escalate to dispatcher',
    escalate_branch_manager: 'Escalate to branch manager',
    document_service_failure: 'Document service failure',
    resolved: 'Resolved',
  };
  return labels[action] ?? action;
}

function complaintTypeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EvidencePanel({ kase }: { kase: ComplaintCaseRow }) {
  const [expanded, setExpanded] = useState(false);
  const ac = kase.assistantCase;

  if (!ac) return null;

  return (
    <div className="mt-3 border-t pt-3">
      <button
        type="button"
        className="flex w-full items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`evidence-${kase.caseId}`}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        )}
        {expanded ? 'Hide evidence bundle' : 'Show evidence bundle'}
      </button>

      {expanded && (
        <div
          id={`evidence-${kase.caseId}`}
          className="mt-3 space-y-2"
          data-testid="evidence-bundle"
        >
          {ac.evidence.map((ev, idx) => (
            <div key={idx} className="rounded border bg-muted/30 px-3 py-2 text-sm">
              <span className="font-medium">{ev.label}: </span>
              <span className="text-muted-foreground">{ev.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ComplaintCaseCard({ kase }: { kase: ComplaintCaseRow }) {
  const ac = kase.assistantCase;

  return (
    <Card data-testid={`complaint-case-${kase.caseId}`}>
      <CardHeader className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {kase.stopType === 'delivery' ? (
              <Truck className="h-4 w-4 text-blue-600" aria-hidden="true" />
            ) : (
              <Package className="h-4 w-4 text-amber-600" aria-hidden="true" />
            )}
            <CardTitle className="text-base" data-testid="case-title">
              {ac?.title ?? complaintTypeLabel(kase.complaintType)}
            </CardTitle>
          </div>
          <div className="flex flex-wrap gap-1">
            {evidenceStatusBadge(kase.evidenceStatus)}
            {kase.requiresHumanReview && (
              <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100" data-testid="badge-human-review">
                <Shield className="mr-1 h-3 w-3" aria-hidden="true" />
                Human approval required
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 px-4 pb-4 pt-0 sm:px-5 sm:pb-5">
        {/* Case summary */}
        {ac && (
          <p className="text-sm text-muted-foreground" data-testid="case-summary">
            {ac.summary}
          </p>
        )}

        {/* Complaint type and stop context */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div>
            <span className="text-muted-foreground">Type: </span>
            <span className="font-medium">{complaintTypeLabel(kase.complaintType)}</span>
          </div>
          {kase.customerName && (
            <div>
              <span className="text-muted-foreground">Customer: </span>
              <span className="font-medium">{kase.customerName}</span>
            </div>
          )}
          {kase.jobSiteName && (
            <div>
              <span className="text-muted-foreground">Site: </span>
              <span>{kase.jobSiteName}</span>
            </div>
          )}
          {kase.routeDate && (
            <div>
              <span className="text-muted-foreground">Route date: </span>
              <span>{kase.routeDate}</span>
            </div>
          )}
        </div>

        {/* Address */}
        {kase.address && (
          <div className="flex items-start gap-1 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{kase.address}</span>
          </div>
        )}

        {/* Timestamps */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {kase.departedAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Departed {formatDatetime(kase.departedAt)}
            </span>
          )}
          {kase.arrivedAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Arrived {formatDatetime(kase.arrivedAt)}
            </span>
          )}
          {kase.stopCompletedAt && (
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
              Completed {formatDatetime(kase.stopCompletedAt)}
            </span>
          )}
        </div>

        {/* Proposed recovery */}
        {ac && (
          <div className="rounded border-l-4 border-blue-400 bg-blue-50 px-3 py-2 text-sm" data-testid="recovery-proposal">
            <p className="font-medium text-blue-900">Proposed recovery</p>
            <p className="text-blue-800">{recoveryActionLabel(ac.recoveryAction)}</p>
            {ac.recoveryOwner && (
              <p className="mt-0.5 text-xs text-blue-700">Owner: {ac.recoveryOwner}</p>
            )}
          </div>
        )}

        {/* Recommendation */}
        {ac && (
          <div
            className={
              ac.evidenceStatus === 'incomplete'
                ? 'rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800'
                : ac.evidenceStatus === 'ambiguous'
                  ? 'rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                  : 'rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800'
            }
            data-testid="recommendation"
          >
            {ac.evidenceStatus === 'incomplete' && (
              <AlertTriangle className="mb-1 h-4 w-4" aria-hidden="true" />
            )}
            {ac.recommendation}
          </div>
        )}

        {/* Open exceptions indicator */}
        {kase.openExceptionCount > 0 && (
          <div className="flex items-center gap-2 text-sm text-amber-700" data-testid="open-exceptions">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span>
              {kase.openExceptionCount} open exception
              {kase.openExceptionCount !== 1 ? 's' : ''} on this stop — confirm resolution before routing complaint.
            </span>
          </div>
        )}

        {/* Complaint narrative */}
        {kase.complaintNarrative && (
          <div className="rounded border bg-muted/30 px-3 py-2 text-sm" data-testid="complaint-narrative">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Complaint narrative
            </p>
            <p>{kase.complaintNarrative}</p>
          </div>
        )}

        {/* Filed at */}
        <p className="text-xs text-muted-foreground">
          Filed {formatDatetime(kase.caseCreatedAt)}
          {kase.caseUpdatedAt !== kase.caseCreatedAt && (
            <>, updated {formatDatetime(kase.caseUpdatedAt)}</>
          )}
        </p>

        {/* Expandable evidence bundle */}
        <EvidencePanel kase={kase} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function DeliveryComplaintsScreen() {
  const { profile } = useAuth();
  const userCanReview =
    profile?.role === 'admin' || profile?.role === 'branch_manager';

  const search = useSearch({ from: '/dispatch/complaints' }) as { stop?: string };
  const filterStopId = search.stop ?? null;

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cases, setCases] = useState<ComplaintCaseRow[]>([]);

  const load = useCallback(async () => {
    setLoadState('loading');
    setErrorMessage(null);
    try {
      const rows = await fetchComplaintCases();
      setCases(rows);
      setLoadState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unexpected error loading complaint cases.');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    if (!userCanReview) return;
    void load();
  }, [load, userCanReview]);

  if (!userCanReview) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            Branch manager or admin role is required to access the complaint review queue.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const visibleCases = filterStopId
    ? cases.filter((c) => c.stopId === filterStopId)
    : cases;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FileSearch className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <h1
                className="text-2xl font-bold tracking-tight"
                data-testid="complaints-heading"
              >
                Complaint Review Queue
              </h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Delivery and pickup complaint cases assembled from route timeline, proof-of-delivery
              evidence, and branch notes. Dispatcher reviews and routes — no automatic customer
              promise or credit is issued.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loadState === 'loading'}
            aria-label="Refresh complaint queue"
            data-testid="refresh-button"
          >
            <RefreshCw
              className={`mr-1 h-4 w-4${loadState === 'loading' ? ' animate-spin' : ''}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>

        {/* Loading */}
        {loadState === 'loading' && (
          <Alert data-testid="complaints-loading">
            <AlertDescription>Loading complaint cases…</AlertDescription>
          </Alert>
        )}

        {/* Error */}
        {loadState === 'error' && errorMessage && (
          <Alert variant="destructive" data-testid="complaints-error">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Could not load complaint queue</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Stop-level filter indicator */}
        {filterStopId && loadState === 'ready' && (
          <Alert className="mb-4">
            <AlertDescription>
              Showing complaint cases for stop <span className="font-mono text-xs">{filterStopId}</span>.
            </AlertDescription>
          </Alert>
        )}

        {/* Empty state */}
        {loadState === 'ready' && visibleCases.length === 0 && (
          <Alert data-testid="complaints-empty">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>No open complaint cases</AlertTitle>
            <AlertDescription>
              No open delivery or pickup complaint cases are currently in the queue.
            </AlertDescription>
          </Alert>
        )}

        {/* Case list */}
        {loadState === 'ready' && visibleCases.length > 0 && (
          <div className="space-y-4" data-testid="complaint-case-list">
            <p className="text-sm text-muted-foreground">
              {visibleCases.length} open complaint case{visibleCases.length !== 1 ? 's' : ''} — human approval required for any customer-facing action.
            </p>
            {visibleCases.map((kase) => (
              <ComplaintCaseCard key={kase.caseId} kase={kase} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DeliveryComplaintsPage() {
  return <DeliveryComplaintsScreen />;
}
