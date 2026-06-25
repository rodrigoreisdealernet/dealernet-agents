/**
 * Shop Morning Queue Route
 *
 * Disposition-ready ranked queue for the service & maintenance manager.
 * Surfaces PM-due units, open work-order priorities, parts blockers, and
 * not-available equipment with evidence and next-step recommendations.
 * Assist-only: no status mutations happen from this surface.
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import shopMorningQueuePage from '@/pages/shop-morning-queue.json';
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

export const Route = createFileRoute('/ops/shop-morning-queue')({
  validateSearch: (search: Record<string, unknown>) => ({
    priority: readFilterParam(search.priority),
    itemType: readFilterParam(search.itemType),
    status: readStatusParam(search.status),
  }),
  component: ShopMorningQueuePage,
});

interface ShopMorningQueueScreenProps {
  priority?: string;
  itemType?: string;
  status?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function ShopMorningQueueScreen({
  priority = '%',
  itemType = '%',
  status = 'pending_approval',
  onStateChange,
}: ShopMorningQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(shopMorningQueuePage as PageDefinition),
      state: {
        ...(shopMorningQueuePage as PageDefinition).state,
        priorityFilter: priority,
        itemTypeFilter: itemType,
        statusFilter: status,
      },
    }),
    [priority, itemType, status]
  );

  return (
    <UIEngine
      key="shop-morning-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function ShopMorningQueuePage() {
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
    <ShopMorningQueueScreen
      priority={priority}
      itemType={itemType}
      status={status}
      onStateChange={handleStateChange}
    />
  );
}
