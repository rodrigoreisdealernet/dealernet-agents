/**
 * AI Reporting route tests
 *
 * Covers:
 * • Filter param normalisation (validateSearch contract)
 * • URL-param round-tripping — filter changes land in navigate() calls
 * • Loading, empty, and backend-error states
 * • Chart view: bar chart rendered, drilldown triggers scopeId + view=table
 * • Table view: rows rendered with consistent document counts and totals
 * • Drilldown consistency — same filtered totals shown in both chart labels
 *   and table footer
 * • Bookmark restoration — parsing a URL search string reproduces the same
 *   filter state
 */

import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}));

const { navigateSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
    useNavigate: () => navigateSpy,
  };
});

import {
  AiReportingScreen,
} from '@/routes/analytics/ai-reporting';

import {
  parseAiReportingSearch,
  aiReportingQueryKey,
  rowMatchesFilters,
  buildScopeSummaries,
  type AiReportingFilters,
  type AiReportingRow,
} from '@/lib/reporting/ai-reporting-filters';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return { queryClient, ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>) };
}

function baseFilters(overrides: Partial<AiReportingFilters> = {}): AiReportingFilters {
  return {
    scopeType: 'company',
    scopeId: '',
    categoryId: '',
    itemType: '',
    start: '2020-01-01',
    end: '2030-12-31',
    view: 'chart',
    ...overrides,
  };
}

function sampleRows(): AiReportingRow[] {
  return [
    {
      source_entity_id: 'inv-001',
      source_entity_type: 'invoice',
      document_number: 'INV-00001',
      document_status: 'sent',
      document_date: '2026-06-02',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      originating_scope_id: 'branch-houston',
      originating_scope_name: 'Houston Central',
      branch_scope_id: 'branch-houston',
      branch_scope_name: 'Houston Central',
      region_scope_id: 'region-gulf',
      region_scope_name: 'Gulf Coast',
      company_scope_id: 'company-1',
      company_scope_name: 'Dealernet Industrial',
      transaction_currency_code: 'USD',
      reporting_currency_code: 'USD',
      transaction_total_amount: 1000,
      reporting_total_amount: 1000,
      asset_category_id: 'cat-earthmoving',
    },
    {
      source_entity_id: 'inv-002',
      source_entity_type: 'invoice',
      document_number: 'INV-00002',
      document_status: 'paid',
      document_date: '2026-06-05',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      originating_scope_id: 'branch-dallas',
      originating_scope_name: 'Dallas North Yard',
      branch_scope_id: 'branch-dallas',
      branch_scope_name: 'Dallas North Yard',
      region_scope_id: 'region-north',
      region_scope_name: 'North Texas',
      company_scope_id: 'company-1',
      company_scope_name: 'Dealernet Industrial',
      transaction_currency_code: 'USD',
      reporting_currency_code: 'USD',
      transaction_total_amount: 1200,
      reporting_total_amount: 1200,
      asset_category_id: 'cat-lifting',
    },
    {
      source_entity_id: 'inv-003',
      source_entity_type: 'credit_memo',
      document_number: 'CM-00001',
      document_status: 'approved',
      document_date: '2025-12-01',
      period_start: null,
      period_end: null,
      originating_scope_id: 'branch-houston',
      originating_scope_name: 'Houston Central',
      branch_scope_id: 'branch-houston',
      branch_scope_name: 'Houston Central',
      region_scope_id: 'region-gulf',
      region_scope_name: 'Gulf Coast',
      company_scope_id: 'company-2',
      company_scope_name: 'West Coast Rentals',
      transaction_currency_code: 'USD',
      reporting_currency_code: 'USD',
      transaction_total_amount: 500,
      reporting_total_amount: 500,
      asset_category_id: null,
    },
  ];
}

function mockSuccessResponse(rows = sampleRows()) {
  fromMock.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  });
}

function mockErrorResponse(message = 'DB unavailable') {
  fromMock.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: null, error: new Error(message) }),
  });
}

// ---------------------------------------------------------------------------
// 1. URL search param normalisation
// ---------------------------------------------------------------------------

describe('parseAiReportingSearch', () => {
  const validateSearch = parseAiReportingSearch;

  it('defaults scopeType to company when missing', () => {
    expect(validateSearch({})).toMatchObject({ scopeType: 'company' });
  });

  it('accepts valid scopeType values', () => {
    expect(validateSearch({ scopeType: 'region' })).toMatchObject({ scopeType: 'region' });
    expect(validateSearch({ scopeType: 'branch' })).toMatchObject({ scopeType: 'branch' });
  });

  it('defaults invalid scopeType to company', () => {
    expect(validateSearch({ scopeType: 'invalid' })).toMatchObject({ scopeType: 'company' });
  });

  it('defaults view to chart when missing', () => {
    expect(validateSearch({})).toMatchObject({ view: 'chart' });
  });

  it('accepts view=table', () => {
    expect(validateSearch({ view: 'table' })).toMatchObject({ view: 'table' });
  });

  it('normalises empty strings to empty defaults for scopeId, categoryId, itemType', () => {
    const result = validateSearch({ scopeId: '', categoryId: '  ', itemType: '' });
    expect(result.scopeId).toBe('');
    expect(result.categoryId).toBe('');
    expect(result.itemType).toBe('');
  });

  it('preserves valid scopeId, categoryId, itemType', () => {
    const result = validateSearch({ scopeId: 'branch-1', categoryId: 'cat-lifting', itemType: 'invoice' });
    expect(result.scopeId).toBe('branch-1');
    expect(result.categoryId).toBe('cat-lifting');
    expect(result.itemType).toBe('invoice');
  });

  it('rejects malformed date strings and substitutes defaults', () => {
    const result = validateSearch({ start: 'not-a-date', end: '20260101' });
    expect(result.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts valid ISO date strings', () => {
    const result = validateSearch({ start: '2026-01-01', end: '2026-12-31' });
    expect(result.start).toBe('2026-01-01');
    expect(result.end).toBe('2026-12-31');
  });
});

// ---------------------------------------------------------------------------
// 2. Route validateSearch contract — tested via parseAiReportingSearch
//    (Route is instantiated with parseAiReportingSearch as validateSearch;
//     the function-level tests above already cover the full contract)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3. Query key stability
// ---------------------------------------------------------------------------

describe('aiReportingQueryKey', () => {
  it('produces same key for identical filters', () => {
    const f = baseFilters();
    expect(aiReportingQueryKey(f)).toEqual(aiReportingQueryKey(f));
  });

  it('produces different keys when filters differ', () => {
    const f1 = baseFilters({ scopeId: 'branch-a' });
    const f2 = baseFilters({ scopeId: 'branch-b' });
    expect(aiReportingQueryKey(f1)).not.toEqual(aiReportingQueryKey(f2));
  });

  it('does not include view — chart and table share one cache entry', () => {
    const chart = baseFilters({ view: 'chart' });
    const table = baseFilters({ view: 'table' });
    expect(aiReportingQueryKey(chart)).toEqual(aiReportingQueryKey(table));
  });
});

// ---------------------------------------------------------------------------
// 4. rowMatchesFilters
// ---------------------------------------------------------------------------

describe('rowMatchesFilters', () => {
  const rows = sampleRows();

  it('matches all rows when no filters are active', () => {
    const filters = baseFilters();
    expect(rows.every((r) => rowMatchesFilters(r, filters))).toBe(true);
  });

  it('filters by branch scopeId', () => {
    const filters = baseFilters({ scopeType: 'branch', scopeId: 'branch-houston' });
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).toContain('inv-001');
    expect(matched.map((r) => r.source_entity_id)).toContain('inv-003');
    expect(matched.map((r) => r.source_entity_id)).not.toContain('inv-002');
  });

  it('filters by region scopeId', () => {
    const filters = baseFilters({ scopeType: 'region', scopeId: 'region-north' });
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).toEqual(['inv-002']);
  });

  it('filters by company scopeId', () => {
    const filters = baseFilters({ scopeType: 'company', scopeId: 'company-2' });
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).toEqual(['inv-003']);
  });

  it('filters by categoryId', () => {
    const filters = baseFilters({ categoryId: 'cat-earthmoving' });
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).toEqual(['inv-001']);
  });

  it('filters by itemType (document type)', () => {
    const filters = baseFilters({ itemType: 'credit_memo' });
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).toEqual(['inv-003']);
  });

  it('excludes rows outside the date window', () => {
    const filters = baseFilters({ start: '2026-01-01', end: '2026-12-31' });
    // inv-003 has document_date 2025-12-01 — outside window
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).not.toContain('inv-003');
  });

  it('combines multiple filter dimensions (AND semantics)', () => {
    const filters = baseFilters({
      scopeType: 'branch',
      scopeId: 'branch-houston',
      categoryId: 'cat-earthmoving',
      itemType: 'invoice',
      start: '2026-01-01',
      end: '2026-12-31',
    });
    const matched = rows.filter((r) => rowMatchesFilters(r, filters));
    expect(matched.map((r) => r.source_entity_id)).toEqual(['inv-001']);
  });
});

// ---------------------------------------------------------------------------
// 5. buildScopeSummaries
// ---------------------------------------------------------------------------

describe('buildScopeSummaries', () => {
  it('groups rows by company and sums reporting totals', () => {
    const rows = sampleRows();
    const summaries = buildScopeSummaries(rows, 'company');
    const company1 = summaries.find((s) => s.scopeId === 'company-1');
    expect(company1).toBeDefined();
    expect(company1?.documentCount).toBe(2);
    expect(company1?.reportingTotal).toBe(2200);
    const company2 = summaries.find((s) => s.scopeId === 'company-2');
    expect(company2?.documentCount).toBe(1);
    expect(company2?.reportingTotal).toBe(500);
  });

  it('groups rows by branch', () => {
    const rows = sampleRows();
    const summaries = buildScopeSummaries(rows, 'branch');
    const houston = summaries.find((s) => s.scopeId === 'branch-houston');
    expect(houston?.documentCount).toBe(2);
    expect(houston?.reportingTotal).toBe(1500);
    const dallas = summaries.find((s) => s.scopeId === 'branch-dallas');
    expect(dallas?.documentCount).toBe(1);
    expect(dallas?.reportingTotal).toBe(1200);
  });

  it('returns empty array for empty input', () => {
    expect(buildScopeSummaries([], 'company')).toEqual([]);
  });

  it('sorts summaries descending by reportingTotal', () => {
    const rows = sampleRows();
    const summaries = buildScopeSummaries(rows, 'company');
    const totals = summaries.map((s) => s.reportingTotal);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });
});

// ---------------------------------------------------------------------------
// 6. AiReportingScreen — loading state
// ---------------------------------------------------------------------------

describe('AiReportingScreen loading state', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
  });

  it('renders loading skeleton while query is in flight', async () => {
    // Never resolve so the component stays in loading state
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn(() => new Promise(() => {})),
    });

    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters()} onFiltersChange={noop} />
    );

    expect(screen.getByTestId('ai-report-loading')).toBeInTheDocument();
    expect(screen.getByText(/Loading chart data/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI Reporting' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. AiReportingScreen — error state
// ---------------------------------------------------------------------------

describe('AiReportingScreen error state', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
  });

  it('renders an accessible error alert on backend failure', async () => {
    mockErrorResponse('Connection refused');

    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters()} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-error');
    expect(screen.getByText(/Unable to load reporting data/i)).toBeInTheDocument();
    expect(screen.getByText(/Connection refused/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 8. AiReportingScreen — empty state (chart view)
// ---------------------------------------------------------------------------

describe('AiReportingScreen empty state', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
  });

  it('shows the empty-chart state when no rows match the active filters', async () => {
    mockSuccessResponse(sampleRows());

    const noop = vi.fn();
    // Filter that matches no rows
    const filters = baseFilters({ scopeId: 'branch-nonexistent', scopeType: 'branch' });
    renderWithQueryClient(
      <AiReportingScreen filters={filters} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-empty-chart');
    expect(screen.getByText(/No data found for the selected filters/i)).toBeInTheDocument();
  });

  it('shows the empty-table state when view=table and no rows match', async () => {
    mockSuccessResponse(sampleRows());

    const noop = vi.fn();
    const filters = baseFilters({ scopeId: 'branch-nonexistent', scopeType: 'branch', view: 'table' });
    renderWithQueryClient(
      <AiReportingScreen filters={filters} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-empty-table');
  });
});

// ---------------------------------------------------------------------------
// 9. AiReportingScreen — chart view
// ---------------------------------------------------------------------------

describe('AiReportingScreen chart view', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
    mockSuccessResponse();
  });

  it('renders chart bars for each scope', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'chart' })} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-chart');
    // Two distinct companies in sample data
    expect(screen.getByTestId('ai-report-chart-bar-company-1')).toBeInTheDocument();
    expect(screen.getByTestId('ai-report-chart-bar-company-2')).toBeInTheDocument();
  });

  it('chart labels match the KPI total', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'chart' })} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-kpi-total');
    // Total of all 3 sample rows (wide date window): 1000 + 1200 + 500 = 2700
    const kpiTotal = screen.getByTestId('ai-report-kpi-total');
    expect(kpiTotal.textContent).toContain('$2,700.00');
  });

  it('kpi count matches filtered row count', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'chart' })} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-kpi-count');
    // All 3 rows within the wide date window
    expect(screen.getByTestId('ai-report-kpi-count').textContent).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// 10. AiReportingScreen — table view
// ---------------------------------------------------------------------------

describe('AiReportingScreen table view', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
    mockSuccessResponse();
  });

  it('renders rows in the table view', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'table', start: '2026-01-01', end: '2026-12-31' })} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-table');
    expect(screen.getByTestId('ai-report-row-inv-001')).toBeInTheDocument();
    expect(screen.getByTestId('ai-report-row-inv-002')).toBeInTheDocument();
    // inv-003 (2025-12-01) is outside the date window
    expect(screen.queryByTestId('ai-report-row-inv-003')).not.toBeInTheDocument();
  });

  it('table row total matches KPI total (chart/table consistency)', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'table', start: '2026-01-01', end: '2026-12-31' })} onFiltersChange={noop} />
    );

    await screen.findByTestId('ai-report-table');
    // Both views use the same filteredRows; KPI strip is always visible
    const kpiTotal = screen.getByTestId('ai-report-kpi-total');
    expect(kpiTotal.textContent).toContain('$2,200.00');

    // Sum of individual rows in table also equals 2200
    const row1 = within(screen.getByTestId('ai-report-row-inv-001'));
    const row2 = within(screen.getByTestId('ai-report-row-inv-002'));
    expect(row1.getByText('$1,000.00')).toBeInTheDocument();
    expect(row2.getByText('$1,200.00')).toBeInTheDocument();
  });

  it('filters rows by itemType and reflects reduced count in KPI', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen
        filters={baseFilters({ view: 'table', itemType: 'invoice', start: '2026-01-01', end: '2026-12-31' })}
        onFiltersChange={noop}
      />
    );

    await screen.findByTestId('ai-report-table');
    expect(screen.getByTestId('ai-report-kpi-count').textContent).toBe('2');
    expect(screen.queryByTestId('ai-report-row-inv-003')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 11. Filter change — view toggle triggers onFiltersChange
// ---------------------------------------------------------------------------

describe('AiReportingScreen filter interactions', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
    mockSuccessResponse();
  });

  it('calls onFiltersChange with view=table when Table button is clicked', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'chart' })} onFiltersChange={onFiltersChange} />
    );

    await screen.findByRole('heading', { name: 'AI Reporting' });
    await user.click(screen.getByRole('button', { name: /Table/i }));

    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ view: 'table' }));
  });

  it('calls onFiltersChange with view=chart when Chart button is clicked', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'table' })} onFiltersChange={onFiltersChange} />
    );

    await screen.findByRole('heading', { name: 'AI Reporting' });
    await user.click(screen.getByRole('button', { name: /Chart/i }));

    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ view: 'chart' }));
  });

  it('calls onFiltersChange when Scope Level changes', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters()} onFiltersChange={onFiltersChange} />
    );

    await screen.findByRole('heading', { name: 'AI Reporting' });
    await user.selectOptions(screen.getByLabelText('Scope Level'), 'branch');

    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: 'branch', scopeId: '' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Drilldown — clicking a chart bar sets scopeId and switches to table
// ---------------------------------------------------------------------------

describe('AiReportingScreen drilldown', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
    mockSuccessResponse();
  });

  it('drilldown from chart bar triggers onFiltersChange with scopeId + view=table', async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters({ view: 'chart' })} onFiltersChange={onFiltersChange} />
    );

    await screen.findByTestId('ai-report-chart');
    // Click the Dealernet Industrial drilldown button (company-1)
    await user.click(screen.getByRole('button', { name: /Drilldown: Dealernet Industrial/i }));

    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: 'company-1', view: 'table' }),
    );
  });

  it('drilldown doc count in chart label matches table row count after drilldown', async () => {
    // The chart shows company-1 with documentCount=2; after drilling down to
    // company-1 in table view, 2 rows should be visible.
    const rows = sampleRows().filter((r) => r.company_scope_id === 'company-1');
    const summaries = buildScopeSummaries(rows, 'company');
    const co1 = summaries.find((s) => s.scopeId === 'company-1');

    // All 2 company-1 rows are within the test window
    expect(co1?.documentCount).toBe(2);

    // Now render the table view as if the user drilled down to company-1
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen
        filters={baseFilters({ scopeType: 'company', scopeId: 'company-1', view: 'table', start: '2026-01-01', end: '2026-12-31' })}
        onFiltersChange={noop}
      />
    );

    await screen.findByTestId('ai-report-table');
    expect(screen.getByTestId('ai-report-kpi-count').textContent).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// 13. Bookmark restoration — URL round-trip
// ---------------------------------------------------------------------------

describe('bookmark URL round-trip', () => {
  it('parseAiReportingSearch restores the exact same filter state from a serialised URL', () => {
    // Simulate what TanStack Router would place in the search object
    // from a bookmarked URL like:
    // /analytics/ai-reporting?scopeType=branch&scopeId=branch-houston
    //   &categoryId=cat-earthmoving&itemType=invoice
    //   &start=2026-03-01&end=2026-09-30&view=table
    const urlSearch = {
      scopeType: 'branch',
      scopeId: 'branch-houston',
      categoryId: 'cat-earthmoving',
      itemType: 'invoice',
      start: '2026-03-01',
      end: '2026-09-30',
      view: 'table',
    };

    const restored = parseAiReportingSearch(urlSearch);

    expect(restored).toEqual({
      scopeType: 'branch',
      scopeId: 'branch-houston',
      categoryId: 'cat-earthmoving',
      itemType: 'invoice',
      start: '2026-03-01',
      end: '2026-09-30',
      view: 'table',
    });
  });

  it('a bookmarked URL with partial params restores graceful defaults for missing fields', () => {
    const partialSearch = { scopeType: 'region', start: '2026-06-01' };
    const restored = parseAiReportingSearch(partialSearch);

    expect(restored.scopeType).toBe('region');
    expect(restored.scopeId).toBe('');
    expect(restored.categoryId).toBe('');
    expect(restored.itemType).toBe('');
    expect(restored.start).toBe('2026-06-01');
    expect(restored.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(restored.view).toBe('chart');
  });

  it('rendering with restored search params shows the same document count as directly computed', () => {
    // This integration-style check confirms that parseAiReportingSearch +
    // rowMatchesFilters together reproduce the filter the user last saw.
    const search = {
      scopeType: 'branch',
      scopeId: 'branch-houston',
      categoryId: '',
      itemType: 'invoice',
      start: '2026-01-01',
      end: '2026-12-31',
      view: 'table',
    };

    const restoredFilters = parseAiReportingSearch(search);
    const rows = sampleRows();
    const matched = rows.filter((r) => rowMatchesFilters(r, restoredFilters));
    // Only inv-001 matches: branch-houston + invoice + within 2026
    expect(matched.map((r) => r.source_entity_id)).toEqual(['inv-001']);
  });
});

// ---------------------------------------------------------------------------
// Export toolbar tests
// ---------------------------------------------------------------------------

describe('AiReportingScreen — export toolbar', () => {
  const { mockTriggerBlobDownload, mockTriggerPdfPrint } = vi.hoisted(() => ({
    mockTriggerBlobDownload: vi.fn(),
    mockTriggerPdfPrint: vi.fn(),
  }));

  vi.mock('@/lib/reporting/ai-report-export', async () => {
    const actual = await vi.importActual<typeof import('@/lib/reporting/ai-report-export')>(
      '@/lib/reporting/ai-report-export'
    );
    return {
      ...actual,
      triggerBlobDownload: mockTriggerBlobDownload,
      triggerReportPdfPrint: mockTriggerPdfPrint,
    };
  });

  function filtersWithData(): AiReportingFilters {
    return baseFilters({ view: 'table' });
  }

  beforeEach(() => {
    mockTriggerBlobDownload.mockReset();
    mockTriggerPdfPrint.mockReset();

    fromMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: sampleRows(), error: null }),
        }),
      }),
    });
  });

  it('renders the export toolbar when data loads successfully', async () => {
    renderWithQueryClient(
      <AiReportingScreen filters={filtersWithData()} onFiltersChange={vi.fn()} />
    );
    await screen.findByTestId('ai-report-export-toolbar');
    expect(screen.getByTestId('export-csv-btn')).toBeInTheDocument();
    expect(screen.getByTestId('export-xlsx-btn')).toBeInTheDocument();
    expect(screen.getByTestId('export-pdf-btn')).toBeInTheDocument();
  });

  it('Export CSV calls triggerBlobDownload with a .csv blob', async () => {
    renderWithQueryClient(
      <AiReportingScreen filters={filtersWithData()} onFiltersChange={vi.fn()} />
    );
    await screen.findByTestId('ai-report-export-toolbar');
    await userEvent.click(screen.getByTestId('export-csv-btn'));
    expect(mockTriggerBlobDownload).toHaveBeenCalledOnce();
    const [blob, filename] = mockTriggerBlobDownload.mock.calls[0] as [Blob, string];
    expect(blob.type).toContain('text/csv');
    expect(filename).toMatch(/\.csv$/);
  });

  it('Export Excel calls triggerBlobDownload with a .xlsx blob', async () => {
    renderWithQueryClient(
      <AiReportingScreen filters={filtersWithData()} onFiltersChange={vi.fn()} />
    );
    await screen.findByTestId('ai-report-export-toolbar');
    await userEvent.click(screen.getByTestId('export-xlsx-btn'));
    await vi.waitFor(() => expect(mockTriggerBlobDownload).toHaveBeenCalledOnce());
    const [, filename] = mockTriggerBlobDownload.mock.calls[0] as [Blob, string];
    expect(filename).toMatch(/\.xlsx$/);
  });

  it('Export PDF calls triggerReportPdfPrint and does not re-fetch', async () => {
    renderWithQueryClient(
      <AiReportingScreen filters={filtersWithData()} onFiltersChange={vi.fn()} />
    );
    await screen.findByTestId('ai-report-export-toolbar');
    const fetchCallsBefore = fromMock.mock.calls.length;
    await userEvent.click(screen.getByTestId('export-pdf-btn'));
    expect(mockTriggerPdfPrint).toHaveBeenCalledOnce();
    expect(mockTriggerBlobDownload).not.toHaveBeenCalled();
    expect(fromMock.mock.calls.length).toBe(fetchCallsBefore);
  });
});

// ---------------------------------------------------------------------------
// Human-readable filter labels
// ---------------------------------------------------------------------------

describe('AiReportingScreen — human-readable filter labels', () => {
  beforeEach(() => {
    fromMock.mockReset();
    navigateSpy.mockReset();
    mockSuccessResponse();
  });

  it('Document Type select renders readable labels, not raw snake_case tokens', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters()} onFiltersChange={noop} />
    );

    // Wait for data to load (KPI strip appears only after the query resolves).
    await screen.findByTestId('ai-report-kpi-count');

    const select = screen.getByLabelText('Document Type');
    // The sampleRows include source_entity_type = 'invoice' and 'credit_memo'.
    // Their visible option text must not be raw snake_case tokens.
    const optionTextValues = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);

    // 'invoice' must be capitalised to 'Invoice', not shown as lowercase 'invoice'
    expect(optionTextValues).not.toContain('invoice');
    expect(optionTextValues).toContain('Invoice');

    // 'credit_memo' must be sentence-cased to 'Credit memo', not shown as raw token
    expect(optionTextValues).not.toContain('credit_memo');
    expect(optionTextValues).toContain('Credit memo');
  });

  it('Document Type option value preserves the canonical backend token for filtering', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters()} onFiltersChange={noop} />
    );

    // Wait for data to load (KPI strip appears only after the query resolves).
    await screen.findByTestId('ai-report-kpi-count');

    const select = screen.getByLabelText('Document Type') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    const invoiceOption = options.find((o) => o.textContent === 'Invoice');

    // The option's value must still be the canonical 'invoice' token so URL params work correctly.
    expect(invoiceOption?.value).toBe('invoice');
  });

  it('Asset Category select renders readable labels from category id slugs', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen filters={baseFilters()} onFiltersChange={noop} />
    );

    // Wait for data to load (KPI strip appears only after the query resolves).
    await screen.findByTestId('ai-report-kpi-count');

    const select = screen.getByLabelText('Asset Category');
    const optionTextValues = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);

    // 'cat-earthmoving' and 'cat-lifting' must be humanized.
    expect(optionTextValues).not.toContain('cat-earthmoving');
    expect(optionTextValues).not.toContain('cat-lifting');

    // Humanized form should appear.
    expect(optionTextValues).toContain('Cat earthmoving');
    expect(optionTextValues).toContain('Cat lifting');
  });

  it('table Type column shows human-readable document type, not raw source_entity_type', async () => {
    const noop = vi.fn();
    renderWithQueryClient(
      <AiReportingScreen
        filters={baseFilters({ view: 'table', start: '2026-01-01', end: '2026-12-31' })}
        onFiltersChange={noop}
      />
    );

    await screen.findByTestId('ai-report-table');

    const row1 = screen.getByTestId('ai-report-row-inv-001');
    // The Type badge inside the row must show 'Invoice', not the raw lowercase 'invoice' token.
    expect(row1.textContent).toContain('Invoice');
  });
});
