/**
 * Technician Morning Queue Route
 *
 * Prioritized morning work queue for service technicians and shop foremen.
 * Surfaces returned-unit follow-up, PM work, active repairs, and rent-ready
 * checks ranked by contract risk, overdue maintenance, parts blockers, and
 * return-condition evidence.
 * Assist-only: no status mutations happen from this surface. Technicians and
 * foremen may override the AI recommendation via the finding detail page.
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import technicianMorningQueuePage from '@/pages/technician-morning-queue.json';
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

export const Route = createFileRoute('/ops/technician-morning-queue')({
  validateSearch: (search: Record<string, unknown>) => ({
    priority: readFilterParam(search.priority),
    itemType: readFilterParam(search.itemType),
    status: readStatusParam(search.status),
  }),
  component: TechnicianMorningQueuePage,
});

interface TechnicianMorningQueueScreenProps {
  priority?: string;
  itemType?: string;
  status?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function TechnicianMorningQueueScreen({
  priority = '%',
  itemType = '%',
  status = 'pending_approval',
  onStateChange,
}: TechnicianMorningQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(technicianMorningQueuePage as PageDefinition),
      state: {
        ...(technicianMorningQueuePage as PageDefinition).state,
        priorityFilter: priority,
        itemTypeFilter: itemType,
        statusFilter: status,
      },
    }),
    [priority, itemType, status]
  );

  return (
    <UIEngine
      key="technician-morning-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function TechnicianMorningQueuePage() {
  const { priority, itemType, status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          priority: readFilterParam(nextState.priorityFilter),
          itemType: readFilterParam(nextState.itemTypeFilter),
          status: readFilterParam(nextState.statusFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <TechnicianMorningQueueScreen
      priority={priority}
      itemType={itemType}
      status={status}
      onStateChange={handleStateChange}
    />
  );
}
