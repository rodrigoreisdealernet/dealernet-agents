import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import opsFindingsQueuePage from '@/pages/ops-findings-queue.json';
import type { PageDefinition } from '@/engine/types';

function readWorkflowParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

export const Route = createFileRoute('/ops/findings/')({
  validateSearch: (search: Record<string, unknown>) => ({
    workflow: readWorkflowParam(search.workflow),
  }),
  component: OpsFindingsQueuePage,
});

interface OpsFindingsQueueScreenProps {
  page?: PageDefinition;
  workflowFilter?: string;
}

export function OpsFindingsQueueScreen({
  page = opsFindingsQueuePage as PageDefinition,
  workflowFilter = '%',
}: OpsFindingsQueueScreenProps) {
  return (
    <UIEngine
      key={workflowFilter}
      page={{
        ...page,
        state: {
          ...(page.state || {}),
          workflowFilter,
        },
      }}
    />
  );
}

function OpsFindingsQueuePage() {
  const { workflow } = Route.useSearch();
  return <OpsFindingsQueueScreen workflowFilter={workflow} />;
}
