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
      <a href={to as string} {...props}>{children}</a>
    ),
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { DashboardScreen } from '@/routes/index';

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

const typicalKpis = {
  as_of: '2026-06-06T12:00:00Z',
  assets_on_rent: 12,
  fleet_utilization_pct: 75,
  overdue_returns_count: 3,
  open_maintenance_count: 5,
  period_revenue: 50000,
  prior_period_revenue: 40000,
  available_assets: 4,
  unavailable_assets: 16,
  total_assets: 20,
};

function mockKpis(kpis: Partial<typeof typicalKpis>) {
  useDataSourcesMock.mockReturnValue({
    data: {
      kpis: { ...typicalKpis, ...kpis },
      ops_agents: [],
      ops_kpis: [],
    },
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  });
}

describe('home dashboard screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders the page heading and subtitle', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByRole('heading', { name: 'Operations Dashboard' })).toBeInTheDocument();
    expect(
      screen.getByText('Live operational KPIs from Supabase with direct links to act.')
    ).toBeInTheDocument();
    // As-of pill uses formatDateTime — must not be the raw ISO string
    expect(screen.queryByText(/UTC ISO timestamp/)).not.toBeInTheDocument();
    expect(screen.getByText(/^As of Jun 6/)).toBeInTheDocument();
  });

  it('renders Assets On Rent StatCard with utilization hint and action link', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('75% of 20 assets')).toBeInTheDocument();
    expect(screen.getByText('Branch Operations →')).toBeInTheDocument();
  });

  it('renders Overdue Returns StatCard with danger delta when count > 0', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('overdue')).toBeInTheDocument();
    expect(screen.getByText('Returns →')).toBeInTheDocument();
  });

  it('renders Open Maintenance StatCard with queue action link', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Maintenance Queue →')).toBeInTheDocument();
  });

  it('renders Period Revenue StatCard with formatted currency, delta, and action link', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('$50,000')).toBeInTheDocument();
    expect(screen.getByText('vs prior period')).toBeInTheDocument();
    expect(screen.getByText('Fleet Reporting →')).toBeInTheDocument();
  });

  it('renders Availability Snapshot StatCard with combined hint and action link', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('4 available · 16 unavailable')).toBeInTheDocument();
    expect(screen.getByText('Availability Lookup →')).toBeInTheDocument();
  });

  it('shows "All clear" flat delta when overdue count is zero', () => {
    mockKpis({ overdue_returns_count: 0 });

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.queryByText('3 overdue')).not.toBeInTheDocument();
  });

  it('shows flat revenue delta when period and prior period are equal', () => {
    mockKpis({ period_revenue: 0, prior_period_revenue: 0 });

    renderWithQueryClient(<DashboardScreen />);

    // Flat direction prefix — and label "vs prior period"
    const flatPrefixes = screen.getAllByText('—');
    expect(flatPrefixes.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('vs prior period')).toBeInTheDocument();
  });

  it('shows down revenue delta when period revenue is less than prior period', () => {
    mockKpis({ period_revenue: 30000, prior_period_revenue: 50000 });

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('▼')).toBeInTheDocument();
    expect(screen.getByText('vs prior period')).toBeInTheDocument();
  });

  it('renders zero values for all KPIs when data is empty (zero-state)', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        kpis: {
          as_of: '2026-06-06T12:00:00Z',
          assets_on_rent: 0,
          fleet_utilization_pct: 0,
          overdue_returns_count: 0,
          open_maintenance_count: 0,
          period_revenue: 0,
          prior_period_revenue: 0,
          available_assets: 0,
          unavailable_assets: 0,
          total_assets: 0,
        },
        ops_agents: [],
        ops_kpis: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('0% of 0 assets')).toBeInTheDocument();
    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('vs prior period')).toBeInTheDocument();
    expect(screen.getByText('0 available · 0 unavailable')).toBeInTheDocument();
  });

  it('renders KPI StatCards in a responsive grid layout', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    const kpiGrid = screen
      .getByText('Branch Operations →')
      .closest('.grid') as HTMLDivElement;

    expect(kpiGrid).toBeInTheDocument();
    expect(kpiGrid.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(15rem, 1fr))');
    expect(kpiGrid.style.gap).toBe('1rem');
  });

  it('renders Agentic Operations panel with empty-state when no agents are configured', () => {
    mockKpis({});

    renderWithQueryClient(<DashboardScreen />);

    expect(screen.getByText('Agentic Operations')).toBeInTheDocument();
    expect(screen.getByText('No agents configured')).toBeInTheDocument();
  });
});

