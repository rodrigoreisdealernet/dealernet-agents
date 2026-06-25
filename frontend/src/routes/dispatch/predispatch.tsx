/**
 * Predispatch Staging Assistant Route
 *
 * Generates the next-run staging and exception list from dispatch, contract, and
 * yard-readiness signals. Validates contacts, addresses, delivery instructions, and
 * contract readiness before the truck departs.
 *
 * Operating-model tags: yard-logistics-coordinator:t2, yard-logistics-coordinator:t4
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/data/supabase';
import { buildPredispatchStagingList, PREDISPATCH_STAGING_TAGS } from '@/lib/predispatch-staging';
import type {
  PredispatchStagingResult,
  StagingException,
  StagingItem,
  DispatchLineRow,
  ContractSignalRow,
  YardReadinessRow,
} from '@/lib/predispatch-staging';

export const Route = createFileRoute('/dispatch/predispatch')({
  component: PredispatchStagingPage,
});

const DISPATCH_LINE_SELECT = [
  'entity_id',
  'contract_id',
  'asset_id',
  'category_id',
  'status',
  'actual_start',
  'actual_end',
  'data',
].join(', ');

const CONTRACT_SELECT = 'id, entity_versions!inner(data, is_current)';

const YARD_SELECT = [
  'activity_id',
  'lane_key',
  'contract_id',
  'contract_line_id',
  'asset_id',
  'asset_name',
  'asset_category_name',
  'job_site_id',
  'job_site_name',
  'customer_name',
  'branch_id',
  'scheduled_start_at',
  'sort_at',
].join(', ');

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

async function fetchLines(): Promise<DispatchLineRow[]> {
  const { data, error } = await supabase
    .from('v_rental_contract_line_current')
    .select(DISPATCH_LINE_SELECT)
    .eq('status', 'pending_execution');
  if (error) throw new Error(error.message || 'Unable to load dispatch lines.');
  return (data ?? []) as DispatchLineRow[];
}

async function fetchContracts(contractIds: string[]): Promise<ContractSignalRow[]> {
  if (contractIds.length === 0) return [];
  const { data, error } = await supabase
    .from('entities')
    .select(CONTRACT_SELECT)
    .eq('entity_type', 'rental_contract')
    .eq('entity_versions.is_current', true)
    .in('id', contractIds);
  if (error) throw new Error(error.message || 'Unable to load contract data.');
  return (data ?? []) as ContractSignalRow[];
}

async function fetchYardReadiness(): Promise<YardReadinessRow[]> {
  const { data, error } = await supabase
    .from('v_live_yard_activity_current')
    .select(YARD_SELECT)
    .eq('lane_key', 'going_out');
  if (error) throw new Error(error.message || 'Unable to load yard readiness.');
  return (data ?? []) as YardReadinessRow[];
}

function severityVariant(severity: StagingException['severity']): 'default' | 'destructive' | 'secondary' {
  switch (severity) {
    case 'blocking':
      return 'destructive';
    case 'warning':
      return 'secondary';
    default:
      return 'default';
  }
}

function StagingItemCard({ item }: { item: StagingItem }) {
  return (
    <div
      className={`rounded-lg border p-4 space-y-2 ${item.readyToStage ? '' : 'border-destructive/50 bg-destructive/5'}`}
      data-testid="staging-item"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{item.contractNumber}</h3>
            <Badge variant={item.readyToStage ? 'secondary' : 'destructive'}>
              {item.readyToStage ? 'Ready to stage' : 'Blocked'}
            </Badge>
            {item.exceptionCount > 0 ? (
              <Badge variant="outline">{item.exceptionCount} exception{item.exceptionCount !== 1 ? 's' : ''}</Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            {item.customerName ? <span>{item.customerName}</span> : null}
            {item.jobSiteName ? <span>· {item.jobSiteName}</span> : null}
            {item.categoryName ? <span>· {item.categoryName}</span> : null}
            {item.assetName ? <span>· {item.assetName}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {item.scheduledAt ? (
            <span className="text-muted-foreground">
              {new Date(item.scheduledAt).toLocaleString()}
            </span>
          ) : null}
          {item.contractId ? (
            <a
              className="text-primary underline-offset-4 hover:underline"
              href={item.routeHref}
              data-testid="staging-item-contract-link"
            >
              Open contract
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StagingExceptionCard({ exception: ex }: { exception: StagingException }) {
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="staging-exception">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{ex.title}</h3>
            <Badge variant={severityVariant(ex.severity)}>
              {ex.severity === 'blocking' ? 'Blocking' : 'Warning'}
            </Badge>
            {ex.tags.map((tag) => (
              <Badge key={tag} variant="outline">{tag}</Badge>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{ex.summary}</p>
        </div>
        {ex.contractId ? (
          <a
            className="shrink-0 text-sm text-primary underline-offset-4 hover:underline"
            href={ex.routeHref}
            data-testid="staging-exception-link"
          >
            {ex.contractNumber}
          </a>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Evidence</p>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {ex.evidence.map((ev, idx) => (
            <li key={`${ex.id}-${idx}`}>
              <span className="font-medium text-foreground">{ev.label}:</span>{' '}
              {ev.value}
            </li>
          ))}
        </ul>
      </div>

      <Alert>
        <AlertTitle>Required action</AlertTitle>
        <AlertDescription data-testid="staging-exception-action">{ex.humanAction}</AlertDescription>
      </Alert>
    </div>
  );
}

function PredispatchStagingPanel({ result, onRegenerate, isLoading }: {
  result: PredispatchStagingResult;
  onRegenerate: () => void;
  isLoading: boolean;
}) {
  const blockingCount = result.exceptions.filter((e) => e.severity === 'blocking').length;
  const warningCount = result.exceptions.filter((e) => e.severity === 'warning').length;

  return (
    <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="predispatch-staging-panel">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle>Predispatch Staging List</CardTitle>
              <CardDescription>
                Next-run staging and exception list built from dispatch, contract, and yard-readiness signals.
                Blocking exceptions must be resolved before the run is released.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {PREDISPATCH_STAGING_TAGS.map((tag) => (
                <Badge key={tag} variant="outline">{tag}</Badge>
              ))}
              <Button variant="outline" size="sm" onClick={onRegenerate} disabled={isLoading}>
                {isLoading ? 'Refreshing…' : 'Refresh list'}
              </Button>
            </div>
          </div>
          {!result.noOp ? (
            <div className="flex flex-wrap gap-2 pt-2">
              <Badge variant="outline">{result.items.length} line{result.items.length !== 1 ? 's' : ''}</Badge>
              {blockingCount > 0 ? (
                <Badge variant="destructive">{blockingCount} blocking exception{blockingCount !== 1 ? 's' : ''}</Badge>
              ) : null}
              {warningCount > 0 ? (
                <Badge variant="secondary">{warningCount} warning{warningCount !== 1 ? 's' : ''}</Badge>
              ) : null}
              {blockingCount === 0 && warningCount === 0 ? (
                <Badge variant="secondary">No exceptions</Badge>
              ) : null}
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-6">
          {result.noOp ? (
            <Alert>
              <AlertTitle>No pending dispatch lines in the current window</AlertTitle>
              <AlertDescription>
                No contract lines with status pending_execution were found within the next 2-day dispatch window.
                Use the refresh button to regenerate after adding new lines.
              </AlertDescription>
            </Alert>
          ) : null}

          {!result.noOp && result.items.length > 0 ? (
            <div className="space-y-4">
              <h2 className="text-base font-semibold">Staging Queue</h2>
              <div className="space-y-3">
                {result.items.map((item) => (
                  <StagingItemCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          ) : null}

          {!result.noOp && result.exceptions.length > 0 ? (
            <div className="space-y-4">
              <h2 className="text-base font-semibold">Exception Queue</h2>
              <p className="text-sm text-muted-foreground">
                Each exception below preserves the source evidence. Blocking exceptions must be cleared before the run is released; warnings require coordinator review.
              </p>
              <div className="space-y-3">
                {result.exceptions.map((ex) => (
                  <StagingExceptionCard key={ex.id} exception={ex} />
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

export function PredispatchStagingScreen() {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lines, setLines] = useState<DispatchLineRow[]>([]);
  const [contracts, setContracts] = useState<ContractSignalRow[]>([]);
  const [yardReadiness, setYardReadiness] = useState<YardReadinessRow[]>([]);

  const load = useCallback(async () => {
    setLoadState('loading');
    setErrorMessage(null);
    try {
      const fetchedLines = await fetchLines();
      const contractIds = [...new Set(
        fetchedLines
          .map((l) => (typeof l.contract_id === 'string' ? l.contract_id : ''))
          .filter(Boolean)
      )];
      const [fetchedContracts, fetchedYard] = await Promise.all([
        fetchContracts(contractIds),
        fetchYardReadiness(),
      ]);
      setLines(fetchedLines);
      setContracts(fetchedContracts);
      setYardReadiness(fetchedYard);
      setLoadState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unexpected error loading staging data.');
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const result = useMemo(
    () => buildPredispatchStagingList({ dispatchLines: lines, contracts, yardReadiness }),
    [lines, contracts, yardReadiness],
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="predispatch-heading">
            Predispatch Staging Assistant
          </h1>
          <p className="text-sm text-muted-foreground">
            Pre-dispatch validation of contacts, addresses, delivery instructions, and contract readiness
            before the next truck run.
          </p>
        </div>

        {loadState === 'loading' ? (
          <Alert data-testid="predispatch-loading">
            <AlertDescription>Building staging list from dispatch and contract signals…</AlertDescription>
          </Alert>
        ) : null}

        {loadState === 'error' && errorMessage ? (
          <Alert variant="destructive" data-testid="predispatch-error">
            <AlertTitle>Unable to load staging data</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {loadState === 'ready' ? (
          <PredispatchStagingPanel
            result={result}
            onRegenerate={load}
            isLoading={false}
          />
        ) : null}
      </div>
    </div>
  );
}

function PredispatchStagingPage() {
  return <PredispatchStagingScreen />;
}
