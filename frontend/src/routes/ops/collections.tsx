import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsCollectionsQueuePage from '@/pages/ops-collections-queue.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

export const Route = createFileRoute('/ops/collections')({
  validateSearch: (search: Record<string, unknown>) => ({
    severity: readFilterParam(search.severity),
    status: readFilterParam(search.status),
  }),
  component: CollectionsQueuePage,
});

interface CollectionsQueueScreenProps {
  severity?: string;
  status?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function CollectionsQueueScreen({
  severity = '%',
  status = '%',
  onStateChange,
}: CollectionsQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(opsCollectionsQueuePage as PageDefinition),
      state: {
        ...(opsCollectionsQueuePage as PageDefinition).state,
        severityFilter: severity,
        statusFilter: status,
      },
    }),
    [severity, status]
  );

  return (
    <UIEngine
      key="collections-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

export function CollectionsQueuePage() {
  const { severity, status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          severity: readFilterParam(nextState.severityFilter),
          status: readFilterParam(nextState.statusFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <CollectionsQueueScreen
      severity={severity}
      status={status}
      onStateChange={handleStateChange}
    />
  );
}
