/**
 * Monthly Branch Performance Pack Route
 *
 * Operating-model tag: branch-operations-manager:t7
 * Task: Assemble the branch performance and exception pack for monthly regional review.
 */

import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UIEngine } from '@/engine';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import { useDataSources } from '@/engine/useDataSources';
import type { PageDefinition } from '@/engine/types';
import {
  BRANCH_PERFORMANCE_PACK_SOURCES,
  BRANCH_PERFORMANCE_PACK_TAG,
  buildMonthlyBranchPack,
} from '@/lib/reporting/branch-performance-pack';

export const Route = createFileRoute('/branch/monthly-pack')({
  component: MonthlyBranchPackPage,
});

const PACK_HEADER_PAGE: PageDefinition = {
  id: 'branch-monthly-pack-header',
  title: 'Monthly Branch Performance Pack',
  state: {},
  dataSources: {},
  layout: {
    type: 'Stack',
    props: { spacing: 1 },
    children: [
      {
        type: 'Heading',
        props: { level: 1, children: 'Monthly Branch Performance Pack' },
      },
      {
        type: 'Text',
        props: {
          variant: 'muted',
          children:
            'Automatically assembled from existing branch utilization, exception, and corrective-action sources for monthly regional review. Manager edits and approves interpretation before distribution.',
        },
      },
    ],
  },
};

const MANAGER_COMMENTARY_STORAGE_KEY = 'branch-monthly-pack-manager-commentary';

function formatCurrency(value: number | null): string {
  if (value === null) return 'N/A';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function buildBranchAvailabilityHref(branchId: string): string | null {
  const normalizedBranchId = branchId.trim();
  if (!normalizedBranchId || normalizedBranchId === 'unknown-branch') {
    return null;
  }

  const params = new URLSearchParams({ branch_id: normalizedBranchId });
  return `/rental/availability?${params.toString()}`;
}

export function MonthlyBranchPackScreen() {
  const [managerCommentary, setManagerCommentary] = useState(() => {
    try {
      return window.sessionStorage.getItem(MANAGER_COMMENTARY_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const packSources = useDataSources(BRANCH_PERFORMANCE_PACK_SOURCES, createExpressionContext());

  const isAnyLoading = Object.values(packSources.isLoading).some(Boolean);

  const monthlyPack = buildMonthlyBranchPack(
    packSources.data.branch_utilization,
    packSources.data.asset_analytics,
    packSources.data.work_orders,
    packSources.data.inspection_exceptions,
    packSources.data.pm_due_assets,
  );

  const loadErrors = Object.entries(packSources.errors)
    .filter(([, err]) => err != null)
    .map(([key, err]) => ({ key, message: (err as Error).message || 'Load error' }));

  useEffect(() => {
    try {
      if (managerCommentary) {
        window.sessionStorage.setItem(MANAGER_COMMENTARY_STORAGE_KEY, managerCommentary);
      } else {
        window.sessionStorage.removeItem(MANAGER_COMMENTARY_STORAGE_KEY);
      }
    } catch {
      // sessionStorage unavailable — skip persistence silently
    }
  }, [managerCommentary]);

  return (
    <div className="space-y-6">
      <UIEngine page={PACK_HEADER_PAGE} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {BRANCH_PERFORMANCE_PACK_TAG}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Pack generated: {new Date(monthlyPack.packGeneratedAt).toLocaleString()}
        </span>
      </div>

      <Alert variant="warning">
        <AlertTitle>Human approval required before regional distribution</AlertTitle>
        <AlertDescription>
          Interpretation, commitments, and sign-off on the pack remain with the branch manager.
          This tool assembles and formats the supporting evidence; it does not approve or
          distribute it.
        </AlertDescription>
      </Alert>

      {/* Source load errors */}
      {loadErrors.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>One or more data sources could not be loaded</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {loadErrors.map(({ key, message }) => (
                <li key={key}>
                  <span className="font-medium">{key}:</span> {message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Pack-level source exceptions — only rendered once all sources have finished loading
          and no source has errored, to avoid false "returned no rows" alerts during fetch */}
      {!isAnyLoading && loadErrors.length === 0 && monthlyPack.packSourceExceptions.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Missing or stale source exceptions</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {monthlyPack.packSourceExceptions.map((exception) => (
                <li key={exception}>{exception}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Section 1: Branch Performance Metrics */}
      <section aria-label="Branch performance metrics">
        <Card>
          <CardHeader>
            <CardTitle>Branch Performance Metrics</CardTitle>
            <CardDescription>
              Utilization and on-rent counts per branch from the branch utilization reporting view.
              Source: v_branch_utilization.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.branch_utilization ? (
              <p className="text-sm text-muted-foreground">Loading branch performance metrics...</p>
            ) : packSources.errors.branch_utilization ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load branch utilization</AlertTitle>
                <AlertDescription>
                  {(packSources.errors.branch_utilization as Error).message ||
                    'Please refresh and try again.'}
                </AlertDescription>
              </Alert>
            ) : monthlyPack.performanceMetrics.length === 0 ? (
              <Alert variant="warning">
                <AlertTitle>No branch performance data found</AlertTitle>
                <AlertDescription>
                  The branch utilization source returned no rows. The performance section cannot be
                  assembled — verify the reporting view is populated.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {monthlyPack.performanceMetrics.map((metric) => {
                  const branchAvailabilityHref = buildBranchAvailabilityHref(metric.branchId);

                  return (
                    <div key={metric.branchId} className="rounded-lg border p-4 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{metric.branchName}</p>
                        <Badge variant="secondary">{metric.onRentCount} on rent</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Utilization:{' '}
                        {metric.utilizationRatePct !== null
                          ? `${metric.utilizationRatePct}%`
                          : 'unavailable'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Last updated: {metric.lastUpdated || 'unknown'}
                      </p>
                      {metric.sourceException ? (
                        <Alert variant="warning" className="mt-2">
                          <AlertTitle>Source exception</AlertTitle>
                          <AlertDescription>{metric.sourceException}</AlertDescription>
                        </Alert>
                      ) : null}
                      {branchAvailabilityHref ? (
                        <Link
                          to={branchAvailabilityHref as never}
                          className="text-sm text-primary underline underline-offset-4"
                        >
                          Review branch availability
                        </Link>
                      ) : (
                        <p className="text-sm text-muted-foreground">Branch scope unavailable</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 2: Notable Exceptions */}
      <section aria-label="Notable exceptions">
        <Card>
          <CardHeader>
            <CardTitle>Notable Exceptions</CardTitle>
            <CardDescription>
              Failed inspections, overdue or pre-due preventive maintenance, and high-downtime
              assets assembled from inspection, PM, and asset analytics sources.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.inspection_exceptions ||
            packSources.isLoading.pm_due_assets ||
            packSources.isLoading.asset_analytics ? (
              <p className="text-sm text-muted-foreground">Loading exceptions...</p>
            ) : monthlyPack.exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No exceptions were surfaced from the current source data.
              </p>
            ) : (
              monthlyPack.exceptions.map((exception) => (
                <div key={exception.id} className="rounded-lg border p-4 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{exception.label}</p>
                    <Badge variant={exception.severity === 'critical' ? 'destructive' : 'secondary'}>
                      {exception.severity === 'critical' ? 'Critical' : 'Warning'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {exception.category === 'inspection'
                      ? 'Failed inspection'
                      : exception.category === 'pm_due'
                        ? 'Preventive maintenance'
                        : 'High downtime'}{' '}
                    · Asset {exception.assetId || 'unknown'}
                  </p>
                  <p className="text-sm text-muted-foreground">{exception.detail}</p>
                  {exception.missingSourceReason ? (
                    <Alert variant="warning" className="mt-2">
                      <AlertTitle>Missing source data</AlertTitle>
                      <AlertDescription>{exception.missingSourceReason}</AlertDescription>
                    </Alert>
                  ) : null}
                  {exception.sourceRef ? (
                    <div className="mt-2">
                      <Link
                        to={exception.sourceRef as never}
                        className="text-sm text-primary underline underline-offset-4"
                      >
                        Open source record
                      </Link>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 3: Corrective Actions */}
      <section aria-label="Corrective actions">
        <Card>
          <CardHeader>
            <CardTitle>Corrective Actions — Open Work Orders</CardTitle>
            <CardDescription>
              Open maintenance work orders from the work-order billing view, ordered by estimated
              cost. Source: v_maintenance_work_order_billing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.work_orders ? (
              <p className="text-sm text-muted-foreground">Loading corrective actions...</p>
            ) : packSources.errors.work_orders ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load work orders</AlertTitle>
                <AlertDescription>
                  {(packSources.errors.work_orders as Error).message ||
                    'Please refresh and try again.'}
                </AlertDescription>
              </Alert>
            ) : monthlyPack.correctiveActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open maintenance work orders found in the current source data.
              </p>
            ) : (
              monthlyPack.correctiveActions.map((action) => (
                <div key={action.workOrderId} className="rounded-lg border p-4 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{action.name}</p>
                    <Badge variant="outline">{action.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Asset {action.assetId || 'unknown'} · Estimated:{' '}
                    {formatCurrency(action.estimatedCost)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last updated: {action.lastUpdated || 'unknown'}
                  </p>
                  {action.missingSourceReason ? (
                    <Alert variant="warning" className="mt-2">
                      <AlertTitle>Missing source data</AlertTitle>
                      <AlertDescription>{action.missingSourceReason}</AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-4 text-sm">
                    <Link
                      to={`/entities/maintenance_record/${action.workOrderId}` as never}
                      className="text-primary underline underline-offset-4"
                    >
                      Open work order
                    </Link>
                    {action.assetId ? (
                      <Link
                        to={`/entities/asset/${action.assetId}` as never}
                        className="text-primary underline underline-offset-4"
                      >
                        Open asset record
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 4: Manager Commentary */}
      <section aria-label="Manager commentary and commitments">
        <Card>
          <CardHeader>
            <CardTitle>Manager Commentary & Commitments</CardTitle>
            <CardDescription>
              Editable area for the branch manager to record interpretation, corrective commitments,
              and context before the pack is shared for regional review. This section is not
              auto-populated — it remains under manager control.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert variant="warning">
              <AlertTitle>Manager sign-off required</AlertTitle>
              <AlertDescription>
                Complete this section before distributing the pack for regional review. Commitments
                and interpretations recorded here are the responsibility of the signing manager.
              </AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor="manager-commentary">Commentary and corrective commitments</Label>
              <Textarea
                id="manager-commentary"
                placeholder="Record performance interpretation, exception context, and any corrective commitments here before distributing for regional review..."
                value={managerCommentary}
                onChange={(e) => setManagerCommentary(e.target.value)}
                rows={8}
                className="resize-y"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Commentary is saved in this browser session so reloads do not drop the regional-review
              handoff context, but it is not automatically transmitted or shared outside this pack.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function MonthlyBranchPackPage() {
  return <MonthlyBranchPackScreen />;
}
