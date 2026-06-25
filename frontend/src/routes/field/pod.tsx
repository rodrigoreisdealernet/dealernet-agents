/**
 * Stop Proof-of-Delivery / Proof-of-Collection Read Surface
 *
 * Branch and driver-facing view of the completed evidence bundle for a single
 * route stop.  Scoped to show only the evidence captured at that stop —
 * signature, condition notes, photos, timestamps, and the linked rental/asset
 * context.  No fleet, route, or driver identity data is exposed.
 *
 * Access:
 *   field_operator — their own completed stops only
 *   branch_manager / admin — all completed stops
 *
 * Query param: ?stop=<stop_id>  (UUID of the completed route stop)
 */

import { useEffect, useState } from 'react';
import { createFileRoute, useSearch } from '@tanstack/react-router';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Image,
  MapPin,
  Package,
  Truck,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/auth/AuthContext';
import { canOperate } from '@/auth/types';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PodBundle = {
  stopId: string;
  stopType: 'delivery' | 'pickup';
  customerName: string | null;
  jobSiteName: string | null;
  address: string | null;
  contractLineId: string | null;
  assetId: string | null;
  signature: string | null;
  conditionNotes: string | null;
  photoPaths: string[];
  completedAt: string | null;
  evidenceStatus: 'complete' | 'needs_review';
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export async function loadStopPod(stopId: string): Promise<PodBundle | null> {
  const { data, error } = await supabase.rpc('get_stop_pod', {
    p_stop_id: stopId,
  });
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  const raw = data as Record<string, unknown>;
  return {
    stopId: raw.stop_id as string,
    stopType: (raw.stop_type as 'delivery' | 'pickup') ?? 'delivery',
    customerName: (raw.customer_name as string | null) ?? null,
    jobSiteName: (raw.job_site_name as string | null) ?? null,
    address: (raw.address as string | null) ?? null,
    contractLineId: (raw.contract_line_id as string | null) ?? null,
    assetId: (raw.asset_id as string | null) ?? null,
    signature: (raw.signature as string | null) ?? null,
    conditionNotes: (raw.condition_notes as string | null) ?? null,
    photoPaths: (raw.photo_paths as string[]) ?? [],
    completedAt: (raw.completed_at as string | null) ?? null,
    evidenceStatus: (raw.evidence_status as 'complete' | 'needs_review') ?? 'needs_review',
  };
}

function formatDatetime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/field/pod')({
  component: StopPodScreen,
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StopPodScreen() {
  const { profile } = useAuth();
  const userCanOperate = canOperate(profile?.role);

  // TanStack Router — read the `stop` search param.
  const search = useSearch({ from: '/field/pod' }) as { stop?: string };
  const stopId = search.stop ?? null;

  const [bundle, setBundle] = useState<PodBundle | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!userCanOperate) {
      setIsLoading(false);
      return;
    }

    if (!stopId) {
      setIsLoading(false);
      setNotFound(true);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setNotFound(false);

    loadStopPod(stopId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setNotFound(true);
        } else {
          setBundle(result);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load proof record.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [stopId, userCanOperate]);

  if (!userCanOperate) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>
            Your account does not have permission to view proof records.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-10 sm:space-y-6 sm:p-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-xl sm:text-2xl">Stop Proof Record</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            Evidence captured at stop completion — scoped to this stop only.
          </p>
        </CardHeader>
      </Card>

      {/* ── Loading / error / not-found ────────────────────────────────────── */}
      {isLoading && (
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading proof record…
        </p>
      )}
      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Could not load proof record</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {!isLoading && !loadError && notFound && (
        <Alert>
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Proof record not found</AlertTitle>
          <AlertDescription>
            No completed evidence bundle was found for this stop. The stop may not have been
            completed yet, or proof capture may not have been performed.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Evidence bundle ────────────────────────────────────────────────── */}
      {!isLoading && !loadError && bundle && (
        <>
          {/* Evidence status banner */}
          {bundle.evidenceStatus === 'needs_review' ? (
            <Alert className="border-amber-400 bg-amber-50 text-amber-900">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              <AlertTitle className="text-sm font-semibold">Needs review</AlertTitle>
              <AlertDescription className="text-xs">
                Evidence is incomplete — signature was not captured at completion. Branch review is
                required before this stop can be considered fully proven.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert className="border-green-400 bg-green-50 text-green-900">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              <AlertTitle className="text-sm font-semibold">Evidence complete</AlertTitle>
              <AlertDescription className="text-xs">
                Signature and completion timestamp captured. This stop is dispute-ready.
              </AlertDescription>
            </Alert>
          )}

          {/* Stop context */}
          <Card>
            <CardHeader className="p-4 sm:p-5">
              <div className="flex items-center gap-2">
                {bundle.stopType === 'delivery' ? (
                  <Truck className="h-4 w-4 text-blue-600" aria-hidden="true" />
                ) : (
                  <Package className="h-4 w-4 text-amber-600" aria-hidden="true" />
                )}
                <CardTitle className="text-base">Stop context</CardTitle>
                <Badge
                  className={
                    bundle.stopType === 'delivery'
                      ? 'bg-blue-100 text-blue-800 hover:bg-blue-100'
                      : 'bg-amber-100 text-amber-800 hover:bg-amber-100'
                  }
                >
                  {bundle.stopType === 'delivery' ? 'Delivery' : 'Pickup'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 px-4 pb-4 pt-0 sm:px-5 sm:pb-5">
              {bundle.customerName && (
                <div className="flex items-start gap-2 text-sm">
                  <span className="w-28 shrink-0 text-muted-foreground">Customer</span>
                  <span className="font-medium">{bundle.customerName}</span>
                </div>
              )}
              {bundle.jobSiteName && (
                <div className="flex items-start gap-2 text-sm">
                  <span className="w-28 shrink-0 text-muted-foreground">Job site</span>
                  <span>{bundle.jobSiteName}</span>
                </div>
              )}
              {bundle.address && (
                <div className="flex items-start gap-2 text-sm">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="text-muted-foreground">{bundle.address}</span>
                </div>
              )}
              {bundle.assetId && (
                <div className="flex items-start gap-2 text-sm">
                  <span className="w-28 shrink-0 text-muted-foreground">Asset</span>
                  <span className="font-mono text-xs">{bundle.assetId}</span>
                </div>
              )}
              {bundle.contractLineId && (
                <div className="flex items-start gap-2 text-sm">
                  <span className="w-28 shrink-0 text-muted-foreground">Contract line</span>
                  <span className="font-mono text-xs">{bundle.contractLineId}</span>
                </div>
              )}
              <div className="flex items-start gap-2 text-sm">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="text-muted-foreground">
                  Completed {formatDatetime(bundle.completedAt)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Captured evidence */}
          <Card>
            <CardHeader className="p-4 sm:p-5">
              <CardTitle className="text-base">Captured evidence</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 px-4 pb-4 pt-0 sm:px-5 sm:pb-5">
              {/* Signature */}
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Customer / receiver signature
                </p>
                {bundle.signature ? (
                  <p
                    className="rounded border bg-muted/40 px-3 py-2 text-sm font-medium"
                    aria-label="Captured signature"
                  >
                    {bundle.signature}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">Not captured</p>
                )}
              </div>

              {/* Condition notes */}
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Condition / delivery notes
                </p>
                {bundle.conditionNotes ? (
                  <p className="whitespace-pre-wrap rounded border bg-muted/40 px-3 py-2 text-sm">
                    {bundle.conditionNotes}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">None recorded</p>
                )}
              </div>

              {/* Photos */}
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Photos
                </p>
                {bundle.photoPaths.length > 0 ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Image className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span>
                      {bundle.photoPaths.length} photo{bundle.photoPaths.length !== 1 ? 's' : ''}{' '}
                      attached
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No photos attached</p>
                )}
              </div>

              {/* Evidence status summary */}
              <div className="border-t pt-3">
                <div className="flex items-center gap-2">
                  {bundle.evidenceStatus === 'complete' ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
                  )}
                  <span className="text-sm font-medium">
                    {bundle.evidenceStatus === 'complete'
                      ? 'Dispute-ready audit bundle'
                      : 'Incomplete — branch review required'}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
