/**
 * Fleet Utilization & Revenue Reporting Route
 */

import { Link, createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UIEngine } from '@/engine';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import { useDataSources } from '@/engine/useDataSources';
import fleetReportingDashboardPage from '@/pages/fleet-reporting-dashboard.json';
import type { PageDefinition } from '@/engine/types';
import {
  buildDispositionCaseCards,
  buildInspectionExceptionCards,
  buildWeeklyShopKpiPack,
  SERVICE_MAINTENANCE_PACK_TAGS,
  SERVICE_MAINTENANCE_PACK_SOURCES,
} from '@/lib/reporting/service-maintenance-pack';

export const Route = createFileRoute('/analytics/fleet')({
  component: FleetReportingDashboardPage,
});

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function FleetReportingDashboardScreen() {
  const serviceMaintenancePack = useDataSources(
    SERVICE_MAINTENANCE_PACK_SOURCES,
    createExpressionContext(),
  );

  const inspectionExceptions = buildInspectionExceptionCards(
    serviceMaintenancePack.data.inspection_exceptions,
  );
  const dispositionCases = buildDispositionCaseCards(
    serviceMaintenancePack.data.disposition_candidates,
    serviceMaintenancePack.data.maintenance_review_work_orders,
  );
  const weeklyKpiPack = buildWeeklyShopKpiPack(
    serviceMaintenancePack.data.pm_due_assets,
    serviceMaintenancePack.data.shop_category_downtime,
    serviceMaintenancePack.data.maintenance_review_work_orders,
    serviceMaintenancePack.data.inspection_exceptions,
  );

  return (
    <div className="space-y-6">
      <UIEngine page={fleetReportingDashboardPage as PageDefinition} />

      <section className="space-y-6" aria-label="Service and maintenance manager pack">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Inspection, repair disposition, and shop KPI pack</h2>
          <p className="text-sm text-muted-foreground">
            Review inspection exceptions, chronic-repair context, and weekly shop KPIs from existing
            inspection, maintenance, utilization, and reporting sources.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {SERVICE_MAINTENANCE_PACK_TAGS.map((tag) => (
              <Badge key={tag} variant="outline" className="font-mono text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </div>

        <Alert variant="warning">
          <AlertTitle>Human approval remains required</AlertTitle>
          <AlertDescription>
            Inspection pass/fail, rent-ready release, repair authorization, sale or retire decisions,
            and spend-significant commitments stay human-approved even when this pack assembles the
            supporting evidence automatically.
          </AlertDescription>
        </Alert>

        <div className="grid gap-6 xl:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Inspection exception review</CardTitle>
              <CardDescription>
                Failed inspections stay traceable to the source record before anyone approves
                rent-ready status.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {serviceMaintenancePack.isLoading.inspection_exceptions ? (
                <p className="text-sm text-muted-foreground">Loading inspection exceptions...</p>
              ) : serviceMaintenancePack.errors.inspection_exceptions ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load inspection exceptions</AlertTitle>
                  <AlertDescription>
                    {serviceMaintenancePack.errors.inspection_exceptions.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : inspectionExceptions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No failed inspection exceptions are currently surfaced.</p>
              ) : (
                inspectionExceptions.map((inspection) => (
                  <div
                    key={`${inspection.assetId}-${inspection.inspectionId || inspection.recordedAt || inspection.inspectionLabel}`}
                    className="rounded-lg border p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{inspection.inspectionLabel}</p>
                      <Badge variant="destructive">Review before rent-ready approval</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Asset {inspection.assetId} · Recorded {inspection.recordedAt || 'unknown'}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Audit ref {inspection.inspectionId || 'missing source record'}
                    </p>
                    {inspection.missingSourceReason ? (
                      <Alert variant="warning" className="mt-3">
                        <AlertTitle>Missing source data</AlertTitle>
                        <AlertDescription>
                          Cannot support a success-shaped rent-ready recommendation until {inspection.missingSourceReason}.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-4 text-sm">
                      {inspection.reviewPath ? (
                        <Link to={inspection.reviewPath as never} className="text-primary underline underline-offset-4">
                          Open inspection record
                        </Link>
                      ) : null}
                      <Link to={inspection.comparisonPath as never} className="text-primary underline underline-offset-4">
                        Compare inspections
                      </Link>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Repair disposition case context</CardTitle>
              <CardDescription>
                Chronic or high-cost units pair utilization history with tracked maintenance spend
                before repair, reposition, sale, or retire recommendations.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {serviceMaintenancePack.isLoading.disposition_candidates || serviceMaintenancePack.isLoading.maintenance_review_work_orders ? (
                <p className="text-sm text-muted-foreground">Loading repair disposition context...</p>
              ) : serviceMaintenancePack.errors.disposition_candidates ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load disposition candidates</AlertTitle>
                  <AlertDescription>
                    {serviceMaintenancePack.errors.disposition_candidates.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : serviceMaintenancePack.errors.maintenance_review_work_orders ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load maintenance spend context</AlertTitle>
                  <AlertDescription>
                    {serviceMaintenancePack.errors.maintenance_review_work_orders.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : dispositionCases.length === 0 ? (
                <p className="text-sm text-muted-foreground">No chronic or high-cost repair candidates are currently surfaced.</p>
              ) : (
                dispositionCases.map((repairCase) => (
                  <div key={repairCase.assetId} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{repairCase.assetName}</p>
                      <Badge variant="secondary">{repairCase.totalDowntimeMinutes} downtime min</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {repairCase.branchName} · {repairCase.categoryName}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Utilization {repairCase.utilizationPct ?? 'N/A'}% · Downtime {repairCase.downtimePct ?? 'N/A'}% · Revenue {formatCurrency(repairCase.lifetimeRevenue)}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      ROI {repairCase.roiPct !== null ? `${repairCase.roiPct}%` : 'Unavailable'} · Last order {repairCase.lastOrderAt || 'missing'}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Highest tracked work order {repairCase.workOrderName || 'missing'} · Status {repairCase.workOrderStatus || 'missing'} · Sell total {formatCurrency(repairCase.workOrderSellTotal || 0)}
                    </p>
                    {repairCase.missingSourceReasons.length > 0 ? (
                      <Alert variant="warning" className="mt-3">
                        <AlertTitle>Missing source data</AlertTitle>
                        <AlertDescription>
                          Do not auto-recommend disposition changes while {repairCase.missingSourceReasons.join('; ')}.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-4 text-sm">
                      <Link to={`/entities/asset/${repairCase.assetId}` as never} className="text-primary underline underline-offset-4">
                        Open asset record
                      </Link>
                      {repairCase.workOrderId ? (
                        <Link to={`/entities/maintenance_record/${repairCase.workOrderId}` as never} className="text-primary underline underline-offset-4">
                          Open maintenance work order
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Weekly shop KPI pack</CardTitle>
              <CardDescription>
                Automatically assembled from PM, maintenance billing, downtime, and inspection
                sources with explicit stale or missing-source exceptions.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {serviceMaintenancePack.isLoading.pm_due_assets || serviceMaintenancePack.isLoading.shop_category_downtime ? (
                <p className="text-sm text-muted-foreground">Loading weekly shop KPI pack...</p>
              ) : serviceMaintenancePack.errors.pm_due_assets ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load PM KPI inputs</AlertTitle>
                  <AlertDescription>
                    {serviceMaintenancePack.errors.pm_due_assets.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : serviceMaintenancePack.errors.shop_category_downtime ? (
                <Alert variant="destructive">
                  <AlertTitle>Unable to load downtime KPI inputs</AlertTitle>
                  <AlertDescription>
                    {serviceMaintenancePack.errors.shop_category_downtime.message || 'Please refresh and try again.'}
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {weeklyKpiPack.sourceExceptions.length > 0 ? (
                    <Alert variant="warning">
                      <AlertTitle>Missing or stale source exceptions</AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc pl-5">
                          {weeklyKpiPack.sourceExceptions.map((exception) => (
                            <li key={exception}>{exception}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">PM due now</p>
                      <p className="text-2xl font-semibold">{weeklyKpiPack.duePmCount}</p>
                    </div>
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">PM pre-due</p>
                      <p className="text-2xl font-semibold">{weeklyKpiPack.preDuePmCount}</p>
                    </div>
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">Inspection exceptions</p>
                      <p className="text-2xl font-semibold">{weeklyKpiPack.inspectionExceptionCount}</p>
                    </div>
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">Tracked maintenance spend</p>
                      <p className="text-2xl font-semibold">{formatCurrency(weeklyKpiPack.trackedMaintenanceSpend)}</p>
                    </div>
                    <div className="rounded-lg border p-4 sm:col-span-2">
                      <p className="text-sm text-muted-foreground">Category downtime minutes in pack scope</p>
                      <p className="text-2xl font-semibold">{weeklyKpiPack.categoryDowntimeMinutes}</p>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

function FleetReportingDashboardPage() {
  return <FleetReportingDashboardScreen />;
}
