import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
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
import {
  buildBranchPLSummary,
  buildNetworkUtilizationSummary,
  buildNetworkUptimeSummary,
  buildExecutiveExceptions,
  buildExecutiveOperatingPack,
  EXECUTIVE_OPERATING_PACK_TAG,
} from '@/lib/reporting/executive-operating-pack';
import { ExecutiveMonthlyOperatingPackScreen } from '@/routes/executive/monthly-operating-pack';

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
          branch_name: 'North Yard',
          lifetime_revenue: 48000,
          utilization_pct: 55.0,
          downtime_pct: 18.0,
          total_downtime_minutes: 480,
          roi_pct: 12.5,
          roi_status: 'at_risk',
          last_order_at: '2026-05-01T08:00:00Z',
        },
        {
          asset_id: 'asset-2',
          asset_name: 'Boom Lift 60',
          branch_name: 'South Depot',
          lifetime_revenue: 32000,
          utilization_pct: 42.0,
          downtime_pct: 5.0,
          total_downtime_minutes: 120,
          roi_pct: 8.0,
          roi_status: 'on_track',
          last_order_at: '2026-05-15T08:00:00Z',
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
      inspection_exceptions: false,
      pm_due_assets: false,
    },
    errors: overrides.errors ?? {
      branch_utilization: null,
      asset_analytics: null,
      inspection_exceptions: null,
      pm_due_assets: null,
    },
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  };
}

// ── Unit tests for assembly functions ────────────────────────────────────────

describe('buildBranchPLSummary', () => {
  it('returns empty array when no rows supplied', () => {
    expect(buildBranchPLSummary([])).toEqual([]);
    expect(buildBranchPLSummary(null)).toEqual([]);
    expect(buildBranchPLSummary(undefined)).toEqual([]);
  });

  it('aggregates revenue and ROI by branch name', () => {
    const rows = [
      { branch_name: 'North Yard', lifetime_revenue: 30000, roi_pct: 10.0 },
      { branch_name: 'North Yard', lifetime_revenue: 20000, roi_pct: 15.0 },
      { branch_name: 'South Depot', lifetime_revenue: 40000, roi_pct: 8.0 },
    ];
    const result = buildBranchPLSummary(rows);
    expect(result).toHaveLength(2);

    const north = result.find((r) => r.branchName === 'North Yard');
    expect(north?.totalRevenue).toBe(50000);
    expect(north?.avgRoiPct).toBe(12.5);
    expect(north?.assetCount).toBe(2);
    expect(north?.sourceException).toBeNull();

    const south = result.find((r) => r.branchName === 'South Depot');
    expect(south?.totalRevenue).toBe(40000);
    expect(south?.avgRoiPct).toBe(8.0);
    expect(south?.assetCount).toBe(1);
  });

  it('surfaces a source exception when total revenue is zero', () => {
    const rows = [{ branch_name: 'Empty Branch', lifetime_revenue: 0, roi_pct: null }];
    const result = buildBranchPLSummary(rows);
    expect(result[0].sourceException).toMatch(/no lifetime revenue recorded/i);
  });

  it('returns null avgRoiPct when no roi_pct values exist', () => {
    const rows = [{ branch_name: 'North Yard', lifetime_revenue: 10000, roi_pct: null }];
    const result = buildBranchPLSummary(rows);
    expect(result[0].avgRoiPct).toBeNull();
  });

  it('sorts results by branch name', () => {
    const rows = [
      { branch_name: 'Zeta Yard', lifetime_revenue: 5000, roi_pct: null },
      { branch_name: 'Alpha Depot', lifetime_revenue: 8000, roi_pct: null },
    ];
    const result = buildBranchPLSummary(rows);
    expect(result[0].branchName).toBe('Alpha Depot');
    expect(result[1].branchName).toBe('Zeta Yard');
  });
});

describe('buildNetworkUtilizationSummary', () => {
  it('returns empty array when no rows supplied', () => {
    expect(buildNetworkUtilizationSummary([])).toEqual([]);
  });

  it('maps branch utilization rows correctly', () => {
    const rows = [
      { branch_id: 'b-1', branch_name: 'North Yard', on_rent_count: 12, utilization_rate_pct: 68.5, last_updated: '2026-06-01T08:00:00Z' },
    ];
    const result = buildNetworkUtilizationSummary(rows);
    expect(result).toHaveLength(1);
    expect(result[0].branchId).toBe('b-1');
    expect(result[0].branchName).toBe('North Yard');
    expect(result[0].onRentCount).toBe(12);
    expect(result[0].utilizationRatePct).toBe(68.5);
    expect(result[0].sourceException).toBeNull();
  });

  it('surfaces stale timestamp exception when last_updated is null', () => {
    const rows = [
      { branch_id: 'b-1', branch_name: 'Stale Branch', on_rent_count: 5, utilization_rate_pct: 50, last_updated: null },
    ];
    const result = buildNetworkUtilizationSummary(rows);
    expect(result[0].sourceException).toMatch(/freshness timestamp missing/i);
  });

  it('surfaces missing branch source exception when branch_id is null', () => {
    const rows = [
      { branch_id: null, branch_name: null, on_rent_count: 0, utilization_rate_pct: null, last_updated: null },
    ];
    const result = buildNetworkUtilizationSummary(rows);
    expect(result[0].sourceException).toMatch(/branch source record missing/i);
  });
});

describe('buildNetworkUptimeSummary', () => {
  it('returns empty array when no high-downtime rows exist', () => {
    const rows = [
      { asset_id: 'a-1', asset_name: 'Clean Asset', total_downtime_minutes: 0, downtime_pct: 0, roi_status: 'on_track' },
    ];
    expect(buildNetworkUptimeSummary(rows)).toEqual([]);
  });

  it('returns top 10 assets by downtime minutes', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      asset_id: `asset-${i}`,
      asset_name: `Asset ${i}`,
      branch_name: 'North Yard',
      total_downtime_minutes: 100 + i,
      downtime_pct: 5,
      roi_status: 'on_track',
    }));
    const result = buildNetworkUptimeSummary(rows);
    expect(result).toHaveLength(10);
  });

  it('sets sourceRef to the asset entity path', () => {
    const rows = [{ asset_id: 'asset-1', asset_name: 'Excavator', branch_name: 'North Yard', total_downtime_minutes: 300, downtime_pct: 12 }];
    const result = buildNetworkUptimeSummary(rows);
    expect(result[0].sourceRef).toBe('/entities/asset/asset-1');
  });

  it('surfaces source exception when downtime_pct is missing', () => {
    const rows = [{ asset_id: 'asset-1', asset_name: 'Excavator', total_downtime_minutes: 300, downtime_pct: null }];
    const result = buildNetworkUptimeSummary(rows);
    expect(result[0].sourceException).toMatch(/downtime percentage missing/i);
  });
});

describe('buildExecutiveExceptions', () => {
  it('returns failed inspections as critical severity', () => {
    const inspections = [
      { asset_id: 'a-1', service_record_id: 'svc-1', service_name: 'Pre-rental inspection', outcome: 'fail', opened_at: '2026-06-01T08:00:00Z' },
    ];
    const result = buildExecutiveExceptions(inspections, []);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('inspection');
    expect(result[0].severity).toBe('critical');
    expect(result[0].id).toBe('svc-1');
  });

  it('returns overdue PM assets as critical severity', () => {
    const pmRows = [
      { asset_id: 'a-2', policy_id: 'policy-1', label: '90-day service', is_due: true, is_pre_due: false, last_maintenance_at: '2026-03-01T00:00:00Z' },
    ];
    const result = buildExecutiveExceptions([], pmRows);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('pm_due');
    expect(result[0].severity).toBe('critical');
    expect(result[0].detail).toMatch(/PM overdue/i);
  });

  it('returns pre-due PM assets as warning severity', () => {
    const pmRows = [
      { asset_id: 'a-3', policy_id: 'policy-2', label: '30-day check', is_due: false, is_pre_due: true, last_maintenance_at: '2026-05-01T00:00:00Z' },
    ];
    const result = buildExecutiveExceptions([], pmRows);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
    expect(result[0].detail).toMatch(/PM coming due/i);
  });

  it('excludes PM rows where neither is_due nor is_pre_due is set', () => {
    const pmRows = [
      { asset_id: 'a-4', policy_id: 'policy-3', label: 'Annual check', is_due: false, is_pre_due: false },
    ];
    const result = buildExecutiveExceptions([], pmRows);
    expect(result).toHaveLength(0);
  });

  it('surfaces missing source reason when asset_id is absent from PM row', () => {
    const pmRows = [{ asset_id: null, policy_id: 'p-1', label: 'Service', is_due: true, is_pre_due: false }];
    const result = buildExecutiveExceptions([], pmRows);
    expect(result[0].missingSourceReason).toMatch(/asset source record missing/i);
  });

  it('surfaces missing source reason when inspection has no asset_id or service_record_id', () => {
    const inspections = [{ asset_id: null, service_record_id: null, service_name: 'Check', outcome: 'fail' }];
    const result = buildExecutiveExceptions(inspections, []);
    expect(result[0].missingSourceReason).toMatch(/asset link and inspection source record both missing/i);
  });
});

describe('buildExecutiveOperatingPack', () => {
  it('returns the operations-executive:t2 operating model tag', () => {
    const pack = buildExecutiveOperatingPack([], [], [], []);
    expect(pack.operatingModelTag).toBe(EXECUTIVE_OPERATING_PACK_TAG);
    expect(pack.operatingModelTag).toBe('operations-executive:t2');
  });

  it('surfaces a pack-level exception when branch utilization returns no rows', () => {
    const pack = buildExecutiveOperatingPack([], [{ branch_name: 'N', asset_id: 'a', lifetime_revenue: 1000 }], [], []);
    const msg = pack.packSourceExceptions.find((e) => /utilization source returned no rows/i.test(e));
    expect(msg).toBeDefined();
  });

  it('surfaces a pack-level exception when asset analytics returns no rows', () => {
    const pack = buildExecutiveOperatingPack([{ branch_id: 'b', branch_name: 'B', on_rent_count: 1, utilization_rate_pct: 50, last_updated: '2026-06-01T00:00:00Z' }], [], [], []);
    const msg = pack.packSourceExceptions.find((e) => /P&L and uptime sections are empty/i.test(e));
    expect(msg).toBeDefined();
  });

  it('surfaces a pack-level exception when both inspection and PM sources return no rows', () => {
    const pack = buildExecutiveOperatingPack([], [], [], []);
    const msg = pack.packSourceExceptions.find((e) => /Both inspection and PM sources/i.test(e));
    expect(msg).toBeDefined();
  });

  it('produces no pack-level exceptions when all sources are present and fresh', () => {
    const branchUtil = [{ branch_id: 'b', branch_name: 'B', on_rent_count: 5, utilization_rate_pct: 60, last_updated: '2026-06-01T00:00:00Z' }];
    const assetAnalytics = [{ asset_id: 'a', branch_name: 'B', lifetime_revenue: 1000, roi_pct: 10, total_downtime_minutes: 0 }];
    const inspections = [{ asset_id: 'a', service_record_id: 's', outcome: 'fail' }];
    const pack = buildExecutiveOperatingPack(branchUtil, assetAnalytics, inspections, []);
    expect(pack.packSourceExceptions).toHaveLength(0);
  });
});

// ── Screen tests ─────────────────────────────────────────────────────────────

describe('ExecutiveMonthlyOperatingPackScreen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders the operating-model tag badge and pack header', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    expect(screen.getByText('operations-executive:t2')).toBeInTheDocument();
    expect(screen.getByText(/Human sign-off required before distribution/i)).toBeInTheDocument();
  });

  it('renders cross-branch P&L summary cards for each branch', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    const section = screen.getByRole('region', { name: 'Cross-branch P&L summary' });
    expect(section).toBeInTheDocument();
    // Scope text lookups to the P&L section to avoid collision with the utilization section
    expect(within(section).getByText('North Yard')).toBeInTheDocument();
    expect(within(section).getByText('South Depot')).toBeInTheDocument();
    expect(within(section).getByText(/Revenue:.*\$48,000/)).toBeInTheDocument();
    expect(within(section).getByText(/Revenue:.*\$32,000/)).toBeInTheDocument();
  });

  it('renders network utilization section with on-rent counts and utilization rates', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    const section = screen.getByRole('region', { name: 'Network utilization' });
    expect(section).toBeInTheDocument();
    expect(within(section).getByText('North Yard')).toBeInTheDocument();
    expect(within(section).getByText('12 on rent')).toBeInTheDocument();
    expect(within(section).getByText(/Utilization:.*68.5%/)).toBeInTheDocument();
  });

  it('surfaces a per-branch stale-source warning when last_updated is missing', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    expect(screen.getByText(/utilization freshness timestamp missing/i)).toBeInTheDocument();
  });

  it('renders fleet uptime section with top high-downtime assets', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    const section = screen.getByRole('region', { name: 'Fleet uptime' });
    expect(section).toBeInTheDocument();
    expect(within(section).getByText('Excavator 320')).toBeInTheDocument();
    expect(within(section).getByText(/480 min downtime/)).toBeInTheDocument();
    // Scope the "Open asset record" links to the uptime section; asset-1 (480 min) sorts first
    const uptimeLinks = within(section).getAllByRole('link', { name: 'Open asset record' });
    expect(uptimeLinks[0]).toHaveAttribute('href', '/entities/asset/asset-1');
  });

  it('renders notable exceptions with inspection failures and PM overdue items', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    const section = screen.getByRole('region', { name: 'Notable exceptions' });
    expect(section).toBeInTheDocument();
    expect(screen.getByText('Pre-rental inspection')).toBeInTheDocument();
    expect(screen.getAllByText('Critical').length).toBeGreaterThan(0);
    expect(screen.getByText('90-day service')).toBeInTheDocument();
    expect(screen.getByText(/PM overdue/)).toBeInTheDocument();
  });

  it('renders the executive commentary section with a sign-off alert and textarea', async () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    const user = userEvent.setup();
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    const section = screen.getByRole('region', { name: 'Executive commentary and commitments' });
    expect(section).toBeInTheDocument();
    expect(screen.getByText(/Executive sign-off required/i)).toBeInTheDocument();

    const textarea = screen.getByLabelText('Commentary and commitments');
    expect(textarea).toBeInTheDocument();
    await user.type(textarea, 'Reviewing uptime with workshop lead across all branches.');
    expect(textarea).toHaveValue('Reviewing uptime with workshop lead across all branches.');
  });

  it('restores saved executive commentary after the screen remounts', async () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    const user = userEvent.setup();
    const savedCommentary = 'Board pack signed off. North Yard uptime improvement plan committed.';

    const firstRender = renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);
    const textarea = screen.getByLabelText('Commentary and commitments');
    await user.type(textarea, savedCommentary);
    expect(textarea).toHaveValue(savedCommentary);

    firstRender.unmount();

    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);
    expect(screen.getByLabelText('Commentary and commitments')).toHaveValue(savedCommentary);
  });

  it('shows loading placeholders and suppresses pack-level exceptions while sources are loading', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        branch_utilization: [],
        asset_analytics: [],
        inspection_exceptions: [],
        pm_due_assets: [],
        isLoading: {
          branch_utilization: true,
          asset_analytics: true,
          inspection_exceptions: true,
          pm_due_assets: true,
        },
      }),
    );
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    expect(screen.getByText(/Loading P&L summary/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading network utilization/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading fleet uptime/i)).toBeInTheDocument();
    expect(screen.getByText(/Loading notable exceptions/i)).toBeInTheDocument();

    // Pack-level "missing source" alert must NOT appear while loading
    expect(screen.queryByText(/Missing or stale source inputs/i)).not.toBeInTheDocument();
  });

  it('shows pack-level exceptions once all sources have finished loading', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        branch_utilization: [],
        isLoading: {
          branch_utilization: false,
          asset_analytics: false,
          inspection_exceptions: false,
          pm_due_assets: false,
        },
      }),
    );
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    expect(screen.getByText(/Missing or stale source inputs/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Branch utilization source returned no rows — utilization section is empty/i),
    ).toBeInTheDocument();
  });

  it('shows pack-level exception when both inspection and PM sources return no rows', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({ inspection_exceptions: [], pm_due_assets: [] }),
    );
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    expect(
      screen.getByText(/Both inspection and PM sources returned no rows/i),
    ).toBeInTheDocument();
  });

  it('shows a destructive alert when a data source fails to load', () => {
    useDataSourcesMock.mockReturnValue(
      makePackSources({
        errors: {
          branch_utilization: new Error('Network request failed'),
          asset_analytics: null,
          inspection_exceptions: null,
          pm_due_assets: null,
        },
      }),
    );
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    expect(screen.getByText(/One or more data sources could not be loaded/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Network request failed/i).length).toBeGreaterThan(0);
  });

  it('renders branch availability deep-links for each utilization row', () => {
    useDataSourcesMock.mockReturnValue(makePackSources());
    renderWithQueryClient(<ExecutiveMonthlyOperatingPackScreen />);

    const links = screen.getAllByRole('link', { name: 'Review branch availability' });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('/rental/availability'));
  });
});
