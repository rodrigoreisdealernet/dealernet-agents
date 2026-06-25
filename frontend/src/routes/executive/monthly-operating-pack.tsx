/**
 * Monthly Executive Operating Pack Route
 *
 * Operating-model tag: operations-executive:t2
 * Task: Assemble the monthly operating pack for leadership or board review
 *       from branch P&L, utilization, uptime, and exception data.
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
  EXECUTIVE_OPERATING_PACK_SOURCES,
  EXECUTIVE_OPERATING_PACK_TAG,
  buildExecutiveOperatingPack,
} from '@/lib/reporting/executive-operating-pack';

export const Route = createFileRoute('/executive/monthly-operating-pack')({
  component: ExecutiveMonthlyOperatingPackPage,
});

const PACK_HEADER_PAGE: PageDefinition = {
  id: 'executive-monthly-operating-pack-header',
  title: 'Monthly Executive Operating Pack',
  state: {},
  dataSources: {},
  layout: {
    type: 'Stack',
    props: { spacing: 1 },
    children: [
      {
        type: 'Heading',
        props: { level: 1, children: 'Monthly Executive Operating Pack' },
      },
      {
        type: 'Text',
        props: {
          variant: 'muted',
          children:
            'Automatically assembled from existing cross-branch P&L, utilization, uptime, and exception sources for monthly leadership and board review. Interpretation, commitments, and sign-off remain with the executive.',
        },
      },
    ],
  },
};

const EXECUTIVE_COMMENTARY_STORAGE_KEY = 'executive-monthly-operating-pack-commentary';

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function ExecutiveMonthlyOperatingPackScreen() {
  const [executiveCommentary, setExecutiveCommentary] = useState(() => {
    try {
      return window.sessionStorage.getItem(EXECUTIVE_COMMENTARY_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });

  const packSources = useDataSources(EXECUTIVE_OPERATING_PACK_SOURCES, createExpressionContext());

  const isAnyLoading = Object.values(packSources.isLoading).some(Boolean);

  const operatingPack = buildExecutiveOperatingPack(
    packSources.data.branch_utilization,
    packSources.data.asset_analytics,
    packSources.data.inspection_exceptions,
    packSources.data.pm_due_assets,
  );

  const loadErrors = Object.entries(packSources.errors)
    .filter(([, err]) => err != null)
    .map(([key, err]) => ({ key, message: (err as Error).message || 'Load error' }));

  useEffect(() => {
    try {
      if (executiveCommentary) {
        window.sessionStorage.setItem(EXECUTIVE_COMMENTARY_STORAGE_KEY, executiveCommentary);
      } else {
        window.sessionStorage.removeItem(EXECUTIVE_COMMENTARY_STORAGE_KEY);
      }
    } catch {
      // sessionStorage unavailable — skip persistence silently
    }
  }, [executiveCommentary]);

  return (
    <div className="space-y-6">
      <UIEngine page={PACK_HEADER_PAGE} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {EXECUTIVE_OPERATING_PACK_TAG}
        </Badge>
        <span className="text-xs text-muted-foreground">
          Pack generated: {new Date(operatingPack.packGeneratedAt).toLocaleString()}
        </span>
      </div>

      <Alert variant="warning">
        <AlertTitle>Human sign-off required before distribution</AlertTitle>
        <AlertDescription>
          Interpretation, commitments, and approval of the pack remain with the executive.
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
      {!isAnyLoading && loadErrors.length === 0 && operatingPack.packSourceExceptions.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Missing or stale source inputs</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {operatingPack.packSourceExceptions.map((exception) => (
                <li key={exception}>{exception}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Section 1: Cross-Branch P&L Summary */}
      <section aria-label="Cross-branch P&L summary">
        <Card>
          <CardHeader>
            <CardTitle>Cross-Branch P&L Summary</CardTitle>
            <CardDescription>
              Total lifetime revenue and average asset ROI per branch, assembled from the asset
              analytics reporting view. Source: v_asset_analytics_current.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.asset_analytics ? (
              <p className="text-sm text-muted-foreground">Loading P&L summary...</p>
            ) : packSources.errors.asset_analytics ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load asset analytics</AlertTitle>
                <AlertDescription>
                  {(packSources.errors.asset_analytics as Error).message ||
                    'Please refresh and try again.'}
                </AlertDescription>
              </Alert>
            ) : operatingPack.plSummary.length === 0 ? (
              <Alert variant="warning">
                <AlertTitle>No P&L data found</AlertTitle>
                <AlertDescription>
                  The asset analytics source returned no rows. The P&L section cannot be assembled
                  — verify the reporting view is populated.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {operatingPack.plSummary.map((item) => (
                  <div key={item.branchName} className="rounded-lg border p-4 space-y-2">
                    <p className="font-medium">{item.branchName}</p>
                    <p className="text-sm text-muted-foreground">
                      Revenue: {formatCurrency(item.totalRevenue)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Avg ROI:{' '}
                      {item.avgRoiPct !== null ? `${item.avgRoiPct}%` : 'unavailable'}
                    </p>
                    <p className="text-xs text-muted-foreground">{item.assetCount} assets</p>
                    {item.sourceException ? (
                      <Alert variant="warning" className="mt-2">
                        <AlertTitle>Source exception</AlertTitle>
                        <AlertDescription>{item.sourceException}</AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 2: Network Utilization */}
      <section aria-label="Network utilization">
        <Card>
          <CardHeader>
            <CardTitle>Network Utilization</CardTitle>
            <CardDescription>
              On-rent counts and utilization rates across all branches from the branch utilization
              reporting view. Source: v_branch_utilization.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.branch_utilization ? (
              <p className="text-sm text-muted-foreground">Loading network utilization...</p>
            ) : packSources.errors.branch_utilization ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load branch utilization</AlertTitle>
                <AlertDescription>
                  {(packSources.errors.branch_utilization as Error).message ||
                    'Please refresh and try again.'}
                </AlertDescription>
              </Alert>
            ) : operatingPack.utilizationSummary.length === 0 ? (
              <Alert variant="warning">
                <AlertTitle>No utilization data found</AlertTitle>
                <AlertDescription>
                  The branch utilization source returned no rows. Verify the reporting view is
                  populated.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {operatingPack.utilizationSummary.map((item) => (
                  <div key={item.branchId} className="rounded-lg border p-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{item.branchName}</p>
                      <Badge variant="secondary">{item.onRentCount} on rent</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Utilization:{' '}
                      {item.utilizationRatePct !== null
                        ? `${item.utilizationRatePct}%`
                        : 'unavailable'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last updated: {item.lastUpdated || 'unknown'}
                    </p>
                    {item.sourceException ? (
                      <Alert variant="warning" className="mt-2">
                        <AlertTitle>Source exception</AlertTitle>
                        <AlertDescription>{item.sourceException}</AlertDescription>
                      </Alert>
                    ) : null}
                    <Link
                      to={`/rental/availability?branch_id=${encodeURIComponent(item.branchId)}` as never}
                      className="text-sm text-primary underline underline-offset-4"
                    >
                      Review branch availability
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 3: Fleet Uptime */}
      <section aria-label="Fleet uptime">
        <Card>
          <CardHeader>
            <CardTitle>Fleet Uptime — High Downtime Assets</CardTitle>
            <CardDescription>
              Top high-downtime assets across the network, ranked by total downtime minutes.
              Source: v_asset_analytics_current.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.asset_analytics ? (
              <p className="text-sm text-muted-foreground">Loading fleet uptime...</p>
            ) : operatingPack.uptimeSummary.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No high-downtime assets found in the current source data.
              </p>
            ) : (
              operatingPack.uptimeSummary.map((item) => (
                <div
                  key={item.assetId || item.assetName}
                  className="rounded-lg border p-4 space-y-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{item.assetName}</p>
                    <Badge variant="secondary">{item.totalDowntimeMinutes} min downtime</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Branch: {item.branchName || 'unknown'} · Downtime:{' '}
                    {item.downtimePct !== null ? `${item.downtimePct}%` : 'unavailable'} · ROI:{' '}
                    {item.roiStatus || 'unknown'}
                  </p>
                  {item.sourceException ? (
                    <Alert variant="warning" className="mt-2">
                      <AlertTitle>Source exception</AlertTitle>
                      <AlertDescription>{item.sourceException}</AlertDescription>
                    </Alert>
                  ) : null}
                  {item.sourceRef ? (
                    <div className="mt-2">
                      <Link
                        to={item.sourceRef as never}
                        className="text-sm text-primary underline underline-offset-4"
                      >
                        Open asset record
                      </Link>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      {/* Section 4: Notable Exceptions */}
      <section aria-label="Notable exceptions">
        <Card>
          <CardHeader>
            <CardTitle>Notable Exceptions</CardTitle>
            <CardDescription>
              Failed inspections and overdue or pre-due preventive maintenance items across the
              network, assembled from inspection and PM sources.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.inspection_exceptions || packSources.isLoading.pm_due_assets ? (
              <p className="text-sm text-muted-foreground">Loading notable exceptions...</p>
            ) : operatingPack.exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No exceptions were surfaced from the current source data.
              </p>
            ) : (
              operatingPack.exceptions.map((exception) => (
                <div key={exception.id} className="rounded-lg border p-4 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{exception.label}</p>
                    <Badge
                      variant={exception.severity === 'critical' ? 'destructive' : 'secondary'}
                    >
                      {exception.severity === 'critical' ? 'Critical' : 'Warning'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {exception.category === 'inspection'
                      ? 'Failed inspection'
                      : 'Preventive maintenance'}{' '}
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

      {/* Section 5: Executive Commentary */}
      <section aria-label="Executive commentary and commitments">
        <Card>
          <CardHeader>
            <CardTitle>Executive Commentary & Commitments</CardTitle>
            <CardDescription>
              Editable area for the executive to record narrative interpretation, corrective
              commitments, and context before the pack is shared for leadership or board review.
              This section is not auto-populated — it remains under executive control.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert variant="warning">
              <AlertTitle>Executive sign-off required</AlertTitle>
              <AlertDescription>
                Complete this section before distributing the pack for leadership or board review.
                Interpretation and commitments recorded here are the responsibility of the signing
                executive.
              </AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor="executive-commentary">Commentary and commitments</Label>
              <Textarea
                id="executive-commentary"
                placeholder="Record network performance interpretation, exception context, and any corrective commitments here before distributing for leadership or board review..."
                value={executiveCommentary}
                onChange={(e) => setExecutiveCommentary(e.target.value)}
                rows={8}
                className="resize-y"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Commentary is saved in this browser session so reloads do not drop the
              board-review handoff context, but it is not automatically transmitted or shared
              outside this pack.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function ExecutiveMonthlyOperatingPackPage() {
  return <ExecutiveMonthlyOperatingPackScreen />;
}
