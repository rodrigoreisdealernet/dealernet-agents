import { useMemo } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { createExpressionContext, useDataSources } from '@/engine';
import {
  buildCounterReviewCases,
  COUNTER_REVIEW_TAGS,
  type CounterReviewCase,
  type CounterReviewSignal,
} from '@/lib/counter-review';
import { counterReviewDataSources } from '@/lib/counter-review-data';

export const Route = createFileRoute('/rental/counter-review')({
  component: CounterReviewPage,
});

function severityClasses(signal: CounterReviewSignal): string {
  if (signal.severity === 'blocking') {
    return 'border-l-4 border-l-destructive bg-destructive/5';
  }
  if (signal.severity === 'opportunity') {
    return 'border-l-4 border-l-primary bg-primary/5';
  }
  return 'border-l-4 border-l-amber-500 bg-amber-500/5';
}

function severityBadgeVariant(signal: CounterReviewSignal): 'destructive' | 'secondary' | 'outline' {
  if (signal.severity === 'blocking') {
    return 'destructive';
  }
  if (signal.severity === 'opportunity') {
    return 'secondary';
  }
  return 'outline';
}

function signalSummary(cases: CounterReviewCase[]) {
  return cases.reduce(
    (summary, reviewCase) => {
      summary.account += reviewCase.accountSignals.length;
      summary.returns += reviewCase.returnSignals.length;
      summary.invoice += reviewCase.invoiceSignals.length;
      summary.sales += reviewCase.salesSignals.length;
      return summary;
    },
    { account: 0, returns: 0, invoice: 0, sales: 0 },
  );
}

function ReviewSection({ title, emptyText, signals }: { title: string; emptyText: string; signals: CounterReviewSignal[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        <Badge variant="outline">{signals.length}</Badge>
      </div>
      {signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="space-y-3">
          {signals.map((signal) => (
            <div key={`${signal.code}-${signal.routeHref}`} className={`rounded-lg border p-4 ${severityClasses(signal)}`}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{signal.title}</p>
                <Badge variant={severityBadgeVariant(signal)}>{signal.severity}</Badge>
                {signal.reviewMode === 'draft' ? <Badge variant="outline">Draft review only</Badge> : null}
              </div>
              <p className="mt-2 text-sm text-foreground/90">{signal.summary}</p>
              <p className="mt-2 text-sm text-muted-foreground">Counter action: {signal.humanAction}</p>
              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {signal.evidence.map((evidence) => (
                  <li key={`${signal.code}-${evidence.label}`}>
                    <span className="font-medium text-foreground">{evidence.label}:</span> {evidence.value}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {signal.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">{tag}</Badge>
                ))}
                <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" to={signal.routeHref as never}>
                  {signal.routeLabel}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function CounterReviewScreen() {
  const context = useMemo(() => createExpressionContext(), []);
  const { data, isLoading, errors } = useDataSources(counterReviewDataSources, context);

  const reviewCases = useMemo(() => buildCounterReviewCases({
    contracts: data.contracts as never,
    invoices: data.invoices as never,
    customerProfiles: data.customerProfiles as never,
    customerIssues: data.customerIssues as never,
    communicationTimeline: data.communicationTimeline as never,
    contractLines: data.contractLines as never,
  }), [data]);

  const summary = useMemo(() => signalSummary(reviewCases), [reviewCases]);
  const hasErrors = Object.values(errors).some(Boolean);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Assist only</Badge>
          <Badge variant="outline">Draft / pre-release review</Badge>
          {COUNTER_REVIEW_TAGS.map((tag) => (
            <Badge key={tag} variant="outline">{tag}</Badge>
          ))}
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Counter account, return, billing, and opportunity review</h1>
          <p className="max-w-4xl text-muted-foreground">
            Review account blockers, return exceptions, invoice anomalies, and outside-sales handoff context in one disposition-ready flow. This surface never overrides credit, releases invoices, closes return exceptions, or reassigns sales ownership automatically.
          </p>
        </div>
      </div>

      {hasErrors ? (
        <Alert>
          <AlertTitle>Unable to load every review signal</AlertTitle>
          <AlertDescription>
            The counter review may be incomplete. Keep manual exception handling in place for any missing finance, return, or customer-history context.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Account blockers</CardDescription>
            <CardTitle>{summary.account}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Return follow-ups</CardDescription>
            <CardTitle>{summary.returns}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Invoice anomalies</CardDescription>
            <CardTitle>{summary.invoice}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Sales handoffs</CardDescription>
            <CardTitle>{summary.sales}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {isLoading.contracts ? (
        <p className="text-sm text-muted-foreground">Loading counter review flow...</p>
      ) : null}

      {!isLoading.contracts && reviewCases.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No disposition blockers are currently surfaced</CardTitle>
            <CardDescription>
              Continue through the existing contract, returns, and billing workflows. Any missing account or billing inputs should still route through the manual exception path.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="space-y-4">
        {reviewCases.map((reviewCase) => (
          <Card key={reviewCase.id} data-testid={`counter-review-case-${reviewCase.id}`}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>{reviewCase.contractNumber}</CardTitle>
                  <CardDescription>
                    Customer: {reviewCase.customerName} · Contract status: {reviewCase.contractStatus}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">Contract</Badge>
                  {reviewCase.customerId ? <Badge variant="secondary">Customer linked</Badge> : <Badge variant="destructive">Customer missing</Badge>}
                  <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" to={`/rental/contracts/${reviewCase.contractId}` as never}>
                    Open contract
                  </Link>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              <ReviewSection
                title="Account review"
                emptyText="No account blockers surfaced for this contract."
                signals={reviewCase.accountSignals}
              />
              <ReviewSection
                title="Return intake"
                emptyText="No routed return exceptions surfaced for this contract."
                signals={reviewCase.returnSignals}
              />
              <ReviewSection
                title="Invoice closeout"
                emptyText="No invoice anomalies surfaced; keep any invoice output in draft/pre-release review until a human approves release."
                signals={reviewCase.invoiceSignals}
              />
              <ReviewSection
                title="Outside-sales handoff"
                emptyText="No outside-sales suggestion surfaced from current customer history."
                signals={reviewCase.salesSignals}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CounterReviewPage() {
  return <CounterReviewScreen />;
}
