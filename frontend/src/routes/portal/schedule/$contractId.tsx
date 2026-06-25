/**
 * Customer Portal – Delivery/Pickup Schedule
 *
 * Standalone, no-chrome route accessible via a shareable/embeddable URL.
 * URL: /portal/schedule/:contractId
 *
 * The root layout auth guard is bypassed for all /portal/* routes, so this
 * page is viewable without staff authentication.  Data is fetched using the
 * Supabase anon key against views that have been explicitly granted to the
 * anon role (see migration lock_down_anon_read_access).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Truck, Package, CheckCircle2, Copy, Check, CalendarDays, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/portal/schedule/$contractId')({
  component: PortalSchedulePage,
});

function PortalSchedulePage() {
  const { contractId } = Route.useParams();
  return <PortalScheduleScreen contractId={contractId} />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LineStatus = 'pending' | 'checked_out' | 'returned' | string;

type LineData = {
  planned_start?: string;
  planned_end?: string;
  job_site_id?: string;
};

type ContractLineRow = {
  entity_id: string;
  status: LineStatus;
  contract_id: string;
  asset_id: string;
  actual_start: string | null;
  actual_end: string | null;
  data: LineData | null;
};

type ContractRow = {
  entity_id: string;
  status: string | null;
  contract_number: string | null;
};

type AssetRow = {
  asset_id: string;
  name: string;
  status: string | null;
};

export type ScheduleEntry = {
  lineId: string;
  assetName: string;
  assetId: string;
  jobSiteId: string | null;
  /** 'delivery' = pending checkout; 'pickup' = scheduled return; 'returned' = completed */
  eventType: 'delivery' | 'pickup' | 'returned';
  scheduledDate: string | null;
  actualDate: string | null;
  lineStatus: LineStatus;
};

type OffRentRequest = {
  id: string;
  lineId: string;
  assetId: string;
  contractId: string;
  jobSiteId: string | null;
  status: string;
  requestType: string;
  urgency: string;
  reason: string;
  customerNote: string;
  hasSupportingPhotos: boolean;
  missingContractContext: boolean;
  evidenceGaps: string[];
  recommendedDisposition: string;
  requiresHumanApproval: boolean;
  requestedAt: string;
};

type CustomerRequestType = 'off_rent_pickup' | 'contract_extension' | 'field_service';
type RequestUrgency = 'critical' | 'high' | 'standard' | 'low';

const REQUEST_TYPE_OPTIONS: Array<{ value: CustomerRequestType; label: string; buttonLabel: string }> = [
  { value: 'off_rent_pickup', label: 'Pickup / call-off', buttonLabel: 'Request pickup / call-off' },
  { value: 'contract_extension', label: 'Extension', buttonLabel: 'Request extension review' },
  { value: 'field_service', label: 'Field service', buttonLabel: 'Request field service' },
];

function recommendedDispositionForRequestType(requestType: CustomerRequestType): string {
  if (requestType === 'off_rent_pickup') {
    return 'Review pickup/call-off readiness with contract line context, then schedule manually after branch approval.';
  }
  if (requestType === 'contract_extension') {
    return 'Validate extension terms and branch availability, then approve or follow up manually with the customer.';
  }
  return 'Triage field-service urgency and evidence, then dispatch only after branch approval.';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toHumanReadableFallback(value: string, kind: 'Contract' | 'Asset'): string {
  const trimmed = value.trim();
  if (UUID_PATTERN.test(trimmed)) {
    return `${kind} ${trimmed.slice(0, 8).toUpperCase()}`;
  }
  return trimmed;
}

function toEventType(lineStatus: LineStatus): ScheduleEntry['eventType'] {
  if (lineStatus === 'pending') return 'delivery';
  if (lineStatus === 'checked_out') return 'pickup';
  return 'returned';
}

function toScheduledDate(entry: ContractLineRow): string | null {
  const status = entry.status;
  if (status === 'pending') return entry.data?.planned_start ?? null;
  if (status === 'checked_out') return entry.data?.planned_end ?? null;
  return entry.actual_end;
}

export function formatDateLabel(iso: string | null | undefined, fallback = 'Not scheduled'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function buildScheduleEntries(
  lines: ContractLineRow[],
  assetMap: Map<string, AssetRow>
): ScheduleEntry[] {
  return lines.map((line) => {
    const asset = assetMap.get(line.asset_id);
    return {
      lineId: line.entity_id,
      assetName: asset?.name?.trim() || toHumanReadableFallback(line.asset_id, 'Asset'),
      assetId: line.asset_id,
      jobSiteId: typeof line.data?.job_site_id === 'string' ? line.data.job_site_id : null,
      eventType: toEventType(line.status),
      scheduledDate: toScheduledDate(line),
      actualDate: line.actual_end,
      lineStatus: line.status,
    };
  });
}

// Sort: pending deliveries first, then checked_out pickups, then returned entries
const STATUS_ORDER: Record<LineStatus, number> = {
  pending: 0,
  checked_out: 1,
  returned: 2,
};

function sortEntries(entries: ScheduleEntry[]): ScheduleEntry[] {
  return [...entries].sort((a, b) => {
    const orderDiff =
      (STATUS_ORDER[a.lineStatus] ?? 99) - (STATUS_ORDER[b.lineStatus] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    const dateA = new Date(a.scheduledDate ?? '').getTime();
    const dateB = new Date(b.scheduledDate ?? '').getTime();
    return (Number.isNaN(dateA) ? Infinity : dateA) - (Number.isNaN(dateB) ? Infinity : dateB);
  });
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

type PortalScheduleRow = {
  contract_entity_id: string;
  contract_status: string | null;
  contract_number: string | null;
  line_entity_id: string | null;
  line_status: string | null;
  line_contract_id: string | null;
  line_asset_id: string | null;
  line_actual_start: string | null;
  line_actual_end: string | null;
  line_data: LineData | null;
  asset_name: string | null;
  asset_status: string | null;
};

type OffRentRequestRow = {
  request_id: string;
  contract_id: string;
  contract_line_id: string;
  asset_id: string;
  job_site_id: string | null;
  request_type: string | null;
  status: string | null;
  urgency: string | null;
  reason: string | null;
  customer_note: string | null;
  has_supporting_photos: boolean | null;
  missing_contract_context: boolean | null;
  evidence_gaps: string[] | null;
  recommended_disposition: string | null;
  requires_human_approval: boolean | null;
  requested_at: string | null;
};

function mapOffRentRequests(
  rows: OffRentRequestRow[] | null | undefined
): OffRentRequest[] {
  return (rows ?? [])
    .map((row) => {
      return {
        id: row.request_id,
        lineId: row.contract_line_id,
        assetId: row.asset_id,
        contractId: row.contract_id,
        jobSiteId: row.job_site_id ?? null,
        status: row.status ?? 'requested',
        requestType: row.request_type ?? 'off_rent_pickup',
        urgency: row.urgency ?? 'standard',
        reason: row.reason ?? '',
        customerNote: row.customer_note ?? '',
        hasSupportingPhotos: row.has_supporting_photos ?? false,
        missingContractContext: row.missing_contract_context ?? false,
        evidenceGaps: Array.isArray(row.evidence_gaps) ? row.evidence_gaps.filter((value) => typeof value === 'string') : [],
        recommendedDisposition: row.recommended_disposition ?? 'Branch review required before customer-facing commitments.',
        requiresHumanApproval: row.requires_human_approval ?? true,
        requestedAt: row.requested_at ?? '',
      };
    })
    .filter((request) => request.lineId.length > 0)
    .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
}

async function loadPortalSchedule(contractId: string, scopeToken: string | null): Promise<{
  contract: ContractRow | null;
  entries: ScheduleEntry[];
  requests: OffRentRequest[];
}> {
  // Use a SECURITY DEFINER RPC to fetch schedule data. The underlying views
  // (v_rental_contract_current, v_rental_contract_line_current, v_current_assets)
  // are revoked from the anon role so they cannot be queried directly by portal users.
  const { data: scheduleRows, error: scheduleError } = await supabase.rpc(
    'portal_get_contract_schedule',
    { p_contract_id: contractId, p_scope_token: scopeToken }
  );

  if (scheduleError) {
    throw new Error(
      (scheduleError as { message?: string }).message ?? 'Failed to load schedule.'
    );
  }

  let requests: OffRentRequest[] = [];
  if (scopeToken) {
    const { data: requestRows, error: requestError } = await supabase.rpc(
      'portal_list_customer_service_requests',
      {
        p_contract_id: contractId,
        p_scope_token: scopeToken,
      }
    );
    if (requestError) {
      throw new Error(requestError.message ?? 'Failed to load off-rent request status.');
    }
    requests = mapOffRentRequests((requestRows ?? []) as OffRentRequestRow[]);
  }

  const rows = (scheduleRows ?? []) as PortalScheduleRow[];
  if (rows.length === 0) {
    return { contract: null, entries: [], requests };
  }

  const firstRow = rows[0];
  const contract: ContractRow = {
    entity_id: firstRow.contract_entity_id,
    status: firstRow.contract_status,
    contract_number: firstRow.contract_number,
  };

  const lines: ContractLineRow[] = rows
    .filter((row) => row.line_entity_id != null)
    .map((row) => ({
      entity_id: row.line_entity_id!,
      status: row.line_status ?? '',
      contract_id: row.line_contract_id ?? '',
      asset_id: row.line_asset_id ?? '',
      actual_start: row.line_actual_start,
      actual_end: row.line_actual_end,
      data: row.line_data,
    }));

  if (lines.length === 0) {
    return { contract, entries: [], requests };
  }

  const assetMap = new Map<string, AssetRow>();
  for (const row of rows) {
    if (row.line_asset_id && row.asset_name) {
      assetMap.set(row.line_asset_id, {
        asset_id: row.line_asset_id,
        name: row.asset_name,
        status: row.asset_status,
      });
    }
  }

  const entries = sortEntries(buildScheduleEntries(lines, assetMap));

  return { contract, entries, requests };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EventTypeIcon({ type }: { type: ScheduleEntry['eventType'] }) {
  if (type === 'delivery') return <Truck className="h-5 w-5 text-blue-600" aria-hidden="true" />;
  if (type === 'pickup') return <Package className="h-5 w-5 text-amber-600" aria-hidden="true" />;
  return <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />;
}

function statusBadge(entry: ScheduleEntry) {
  if (entry.lineStatus === 'pending') {
    return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Delivery Scheduled</Badge>;
  }
  if (entry.lineStatus === 'checked_out') {
    return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">On Rent · Pickup Scheduled</Badge>;
  }
  return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Returned</Badge>;
}

function ScheduleEntryCard({ entry }: { entry: ScheduleEntry }) {
  const siteStatusLabel =
    entry.lineStatus === 'pending'
      ? 'Incoming'
      : entry.lineStatus === 'checked_out'
        ? 'Current'
        : 'Returned';
  const hasScheduledPickup = entry.lineStatus === 'checked_out' && Boolean(entry.scheduledDate);
  const dateLabel =
    entry.eventType === 'delivery'
      ? `Delivery: ${formatDateLabel(entry.scheduledDate)}`
      : entry.eventType === 'pickup'
        ? `Pickup: ${formatDateLabel(entry.scheduledDate)}`
        : `Returned: ${formatDateLabel(entry.actualDate)}`;

  return (
    <Card data-testid={`schedule-entry-${entry.lineId}`}>
      <CardContent className="flex items-start gap-4 pt-4 pb-4">
        <div className="mt-0.5 shrink-0">
          <EventTypeIcon type={entry.eventType} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm leading-snug">{entry.assetName}</p>
          <p className="text-xs text-muted-foreground mt-1" data-testid={`site-status-${entry.lineId}`}>
            {siteStatusLabel}
          </p>
          {hasScheduledPickup && (
            <p className="text-xs text-muted-foreground mt-1" data-testid={`pickup-status-${entry.lineId}`}>
              Scheduled for Pickup
            </p>
          )}
          {entry.jobSiteId && (
            <p className="text-xs text-muted-foreground mt-1">
              Job Site: {entry.jobSiteId}
            </p>
          )}
          <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{dateLabel}</span>
          </div>
        </div>
        <div className="shrink-0">{statusBadge(entry)}</div>
      </CardContent>
    </Card>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (non-secure context or permissions denied);
      // fail silently — the URL is still visible in the browser address bar.
    }
  }, [url]);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void handleCopy()}
      data-testid="copy-link-button"
      aria-label="Copy shareable link"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          Copied!
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          Copy link
        </>
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Main screen (exported for testing)
// ---------------------------------------------------------------------------

export interface PortalScheduleScreenProps {
  contractId: string;
  /** Override the page URL for testing (defaults to window.location.href). */
  pageUrl?: string;
}

function extractPortalScopeToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('scope');
    return token && token.trim().length > 0 ? token.trim() : null;
  } catch {
    return null;
  }
}

export function PortalScheduleScreen({ contractId, pageUrl }: PortalScheduleScreenProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contract, setContract] = useState<ContractRow | null>(null);
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [requests, setRequests] = useState<OffRentRequest[]>([]);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [activeRequestLineId, setActiveRequestLineId] = useState<string | null>(null);
  const [activeRequestType, setActiveRequestType] = useState<CustomerRequestType>('off_rent_pickup');
  const [requestUrgency, setRequestUrgency] = useState<RequestUrgency>('standard');
  const [requestNote, setRequestNote] = useState('');
  const [requestHasPhotos, setRequestHasPhotos] = useState(false);
  const [missingContractContext, setMissingContractContext] = useState(false);
  const [submittingRequestKey, setSubmittingRequestKey] = useState<string | null>(null);

  const shareUrl = useMemo(
    () => pageUrl ?? (typeof window !== 'undefined' ? window.location.href : ''),
    [pageUrl]
  );
  const scopeToken = useMemo(() => extractPortalScopeToken(shareUrl), [shareUrl]);

  useEffect(() => {
    setIsLoading(true);
    setLoadError(null);
    setRequestMessage(null);
    setRequestError(null);
    loadPortalSchedule(contractId, scopeToken)
      .then(({ contract: c, entries: e, requests: r }) => {
        setContract(c);
        setEntries(e);
        setRequests(r);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load schedule.');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [contractId, scopeToken]);

  const contractLabel = contract?.contract_number?.trim() || toHumanReadableFallback(contractId, 'Contract');
  const requestByLineAndType = useMemo(() => {
    const map = new Map<string, OffRentRequest>();
    for (const request of requests) {
      const key = `${request.lineId}:${request.requestType}`;
      if (!map.has(key)) {
        map.set(key, request);
      }
    }
    return map;
  }, [requests]);

  const handleSubmitCustomerRequest = useCallback(async (entry: ScheduleEntry) => {
    if (!scopeToken) {
      setRequestError('Missing or invalid portal scope token.');
      return;
    }

    const requestKey = `${entry.lineId}:${activeRequestType}`;
    setSubmittingRequestKey(requestKey);
    setRequestError(null);
    setRequestMessage(null);

    const requestedAt = new Date().toISOString();
    const selectedType = REQUEST_TYPE_OPTIONS.find((item) => item.value === activeRequestType);
    const trimmedRequestNote = requestNote.trim();
    const payload = {
      contract_id: contractId,
      contract_line_id: entry.lineId,
      asset_id: entry.assetId,
      job_site_id: entry.jobSiteId,
      request_type: activeRequestType,
      status: 'requested',
      urgency: requestUrgency,
      reason: trimmedRequestNote.length > 0
        ? trimmedRequestNote
        : `Customer requested ${selectedType?.label.toLowerCase() ?? 'service follow-up'} from portal schedule`,
      customer_note: trimmedRequestNote,
      has_supporting_photos: requestHasPhotos,
      missing_contract_context: missingContractContext,
      requested_at: requestedAt,
      source: 'portal_schedule',
    };

    try {
      const { data, error } = await supabase.rpc('portal_submit_customer_service_request', {
        p_contract_id: contractId,
        p_contract_line_id: entry.lineId,
        p_scope_token: scopeToken,
        p_request_type: payload.request_type,
        p_urgency: payload.urgency,
        p_reason: payload.reason,
        p_customer_note: payload.customer_note,
        p_has_supporting_photos: payload.has_supporting_photos,
        p_missing_contract_context: payload.missing_contract_context,
      });

      if (error) throw new Error(error.message);

      const createdId = Array.isArray(data) && data[0] && typeof data[0].request_id === 'string'
        ? data[0].request_id
        : null;
      if (!createdId) {
        throw new Error('Off-rent request could not be confirmed.');
      }
      const createdRequest: OffRentRequest = {
        id: createdId,
        lineId: entry.lineId,
        assetId: entry.assetId,
        contractId,
        jobSiteId: entry.jobSiteId,
        status: 'requested',
        requestType: payload.request_type,
        urgency: payload.urgency,
        reason: payload.reason,
        customerNote: payload.customer_note,
        hasSupportingPhotos: payload.has_supporting_photos,
        missingContractContext: payload.missing_contract_context,
        evidenceGaps: [
          ...(payload.has_supporting_photos ? [] : ['supporting_photos_missing']),
          ...(payload.missing_contract_context ? ['contract_context_missing'] : []),
          ...(payload.request_type === 'field_service' && payload.customer_note.length === 0 ? ['service_symptoms_missing'] : []),
        ],
        recommendedDisposition: recommendedDispositionForRequestType(payload.request_type),
        requiresHumanApproval: true,
        requestedAt,
      };
      setRequests((previous) => [
        createdRequest,
        ...previous.filter((request) => `${request.lineId}:${request.requestType}` !== requestKey),
      ]);
      setRequestMessage(`${selectedType?.label ?? 'Customer request'} submitted for ${entry.assetName}. Branch review remains human approved.`);
      setActiveRequestLineId(null);
      setRequestNote('');
      setRequestUrgency('standard');
      setRequestHasPhotos(false);
      setMissingContractContext(false);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Unable to create customer request.');
    } finally {
      setSubmittingRequestKey(null);
    }
  }, [activeRequestType, contractId, missingContractContext, requestHasPhotos, requestNote, requestUrgency, scopeToken]);

  return (
    <div className="min-h-screen bg-background" data-testid="portal-schedule-page">
      {/* Minimal portal header */}
      <header className="border-b bg-card px-4 py-3 flex items-center gap-3 shadow-sm">
        <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center shrink-0">
          <Truck className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">Delivery &amp; Pickup Schedule</p>
          {!isLoading && (
            <p className="text-xs text-muted-foreground truncate" data-testid="contract-label">
              Contract: {contractLabel}
            </p>
          )}
        </div>
        <CopyLinkButton url={shareUrl} />
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {isLoading && (
          <p className="text-sm text-muted-foreground" data-testid="loading-indicator">
            Loading schedule…
          </p>
        )}

        {!isLoading && loadError && (
          <Alert variant="destructive" data-testid="load-error">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Unable to load schedule</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {!isLoading && !loadError && entries.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="empty-state">
            No delivery or pickup events are currently scheduled for this contract.
          </p>
        )}

        {!isLoading && !loadError && entries.length > 0 && (
          <div className="space-y-3" data-testid="schedule-list">
            {entries.map((entry) => (
              <div key={entry.lineId} className="space-y-2">
                <ScheduleEntryCard entry={entry} />
                {(entry.lineStatus === 'checked_out' || REQUEST_TYPE_OPTIONS.some((option) => requestByLineAndType.has(`${entry.lineId}:${option.value}`))) && (
                  <div className="space-y-2 pl-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {REQUEST_TYPE_OPTIONS.map((option) => {
                        const key = `${entry.lineId}:${option.value}`;
                        const existing = requestByLineAndType.get(key);
                        if (existing) {
                          return (
                            <Badge
                              key={key}
                              className="bg-amber-100 text-amber-800 hover:bg-amber-100"
                              data-testid={`customer-requested-${entry.lineId}-${option.value}`}
                            >
                              {option.label} queued · {existing.urgency}
                            </Badge>
                          );
                        }

                        return (
                          <Button
                            key={key}
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setActiveRequestLineId(entry.lineId);
                              setActiveRequestType(option.value);
                            }}
                            data-testid={`customer-request-${entry.lineId}-${option.value}`}
                          >
                            {option.buttonLabel}
                          </Button>
                        );
                      })}
                    </div>

                    {activeRequestLineId === entry.lineId && (
                      <div className="space-y-2 rounded-md border bg-muted/40 p-3" data-testid={`customer-request-form-${entry.lineId}`}>
                        <div className="space-y-1">
                          <label className="text-xs font-medium" htmlFor={`request-type-${entry.lineId}`}>Request type</label>
                          <select
                            id={`request-type-${entry.lineId}`}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            value={activeRequestType}
                            onChange={(event) => setActiveRequestType(event.target.value as CustomerRequestType)}
                            data-testid={`request-type-${entry.lineId}`}
                          >
                            {REQUEST_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium" htmlFor={`request-urgency-${entry.lineId}`}>Urgency</label>
                          <select
                            id={`request-urgency-${entry.lineId}`}
                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                            value={requestUrgency}
                            onChange={(event) => setRequestUrgency(event.target.value as RequestUrgency)}
                            data-testid={`request-urgency-${entry.lineId}`}
                          >
                            <option value="critical">Critical</option>
                            <option value="high">High</option>
                            <option value="standard">Standard</option>
                            <option value="low">Low</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium" htmlFor={`request-note-${entry.lineId}`}>Notes for branch review</label>
                          <textarea
                            id={`request-note-${entry.lineId}`}
                            className="min-h-20 w-full rounded-md border bg-background px-2 py-1 text-sm"
                            value={requestNote}
                            onChange={(event) => setRequestNote(event.target.value)}
                            placeholder="Add context, symptoms, or jobsite constraints."
                            data-testid={`request-note-${entry.lineId}`}
                          />
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={requestHasPhotos}
                              onChange={(event) => setRequestHasPhotos(event.target.checked)}
                              data-testid={`request-photos-${entry.lineId}`}
                            />
                            Supporting photos included
                          </label>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={missingContractContext}
                              onChange={(event) => setMissingContractContext(event.target.checked)}
                              data-testid={`request-missing-context-${entry.lineId}`}
                            />
                            Contract context is incomplete and needs branch follow-up
                          </label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void handleSubmitCustomerRequest(entry)}
                            disabled={submittingRequestKey === `${entry.lineId}:${activeRequestType}`}
                            data-testid={`submit-customer-request-${entry.lineId}`}
                          >
                            {submittingRequestKey === `${entry.lineId}:${activeRequestType}` ? 'Submitting…' : 'Submit request'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActiveRequestLineId(null)}
                            data-testid={`cancel-customer-request-${entry.lineId}`}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!isLoading && !loadError && requestMessage && (
          <Alert data-testid="customer-request-success">
            <AlertTitle>Request recorded</AlertTitle>
            <AlertDescription>{requestMessage}</AlertDescription>
          </Alert>
        )}

        {!isLoading && !loadError && requestError && (
          <Alert variant="destructive" data-testid="customer-request-error">
            <AlertTitle>Unable to submit customer request</AlertTitle>
            <AlertDescription>{requestError}</AlertDescription>
          </Alert>
        )}
      </main>
    </div>
  );
}
