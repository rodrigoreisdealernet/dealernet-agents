import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsCreditReviewQueuePage from '@/pages/ops-credit-review-queue.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

export const Route = createFileRoute('/ops/credit-review')({
  validateSearch: (search: Record<string, unknown>) => ({
    severity: readFilterParam(search.severity),
    status: readFilterParam(search.status),
  }),
  component: CreditReviewQueuePage,
});

interface CreditReviewQueueScreenProps {
  severity?: string;
  status?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function CreditReviewQueueScreen({
  severity = '%',
  status = '%',
  onStateChange,
}: CreditReviewQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(opsCreditReviewQueuePage as PageDefinition),
      state: {
        ...(opsCreditReviewQueuePage as PageDefinition).state,
        severityFilter: severity,
        statusFilter: status,
      },
    }),
    [severity, status]
  );

  return (
    <UIEngine
      key="credit-review-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function CreditReviewQueuePage() {
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
    <CreditReviewQueueScreen
      severity={severity}
      status={status}
      onStateChange={handleStateChange}
    />
  );
}
