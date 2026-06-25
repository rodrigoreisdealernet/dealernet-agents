/**
 * Branch Morning Brief Route
 *
 * Disposition-ready ranked brief for the branch operations manager.
 * Surfaces contract/AP/utilisation exceptions, dispatch risks, maintenance
 * blockers, unavailable units, and customer follow-up prompts with evidence
 * and next-step recommendations.
 * Assist-only: no customer-facing, money-moving, or status-changing actions
 * are initiated from this surface.
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import branchMorningBriefPage from '@/pages/branch-morning-brief.json';
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

export const Route = createFileRoute('/branch/morning-brief')({
  validateSearch: (search: Record<string, unknown>) => ({
    priority: readFilterParam(search.priority),
    itemType: readFilterParam(search.itemType),
    status: readStatusParam(search.status),
  }),
  component: BranchMorningBriefPage,
});

interface BranchMorningBriefScreenProps {
  priority?: string;
  itemType?: string;
  status?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function BranchMorningBriefScreen({
  priority = '%',
  itemType = '%',
  status = 'pending_approval',
  onStateChange,
}: BranchMorningBriefScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(branchMorningBriefPage as PageDefinition),
      state: {
        ...(branchMorningBriefPage as PageDefinition).state,
        priorityFilter: priority,
        itemTypeFilter: itemType,
        statusFilter: status,
      },
    }),
    [priority, itemType, status]
  );

  return (
    <UIEngine
      key="branch-morning-brief"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

export function BranchMorningBriefPage() {
  const { priority, itemType, status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          priority: readFilterParam(nextState.priorityFilter),
          itemType: readFilterParam(nextState.itemTypeFilter),
          status: readStatusParam(nextState.statusFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <BranchMorningBriefScreen
      priority={priority}
      itemType={itemType}
      status={status}
      onStateChange={handleStateChange}
    />
  );
}
