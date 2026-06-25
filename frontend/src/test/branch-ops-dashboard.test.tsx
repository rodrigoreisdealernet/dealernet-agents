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
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { BranchOpsDashboardScreen } from '@/routes/branch/ops';

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

describe('branch operations dashboard screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders utilization KPIs per branch', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization: [
          {
            branch_id: 'branch-1',
            branch_name: 'North Yard',
            on_rent_count: 8,
            utilization_rate_pct: 67,
            last_updated: '2026-06-01T00:00:00Z',
          },
        ],
        in_flight: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<BranchOpsDashboardScreen />);

    expect(screen.getByRole('heading', { name: 'Branch Operations Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('North Yard')).toBeInTheDocument();
    expect(screen.getByText('8 on rent')).toBeInTheDocument();
    expect(screen.getByText('Utilization: 67%')).toBeInTheDocument();
    const checkAvailLink = screen.getByRole('link', { name: 'Check Availability' });
    expect(checkAvailLink).toHaveAttribute('href', '/rental/availability?branch_id=branch-1');
  });

  it('renders transfers in-flight with serial numbers', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization: [],
        in_flight: [
          {
            asset_id: 'asset-42',
            name: 'Excavator 320',
            serial_number: 'SN-320-XC',
            status: 'on_transfer',
            category_id: 'cat-1',
          },
        ],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<BranchOpsDashboardScreen />);

    expect(screen.getByText('Excavator 320')).toBeInTheDocument();
    expect(screen.getByText('In Transit')).toBeInTheDocument();
    expect(screen.getByText('Serial: SN-320-XC')).toBeInTheDocument();
    const checkInLink = screen.getByRole('link', { name: 'Check In Asset' });
    expect(checkInLink).toHaveAttribute('href', '/rental/returns?asset_id=asset-42');
  });

  it('renders availability and maintenance overdue blockers', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization: [],
        in_flight: [],
        availability: [
          {
            branch_id: 'branch-2',
            branch_name: 'South Depot',
            asset_category_id: 'cat-2',
            asset_category_name: 'Loaders',
            total_assets: 10,
            available_assets: 6,
            unavailable_assets: 4,
            maintenance_due_assets: 2,
            maintenance_overdue_assets: 1,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<BranchOpsDashboardScreen />);

    expect(screen.getByText('South Depot • Loaders')).toBeInTheDocument();
    expect(screen.getByText('6 available')).toBeInTheDocument();
    expect(screen.getByText('4 unavailable / 10 total')).toBeInTheDocument();
    expect(screen.getByText('Maintenance overdue: 1')).toBeInTheDocument();
    const checkAvailLink = screen.getByRole('link', { name: 'Check Availability' });
    expect(checkAvailLink).toHaveAttribute('href', '/rental/availability?branch_id=branch-2&category_id=cat-2');
  });

  it('shows empty-state messages when all data sources are empty', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization: [],
        in_flight: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<BranchOpsDashboardScreen />);

    expect(screen.getByText('No branch utilization data found.')).toBeInTheDocument();
    expect(screen.getByText('No transfers currently in flight.')).toBeInTheDocument();
    expect(screen.getByText('No availability data found.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'View Full Availability' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Open Returns / Check-In' })).toHaveAttribute('href', '/rental/returns');
  });
});
