import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsLienDeadlinesPage from '@/pages/ops-lien-deadlines.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

function readTabParam(value: unknown): string {
  if (value === 'waivers') return 'waivers';
  return 'deadlines';
}

export const Route = createFileRoute('/ops/lien-deadlines')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: readTabParam(search.tab),
    status: readFilterParam(search.status),
    waiverStatus: readFilterParam(search.waiverStatus),
  }),
  component: LienDeadlinesPage,
});

interface LienDeadlinesScreenProps {
  tab?: string;
  status?: string;
  waiverStatus?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function LienDeadlinesScreen({
  tab = 'deadlines',
  status = '%',
  waiverStatus = '%',
  onStateChange,
}: LienDeadlinesScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(opsLienDeadlinesPage as PageDefinition),
      state: {
        ...(opsLienDeadlinesPage as PageDefinition).state,
        activeTab: tab,
        statusFilter: status,
        waiverStatusFilter: waiverStatus,
      },
    }),
    [tab, status, waiverStatus]
  );

  return (
    <UIEngine
      key="lien-deadlines"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function LienDeadlinesPage() {
  const { tab, status, waiverStatus } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          tab: readTabParam(nextState.activeTab),
          status: readFilterParam(nextState.statusFilter),
          waiverStatus: readFilterParam(nextState.waiverStatusFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <LienDeadlinesScreen
      tab={tab}
      status={status}
      waiverStatus={waiverStatus}
      onStateChange={handleStateChange}
    />
  );
}
