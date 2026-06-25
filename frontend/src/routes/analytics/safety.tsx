import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import { useDataSources } from '@/engine/useDataSources';
import {
  SAFETY_COMPLIANCE_PACK_SOURCES,
  SAFETY_COMPLIANCE_PACK_TAGS,
  buildSafetyAuditFindings,
  buildSafetyCorrectiveActions,
  buildSafetyLeadershipKpiPack,
} from '@/lib/reporting/safety-compliance-pack';

export const Route = createFileRoute('/analytics/safety')({
  component: SafetyCompliancePackPage,
});

export function SafetyCompliancePackScreen() {
  const packSources = useDataSources(
    SAFETY_COMPLIANCE_PACK_SOURCES,
    createExpressionContext(),
  );

  const auditFindings = buildSafetyAuditFindings(packSources.data.audit_findings);
  const correctiveActions = buildSafetyCorrectiveActions(
    packSources.data.corrective_action_candidates,
  );
  const kpiPack = buildSafetyLeadershipKpiPack(
    packSources.data.audit_findings,
    packSources.data.corrective_action_candidates,
    packSources.data.driver_behavior_summary,
    packSources.data.driver_behavior_exceptions,
  );

  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-label="Safety compliance pack heading">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">
            Safety audit closure and KPI pack
          </h1>
          <p className="text-sm text-muted-foreground">
            Review audit findings, corrective-action blockers, training gaps, and
            driver-behavior signals in one monthly control pack draft.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {SAFETY_COMPLIANCE_PACK_TAGS.map((tag) => (
            <Badge key={tag} variant="outline" className="font-mono text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      </section>

      <Alert variant="warning">
        <AlertTitle>Human approval remains required</AlertTitle>
        <AlertDescription>
          Severity judgments, branch escalations, and corrective-action disposition
          stay human-approved. This workspace drafts the control pack and preserves
          the supporting source links.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Audit findings workspace</CardTitle>
            <CardDescription>
              Highlights overdue findings, repeat patterns, and unresolved evidence gaps
              from the current audit feed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.audit_findings ? (
              <p className="text-sm text-muted-foreground">Loading audit findings...</p>
            ) : packSources.errors.audit_findings ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load audit findings</AlertTitle>
                <AlertDescription>
                  {packSources.errors.audit_findings.message || 'Please refresh and try again.'}
                </AlertDescription>
              </Alert>
            ) : auditFindings.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No audit findings are currently surfaced.
              </p>
            ) : (
              auditFindings.map((finding) => (
                <div key={finding.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{finding.findingType}</p>
                    <Badge variant={finding.isOverdue ? 'destructive' : 'secondary'}>
                      {finding.status}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Scope: {finding.scopeLabel}
                    {finding.customerName ? ` · ${finding.customerName}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{finding.severity}</Badge>
                    {finding.isOverdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    {finding.isRepeatFinding ? <Badge variant="default">Repeat finding</Badge> : null}
                    {finding.evidenceGapReason ? <Badge variant="secondary">Evidence gap</Badge> : null}
                  </div>
                  {finding.evidenceGapReason ? (
                    <Alert variant="warning">
                      <AlertTitle>Evidence gap</AlertTitle>
                      <AlertDescription>{finding.evidenceGapReason}</AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex flex-wrap gap-4 text-sm">
                    <a href={finding.findingPath} className="text-primary underline underline-offset-4">
                      Open finding detail
                    </a>
                    {finding.auditPath ? (
                      <a href={finding.auditPath} className="text-primary underline underline-offset-4">
                        Open audit trail
                      </a>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Corrective-action and training blockers</CardTitle>
            <CardDescription>
              Keeps blocked certification or readiness items visible until a human
              closes the corrective action.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {packSources.isLoading.corrective_action_candidates ? (
              <p className="text-sm text-muted-foreground">Loading corrective actions...</p>
            ) : packSources.errors.corrective_action_candidates ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to load corrective actions</AlertTitle>
                <AlertDescription>
                  {packSources.errors.corrective_action_candidates.message || 'Please refresh and try again.'}
                </AlertDescription>
              </Alert>
            ) : correctiveActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No blocked corrective actions are currently surfaced.
              </p>
            ) : (
              correctiveActions.map((action) => (
                <div key={action.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{action.projectName}</p>
                    <Badge variant={action.isOverdue ? 'destructive' : 'secondary'}>
                      {action.readinessState}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">Asset: {action.assetName}</p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{action.blockerCount} blockers</Badge>
                    {action.hasRepeatBlocker ? <Badge variant="default">Repeat blocker</Badge> : null}
                    {action.isOverdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    {action.evidenceGapReason ? <Badge variant="secondary">Source gap</Badge> : null}
                  </div>
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {action.blockerSummary.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                  {action.evidenceGapReason ? (
                    <Alert variant="warning">
                      <AlertTitle>Source gap</AlertTitle>
                      <AlertDescription>{action.evidenceGapReason}</AlertDescription>
                    </Alert>
                  ) : null}
                  <div className="flex flex-wrap gap-4 text-sm">
                    {action.projectPath ? (
                      <a href={action.projectPath} className="text-primary underline underline-offset-4">
                        Open project
                      </a>
                    ) : null}
                    {action.assetPath ? (
                      <a href={action.assetPath} className="text-primary underline underline-offset-4">
                        Open asset
                      </a>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Leadership KPI pack draft</CardTitle>
            <CardDescription>
              Drafts monthly rollups from audits, training readiness, and driver-behavior
              sources while calling out missing or stale upstream data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Open audit findings</p>
                <p className="text-2xl font-semibold">{kpiPack.openAuditFindings}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Overdue corrective actions</p>
                <p className="text-2xl font-semibold">{kpiPack.overdueCorrectiveActions}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Repeat findings</p>
                <p className="text-2xl font-semibold">{kpiPack.repeatFindings}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Training / certification gaps</p>
                <p className="text-2xl font-semibold">{kpiPack.blockedTrainingOrCertificationItems}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">HOS out-of-hours</p>
                <p className="text-2xl font-semibold">{kpiPack.hosOutOfHoursCount}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">Missing HOS logs</p>
                <p className="text-2xl font-semibold">{kpiPack.hosMissingLogCount}</p>
              </div>
            </div>

            {kpiPack.sourceExceptions.length > 0 ? (
              <Alert variant="warning">
                <AlertTitle>Missing or stale source data</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-5">
                    {kpiPack.sourceExceptions.map((exception) => (
                      <li key={exception}>{exception}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {kpiPack.focusAreas.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No focus areas were automatically recommended from the current source data.
              </p>
            ) : (
              <div className="space-y-3">
                {kpiPack.focusAreas.map((focusArea) => (
                  <div key={focusArea.id} className="rounded-lg border p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{focusArea.title}</p>
                      <Badge variant="outline">Human decision required</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{focusArea.summary}</p>
                    <p className="text-sm">{focusArea.decisionNote}</p>
                    {focusArea.sourceLinks.length > 0 ? (
                      <div className="flex flex-col gap-2 text-sm">
                        {focusArea.sourceLinks.map((sourceLink) => (
                          <a
                            key={`${focusArea.id}-${sourceLink.href}`}
                            href={sourceLink.href}
                            className="text-primary underline underline-offset-4"
                          >
                            {sourceLink.label}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SafetyCompliancePackPage() {
  return <SafetyCompliancePackScreen />;
}
