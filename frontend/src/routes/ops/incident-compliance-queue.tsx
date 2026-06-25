/**
 * Incident reporting and compliance deadline queue route.
 *
 * Safety/compliance manager-facing queue covering OSHA log follow-up,
 * reportable-event deadlines, and post-accident testing obligations.
 *
 * Assist-only: the system proposes the next action, but recordable/reportable
 * determinations and other status-changing or employee-impacting decisions
 * remain explicitly human-approved and audit-trailed through the finding
 * detail surface.
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import incidentComplianceQueuePage from '@/pages/ops-incident-compliance-queue.json';
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

export const Route = createFileRoute('/ops/incident-compliance-queue')({
  validateSearch: (search: Record<string, unknown>) => ({
    obligation: readFilterParam(search.obligation),
    status: readStatusParam(search.status),
  }),
  component: IncidentComplianceQueuePage,
});

interface IncidentComplianceQueueScreenProps {
  obligation?: string;
  status?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function IncidentComplianceQueueScreen({
  obligation = '%',
  status = 'pending_approval',
  onStateChange,
}: IncidentComplianceQueueScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(incidentComplianceQueuePage as PageDefinition),
      state: {
        ...(incidentComplianceQueuePage as PageDefinition).state,
        obligationFilter: obligation,
        statusFilter: status,
      },
    }),
    [obligation, status]
  );

  return (
    <UIEngine
      key="incident-compliance-queue"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function IncidentComplianceQueuePage() {
  const { obligation, status } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          obligation: readFilterParam(nextState.obligationFilter),
          status: readStatusParam(nextState.statusFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <IncidentComplianceQueueScreen
      obligation={obligation}
      status={status}
      onStateChange={handleStateChange}
    />
  );
}
