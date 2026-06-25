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
import { MarketTransportControlPackScreen } from '@/routes/analytics/transport';

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

const buildBaseData = () => ({
  transport_efficiency_summary: [
    {
      total_routes: 40,
      loaded_routes: 36,
      empty_routes: 4,
      load_utilization_pct: 90.0,
      active_routes: 5,
      completed_routes: 30,
      missing_driver_count: 2,
      overdue_count: 4,
      eld_warning_count: 3,
      eld_violation_count: 1,
      stale_position_count: 5,
    },
  ],
  overdue_routes: [
    {
      line_id: 'line-1',
      asset_name: 'Excavator 200',
      assigned_driver: 'driver-1',
      assigned_truck: 'truck-A',
      exception_state: 'overdue',
    },
  ],
  missing_driver_routes: [
    {
      line_id: 'line-2',
      asset_name: 'Boom Lift 12',
      assigned_driver: null,
      assigned_truck: 'truck-Z',
      exception_state: 'missing_driver',
      branch_id: 'branch-2',
    },
  ],
  stale_telemetry_routes: [
    {
      line_id: 'line-3',
      asset_name: 'Telehandler 88',
      assigned_driver: 'driver-9',
      assigned_truck: 'truck-Y',
      branch_id: 'branch-3',
      telemetry_position_status: 'stale',
      telemetry_event_at: '2026-06-11T05:30:00Z',
    },
  ],
  hos_exceptions: [
    {
      line_id: 'line-10',
      assigned_driver: 'driver-2',
      assigned_truck: 'truck-B',
      asset_name: 'Skid Steer 50',
      departure_at: '2026-06-10T06:00:00Z',
      driver_log_status: 'out_of_hours',
      eld_compliance_status: 'warning',
    },
  ],
  dvir_exceptions: [
    {
      id: 'dvir-1',
      route_id: 'route-22',
      driver_id: 'driver-3',
      truck_id: 'truck-C',
      is_safe_to_drive: false,
      requires_review: true,
      defects: [{ description: 'brake fluid leak' }],
      submitted_at: '2026-06-11T07:00:00Z',
    },
  ],
  stop_exceptions: [
    {
      exception_id: 'exc-1',
      route_id: 'route-10',
      route_date: '2026-06-09',
      stop_type: 'delivery',
      exception_type: 'eta_delay',
      customer_name: 'Acme Construction',
      address: '123 Main St',
      estimated_delay_minutes: 45,
      requires_human_review: true,
    },
  ],
});

describe('market transport control pack screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders KPI pack heading and operating-model tags', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByRole('heading', { name: 'Weekly Market Transport Control Pack' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Market transport control pack' })).toBeInTheDocument();
    expect(screen.getByText('market-logistics-dispatcher:t5')).toBeInTheDocument();
    expect(screen.getByText('market-logistics-dispatcher:t6')).toBeInTheDocument();
  });

  it('renders human-approval banner', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Human approval remains required')).toBeInTheDocument();
  });

  it('renders KPI tile values from efficiency summary', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Total routes in scope')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('On-time delivery rate')).toBeInTheDocument();
    expect(screen.getByText('Overdue returns')).toBeInTheDocument();
    expect(screen.getByText('Missing driver assignments')).toBeInTheDocument();
    expect(screen.getByText('Load utilization')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('Stale position telemetry')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText(/4 routes still need a handback/i)).toBeInTheDocument();
    expect(screen.getByText(/2 routes still lack a named driver/i)).toBeInTheDocument();
    expect(screen.getByText(/5 routes no longer have fresh GPS evidence/i)).toBeInTheDocument();
  });

  it('turns KPI exceptions into operator follow-up links', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(
      screen.getByRole('link', { name: 'Open overdue route — Excavator 200' })
    ).toHaveAttribute('href', '/entities/rental_contract_line/line-1');
    expect(
      screen.getByRole('link', { name: 'Open missing-driver route — Boom Lift 12' })
    ).toHaveAttribute('href', '/entities/rental_contract_line/line-2');
    expect(
      screen.getByRole('link', { name: 'Open telemetry case — Telehandler 88' })
    ).toHaveAttribute('href', '/entities/rental_contract_line/line-3');
  });

  it('renders outside-haul feed missing alert', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Outside-haul spend feed not available')).toBeInTheDocument();
  });

  it('renders DOT/ELD compliance summary tiles', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('DOT / ELD compliance summary')).toBeInTheDocument();
    expect(screen.getByText('ELD violations')).toBeInTheDocument();
    expect(screen.getByText('ELD warnings')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders HOS exception card with driver link', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('HOS — driver log out of hours')).toBeInTheDocument();
    const sourceRefs = screen.getAllByText('Source: driver-2');
    expect(sourceRefs.length).toBeGreaterThanOrEqual(1);
    const reviewLinks = screen.getAllByRole('link', { name: 'Open source record' });
    const contractLink = reviewLinks.find((l) => l.getAttribute('href') === '/entities/rental_contract_line/line-10');
    expect(contractLink).toBeDefined();
  });

  it('renders DVIR unsafe card with truck and defect detail', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('DVIR — vehicle marked unsafe to drive')).toBeInTheDocument();
    expect(screen.getByText(/brake fluid leak/)).toBeInTheDocument();
  });

  it('renders stop exception card with customer and delay details', () => {
    useDataSourcesMock.mockReturnValue({
      data: buildBaseData(),
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Stop exception — ETA delay')).toBeInTheDocument();
    expect(screen.getByText(/Acme Construction/)).toBeInTheDocument();
    expect(screen.getByText(/45 min/)).toBeInTheDocument();
  });

  it('shows loading states while sources are fetching', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        transport_efficiency_summary: null,
        overdue_routes: null,
        hos_exceptions: null,
        dvir_exceptions: null,
        stop_exceptions: null,
      },
      isLoading: {
        transport_efficiency_summary: true,
        overdue_routes: true,
        hos_exceptions: true,
        dvir_exceptions: true,
        stop_exceptions: true,
      },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Loading transport KPI summary...')).toBeInTheDocument();
    expect(screen.getByText('Loading ELD compliance summary...')).toBeInTheDocument();
    expect(screen.getByText('Loading compliance exceptions...')).toBeInTheDocument();
  });

  it('shows error states when sources fail', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        transport_efficiency_summary: null,
        overdue_routes: null,
        hos_exceptions: null,
        dvir_exceptions: null,
        stop_exceptions: null,
      },
      isLoading: {},
      errors: {
        transport_efficiency_summary: new Error('efficiency summary query failed'),
        hos_exceptions: new Error('HOS query failed'),
        dvir_exceptions: null,
        stop_exceptions: null,
      },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getAllByText('Unable to load transport KPI summary')).toHaveLength(1);
    expect(screen.getByText('Unable to load ELD compliance summary')).toBeInTheDocument();
    expect(screen.getByText('Unable to load compliance exceptions')).toBeInTheDocument();
  });

  it('shows empty-state message when no compliance exceptions exist', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        transport_efficiency_summary: [{ total_routes: 10, completed_routes: 10, overdue_count: 0 }],
        overdue_routes: [],
        missing_driver_routes: [],
        stale_telemetry_routes: [],
        hos_exceptions: [],
        dvir_exceptions: [],
        stop_exceptions: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('No open compliance exceptions are currently surfaced.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open dispatch live board' }).length).toBeGreaterThanOrEqual(3);
  });

  it('shows source exception banner when efficiency summary is empty', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        transport_efficiency_summary: [],
        overdue_routes: [],
        missing_driver_routes: [],
        stale_telemetry_routes: [],
        hos_exceptions: [],
        dvir_exceptions: [],
        stop_exceptions: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Missing or incomplete source data')).toBeInTheDocument();
    expect(screen.getByText(/returned no rows/)).toBeInTheDocument();
  });

  it('renders missing-source warning inside compliance exception card', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        transport_efficiency_summary: [{ total_routes: 5 }],
        overdue_routes: [],
        missing_driver_routes: [],
        stale_telemetry_routes: [],
        hos_exceptions: [
          {
            line_id: 'line-99',
            assigned_driver: null,
            driver_log_status: 'out_of_hours',
            eld_compliance_status: 'unknown',
          },
        ],
        dvir_exceptions: [],
        stop_exceptions: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText('Missing source data')).toBeInTheDocument();
    expect(screen.getByText(/driver source missing/)).toBeInTheDocument();
  });

  it('shows explicit next steps when KPI summaries have counts but route samples are missing', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        transport_efficiency_summary: [
          {
            total_routes: 12,
            completed_routes: 7,
            overdue_count: 2,
            missing_driver_count: 1,
            stale_position_count: 3,
          },
        ],
        overdue_routes: [],
        missing_driver_routes: [],
        stale_telemetry_routes: [],
        hos_exceptions: [],
        dvir_exceptions: [],
        stop_exceptions: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<MarketTransportControlPackScreen />);

    expect(screen.getByText(/summary shows overdue work, but the sample route list is missing/i)).toBeInTheDocument();
    expect(screen.getByText(/summary flags missing-driver work, but the route-level feed is incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/summary reports stale telemetry, but the sampled route list is unavailable/i)).toBeInTheDocument();
  });
});
