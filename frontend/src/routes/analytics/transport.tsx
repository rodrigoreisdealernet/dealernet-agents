/**
 * Weekly Market Transport Control Pack Route
 *
 * Assembles the logistics KPI package and highlights DOT, HOS, and DVIR
 * exception patterns that need human corrective action.
 *
 * Operating-model tags:
 *   market-logistics-dispatcher:t5 — DOT/HOS/DVIR compliance exception review (assist)
 *   market-logistics-dispatcher:t6 — Weekly/monthly logistics KPI pack assembly (automate)
 *
 * Agentic posture:
 *   - KPI assembly is automated; the dispatcher interprets and escalates.
 *   - Compliance exception surfacing is assist; the dispatcher decides on corrective action.
 *   - Human approval remains required for disciplinary, compliance, or status-changing follow-up.
 */

import { Link, createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UIEngine } from '@/engine';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import { useDataSources } from '@/engine/useDataSources';
import marketTransportControlPackPage from '@/pages/market-transport-control-pack.json';
import type { PageDefinition } from '@/engine/types';
import {
  buildComplianceExceptionCards,
  buildWeeklyTransportKpiPack,
  type DispatchRouteLiveRow,
  MARKET_TRANSPORT_PACK_SOURCES,
  MARKET_TRANSPORT_PACK_TAGS,
} from '@/lib/reporting/market-transport-pack';

export const Route = createFileRoute('/analytics/transport')({
  component: MarketTransportControlPackPage,
});

const EXCEPTION_TYPE_BADGE: Record<string, { label: string; variant: 'destructive' | 'secondary' | 'default' | 'outline' }> = {
  eld_violation: { label: 'ELD violation', variant: 'destructive' },
  eld_warning: { label: 'ELD warning', variant: 'default' },
  hos_out_of_hours: { label: 'HOS — out of hours', variant: 'destructive' },
  hos_missing: { label: 'HOS — log missing', variant: 'default' },
  dvir_unsafe: { label: 'DVIR — unsafe', variant: 'destructive' },
  dvir_defect: { label: 'DVIR — defects', variant: 'default' },
  stop_exception: { label: 'Stop exception', variant: 'secondary' },
};

interface RouteFollowUpLink {
  id: string;
  label: string;
  href: string | null;
  context: string;
}

export function MarketTransportControlPackScreen() {
  const packSources = useDataSources(MARKET_TRANSPORT_PACK_SOURCES, createExpressionContext());

  const weeklyKpiPack = buildWeeklyTransportKpiPack(
    packSources.data.transport_efficiency_summary,
    packSources.data.overdue_routes,
  );

  const complianceExceptions = buildComplianceExceptionCards(
    packSources.data.hos_exceptions,
    packSources.data.dvir_exceptions,
    packSources.data.stop_exceptions,
  );

  const overdueRouteLinks = buildRouteFollowUpLinks(packSources.data.overdue_routes);
  const missingDriverLinks = buildRouteFollowUpLinks(packSources.data.missing_driver_routes);
  const staleTelemetryLinks = buildRouteFollowUpLinks(packSources.data.stale_telemetry_routes);

  return (
    <div className="space-y-6">
      <UIEngine page={marketTransportControlPackPage as PageDefinition} />

      <section className="space-y-6" aria-label="Market transport control pack">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Market transport control pack</h2>
          <p className="text-sm text-muted-foreground">
            Weekly assembly of logistics KPIs and compliance exception patterns from dispatch,
            telematics, DVIR, and stop-exception sources.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {MARKET_TRANSPORT_PACK_TAGS.map((tag) => (
              <Badge key={tag} variant="outline" className="font-mono text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </div>

        <Alert variant="warning">
          <AlertTitle>Human approval remains required</AlertTitle>
          <AlertDescription>
            Disciplinary, compliance, status-changing, and corrective-action follow-up for drivers,
            trucks, and branches stay human-approved even when this pack assembles the supporting
            evidence automatically.
          </AlertDescription>
        </Alert>

        <div className="grid gap-6 xl:grid-cols-3">
          {/* ── Weekly logistics KPI pack (t6) ───────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Weekly logistics KPI pack</CardTitle>
              <CardDescription>
                Automatically assembled from dispatch efficiency, overdue-route, and ELD
                feeds. Outside-haul spend requires a separate BI export and is flagged
                when unavailable.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {packSources.isLoading.transport_efficiency_summary ? (
                <p className="text-sm text-muted-foreground">Loading transport KPI summary...</p>
              ) : packSources.errors.transport_efficiency_summary ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load transport KPI summary</AlertTitle>
                  <AlertDescription>
                    {packSources.errors.transport_efficiency_summary.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {weeklyKpiPack.sourceExceptions.length > 0 ? (
                    <Alert variant="warning">
                      <AlertTitle>Missing or incomplete source data</AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc pl-5">
                          {weeklyKpiPack.sourceExceptions.map((exception) => (
                            <li key={exception}>{exception}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {weeklyKpiPack.outsideHaulFeedMissing ? (
                    <Alert variant="warning">
                      <AlertTitle>Outside-haul spend feed not available</AlertTitle>
                      <AlertDescription>
                        Outside-haul spend requires a BI or dispatch export that is not yet
                        connected. Reconcile the live route queues first, then pull the
                        manual export before presenting to branch or operations leaders.
                        <Link
                          to="/dispatch/live"
                          className="text-primary underline underline-offset-4"
                        >
                          {' '}Open dispatch live board
                        </Link>
                        .
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">Total routes in scope</p>
                      <p className="text-2xl font-semibold">{weeklyKpiPack.totalRoutes}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Current weekly dispatch load that still needs a clean operator readout.
                      </p>
                    </div>
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">On-time delivery rate</p>
                      <p className="text-2xl font-semibold">
                        {weeklyKpiPack.onTimePct !== null ? `${weeklyKpiPack.onTimePct}%` : '—'}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {weeklyKpiPack.onTimePct === null
                          ? 'Waiting on enough route outcomes to confirm whether dispatch is recovering or slipping.'
                          : weeklyKpiPack.onTimePct >= 90
                            ? 'Currently holding a healthy service window — keep exception queues from pulling this down.'
                            : 'Below the good-service bar right now — dispatch should work the overdue and telemetry queues first.'}
                      </p>
                    </div>
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">Load utilization</p>
                      <p className="text-2xl font-semibold">
                        {weeklyKpiPack.loadUtilizationPct !== null ? `${weeklyKpiPack.loadUtilizationPct}%` : '—'}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {weeklyKpiPack.loadUtilizationPct === null
                          ? 'Utilization is missing from the current summary feed.'
                          : weeklyKpiPack.loadUtilizationPct >= 85
                            ? 'Routes are currently well loaded — protect this by clearing blocker queues quickly.'
                            : 'Under-loaded routes remain in the mix — review exceptions before escalating capacity concerns.'}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3">
                    <KpiActionCard
                      title="Overdue returns"
                      count={weeklyKpiPack.overdueCount}
                      badgeLabel={weeklyKpiPack.overdueCount > 0 ? 'Action now' : 'Queue clear'}
                      badgeVariant={weeklyKpiPack.overdueCount > 0 ? 'destructive' : 'outline'}
                      summary={
                        weeklyKpiPack.overdueCount > 0
                          ? `${weeklyKpiPack.overdueCount} route${weeklyKpiPack.overdueCount === 1 ? '' : 's'} still need a handback or branch follow-up before the weekly pack is trustworthy.`
                          : 'No overdue returns are surfaced right now.'
                      }
                      links={overdueRouteLinks}
                      actionLabelPrefix="Open overdue route"
                      fallbackText={
                        weeklyKpiPack.overdueCount > 0
                          ? 'The KPI summary shows overdue work, but the sample route list is missing. Reconcile overdue exceptions directly on the live dispatch board.'
                          : 'Use the live dispatch board to confirm the overdue queue stays clear through handoff.'
                      }
                    />

                    <KpiActionCard
                      title="Missing driver assignments"
                      count={weeklyKpiPack.missingDriverCount}
                      badgeLabel={weeklyKpiPack.missingDriverCount > 0 ? 'Dispatch block' : 'Covered'}
                      badgeVariant={weeklyKpiPack.missingDriverCount > 0 ? 'destructive' : 'outline'}
                      summary={
                        weeklyKpiPack.missingDriverCount > 0
                          ? `${weeklyKpiPack.missingDriverCount} route${weeklyKpiPack.missingDriverCount === 1 ? '' : 's'} still lack a named driver, so the branch cannot execute cleanly yet.`
                          : 'Driver coverage is currently complete for the sampled queue.'
                      }
                      links={missingDriverLinks}
                      actionLabelPrefix="Open missing-driver route"
                      fallbackText={
                        weeklyKpiPack.missingDriverCount > 0
                          ? 'The summary flags missing-driver work, but the route-level feed is incomplete. Open dispatch live and work the missing-driver queue directly.'
                          : 'Open dispatch live if you need to double-check the latest assignment refresh before closing the pack.'
                      }
                    />

                    <KpiActionCard
                      title="Stale position telemetry"
                      count={weeklyKpiPack.stalePositionCount}
                      badgeLabel={weeklyKpiPack.stalePositionCount > 0 ? 'Telemetry gap' : 'Feed fresh'}
                      badgeVariant={weeklyKpiPack.stalePositionCount > 0 ? 'default' : 'outline'}
                      summary={
                        weeklyKpiPack.stalePositionCount > 0
                          ? `${weeklyKpiPack.stalePositionCount} route${weeklyKpiPack.stalePositionCount === 1 ? '' : 's'} no longer have fresh GPS evidence, so dispatch may be working blind.`
                          : 'Telemetry is currently fresh enough to support dispatcher follow-up.'
                      }
                      links={staleTelemetryLinks}
                      actionLabelPrefix="Open telemetry case"
                      fallbackText={
                        weeklyKpiPack.stalePositionCount > 0
                          ? 'The summary reports stale telemetry, but the sampled route list is unavailable. Open the live dispatch board and confirm the telemetry gap before escalating.'
                          : 'Keep the live board open during handoff if you need another telemetry refresh.'
                      }
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* ── DOT / ELD compliance summary ────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>DOT / ELD compliance summary</CardTitle>
              <CardDescription>
                ELD warnings and violations from the live dispatch feed.
                Decide which exceptions need corrective action before they become audit or safety failures.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {packSources.isLoading.transport_efficiency_summary ? (
                <p className="text-sm text-muted-foreground">Loading ELD compliance summary...</p>
              ) : packSources.errors.transport_efficiency_summary ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load ELD compliance summary</AlertTitle>
                  <AlertDescription>
                    {packSources.errors.transport_efficiency_summary.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">ELD violations</p>
                    <p className="text-2xl font-semibold">{weeklyKpiPack.eldViolationCount}</p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">ELD warnings</p>
                    <p className="text-2xl font-semibold">{weeklyKpiPack.eldWarningCount}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── HOS / DVIR + stop exceptions (t5) ───────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>HOS, DVIR, and stop exception review</CardTitle>
              <CardDescription>
                Materially new DOT, HOS, and DVIR exception patterns that warrant
                dispatcher or branch follow-up. Each card includes source evidence.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(packSources.isLoading.hos_exceptions || packSources.isLoading.dvir_exceptions || packSources.isLoading.stop_exceptions) ? (
                <p className="text-sm text-muted-foreground">Loading compliance exceptions...</p>
              ) : (packSources.errors.hos_exceptions || packSources.errors.dvir_exceptions || packSources.errors.stop_exceptions) ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load compliance exceptions</AlertTitle>
                  <AlertDescription>
                    {(packSources.errors.hos_exceptions ?? packSources.errors.dvir_exceptions ?? packSources.errors.stop_exceptions)?.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : complianceExceptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open compliance exceptions are currently surfaced.</p>
              ) : (
                complianceExceptions.map((exception) => {
                  const badge = EXCEPTION_TYPE_BADGE[exception.exceptionType] ?? {
                    label: exception.exceptionType,
                    variant: 'secondary' as const,
                  };
                  return (
                    <div
                      key={exception.id}
                      className="rounded-lg border p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{exception.label}</p>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                      {exception.sourceRef ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          Source: {exception.sourceRef}
                        </p>
                      ) : null}
                      {exception.date ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          Date: {exception.date}
                        </p>
                      ) : null}
                      {exception.detail ? (
                        <p className="mt-1 text-sm text-muted-foreground">{exception.detail}</p>
                      ) : null}
                      {exception.missingSourceReason ? (
                        <Alert variant="warning" className="mt-3">
                          <AlertTitle>Missing source data</AlertTitle>
                          <AlertDescription>
                            Cannot support a corrective-action recommendation until {exception.missingSourceReason}.
                          </AlertDescription>
                        </Alert>
                      ) : null}
                      {exception.reviewPath ? (
                        <div className="mt-3 flex flex-wrap gap-4 text-sm">
                          <Link
                            to={exception.reviewPath as never}
                            className="text-primary underline underline-offset-4"
                          >
                            Open source record
                          </Link>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

function MarketTransportControlPackPage() {
  return <MarketTransportControlPackScreen />;
}

function KpiActionCard({
  title,
  count,
  badgeLabel,
  badgeVariant,
  summary,
  links,
  actionLabelPrefix,
  fallbackText,
}: {
  title: string;
  count: number;
  badgeLabel: string;
  badgeVariant: 'destructive' | 'secondary' | 'default' | 'outline';
  summary: string;
  links: RouteFollowUpLink[];
  actionLabelPrefix: string;
  fallbackText: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-semibold">{count}</p>
        </div>
        <Badge variant={badgeVariant}>{badgeLabel}</Badge>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{summary}</p>

      {links.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {links.map((link) => (
            <li key={link.id} className="rounded-md bg-muted/30 p-3">
              {link.href ? (
                <Link
                  to={link.href as never}
                  className="text-sm font-medium text-primary underline underline-offset-4"
                >
                  {actionLabelPrefix} — {link.label}
                </Link>
              ) : (
                <p className="text-sm font-medium">{link.label}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">{link.context}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">
          {fallbackText}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <Link
          to="/dispatch/live"
          className="text-primary underline underline-offset-4"
        >
          Open dispatch live board
        </Link>
      </div>
    </div>
  );
}

function buildRouteFollowUpLinks(routes: unknown): RouteFollowUpLink[] {
  if (!Array.isArray(routes)) return [];

  return (routes as DispatchRouteLiveRow[])
    .slice(0, 3)
    .map((route, index) => {
      const href = route.line_id
        ? `/entities/rental_contract_line/${route.line_id}`
        : route.contract_id
          ? `/rental/contracts/${route.contract_id}`
          : null;

      const label = route.asset_name
        ?? route.line_id
        ?? route.contract_id
        ?? route.branch_id
        ?? `Route sample ${index + 1}`;

      const contextParts: string[] = [];
      if (route.branch_id) contextParts.push(`Branch ${route.branch_id}`);
      contextParts.push(route.assigned_driver ? `Driver ${route.assigned_driver}` : 'Driver unassigned');
      if (route.assigned_truck) contextParts.push(`Truck ${route.assigned_truck}`);
      if (route.telemetry_position_status) contextParts.push(`GPS ${route.telemetry_position_status}`);
      if (route.telemetry_event_at) contextParts.push(`Last ping ${route.telemetry_event_at}`);

      return {
        id: route.line_id ?? route.contract_id ?? route.asset_id ?? `route-follow-up-${index}`,
        label,
        href,
        context: contextParts.join(' · ') || 'Route-level follow-up is available on the live board.',
      };
    });
}
