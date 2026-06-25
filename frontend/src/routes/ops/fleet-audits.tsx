import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsFleetAuditsPage from '@/pages/ops-fleet-audits.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

export const Route = createFileRoute('/ops/fleet-audits')({
  validateSearch: (search: Record<string, unknown>) => ({
    severity: readFilterParam(search.severity),
    status: readFilterParam(search.status),
    branch: readFilterParam(search.branch),
    customer: readFilterParam(search.customer),
  }),
  component: FleetAuditsPage,
});

interface FleetAuditsScreenProps {
  severity?: string;
  status?: string;
  branch?: string;
  customer?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function FleetAuditsScreen({
  severity = '%',
  status = '%',
  branch = '%',
  customer = '%',
  onStateChange,
}: FleetAuditsScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(opsFleetAuditsPage as PageDefinition),
      state: {
        ...(opsFleetAuditsPage as PageDefinition).state,
        severityFilter: severity,
        statusFilter: status,
        branchFilter: branch,
        customerFilter: customer,
      },
    }),
    [severity, status, branch, customer]
  );

  return (
    <UIEngine
      key="fleet-audits"
      page={page}
      onStateChange={onStateChange}
    />
  );
}

function FleetAuditsPage() {
  const { severity, status, branch, customer } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          severity: readFilterParam(nextState.severityFilter),
          status: readFilterParam(nextState.statusFilter),
          branch: readFilterParam(nextState.branchFilter),
          customer: readFilterParam(nextState.customerFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  return (
    <FleetAuditsScreen
      severity={severity}
      status={status}
      branch={branch}
      customer={customer}
      onStateChange={handleStateChange}
    />
  );
}
