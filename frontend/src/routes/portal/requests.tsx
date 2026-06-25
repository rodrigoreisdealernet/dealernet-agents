/**
 * Customer Portal – Self-Service Call-off & Extension Requests
 *
 * Authenticated route accessible only to verified customer contacts who have
 * signed in via a Supabase magic-link (portal_customer role, ADR-0043).
 *
 * URL: /portal/requests
 *
 * - Unauthenticated visitors: see an inline sign-in form (magic-link OTP).
 * - Authenticated portal_customer: sees eligible rental lines and can submit
 *   call-off or extension requests without directly mutating contract state.
 * - Ineligible lines (not checked_out) and out-of-scope contracts are silently
 *   filtered by the SECURITY DEFINER RPCs.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  LogIn,
  Package,
  Truck,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';
import { usePortalSession } from '@/hooks/usePortalSession';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/portal/requests')({
  component: PortalRequestsPage,
});

function PortalRequestsPage() {
  return <PortalRequestsScreen />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CustomerRequestType = 'off_rent_pickup' | 'contract_extension' | 'field_service';
type RequestUrgency = 'critical' | 'high' | 'standard' | 'low';

const REQUEST_TYPE_OPTIONS: Array<{ value: CustomerRequestType; label: string; buttonLabel: string }> = [
  { value: 'off_rent_pickup',    label: 'Pickup / call-off',  buttonLabel: 'Request pickup / call-off' },
  { value: 'contract_extension', label: 'Extension',          buttonLabel: 'Request extension review' },
  { value: 'field_service',      label: 'Field service',      buttonLabel: 'Request field service' },
];

type RentalLineRow = {
  contractEntityId: string;
  contractStatus: string | null;
  contractNumber: string | null;
  lineEntityId: string;
  lineStatus: string;
  lineAssetId: string;
  lineActualStart: string | null;
  lineActualEnd: string | null;
  lineData: Record<string, unknown> | null;
  assetName: string | null;
  assetStatus: string | null;
};

type ServiceRequest = {
  id: string;
  contractId: string;
  lineId: string;
  requestType: string;
  status: string;
  urgency: string;
  reason: string;
  customerNote: string;
  requestedAt: string;
};

// Raw RPC row shapes --------------------------------------------------------

type RawRentalRow = {
  contract_entity_id: string;
  contract_status: string | null;
  contract_number: string | null;
  line_entity_id: string | null;
  line_status: string | null;
  line_asset_id: string | null;
  line_actual_start: string | null;
  line_actual_end: string | null;
  line_data: Record<string, unknown> | null;
  asset_name: string | null;
  asset_status: string | null;
};

type RawRequestRow = {
  request_id: string;
  contract_id: string;
  contract_line_id: string;
  request_type: string | null;
  status: string | null;
  urgency: string | null;
  reason: string | null;
  customer_note: string | null;
  requested_at: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toHumanReadable(value: string, kind: 'Contract' | 'Asset'): string {
  const t = value.trim();
  return UUID_PATTERN.test(t) ? `${kind} ${t.slice(0, 8).toUpperCase()}` : t;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Not scheduled';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Not scheduled' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function mapRentalRows(rows: RawRentalRow[]): RentalLineRow[] {
  return rows
    .filter((r) => r.line_entity_id != null)
    .map((r) => ({
      contractEntityId: r.contract_entity_id,
      contractStatus: r.contract_status,
      contractNumber: r.contract_number,
      lineEntityId: r.line_entity_id!,
      lineStatus: r.line_status ?? '',
      lineAssetId: r.line_asset_id ?? '',
      lineActualStart: r.line_actual_start,
      lineActualEnd: r.line_actual_end,
      lineData: r.line_data,
      assetName: r.asset_name,
      assetStatus: r.asset_status,
    }));
}

function mapRequestRows(rows: RawRequestRow[]): ServiceRequest[] {
  return rows.map((r) => ({
    id: r.request_id,
    contractId: r.contract_id,
    lineId: r.contract_line_id,
    requestType: r.request_type ?? 'off_rent_pickup',
    status: r.status ?? 'requested',
    urgency: r.urgency ?? 'standard',
    reason: r.reason ?? '',
    customerNote: r.customer_note ?? '',
    requestedAt: r.requested_at ?? '',
  }));
}

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
// Sign-in panel (magic-link OTP)
// ---------------------------------------------------------------------------

export interface PortalSignInPanelProps {
  onSignInSuccess?: () => void;
}

export function PortalSignInPanel({ onSignInSuccess }: PortalSignInPanelProps) {
  const [email, setEmail] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }

    setIsSending(true);
    setError(null);

    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: trimmedEmail,
        options: { shouldCreateUser: false },
      });
      if (otpError) throw new Error(otpError.message);
      setSent(true);
      onSignInSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send sign-in link.');
    } finally {
      setIsSending(false);
    }
  }, [email, onSignInSuccess]);

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-4 py-8" data-testid="sign-in-sent">
        <CheckCircle2 className="h-10 w-10 text-green-600" aria-hidden="true" />
        <p className="text-center text-sm text-muted-foreground max-w-xs">
          A sign-in link has been sent to <strong>{email.trim()}</strong>. Check your inbox and click the link to continue.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" data-testid="portal-sign-in-form">
      <div className="space-y-1">
        <Label htmlFor="portal-email">Email address</Label>
        <Input
          id="portal-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSending}
          data-testid="portal-email-input"
        />
      </div>

      {error && (
        <Alert variant="destructive" data-testid="sign-in-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={isSending}
        data-testid="portal-sign-in-button"
      >
        {isSending ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
            Sending…
          </>
        ) : (
          <>
            <LogIn className="h-4 w-4 mr-2" aria-hidden="true" />
            Send sign-in link
          </>
        )}
      </Button>

      <p className="text-xs text-muted-foreground text-center">
        Portal access is for verified customer contacts only. Contact your Dealernet account manager if you need access.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Rental line request card
// ---------------------------------------------------------------------------

interface RequestCardProps {
  line: RentalLineRow;
  existingRequests: ServiceRequest[];
  onSubmit: (line: RentalLineRow, requestType: CustomerRequestType, urgency: RequestUrgency, note: string, hasPhotos: boolean, missingContext: boolean) => Promise<void>;
  isSubmitting: boolean;
}

function RequestCard({ line, existingRequests, onSubmit, isSubmitting }: RequestCardProps) {
  const [activeType, setActiveType] = useState<CustomerRequestType | null>(null);
  const [urgency, setUrgency] = useState<RequestUrgency>('standard');
  const [note, setNote] = useState('');
  const [hasPhotos, setHasPhotos] = useState(false);
  const [missingContext, setMissingContext] = useState(false);

  const assetLabel = line.assetName?.trim() || toHumanReadable(line.lineAssetId, 'Asset');
  const contractLabel = line.contractNumber?.trim() || toHumanReadable(line.contractEntityId, 'Contract');
  const isEligible = line.lineStatus === 'checked_out';

  const requestsByType = useMemo(() => {
    const map = new Map<string, ServiceRequest>();
    for (const r of existingRequests) {
      if (r.lineId === line.lineEntityId && !map.has(r.requestType)) {
        map.set(r.requestType, r);
      }
    }
    return map;
  }, [existingRequests, line.lineEntityId]);

  const scheduledDate =
    line.lineStatus === 'pending'
      ? (typeof line.lineData?.planned_start === 'string' ? line.lineData.planned_start : null)
      : (typeof line.lineData?.planned_end === 'string' ? line.lineData.planned_end : null);

  const handleSubmit = useCallback(async () => {
    if (!activeType) return;
    await onSubmit(line, activeType, urgency, note, hasPhotos, missingContext);
    setActiveType(null);
    setNote('');
    setUrgency('standard');
    setHasPhotos(false);
    setMissingContext(false);
  }, [activeType, hasPhotos, line, missingContext, note, onSubmit, urgency]);

  return (
    <Card data-testid={`rental-line-${line.lineEntityId}`}>
      <CardContent className="pt-4 pb-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">
            {line.lineStatus === 'pending' ? (
              <Truck className="h-5 w-5 text-blue-600" aria-hidden="true" />
            ) : line.lineStatus === 'checked_out' ? (
              <Package className="h-5 w-5 text-amber-600" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden="true" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm leading-snug">{assetLabel}</p>
            <p className="text-xs text-muted-foreground">{contractLabel}</p>
            {scheduledDate && (
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{formatDate(scheduledDate)}</span>
              </div>
            )}
          </div>
          <div className="shrink-0">
            {line.lineStatus === 'checked_out' && (
              <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">On Rent</Badge>
            )}
            {line.lineStatus === 'pending' && (
              <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Incoming</Badge>
            )}
            {line.lineStatus === 'returned' && (
              <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Returned</Badge>
            )}
          </div>
        </div>

        {isEligible && (
          <div className="space-y-2 pl-8">
            <div className="flex flex-wrap items-center gap-2">
              {REQUEST_TYPE_OPTIONS.map((option) => {
                const existing = requestsByType.get(option.value);
                if (existing) {
                  return (
                    <Badge
                      key={option.value}
                      className="bg-amber-100 text-amber-800 hover:bg-amber-100"
                      data-testid={`requested-${line.lineEntityId}-${option.value}`}
                    >
                      {option.label} queued · {existing.urgency}
                    </Badge>
                  );
                }
                return (
                  <Button
                    key={option.value}
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActiveType(option.value);
                    }}
                    data-testid={`request-${line.lineEntityId}-${option.value}`}
                  >
                    {option.buttonLabel}
                  </Button>
                );
              })}
            </div>

            {activeType !== null && (
              <div
                className="space-y-2 rounded-md border bg-muted/40 p-3"
                data-testid={`request-form-${line.lineEntityId}`}
              >
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor={`rtype-${line.lineEntityId}`}>Request type</label>
                  <select
                    id={`rtype-${line.lineEntityId}`}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={activeType}
                    onChange={(e) => setActiveType(e.target.value as CustomerRequestType)}
                    data-testid={`select-type-${line.lineEntityId}`}
                  >
                    {REQUEST_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor={`urgency-${line.lineEntityId}`}>Urgency</label>
                  <select
                    id={`urgency-${line.lineEntityId}`}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={urgency}
                    onChange={(e) => setUrgency(e.target.value as RequestUrgency)}
                    data-testid={`select-urgency-${line.lineEntityId}`}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="standard">Standard</option>
                    <option value="low">Low</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor={`note-${line.lineEntityId}`}>Notes for branch review</label>
                  <textarea
                    id={`note-${line.lineEntityId}`}
                    className="min-h-[72px] w-full rounded-md border bg-background px-2 py-1 text-sm"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Add context, symptoms, or jobsite constraints."
                    data-testid={`note-${line.lineEntityId}`}
                  />
                </div>

                <div className="flex flex-col gap-1 text-xs">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={hasPhotos}
                      onChange={(e) => setHasPhotos(e.target.checked)}
                      data-testid={`photos-${line.lineEntityId}`}
                    />
                    Supporting photos included
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={missingContext}
                      onChange={(e) => setMissingContext(e.target.checked)}
                      data-testid={`missing-context-${line.lineEntityId}`}
                    />
                    Contract context is incomplete and needs branch follow-up
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleSubmit()}
                    disabled={isSubmitting}
                    data-testid={`submit-request-${line.lineEntityId}`}
                  >
                    {isSubmitting ? 'Submitting…' : 'Submit request'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setActiveType(null)}
                    data-testid={`cancel-request-${line.lineEntityId}`}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main screen (exported for testing)
// ---------------------------------------------------------------------------

export function PortalRequestsScreen() {
  const portalSession = usePortalSession();
  const [lines, setLines] = useState<RentalLineRow[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [isDataLoading, setIsDataLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load rentals + existing requests once we have an authenticated portal session.
  useEffect(() => {
    if (portalSession.isLoading || !portalSession.isPortalCustomer) {
      setLines([]);
      setRequests([]);
      setLoadError(null);
      return;
    }

    setIsDataLoading(true);
    setLoadError(null);

    Promise.all([
      supabase.rpc('portal_get_authenticated_rentals'),
      supabase.rpc('portal_list_authenticated_service_requests'),
    ])
      .then(([rentalsResult, requestsResult]) => {
        if (rentalsResult.error) throw new Error(rentalsResult.error.message ?? 'Failed to load rentals.');
        if (requestsResult.error) throw new Error(requestsResult.error.message ?? 'Failed to load requests.');

        setLines(mapRentalRows((rentalsResult.data ?? []) as RawRentalRow[]));
        setRequests(mapRequestRows((requestsResult.data ?? []) as RawRequestRow[]));
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load portal data.');
      })
      .finally(() => {
        setIsDataLoading(false);
      });
  }, [portalSession.isLoading, portalSession.isPortalCustomer]);

  const handleSubmitRequest = useCallback(async (
    line: RentalLineRow,
    requestType: CustomerRequestType,
    urgency: RequestUrgency,
    note: string,
    hasPhotos: boolean,
    missingContext: boolean,
  ) => {
    setSubmitError(null);
    setSubmitMessage(null);
    setIsSubmitting(true);

    const trimmedNote = note.trim();
    const selectedType = REQUEST_TYPE_OPTIONS.find((o) => o.value === requestType);
    const requestedAt = new Date().toISOString();

    try {
      const { data, error } = await supabase.rpc('portal_submit_authenticated_service_request', {
        p_contract_id: line.contractEntityId,
        p_contract_line_id: line.lineEntityId,
        p_request_type: requestType,
        p_urgency: urgency,
        p_reason: trimmedNote.length > 0
          ? trimmedNote
          : `Customer requested ${selectedType?.label.toLowerCase() ?? 'service follow-up'} from portal`,
        p_customer_note: trimmedNote,
        p_has_supporting_photos: hasPhotos,
        p_missing_contract_context: missingContext,
      });

      if (error) throw new Error(error.message);

      const createdId =
        Array.isArray(data) && data[0] && typeof data[0].request_id === 'string'
          ? data[0].request_id
          : null;
      if (!createdId) throw new Error('Request could not be confirmed.');

      const newRequest: ServiceRequest = {
        id: createdId,
        contractId: line.contractEntityId,
        lineId: line.lineEntityId,
        requestType,
        status: 'requested',
        urgency,
        reason: trimmedNote,
        customerNote: trimmedNote,
        requestedAt,
      };

      setRequests((prev) => [
        newRequest,
        ...prev.filter((r) => !(r.lineId === line.lineEntityId && r.requestType === requestType)),
      ]);
      setSubmitMessage(
        `${selectedType?.label ?? 'Request'} submitted for ${line.assetName ?? toHumanReadable(line.lineAssetId, 'Asset')}. Branch review remains human approved.`
      );
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to submit request.');
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  // Unauthenticated state --------------------------------------------------
  if (!portalSession.isLoading && !portalSession.isPortalCustomer) {
    return (
      <div className="min-h-screen bg-background" data-testid="portal-requests-page">
        <header className="border-b bg-card px-4 py-3 flex items-center gap-3 shadow-sm">
          <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center shrink-0">
            <Truck className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold leading-tight">Rental Service Requests</p>
        </header>
        <main className="max-w-md mx-auto px-4 py-8">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Sign in to continue</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Enter your registered email address to receive a sign-in link for your rental account.
              </p>
              <PortalSignInPanel />
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  // Authenticated state ----------------------------------------------------
  const eligibleLines = lines.filter((l) => l.lineStatus === 'checked_out');

  return (
    <div className="min-h-screen bg-background" data-testid="portal-requests-page">
      <header className="border-b bg-card px-4 py-3 flex items-center gap-3 shadow-sm">
        <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center shrink-0">
          <Truck className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">Rental Service Requests</p>
          {portalSession.session?.user?.email && (
            <p className="text-xs text-muted-foreground truncate" data-testid="portal-user-email">
              {portalSession.session.user.email}
            </p>
          )}
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {(portalSession.isLoading || isDataLoading) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="loading-indicator">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading your rentals…
          </div>
        )}

        {!portalSession.isLoading && !isDataLoading && loadError && (
          <Alert variant="destructive" data-testid="load-error">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Unable to load rentals</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {!portalSession.isLoading && !isDataLoading && !loadError && eligibleLines.length === 0 && lines.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="empty-state">
            No active rentals found for your account. If you believe this is incorrect, please contact your branch.
          </p>
        )}

        {!portalSession.isLoading && !isDataLoading && !loadError && eligibleLines.length === 0 && lines.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="no-eligible-lines">
            Your current rentals are not yet eligible for self-service requests. Equipment must be checked out before a call-off or extension request can be submitted.
          </p>
        )}

        {!portalSession.isLoading && !isDataLoading && !loadError && eligibleLines.length > 0 && (
          <div className="space-y-3" data-testid="rental-lines-list">
            <p className="text-sm font-medium">Your active rentals</p>
            {eligibleLines.map((line) => (
              <RequestCard
                key={line.lineEntityId}
                line={line}
                existingRequests={requests.filter((r) => r.lineId === line.lineEntityId)}
                onSubmit={handleSubmitRequest}
                isSubmitting={isSubmitting}
              />
            ))}
          </div>
        )}

        {submitMessage && (
          <Alert data-testid="submit-success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Request recorded</AlertTitle>
            <AlertDescription data-testid="submit-success-message">{submitMessage}</AlertDescription>
          </Alert>
        )}

        {submitError && (
          <Alert variant="destructive" data-testid="submit-error">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Unable to submit request</AlertTitle>
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        {!portalSession.isLoading && !isDataLoading && !loadError && requests.length > 0 && (
          <div className="space-y-2 pt-2" data-testid="existing-requests-section">
            <p className="text-sm font-medium text-muted-foreground">Submitted requests</p>
            {requests.map((r) => (
              <Card key={r.id} className="border-l-4 border-l-amber-400" data-testid={`request-record-${r.id}`}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium capitalize">{r.requestType.replace(/_/g, ' ')}</p>
                    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 capitalize" data-testid={`request-status-${r.id}`}>
                      {r.status.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  {r.customerNote && (
                    <p className="text-xs text-muted-foreground mt-1">{r.customerNote}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    Urgency: {r.urgency} · {r.requestedAt ? formatDate(r.requestedAt) : 'Pending'}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export { recommendedDispositionForRequestType };
