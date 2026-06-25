/**
 * Account Health Queue Route
 *
 * Rep-facing ranked queue of dormant, lost, at-risk, and growth-opportunity
 * accounts. Surfaces rental-history, utilization-shift, open-opportunity, and
 * contact-gap evidence so the rep can review and edit a suggested outreach
 * angle before any contact is made.
 *
 * Assist-only: no automatic outreach, account-stage mutation, or commercial
 * offer is made from this surface. The no-op state is shown explicitly when
 * there are no materially new account-health signals.
 *
 * Operating-model tags: outside-sales-representative:t6 (dormant/lost win-back)
 *                        outside-sales-representative:t7 (at-risk/growth)
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import accountHealthQueuePage from '@/pages/ops-account-health-queue.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

function readStatusParam(value: unknown): string {
  if (typeof value !== 'string') return 'pending_approval';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'pending_approval';
}

export const Route = createFileRoute('/ops/account-health-queue')({
  validateSearch: (search: Record<string, unknown>) => ({
    signal: readFilterParam(search.signal),
    priority: readFilterParam(search.priority),
    status: readStatusParam(search.status),
    customer: readFilterParam(search.customer),
  }),
  component: AccountHealthQueuePage,
});

interface AccountHealthQueueScreenProps {
  signal?: string;
  priority?: string;
  status?: string;
  customer?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function AccountHealthQueueScreen({
  signal = '%',
  priority = '%',
  status = 'pending_approval',
  customer = '%',
  onStateChange,
}: AccountHealthQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(accountHealthQueuePage as PageDefinition),
      state: {
        ...(accountHealthQueuePage as PageDefinition).state,
        signalFilter: signal,
        priorityFilter: priority,
        statusFilter: status,
        customerFilter: customer,
      },
    }),
    [signal, priority, status, customer]
  );

  return (
    <UIEngine
      key="account-health-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function AccountHealthQueuePage() {
  const { signal, priority, status, customer } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          signal: readFilterParam(nextState.signalFilter),
          priority: readFilterParam(nextState.priorityFilter),
          status: readFilterParam(nextState.statusFilter),
          customer: readFilterParam(nextState.customerFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <AccountHealthQueueScreen
      signal={signal}
      priority={priority}
      status={status}
      customer={customer}
      onStateChange={handleStateChange}
    />
  );
}
