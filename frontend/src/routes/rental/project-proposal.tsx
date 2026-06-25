/**
 * Project Proposal Workbench Route
 *
 * Outside-sales-representative workbench for assembling project-scale rental
 * proposals from account context, candidate fleet mix, branch availability, and
 * pricing-history evidence.
 *
 * Operating-model tags: outside-sales-representative:t3, outside-sales-representative:t5
 *
 * Assist-only: no customer-facing pricing, terms, or commitments are generated
 * or sent automatically. All customer materials require explicit human approval.
 *
 * URL: /rental/project-proposal
 * Access: admin / branch_manager (canWrite)
 */
import { useCallback, useMemo } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { UIEngine } from '@/engine';
import { useAuthCapabilities } from '@/auth/AuthContext';
import projectProposalWorkbenchPage from '@/pages/project-proposal-workbench.json';
import type { PageDefinition } from '@/engine/types';

function readFilterParam(value: unknown): string {
  if (typeof value !== 'string') return '%';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '%';
}

export const Route = createFileRoute('/rental/project-proposal')({
  validateSearch: (search: Record<string, unknown>) => ({
    customer: readFilterParam(search.customer),
    category: readFilterParam(search.category),
    branch: readFilterParam(search.branch),
  }),
  component: ProjectProposalWorkbenchPage,
});

interface ProjectProposalWorkbenchScreenProps {
  customerFilter?: string;
  categoryFilter?: string;
  branchFilter?: string;
  onStateChange?: (state: Record<string, unknown>) => void;
}

export function ProjectProposalWorkbenchScreen({
  customerFilter = '%',
  categoryFilter = '%',
  branchFilter = '%',
  onStateChange,
}: ProjectProposalWorkbenchScreenProps = {}) {
  const page = useMemo<PageDefinition>(
    () => ({
      ...(projectProposalWorkbenchPage as PageDefinition),
      state: {
        ...(projectProposalWorkbenchPage as PageDefinition).state,
        customerFilter,
        categoryFilter,
        branchFilter,
      },
    }),
    [customerFilter, categoryFilter, branchFilter]
  );

  return (
    <div data-testid="project-proposal-workbench-screen">
      <UIEngine
        key="project-proposal-workbench"
        page={page}
        onStateChange={onStateChange}
      />
    </div>
  );
}

export function ProjectProposalWorkbenchPage() {
  const { canWrite } = useAuthCapabilities();
  const { customer, category, branch } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleStateChange = useCallback(
    (nextState: Record<string, unknown>) => {
      void navigate({
        search: {
          customer: readFilterParam(nextState.customerFilter),
          category: readFilterParam(nextState.categoryFilter),
          branch: readFilterParam(nextState.branchFilter),
        },
        replace: true,
      });
    },
    [navigate]
  );

  if (!canWrite) {
    return (
      <div className="p-6 max-w-xl mx-auto" data-testid="project-proposal-access-denied">
        <Alert variant="destructive">
          <Lock className="h-4 w-4" />
          <AlertTitle>Access Denied</AlertTitle>
          <AlertDescription>
            Project Proposal Workbench is available to admin and branch manager users only.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ProjectProposalWorkbenchScreen
      customerFilter={customer}
      categoryFilter={category}
      branchFilter={branch}
      onStateChange={handleStateChange}
    />
  );
}