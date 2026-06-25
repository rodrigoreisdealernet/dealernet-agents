import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useDataSourcesMock } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({
      children,
      to,
      search,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; search?: Record<string, unknown> }) => {
      const hrefBase = to as string;
      const searchString = search
        ? new URLSearchParams(
            Object.entries(search).reduce<Record<string, string>>((acc, [key, value]) => {
              acc[key] = String(value);
              return acc;
            }, {})
          ).toString()
        : '';
      const href = searchString ? `${hrefBase}?${searchString}` : hrefBase;
      return <a href={href} {...props}>{children}</a>;
    },
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { IncidentComplianceQueueScreen } from '@/routes/ops/incident-compliance-queue';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
}

describe('incident compliance queue screen', () => {
  beforeEach(() => {
    cleanup();
    initializeRegistry();
    useDataSourcesMock.mockReset();
  });

  it('renders deadline, evidence, blocker, and human-approval messaging for incident cases', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        findings: [
          {
            id: 'finding-incident-1',
            finding_type: 'reportable_event_deadline',
            severity: 'critical',
            status: 'pending_approval',
            contract_id: 'contract-1',
            expected: {
              case_title: 'Forklift rollover — hospital treatment',
              branch_name: 'Denver North',
              employee_name: 'Jordan Lee',
              equipment_name: 'CAT DP30N forklift',
              due_at: '2026-06-20T12:00:00Z',
              rule_citation: '29 CFR 1904.39',
              blockers: ['Witness statement still missing.'],
            },
            evidence: [
              {
                label: 'Supervisor intake signed',
                entity_id: 'entity-evidence-1',
              },
            ],
            proposed_action: 'Prepare 8-hour reporting packet for human approval.',
            rationale: 'Hospital treatment makes this potentially reportable.',
            confidence: 0.92,
            created_at: '2026-06-19T08:00:00Z',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<IncidentComplianceQueueScreen />);

    expect(screen.getByRole('heading', { name: 'Incident Reporting & Compliance Queue' })).toBeInTheDocument();
    expect(screen.getByText('Branch: Denver North')).toBeInTheDocument();
    expect(screen.getByText('Employee: Jordan Lee')).toBeInTheDocument();
    expect(screen.getByText('Equipment: CAT DP30N forklift')).toBeInTheDocument();
    expect(screen.getByText(/Cited rule: 29 CFR 1904.39/)).toBeInTheDocument();
    expect(screen.getByText('Human disposition required')).toBeInTheDocument();
    expect(screen.getByText('Compliance blocker — needs human review')).toBeInTheDocument();
    expect(screen.getByText('Supervisor intake signed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit' })).toHaveAttribute('href', '/ops/audit/entity-evidence-1');
    expect(screen.getByRole('link', { name: 'Open case' })).toHaveAttribute(
      'href',
      '/ops/findings/finding-incident-1?source=incident-compliance-queue&returnObligation=%25&returnStatus=pending_approval'
    );
  });
});
