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
    Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => {
      const href = typeof to === 'string' ? to : props.href;
      return <a {...props} href={href}>{children}</a>;
    },
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { FleetReportingDashboardScreen } from '@/routes/analytics/fleet';

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

describe('fleet reporting dashboard screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders utilization, invoice revenue, and downtime data', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization_by_branch: [
          {
            branch_id: 'branch-1',
            branch_name: 'North Yard',
            on_rent_count: 8,
            utilization_rate_pct: 67,
            last_updated: '2026-06-01T00:00:00Z',
          },
        ],
        utilization_by_category: [
          {
            branch_id: 'branch-1',
            branch_name: 'North Yard',
            asset_category_id: 'cat-1',
            asset_category_name: 'Excavators',
            total_assets: 12,
            available_assets: 4,
            unavailable_assets: 8,
          },
        ],
        invoice_revenue: [
          {
            id: 'invoice-1',
            source_record_id: 'INV-001',
            entity_versions: [
              {
                data: {
                  total: 5400,
                  subtotal: 5000,
                  tax: 400,
                },
              },
            ],
          },
        ],
        asset_downtime: [
          {
            asset_id: 'asset-7',
            downtime_recorded_at: '2026-06-02T00:00:00Z',
            downtime_minutes: 180,
            maintenance_record_id: 'maint-7',
          },
        ],
        asset_identity: [
          {
            entity_id: 'asset-7',
            name: 'Genie S-65 Boom Lift',
            data: { serial_number: 'TXR-42037' },
            current_asset_category_name: 'Boom Lifts',
            current_branch_name: 'North Yard',
          },
        ],
        category_downtime: [
          {
            asset_category_id: 'cat-1',
            asset_category_name: 'Excavators',
            asset_count: 12,
            downtime_intervals: 4,
            total_downtime_minutes: 540,
            average_interval_minutes: 135,
            maintenance_downtime_minutes: 420,
            inspection_downtime_minutes: 120,
            last_downtime_recorded_at: '2026-06-02T00:00:00Z',
          },
        ],
        asset_analytics: [
          {
            asset_id: 'asset-1',
            asset_name: 'Excavator 100',
            asset_category_name: 'Excavators',
            branch_name: 'North Yard',
            ownership_type: 'owned',
            lifetime_revenue: 12400,
            utilization_pct: 62.5,
            downtime_pct: 4.2,
            total_downtime_minutes: 840,
            rental_frequency: 6,
            roi_pct: null,
            roi_status: 'unavailable',
            last_order_at: '2026-06-03T09:00:00Z',
          },
        ],
        inspection_exceptions: [
          {
            asset_id: 'asset-7',
            service_record_id: 'inspection-7',
            service_name: 'Return inspection',
            outcome: 'fail',
            completed_at: '2026-06-05T12:00:00Z',
          },
        ],
        maintenance_review_work_orders: [
          {
            maintenance_record_id: 'wo-7',
            asset_id: 'asset-1',
            name: 'Hydraulic rebuild',
            work_order_status: 'awaiting_approval',
            sell_total: 4800,
          },
        ],
        disposition_candidates: [
          {
            asset_id: 'asset-1',
            asset_name: 'Excavator 100',
            branch_name: 'North Yard',
            asset_category_name: 'Excavators',
            lifetime_revenue: 12400,
            utilization_pct: 62.5,
            downtime_pct: 4.2,
            total_downtime_minutes: 840,
            rental_frequency: 6,
            roi_pct: null,
            roi_status: 'unavailable',
            last_order_at: '2026-06-03T09:00:00Z',
          },
        ],
        pm_due_assets: [
          {
            asset_id: 'asset-7',
            policy_id: 'pm-1',
            trigger_type: 'meter',
            is_due: true,
            latest_meter_value: null,
          },
          {
            asset_id: 'asset-2',
            policy_id: 'pm-2',
            trigger_type: 'time_interval',
            is_due: false,
            is_pre_due: true,
          },
        ],
        shop_category_downtime: [
          {
            asset_category_id: 'cat-1',
            total_downtime_minutes: 540,
            last_downtime_recorded_at: null,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<FleetReportingDashboardScreen />);

    expect(screen.getByRole('heading', { name: 'Fleet Utilization & Revenue Reporting' })).toBeInTheDocument();
    expect(screen.getByText('North Yard')).toBeInTheDocument();
    expect(screen.getByText('Utilization: 67%')).toBeInTheDocument();
    expect(screen.getByText('North Yard • Excavators')).toBeInTheDocument();
    expect(screen.getByText('8 unavailable')).toBeInTheDocument();
    expect(screen.getByText('Total $5400')).toBeInTheDocument();
    expect(screen.getByText('Subtotal $5000 · Tax $400')).toBeInTheDocument();
    expect(screen.getByText('540 downtime min')).toBeInTheDocument();
    expect(screen.getByText('12 assets · 4 intervals · Avg 135 min')).toBeInTheDocument();
    expect(screen.getByText('Maintenance 420 min · Inspection 120 min')).toBeInTheDocument();
    expect(screen.getByText('Genie S-65 Boom Lift · TXR-42037')).toBeInTheDocument();
    expect(screen.getByText('180 min downtime')).toBeInTheDocument();
    expect(screen.getAllByText('Excavator 100')).toHaveLength(2);
    expect(screen.getByText('Revenue $12400')).toBeInTheDocument();
    expect(screen.getByText('Utilization 62.5% · Downtime 4.2% · Frequency 6')).toBeInTheDocument();
    expect(screen.getAllByText('ROI Unavailable · Last order 2026-06-03T09:00:00Z')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Inspection, repair disposition, and shop KPI pack' })).toBeInTheDocument();
    expect(screen.getByText('service-maintenance-manager:t4')).toBeInTheDocument();
    expect(screen.getByText('service-maintenance-manager:t5')).toBeInTheDocument();
    expect(screen.getByText('service-maintenance-manager:t7')).toBeInTheDocument();
    expect(screen.getByText('Open inspection record')).toHaveAttribute('href', '/entities/inspection/inspection-7');
    expect(screen.getByText('Compare inspections')).toHaveAttribute('href', '/rental/inspection-comparison?asset_id=asset-7');
    expect(screen.getByText(/Highest tracked work order Hydraulic rebuild/)).toBeInTheDocument();
    expect(screen.getByText('PM due now')).toBeInTheDocument();
    expect(screen.getByText('Tracked maintenance spend')).toBeInTheDocument();
    expect(screen.getByText('1 PM due assets are missing fresh meter readings')).toBeInTheDocument();
  });

  it('shows empty-state messages when dashboard sources are empty', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization_by_branch: [],
        utilization_by_category: [],
        invoice_revenue: [],
        asset_downtime: [],
        asset_identity: [],
        category_downtime: [],
        asset_analytics: [],
        inspection_exceptions: [],
        maintenance_review_work_orders: [],
        disposition_candidates: [],
        pm_due_assets: [],
        shop_category_downtime: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<FleetReportingDashboardScreen />);

    expect(screen.getByText('No branch utilization data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No branch/category utilization data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No invoice revenue data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No category downtime data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No asset downtime data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No per-asset analytics data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No failed inspection exceptions are currently surfaced.')).toBeInTheDocument();
    expect(screen.getByText('No chronic or high-cost repair candidates are currently surfaced.')).toBeInTheDocument();
  });

  it('shows empty-state messages when sources resolve to non-list payloads', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization_by_branch: {},
        utilization_by_category: {},
        invoice_revenue: {},
        asset_downtime: {},
        asset_identity: {},
        asset_analytics: {},
        inspection_exceptions: {},
        maintenance_review_work_orders: {},
        disposition_candidates: {},
        pm_due_assets: {},
        shop_category_downtime: {},
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<FleetReportingDashboardScreen />);

    expect(screen.getByText('No branch utilization data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No branch/category utilization data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No invoice revenue data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No asset downtime data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No per-asset analytics data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No failed inspection exceptions are currently surfaced.')).toBeInTheDocument();
    expect(screen.getByText('No chronic or high-cost repair candidates are currently surfaced.')).toBeInTheDocument();
  });

  it('shows loading states while data sources are fetching', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization_by_branch: null,
        utilization_by_category: null,
        invoice_revenue: null,
        asset_downtime: null,
        asset_identity: null,
        category_downtime: null,
        asset_analytics: null,
        inspection_exceptions: null,
        maintenance_review_work_orders: null,
        disposition_candidates: null,
        pm_due_assets: null,
        shop_category_downtime: null,
      },
      isLoading: {
        utilization_by_branch: true,
        utilization_by_category: true,
        invoice_revenue: true,
        asset_downtime: true,
        asset_identity: true,
        category_downtime: true,
        asset_analytics: true,
        inspection_exceptions: true,
        maintenance_review_work_orders: true,
        disposition_candidates: true,
        pm_due_assets: true,
        shop_category_downtime: true,
      },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<FleetReportingDashboardScreen />);

    expect(screen.getByText('Loading branch utilization...')).toBeInTheDocument();
    expect(screen.getByText('Loading category utilization...')).toBeInTheDocument();
    expect(screen.getByText('Loading invoice revenue...')).toBeInTheDocument();
    expect(screen.getByText('Loading category downtime...')).toBeInTheDocument();
    expect(screen.getByText('Loading asset downtime...')).toBeInTheDocument();
    expect(screen.getByText('Loading per-asset analytics...')).toBeInTheDocument();
    expect(screen.getByText('Loading inspection exceptions...')).toBeInTheDocument();
    expect(screen.getByText('Loading repair disposition context...')).toBeInTheDocument();
    expect(screen.getByText('Loading weekly shop KPI pack...')).toBeInTheDocument();
  });

  it('shows error states when data sources fail', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        utilization_by_branch: null,
        utilization_by_category: null,
        invoice_revenue: null,
        asset_downtime: null,
        asset_identity: null,
        category_downtime: null,
        asset_analytics: null,
        inspection_exceptions: null,
        maintenance_review_work_orders: null,
        disposition_candidates: null,
        pm_due_assets: null,
        shop_category_downtime: null,
      },
      isLoading: {},
      errors: {
        utilization_by_branch: new Error('branch utilization query failed'),
        utilization_by_category: new Error('category utilization query failed'),
        invoice_revenue: new Error('invoice revenue query failed'),
        asset_downtime: new Error('asset downtime query failed'),
        asset_identity: new Error('asset identity query failed'),
        category_downtime: new Error('category downtime query failed'),
        asset_analytics: new Error('asset analytics query failed'),
        inspection_exceptions: new Error('inspection exception query failed'),
        maintenance_review_work_orders: new Error('maintenance work order query failed'),
        disposition_candidates: new Error('disposition candidate query failed'),
        pm_due_assets: new Error('pm due assets query failed'),
        shop_category_downtime: new Error('shop downtime query failed'),
      },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<FleetReportingDashboardScreen />);

    expect(screen.getByText('Unable to load branch utilization')).toBeInTheDocument();
    expect(screen.getByText('Unable to load category utilization')).toBeInTheDocument();
    expect(screen.getByText('Unable to load invoice revenue')).toBeInTheDocument();
    expect(screen.getByText('Unable to load asset downtime')).toBeInTheDocument();
    expect(screen.getByText('No category downtime data for this period.')).toBeInTheDocument();
    expect(screen.getByText('No per-asset analytics data for this period.')).toBeInTheDocument();
    expect(screen.getByText('Unable to load inspection exceptions')).toBeInTheDocument();
    expect(screen.getByText('Unable to load disposition candidates')).toBeInTheDocument();
    expect(screen.getByText('Unable to load PM KPI inputs')).toBeInTheDocument();
  });
});
