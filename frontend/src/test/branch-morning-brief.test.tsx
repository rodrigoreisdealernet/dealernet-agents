import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useDataSourcesMock, navigateSpy } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
  navigateSpy: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
      <a href={to} {...props}>{children}</a>
    ),
    createFileRoute: () => () => ({}),
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { BranchMorningBriefScreen } from '@/routes/branch/morning-brief';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeBriefSources(overrides: {
  briefItems?: unknown[];
  latestRun?: unknown;
  isLoading?: Record<string, boolean>;
  errors?: Record<string, Error | null>;
} = {}) {
  return {
    data: {
      briefItems: overrides.briefItems !== undefined
        ? overrides.briefItems
        : [
            {
              id: 'finding-1',
              agent_key: 'branch-morning-brief',
              finding_type: 'contract_exception',
              severity: 'critical',
              status: 'pending_approval',
              contract_id: 'RC-001',
              line_item_id: null,
              evidence: ['Contract overdue by 14 days', 'Last payment: 2026-05-01'],
              proposed_action: 'Contact customer and escalate to credit team',
              rationale: 'Contract past due date with no payment',
              confidence: 0.95,
              is_stale: false,
              created_at: '2026-06-15T06:00:00Z',
              expected: {
                owner_team: 'branch-operations-manager',
                operating_model_tags: ['branch-operations-manager:t1'],
                stale_signals: [],
                blockers: [],
                is_stale_data: false,
              },
            },
            {
              id: 'finding-2',
              agent_key: 'branch-morning-brief',
              finding_type: 'dispatch_exception',
              severity: 'high',
              status: 'pending_approval',
              contract_id: null,
              line_item_id: 'LI-099',
              evidence: ['Delivery scheduled for 07:00, no driver assigned'],
              proposed_action: 'Assign available driver or reschedule',
              rationale: 'Dispatch window at risk',
              confidence: 0.88,
              is_stale: false,
              created_at: '2026-06-15T05:30:00Z',
              expected: {
                owner_team: 'dispatch-team',
                operating_model_tags: ['branch-operations-manager:t4'],
                stale_signals: [],
                blockers: [],
                is_stale_data: false,
              },
            },
          ],
      latestRun: overrides.latestRun !== undefined
        ? overrides.latestRun
        : {
            run_id: 'run-abc',
            workflow_key: 'branch-morning-brief',
            status: 'succeeded',
            started_at: '2026-06-15T05:00:00Z',
            finished_at: '2026-06-15T05:10:00Z',
          },
    },
    isLoading: overrides.isLoading ?? {
      briefItems: false,
      latestRun: false,
    },
    errors: overrides.errors ?? {
      briefItems: null,
      latestRun: null,
    },
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  };
}

describe('BranchMorningBriefScreen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders the page heading and subtitle', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByRole('heading', { level: 1, name: 'Branch Morning Brief' })).toBeInTheDocument();
    expect(
      screen.getByText(/Ranked disposition-ready queue for the branch operations manager/i),
    ).toBeInTheDocument();
  });

  it('shows the not-yet-generated alert when no run exists', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources({ latestRun: null, briefItems: [] }));
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByText('Brief not yet generated')).toBeInTheDocument();
    expect(
      screen.getByText(/No morning brief has been generated today/i),
    ).toBeInTheDocument();
  });

  it('shows the no-op alert when the last run found no new signals', () => {
    useDataSourcesMock.mockReturnValue(
      makeBriefSources({
        latestRun: {
          run_id: 'run-noop',
          workflow_key: 'branch-morning-brief',
          status: 'no_op',
          started_at: '2026-06-15T05:00:00Z',
          finished_at: '2026-06-15T05:01:00Z',
        },
        briefItems: [],
      }),
    );
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByText('No new branch signals')).toBeInTheDocument();
    expect(
      screen.getByText(/The last brief run found no materially new exceptions/i),
    ).toBeInTheDocument();
  });

  it('does not show no-op or not-yet-generated alerts when a normal run exists with items', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.queryByText('Brief not yet generated')).not.toBeInTheDocument();
    expect(screen.queryByText('No new branch signals')).not.toBeInTheDocument();
  });

  it('renders ranked brief items with severity badge, finding type, and status', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    // critical item comes first
    const criticalBadges = screen.getAllByText('critical');
    expect(criticalBadges.length).toBeGreaterThan(0);
    expect(screen.getByText('contract_exception')).toBeInTheDocument();

    // high-severity dispatch item also renders
    const highBadges = screen.getAllByText('high');
    expect(highBadges.length).toBeGreaterThan(0);
    expect(screen.getByText('dispatch_exception')).toBeInTheDocument();
  });

  it('renders brief item evidence lines', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByText('Contract overdue by 14 days')).toBeInTheDocument();
    expect(screen.getByText('Last payment: 2026-05-01')).toBeInTheDocument();
    expect(screen.getByText('Delivery scheduled for 07:00, no driver assigned')).toBeInTheDocument();
  });

  it('renders the recommended action (proposed_action) for each item', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(
      screen.getByText('Contact customer and escalate to credit team'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Assign available driver or reschedule'),
    ).toBeInTheDocument();
  });

  it('renders the owner/team for each item', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    // Both owner labels and their values render
    const ownerLabels = screen.getAllByText('Owner:');
    expect(ownerLabels.length).toBeGreaterThan(0);
    expect(screen.getByText('branch-operations-manager')).toBeInTheDocument();
    expect(screen.getByText('dispatch-team')).toBeInTheDocument();
  });

  it('renders operating-model tags for each item', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByText('branch-operations-manager:t1')).toBeInTheDocument();
    expect(screen.getByText('branch-operations-manager:t4')).toBeInTheDocument();
  });

  it('renders stale-data badge and stale-signals list when item has stale data', () => {
    useDataSourcesMock.mockReturnValue(
      makeBriefSources({
        briefItems: [
          {
            id: 'finding-stale',
            agent_key: 'branch-morning-brief',
            finding_type: 'utilization_outlier',
            severity: 'medium',
            status: 'pending_approval',
            contract_id: null,
            line_item_id: 'LI-stale',
            evidence: ['Fleet utilization below threshold'],
            proposed_action: 'Review asset deployment plan',
            rationale: 'Utilization below 40%',
            confidence: 0.7,
            is_stale: true,
            created_at: '2026-06-15T05:00:00Z',
            expected: {
              owner_team: 'branch-operations-manager',
              operating_model_tags: ['branch-operations-manager:t1'],
              stale_signals: ['utilization_rate freshness: 48h', 'fleet_count freshness: 36h'],
              blockers: [],
              is_stale_data: true,
            },
          },
        ],
      }),
    );
    renderWithQueryClient(<BranchMorningBriefScreen />);

    // Stale data badge on the item
    expect(screen.getByText('Stale data')).toBeInTheDocument();

    // Stale signals section header
    expect(screen.getByText(/Stale signals.*review before acting/i)).toBeInTheDocument();

    // Individual stale signal entries
    expect(screen.getByText('utilization_rate freshness: 48h')).toBeInTheDocument();
    expect(screen.getByText('fleet_count freshness: 36h')).toBeInTheDocument();
  });

  it('renders drill-down link to the finding detail for each item', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    const viewDetailLinks = screen.getAllByText('View Detail →');
    expect(viewDetailLinks.length).toBeGreaterThan(0);

    // First item (finding-1) link points to its finding detail
    expect(viewDetailLinks[0].closest('a')).toHaveAttribute('href', '/ops/findings/finding-1');
  });

  it('shows the empty-state message when briefItems is empty and run succeeded', () => {
    useDataSourcesMock.mockReturnValue(
      makeBriefSources({
        briefItems: [],
        latestRun: {
          run_id: 'run-empty',
          workflow_key: 'branch-morning-brief',
          status: 'succeeded',
          started_at: '2026-06-15T05:00:00Z',
          finished_at: '2026-06-15T05:05:00Z',
        },
      }),
    );
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByText('No items match the current filters')).toBeInTheDocument();
    expect(
      screen.getByText(/Adjust the filters above or trigger a new morning brief/i),
    ).toBeInTheDocument();
  });

  it('renders filter controls for priority, signal type, and status', () => {
    useDataSourcesMock.mockReturnValue(makeBriefSources());
    renderWithQueryClient(<BranchMorningBriefScreen />);

    expect(screen.getByLabelText('Priority')).toBeInTheDocument();
    expect(screen.getByLabelText('Signal Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
  });
});
