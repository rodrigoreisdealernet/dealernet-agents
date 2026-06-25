/**
 * Dispatch Live Operations Route
 */

import { useCallback, useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConflictAssistantPanel } from '@/components/rental/ConflictAssistantPanel';
import { supabase } from '@/data/supabase';
import { UIEngine } from '@/engine';
import dispatchLiveOpsPage from '@/pages/dispatch-live-ops.json';
import type { PageDefinition } from '@/engine/types';
import { buildDispatchConflictLookout } from '@/lib/dispatchConflictLookout';
import type { ConflictAssistantResult } from '@/lib/bookingConflictAssistant';

export const Route = createFileRoute('/dispatch/live')({
  component: DispatchLiveOpsPage,
});

const ROUTE_SELECT = [
  'line_id',
  'contract_id',
  'asset_id',
  'asset_name',
  'route_status',
  'exception_state',
  'branch_id',
  'assigned_driver',
  'assigned_truck',
  'telemetry_position_status',
  'telemetry_event_at',
  'telemetry_sync_status',
  'eld_compliance_status',
  'driver_log_status',
].join(', ');

const LINE_SELECT = [
  'entity_id',
  'contract_id',
  'status',
  'asset_id',
  'category_id',
  'actual_end',
  'data',
].join(', ');

const CONTRACT_SELECT = 'id, entity_versions!inner(data, is_current)';

const AVAILABILITY_SELECT = [
  'branch_id',
  'branch_name',
  'asset_category_id',
  'asset_category_name',
  'available_assets',
  'unavailable_assets',
  'maintenance_due_assets',
  'maintenance_overdue_assets',
  'soft_down_assets',
  'hard_down_assets',
].join(', ');

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function buildInitialResult(): ConflictAssistantResult {
  return buildDispatchConflictLookout({ routes: [], lines: [], contracts: [], availability: [] });
}

async function fetchRoutes(): Promise<unknown[]> {
  const { data, error } = await supabase
    .from('v_dispatch_route_live')
    .select(ROUTE_SELECT);
  if (error) throw new Error(error.message || 'Unable to load live dispatch routes.');
  return data ?? [];
}

async function fetchLines(): Promise<unknown[]> {
  const { data, error } = await supabase
    .from('v_rental_contract_line_current')
    .select(LINE_SELECT)
    .in('status', ['checked_out', 'pending_execution']);
  if (error) throw new Error(error.message || 'Unable to load dispatch lookout lines.');
  return data ?? [];
}

async function fetchAvailability(): Promise<unknown[]> {
  const { data, error } = await supabase
    .from('rental_asset_availability_current')
    .select(AVAILABILITY_SELECT);
  if (error) throw new Error(error.message || 'Unable to load branch capacity.');
  return data ?? [];
}

async function fetchContracts(contractIds: string[]) {
  if (contractIds.length === 0) return [];
  const { data, error } = await supabase
    .from('entities')
    .select(CONTRACT_SELECT)
    .eq('entity_type', 'rental_contract')
    .eq('entity_versions.is_current', true)
    .in('id', contractIds);
  if (error) throw new Error(error.message || 'Unable to load contract context.');
  return data ?? [];
}

export function DispatchLiveOpsScreen() {
  return <UIEngine page={dispatchLiveOpsPage as PageDefinition} />;
}

export function DispatchConflictLookoutSection() {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ConflictAssistantResult>(() => buildInitialResult());

  const refresh = useCallback(async () => {
    setLoadState('loading');
    setErrorMessage(null);
    try {
      const [routes, lines, availability] = await Promise.all([
        fetchRoutes(),
        fetchLines(),
        fetchAvailability(),
      ]);
      const contractIds = Array.from(new Set(
        [...routes, ...lines]
          .map((row) => {
            if (!row || typeof row !== 'object') return '';
            return 'contract_id' in row && typeof row.contract_id === 'string' ? row.contract_id : '';
          })
          .filter(Boolean),
      ));
      const contracts = await fetchContracts(contractIds);
      setResult(buildDispatchConflictLookout({ routes, lines, contracts, availability }));
      setLoadState('ready');
    } catch (error) {
      setLoadState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load dispatch lookout.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  if (loadState === 'error') {
    return (
      <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="dispatch-lookout-error">
        <Alert variant="destructive">
          <AlertTitle>Unable to load dispatch lookout</AlertTitle>
          <AlertDescription>{errorMessage || 'Please retry the live board refresh.'}</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (loadState === 'loading' && result.noOp) {
    return (
      <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="dispatch-lookout-loading">
        <Alert>
          <AlertTitle>Refreshing dispatch lookout</AlertTitle>
          <AlertDescription>
            Pulling dwell, contract readiness, telemetry, and branch-capacity signals for the market recovery brief.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <ConflictAssistantPanel
      title="Market Dispatch Recovery Brief"
      description="Ranks materially new market-level dwell, contract blocker, telemetry, and same-day capacity exceptions so a dispatcher can choose the next human-approved recovery path."
      result={result}
      allowFollowUpApproval
    />
  );
}

function DispatchLiveOpsPage() {
  return (
    <>
      <DispatchLiveOpsScreen />
      <DispatchConflictLookoutSection />
    </>
  );
}
