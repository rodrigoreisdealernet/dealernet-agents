/**
 * Self-Service Dashboard Builder — unit tests
 *
 * Covers the metric catalog contract, localStorage persistence helpers, and
 * the React screen rendering.
 */

import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// ── Router mock ───────────────────────────────────────────────────────────────

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('@/data/supabase', () => ({
  supabase: { from: fromMock },
}));

import {
  METRIC_CATALOG,
  SUBJECT_LABELS,
  SOURCE_VIEW_LABELS,
  MAX_TILES,
  getMetric,
  isApprovedMetric,
  loadSavedDashboards,
  saveDashboard,
  deleteDashboard,
  metricsBySubject,
  type SavedDashboard,
} from '@/lib/reporting/metric-catalog';

import { DashboardBuilderScreen } from '@/routes/analytics/dashboards';

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function makeDashboard(overrides: Partial<SavedDashboard> = {}): SavedDashboard {
  return {
    id: 'test-dashboard-1',
    name: 'My Test Dashboard',
    metricKeys: ['fleet_utilization_pct', 'period_revenue'],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Metric catalog unit tests ─────────────────────────────────────────────────

describe('metric catalog', () => {
  it('exports a non-empty catalog', () => {
    expect(METRIC_CATALOG.length).toBeGreaterThan(0);
  });

  it('all metric keys are unique', () => {
    const keys = METRIC_CATALOG.map((m) => m.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('all metrics have a source view that is not a raw operational table', () => {
    const forbiddenRawTables = ['entities', 'entity_versions', 'entity_facts', 'events'];
    for (const metric of METRIC_CATALOG) {
      expect(forbiddenRawTables).not.toContain(metric.source);
    }
  });

  it('isApprovedMetric returns true for catalog keys', () => {
    for (const m of METRIC_CATALOG) {
      expect(isApprovedMetric(m.key)).toBe(true);
    }
  });

  it('isApprovedMetric returns false for unknown keys', () => {
    expect(isApprovedMetric('raw_sql_injection')).toBe(false);
    expect(isApprovedMetric('')).toBe(false);
    expect(isApprovedMetric('SELECT * FROM entities')).toBe(false);
  });

  it('getMetric returns the catalog entry for a known key', () => {
    const m = getMetric('fleet_utilization_pct');
    expect(m).toBeDefined();
    expect(m?.label).toBe('Fleet Utilization');
  });

  it('getMetric returns undefined for unknown keys', () => {
    expect(getMetric('not_in_catalog')).toBeUndefined();
  });

  it('metricsBySubject groups all metrics without losing any', () => {
    const grouped = metricsBySubject();
    const totalGrouped = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    expect(totalGrouped).toBe(METRIC_CATALOG.length);
  });

  it('every subject key in SUBJECT_LABELS is populated in metricsBySubject', () => {
    const grouped = metricsBySubject();
    for (const subject of Object.keys(SUBJECT_LABELS)) {
      expect(Array.isArray(grouped[subject as keyof typeof grouped])).toBe(true);
    }
  });

  it('MAX_TILES is a positive integer', () => {
    expect(Number.isInteger(MAX_TILES)).toBe(true);
    expect(MAX_TILES).toBeGreaterThan(0);
  });

  it('SOURCE_VIEW_LABELS covers every view name used in the catalog', () => {
    const usedViews = new Set(METRIC_CATALOG.map((m) => m.source));
    for (const view of usedViews) {
      expect(SOURCE_VIEW_LABELS).toHaveProperty(view);
    }
  });

  it('SOURCE_VIEW_LABELS values are operator-friendly (no raw DB view identifiers)', () => {
    const rawViewPattern = /^v_[a-z_]+$/;
    for (const label of Object.values(SOURCE_VIEW_LABELS)) {
      expect(label).not.toMatch(rawViewPattern);
    }
  });
});

// ── localStorage persistence tests ───────────────────────────────────────────

describe('saved dashboard persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('loadSavedDashboards returns [] when storage is empty', () => {
    expect(loadSavedDashboards()).toEqual([]);
  });

  it('saveDashboard stores a dashboard and loadSavedDashboards retrieves it', () => {
    const d = makeDashboard();
    saveDashboard(d);
    const loaded = loadSavedDashboards();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(d.id);
    expect(loaded[0].name).toBe(d.name);
    expect(loaded[0].metricKeys).toEqual(d.metricKeys);
  });

  it('saveDashboard updates an existing dashboard when the id matches', () => {
    const d = makeDashboard();
    saveDashboard(d);
    const updated = { ...d, name: 'Updated Name' };
    saveDashboard(updated);
    const loaded = loadSavedDashboards();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Updated Name');
  });

  it('saveDashboard appends when the id is new', () => {
    saveDashboard(makeDashboard({ id: 'a' }));
    saveDashboard(makeDashboard({ id: 'b' }));
    expect(loadSavedDashboards()).toHaveLength(2);
  });

  it('deleteDashboard removes the dashboard by id', () => {
    saveDashboard(makeDashboard({ id: 'to-delete' }));
    saveDashboard(makeDashboard({ id: 'to-keep' }));
    deleteDashboard('to-delete');
    const loaded = loadSavedDashboards();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('to-keep');
  });

  it('loadSavedDashboards returns [] on corrupt JSON', () => {
    localStorage.setItem('dia_saved_dashboards', 'not-json}}}');
    expect(loadSavedDashboards()).toEqual([]);
  });

  it('loadSavedDashboards returns [] when storage contains a non-array', () => {
    localStorage.setItem('dia_saved_dashboards', '{"foo":"bar"}');
    expect(loadSavedDashboards()).toEqual([]);
  });
});

// ── DashboardBuilderScreen rendering tests ────────────────────────────────────

describe('DashboardBuilderScreen', () => {
  beforeEach(() => {
    localStorage.clear();

    // Default: Supabase queries return no data so tiles show fallback
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the page heading', () => {
    renderWithQueryClient(<DashboardBuilderScreen />);
    expect(screen.getByRole('heading', { name: /dashboard builder/i })).toBeInTheDocument();
  });

  it('shows the empty canvas state when no metrics are selected', () => {
    renderWithQueryClient(<DashboardBuilderScreen />);
    expect(screen.getByText(/no kpis selected/i)).toBeInTheDocument();
  });

  it('renders the metric catalog sidebar with subject headings', () => {
    renderWithQueryClient(<DashboardBuilderScreen />);
    const sidebar = document.querySelector('aside')!;
    expect(sidebar).toHaveAttribute('tabindex', '0');
    expect(within(sidebar).getByText(/metric catalog/i)).toBeInTheDocument();
    expect(within(sidebar).getByText(/fleet performance/i)).toBeInTheDocument();
    expect(within(sidebar).getByText(/financial health/i)).toBeInTheDocument();
  });

  it('renders all catalog metric buttons in the sidebar', () => {
    renderWithQueryClient(<DashboardBuilderScreen />);
    for (const metric of METRIC_CATALOG) {
      expect(screen.getByRole('button', { name: new RegExp(metric.label, 'i') })).toBeInTheDocument();
    }
  });

  it('shows the approved metric reference table', () => {
    renderWithQueryClient(<DashboardBuilderScreen />);
    const referenceSection = screen.getByText(/approved metric reference/i).closest('section')!;
    expect(within(referenceSection).getByText(/fleet utilization/i)).toBeInTheDocument();
  });

  it('reference table shows operator-friendly data source labels, not raw DB view names', () => {
    renderWithQueryClient(<DashboardBuilderScreen />);
    const referenceSection = screen.getByText(/approved metric reference/i).closest('section')!;

    // Human-readable labels must be present (multiple rows may share a label)
    expect(within(referenceSection).getAllByText('Fleet & Operations Overview').length).toBeGreaterThan(0);
    expect(within(referenceSection).getAllByText('Branch Performance').length).toBeGreaterThan(0);
    expect(within(referenceSection).getAllByText('Asset-Level Analytics').length).toBeGreaterThan(0);
    expect(within(referenceSection).getAllByText('Fleet Downtime Analytics').length).toBeGreaterThan(0);

    // Raw DB view identifiers must not be visible
    const rawViewPattern = /^v_[a-z_]+$/;
    const allCells = within(referenceSection).getAllByRole('cell');
    for (const cell of allCells) {
      expect(cell.textContent ?? '').not.toMatch(rawViewPattern);
    }
  });

  it('adding a metric moves it from catalog to the canvas', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    const btn = screen.getByRole('button', { name: /fleet utilization/i });
    await user.click(btn);

    // Canvas should no longer show empty state
    expect(screen.queryByText(/no kpis selected/i)).not.toBeInTheDocument();

    // The metric should appear as "Added" in the sidebar
    expect(screen.getByText('Added')).toBeInTheDocument();
  });

  it('removing a metric tile restores the empty canvas state', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    await user.click(screen.getByRole('button', { name: /fleet utilization/i }));
    expect(screen.queryByText(/no kpis selected/i)).not.toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /remove fleet utilization/i });
    await user.click(removeBtn);
    expect(screen.getByText(/no kpis selected/i)).toBeInTheDocument();
  });

  it('shows an error when Save is clicked with no name', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    await user.click(screen.getByRole('button', { name: /fleet utilization/i }));
    await user.click(screen.getByRole('button', { name: /save dashboard/i }));

    expect(screen.getByText(/please enter a name/i)).toBeInTheDocument();
  });

  it('shows an error when Save is clicked with no metrics', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    const nameInput = screen.getByLabelText(/dashboard name/i);
    await user.type(nameInput, 'Test');
    await user.click(screen.getByRole('button', { name: /save dashboard/i }));

    expect(screen.getByText(/add at least one metric/i)).toBeInTheDocument();
  });

  it('saves a dashboard to localStorage and shows it in the Saved Dashboards section', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    await user.click(screen.getByRole('button', { name: /fleet utilization/i }));
    const nameInput = screen.getByLabelText(/dashboard name/i);
    await user.type(nameInput, 'Fleet Weekly');
    await user.click(screen.getByRole('button', { name: /save dashboard/i }));

    expect(screen.getByText(/dashboard saved/i)).toBeInTheDocument();
    expect(screen.getByText('Fleet Weekly')).toBeInTheDocument();
    expect(loadSavedDashboards()).toHaveLength(1);
  });

  it('loading a saved dashboard populates the canvas', async () => {
    const d = makeDashboard();
    saveDashboard(d);

    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    const loadBtn = screen.getByRole('button', { name: /^load$/i });
    await user.click(loadBtn);

    expect(screen.queryByText(/no kpis selected/i)).not.toBeInTheDocument();
  });

  it('deleting a saved dashboard removes it from the list', async () => {
    saveDashboard(makeDashboard());
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    await user.click(deleteBtn);

    expect(loadSavedDashboards()).toHaveLength(0);
    expect(screen.getByText(/no saved dashboards yet/i)).toBeInTheDocument();
  });

  it('shows a "New Dashboard" button that resets the builder', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    await user.click(screen.getByRole('button', { name: /fleet utilization/i }));
    expect(screen.queryByText(/no kpis selected/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /\+ new dashboard/i }));
    expect(screen.getByText(/no kpis selected/i)).toBeInTheDocument();
  });
});

// ── Unsupported metric contract enforcement ───────────────────────────────────

describe('unsupported metric enforcement', () => {
  beforeEach(() => {
    localStorage.clear();
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('loading a saved dashboard with an unsupported key shows unsupported count warning', async () => {
    const d = makeDashboard({ metricKeys: ['fleet_utilization_pct', 'unsupported_raw_table_query'] });
    saveDashboard(d);

    renderWithQueryClient(<DashboardBuilderScreen />);

    const savedSection = screen.getByText(/saved dashboards/i).closest('section')!;
    expect(within(savedSection).getByText(/1 unsupported/i)).toBeInTheDocument();
  });

  it('trying to save a dashboard with an unsupported key (loaded from storage) is rejected', async () => {
    const d = makeDashboard({ metricKeys: ['unsupported_raw_table_query'] });
    saveDashboard(d);

    const user = userEvent.setup();
    renderWithQueryClient(<DashboardBuilderScreen />);

    // Load the bad dashboard
    await user.click(screen.getByRole('button', { name: /^load$/i }));

    const nameInput = screen.getByLabelText(/dashboard name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Bad Dashboard');
    await user.click(screen.getByRole('button', { name: /update dashboard/i }));

    expect(screen.getByText(/not in the approved catalog/i)).toBeInTheDocument();
  });
});
