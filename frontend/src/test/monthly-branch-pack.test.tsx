import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { MonthlyBranchPackScreen } from '@/routes/branch/monthly-pack';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makePackSources(overrides: {
  branch_utilization?: unknown;
  asset_analytics?: unknown;
  work_orders?: unknown;
  inspection_exceptions?: unknown;
  pm_due_assets?: unknown;
  isLoading?: Record<string, boolean>;
  errors?: Record<string, Error | null>;
} = {}) {
  return {
    data: {
      branch_utilization: overrides.branch_utilization ?? [
        {
          branch_id: 'branch-1',
          branch_name: 'North Yard',
          on_rent_count: 12,
          utilization_rate_pct: 68.5,
          last_updated: '2026-06-01T08:00:00Z',
        },
        {
          branch_id: 'branch-2',
          branch_name: 'South Depot',
          on_rent_count: 8,
          utilization_rate_pct: 42.0,
          last_updated: null,
        },
      ],
      asset_analytics: overrides.asset_analytics ?? [
        {
          asset_id: 'asset-1',
          asset_name: 'Excavator 320',
          total_downtime_minutes: 480,
          utilization_pct: 55.0,
          roi_status: 'at_risk',
          last_order_at: '2026-05-01T08:00:00Z',
        },
      ],
      work_orders: overrides.work_orders ?? [
        {
          maintenance_record_id: 'wo-1',
          name: 'Engine repair - Excavator 320',
          work_order_status: 'open',
          maintenance_type: 'corrective',
          asset_id: 'asset-1',
          internal_subtotal: 1200,
          sell_total: 1500,
          created_at: '2026-06-01T08:00:00Z',
          last_updated_at: '2026-06-02T10:00:00Z',
        },
      ],
      inspection_exceptions: overrides.inspection_exceptions ?? [
        {
          asset_id: 'asset-1',
          service_record_id: 'insp-1',
          service_name: 'Pre-rental inspection',
          service_type: 'inspection',
          outcome: 'fail',
          status: 'open',
          opened_at: '2026-06-01T08:00:00Z',
          completed_at: '2026-06-01T09:00:00Z',
          service_sort_at: '2026-06-01T09:00:00Z',
        },
      ],
      pm_due_assets: overrides.pm_due_assets ?? [
        {
          asset_id: 'asset-2',
          policy_id: 'pm-policy-1',
          trigger_type: 'calendar',
          label: '90-day service',
          latest_meter_value: null,
          latest_meter_at: null,
          last_maintenance_at: '2026-03-01T00:00:00Z',
          is_due: true,
          is_pre_due: false,
        },
      ],
    },
    isLoading: overrides.isLoading ?? {
      branch_utilization: false,
      asset_analytics: false,
      work_orders: false,
      inspection_exceptions: false,
      pm_due_assets: false,
    },
    errors: overrides.errors ?? {
      branch_utilization: null,
      asset_analytics: null,
      work_orders: null,
      inspection_exceptions: null,
      pm_due_assets: null,
    },
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  };
}

// Tests for the monthly branch performance pack screen
describe('MonthlyBranchPackScreen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders the operating-model tag badge and pack header', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    expect(screen.getByText('branch-operations-manager:t7')).toBeInTheDocument();
    expect(screen.getByText(/Human approval required before regional distribution/i)).toBeInTheDocument();
  });

  it('renders branch performance metrics with utilization rates and on-rent counts', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    const metricsSection = screen.getByRole('region', { name: 'Branch performance metrics' });
    expect(metricsSection).toBeInTheDocument();

    expect(screen.getByText('North Yard')).toBeInTheDocument();
    expect(screen.getByText('12 on rent')).toBeInTheDocument();
    expect(screen.getByText(/Utilization:.*68.5%/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Review branch availability' })[0]).toHaveAttribute(
      'href',
      '/rental/availability?branch_id=branch-1',
    );

    expect(screen.getByText('South Depot')).toBeInTheDocument();
    expect(screen.getByText('8 on rent')).toBeInTheDocument();
  });

  it('surfaces a per-metric stale-source warning when last_updated is missing', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    // South Depot row has last_updated: null — triggers the stale timestamp exception
    expect(screen.getByText(/utilization freshness timestamp missing/i)).toBeInTheDocument();
  });

  it('renders notable exceptions: failed inspections as critical and overdue PM items', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    const exceptionsSection = screen.getByRole('region', { name: 'Notable exceptions' });
    expect(exceptionsSection).toBeInTheDocument();

    // Failed inspection row → severity: critical
    expect(screen.getByText('Pre-rental inspection')).toBeInTheDocument();
    const criticalBadges = screen.getAllByText('Critical');
    expect(criticalBadges.length).toBeGreaterThan(0);

    // Overdue PM row (is_due: true) → also severity: critical
    expect(screen.getByText('90-day service')).toBeInTheDocument();
    expect(screen.getByText(/PM overdue/)).toBeInTheDocument();

    // High-downtime asset from asset_analytics (total_downtime_minutes: 480) → warning
    expect(screen.getByText(/High downtime: Excavator 320/)).toBeInTheDocument();
    expect(screen.getByText(/480 downtime min/)).toBeInTheDocument();
  });

  it('excludes completed and closed work orders from the corrective actions section', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        work_orders: [
          {
            maintenance_record_id: 'wo-open-1',
            name: 'Open boom lift hydraulic repair',
            work_order_status: 'open',
            maintenance_type: 'corrective',
            asset_id: 'asset-open',
            internal_subtotal: 1800,
            sell_total: 2200,
            created_at: '2026-06-10T08:00:00Z',
            last_updated_at: '2026-06-11T10:00:00Z',
          },
          {
            maintenance_record_id: 'wo-completed-1',
            name: 'Completed engine overhaul',
            work_order_status: 'completed',
            maintenance_type: 'corrective',
            asset_id: 'asset-done',
            internal_subtotal: 4000,
            sell_total: 4800,
            created_at: '2026-05-01T08:00:00Z',
            last_updated_at: '2026-05-20T10:00:00Z',
          },
          {
            maintenance_record_id: 'wo-closed-1',
            name: 'Closed brake inspection',
            work_order_status: 'closed',
            maintenance_type: 'preventive',
            asset_id: 'asset-closed',
            internal_subtotal: 300,
            sell_total: 350,
            created_at: '2026-05-05T08:00:00Z',
            last_updated_at: '2026-05-15T10:00:00Z',
          },
        ],
      }),
    );
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    // The open work order renders
    expect(screen.getByText('Open boom lift hydraulic repair')).toBeInTheDocument();

    // Completed and closed work orders are excluded
    expect(screen.queryByText('Completed engine overhaul')).not.toBeInTheDocument();
    expect(screen.queryByText('Closed brake inspection')).not.toBeInTheDocument();
  });

  it('renders corrective actions with work order name, status, and estimated cost', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    const actionsSection = screen.getByRole('region', { name: 'Corrective actions' });
    expect(actionsSection).toBeInTheDocument();

    expect(screen.getByText('Engine repair - Excavator 320')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText(/Estimated:.*\$1,500/)).toBeInTheDocument();

    // Deep-link to work order and asset record
    expect(screen.getByRole('link', { name: 'Open work order' })).toHaveAttribute(
      'href',
      '/entities/maintenance_record/wo-1',
    );
    expect(screen.getByRole('link', { name: 'Open asset record' })).toHaveAttribute(
      'href',
      '/entities/asset/asset-1',
    );
  });

  it('shows loading UI and no false missing-source or empty-state warnings while sources are loading', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        // All data arrays empty — as they would be before fetch resolves
        branch_utilization: [],
        asset_analytics: [],
        work_orders: [],
        inspection_exceptions: [],
        pm_due_assets: [],
        isLoading: {
          branch_utilization: true,
          asset_analytics: true,
          work_orders: true,
          inspection_exceptions: true,
          pm_due_assets: true,
        },
      }),
    );
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    // Loading indicators are present for each section
    expect(screen.getByText(/Loading branch performance metrics/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading exceptions/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading corrective actions/i)).toBeInTheDocument();

    // Pack-level "missing source" alert must NOT appear while loading
    expect(screen.queryByText(/Missing or stale source exceptions/i)).not.toBeInTheDocument();
    // No false "returned no rows" pack-level exception text
    expect(screen.queryByText(/source returned no rows/i)).not.toBeInTheDocument();
    // Section-level empty-states must NOT appear while loading
    expect(screen.queryByText(/No branch performance data found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No open maintenance work orders/i)).not.toBeInTheDocument();
  });

  it('shows pack-level exceptions once sources have finished loading', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        branch_utilization: [],
        isLoading: {
          branch_utilization: false,
          asset_analytics: false,
          work_orders: false,
          inspection_exceptions: false,
          pm_due_assets: false,
        },
      }),
    );
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    // Sources are done — the pack-level exception should surface
    expect(screen.getByText(/Missing or stale source exceptions/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Branch utilization source returned no rows — performance section is empty/i),
    ).toBeInTheDocument();
  });

  it('surfaces a pack-level source exception when branch utilization returns no rows', () => {
    useDataSourcesMock.mockReturnValue(makePackSources({ branch_utilization: [] }));
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    // Pack-level exception alert
    expect(
      screen.getByText(/Branch utilization source returned no rows — performance section is empty/i),
    ).toBeInTheDocument();

    // Section-level empty state
    expect(screen.getByText(/No branch performance data found/i)).toBeInTheDocument();
  });

  it('surfaces a pack-level exception when both inspection and PM sources return no rows', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({ inspection_exceptions: [], pm_due_assets: [] }),
    );
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    expect(
      screen.getByText(/Both inspection and PM sources returned no rows/i),
    ).toBeInTheDocument();
  });

  it('renders the manager commentary section with a sign-off alert and an editable textarea', async () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    const user = userEvent.setup();
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    const commentarySection = screen.getByRole('region', {
      name: 'Manager commentary and commitments',
    });
    expect(commentarySection).toBeInTheDocument();

    expect(screen.getByText(/Manager sign-off required/i)).toBeInTheDocument();

    const textarea = screen.getByLabelText('Commentary and corrective commitments');
    expect(textarea).toBeInTheDocument();
    await user.type(textarea, 'Reviewing corrective actions with workshop lead.');
    expect(textarea).toHaveValue('Reviewing corrective actions with workshop lead.');
    expect(
      screen.getByText(/Commentary is saved in this browser session so reloads do not drop/i),
    ).toBeInTheDocument();
  });

  it('restores saved manager commentary after the screen remounts', async () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    const user = userEvent.setup();
    const savedCommentary = 'Regional review: workshop lead committed to close the open repair by Friday.';

    const firstRender = renderWithQueryClient(<MonthlyBranchPackScreen />);
    const textarea = screen.getByLabelText('Commentary and corrective commitments');
    await user.type(textarea, savedCommentary);
    expect(textarea).toHaveValue(savedCommentary);

    firstRender.unmount();

    renderWithQueryClient(<MonthlyBranchPackScreen />);
    expect(screen.getByLabelText('Commentary and corrective commitments')).toHaveValue(savedCommentary);
  });

  it('shows a destructive alert when a data source load fails', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        errors: {
          branch_utilization: new Error('Network request failed'),
          asset_analytics: null,
          work_orders: null,
          inspection_exceptions: null,
          pm_due_assets: null,
        },
      }),
    );
    renderWithQueryClient(<MonthlyBranchPackScreen />);

    expect(screen.getByText(/One or more data sources could not be loaded/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Network request failed/i).length).toBeGreaterThan(0);
  });
});
