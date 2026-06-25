/**
 * UI-level tests for /inventory/calendar – InventoryCalendarScreen
 *
 * Covers:
 *  1. Initial load calls the fleet_get_availability_calendar RPC and renders
 *     results into branch/category groups with availability badges.
 *  2. Clicking Apply passes the current filter state to the RPC.
 *  3. Clicking Apply when startDate > endDate shows the validation error and
 *     does NOT call the RPC.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoist mocks before any module imports
// ---------------------------------------------------------------------------

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import { InventoryCalendarScreen } from '@/routes/inventory/calendar';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const AVAILABLE_ASSET = {
  entity_id: 'asset-001',
  name: 'Excavator XL',
  identifier: 'EXC-001',
  branch_id: 'branch-north',
  branch_name: 'North Depot',
  asset_category_id: 'cat-earthmoving',
  asset_category_name: 'Earthmoving',
  operational_status: 'available',
  maintenance_due_status: 'none',
  is_available: true,
  conflict_reason: null,
};

const MAINTENANCE_ASSET = {
  entity_id: 'asset-002',
  name: 'Forklift 5T',
  identifier: 'FLK-002',
  branch_id: 'branch-south',
  branch_name: 'South Yard',
  asset_category_id: 'cat-material-handling',
  asset_category_name: 'Material Handling',
  operational_status: 'in_maintenance',
  maintenance_due_status: 'overdue',
  is_available: false,
  conflict_reason: 'maintenance',
};

const ON_RENT_ASSET = {
  entity_id: 'asset-003',
  name: 'Crane 20T',
  identifier: 'CRN-003',
  branch_id: 'branch-north',
  branch_name: 'North Depot',
  asset_category_id: 'cat-lifting',
  asset_category_name: 'Lifting',
  operational_status: 'available',
  maintenance_due_status: 'none',
  is_available: false,
  conflict_reason: 'on_rent',
};

function mockRpcSuccess(rows: unknown[]) {
  rpcMock.mockResolvedValue({ data: rows, error: null });
}

function mockRpcError(message: string) {
  // Reject the promise so the catch block receives an Error with .message set,
  // matching how real network/auth failures surface from the Supabase client.
  rpcMock.mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InventoryCalendarScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Initial load ────────────────────────────────────────────────────────

  it('renders page heading and filter controls on mount', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    expect(
      screen.getByRole('heading', { name: /fleet availability calendar/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toBeInTheDocument();
    expect(screen.getByLabelText('Branch')).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toBeInTheDocument();

    // The Apply button is hidden behind "Loading…" during the initial mount
    // fetch; wait for the load to settle before asserting on its presence.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument(),
    );
  });

  it('calls fleet_get_availability_calendar on initial mount', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'fleet_get_availability_calendar',
        expect.any(Object),
      );
    });
  });

  it('renders branch/category groups with asset rows after initial load', async () => {
    mockRpcSuccess([AVAILABLE_ASSET, MAINTENANCE_ASSET]);
    render(<InventoryCalendarScreen />);

    // Branch headers
    await waitFor(() => expect(screen.getAllByText('North Depot').length).toBeGreaterThan(0));
    expect(screen.getAllByText('South Yard').length).toBeGreaterThan(0);

    // Category headers within groups
    expect(screen.getAllByText('Earthmoving').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Material Handling').length).toBeGreaterThan(0);

    // Asset names
    expect(screen.getByText('Excavator XL')).toBeInTheDocument();
    expect(screen.getByText('Forklift 5T')).toBeInTheDocument();
  });

  it('shows "Available" badge for available assets', async () => {
    mockRpcSuccess([AVAILABLE_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(screen.getByText('Excavator XL')).toBeInTheDocument());
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('shows "In Maintenance" badge for maintenance-blocked assets', async () => {
    mockRpcSuccess([MAINTENANCE_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(screen.getByText('Forklift 5T')).toBeInTheDocument());
    // "In Maintenance" also appears as a status filter <option>, so use
    // getAllByText and confirm at least one match exists.
    expect(screen.getAllByText('In Maintenance').length).toBeGreaterThan(0);
  });

  it('shows "On Rent" badge for on-rent-blocked assets', async () => {
    mockRpcSuccess([ON_RENT_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(screen.getByText('Crane 20T')).toBeInTheDocument());
    expect(screen.getByText('On Rent')).toBeInTheDocument();
  });

  it('shows "Maint. Overdue" badge for assets with maintenance_due_status=overdue', async () => {
    mockRpcSuccess([MAINTENANCE_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(screen.getByText('Forklift 5T')).toBeInTheDocument());
    expect(screen.getByText('Maint. Overdue')).toBeInTheDocument();
  });

  it('renders the summary bar with available count when results are returned', async () => {
    mockRpcSuccess([AVAILABLE_ASSET, MAINTENANCE_ASSET]);
    render(<InventoryCalendarScreen />);

    // SummaryBar shows "N available" badge
    await waitFor(() => expect(screen.getByText('1 available')).toBeInTheDocument());
  });

  it('shows empty-state card when no assets are returned', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => {
      expect(
        screen.getByText('No assets found for the selected filters.'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/try widening the date window/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear scope filters/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view assets/i })).toHaveAttribute('href', '/entities/asset');
  });

  it('reloads a widened-scope availability query when clear scope filters is clicked from the empty state', async () => {
    const user = userEvent.setup();
    rpcMock
      .mockResolvedValueOnce({ data: [AVAILABLE_ASSET, MAINTENANCE_ASSET], error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [AVAILABLE_ASSET, MAINTENANCE_ASSET], error: null });

    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(screen.getByText('Forklift 5T')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-north');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-earthmoving');
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(
        screen.getByText('No assets found for the selected filters.'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('Forklift 5T')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear scope filters/i }));

    await waitFor(() => expect(screen.getByText('Forklift 5T')).toBeInTheDocument());

    const lastRpcParams = rpcMock.mock.calls[rpcMock.mock.calls.length - 1]?.[1] as Record<string, unknown>;
    expect(lastRpcParams).not.toHaveProperty('p_branch_id');
    expect(lastRpcParams).not.toHaveProperty('p_category_id');
    expect(lastRpcParams).toMatchObject({
      p_start_date: expect.any(String),
      p_end_date: expect.any(String),
    });
  });

  it('shows error alert on RPC failure', async () => {
    mockRpcError('database connection refused');
    render(<InventoryCalendarScreen />);

    await waitFor(() => {
      expect(screen.getByText('Unable to load availability')).toBeInTheDocument();
      expect(screen.getByText('database connection refused')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear scope filters/i })).toBeInTheDocument();
  });

  // ── 2. Apply passes filters to RPC ────────────────────────────────────────

  it('sends updated start and end dates to RPC when Apply is clicked', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    // Wait for the initial mount call to complete
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    // Update date filters
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-08-14' },
    });

    rpcMock.mockClear();
    mockRpcSuccess([]);

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'fleet_get_availability_calendar',
        expect.objectContaining({
          p_start_date: '2026-08-01',
          p_end_date: '2026-08-14',
        }),
      );
    });
  });

  it('shows human-readable branch and category options and still sends IDs in RPC params', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([AVAILABLE_ASSET, MAINTENANCE_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('option', { name: 'North Depot' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Earthmoving' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-north');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-earthmoving');

    rpcMock.mockClear();
    mockRpcSuccess([]);

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'fleet_get_availability_calendar',
        expect.objectContaining({
          p_branch_id: 'branch-north',
          p_category_id: 'cat-earthmoving',
        }),
      );
    });
  });

  it('keeps the selected scope visible with human-readable labels', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([AVAILABLE_ASSET, MAINTENANCE_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-north');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-earthmoving');

    expect(screen.getByText('Branch: North Depot')).toBeInTheDocument();
    expect(screen.getByText('Category: Earthmoving')).toBeInTheDocument();
  });

  it('includes status filter in RPC params when a status option is selected', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    const statusSelect = screen.getByLabelText('Status');
    await user.selectOptions(statusSelect, 'in_maintenance');

    rpcMock.mockClear();
    mockRpcSuccess([]);

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'fleet_get_availability_calendar',
        expect.objectContaining({ p_status: 'in_maintenance' }),
      );
    });
  });

  it('shows next-step actions that match asset state', async () => {
    mockRpcSuccess([AVAILABLE_ASSET, MAINTENANCE_ASSET, ON_RENT_ASSET]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(screen.getByText('Excavator XL')).toBeInTheDocument());

    expect(screen.getByRole('link', { name: 'Create rental order' })).toHaveAttribute(
      'href',
      expect.stringContaining('/rental/quoting?'),
    );
    expect(screen.getByRole('link', { name: 'Open maintenance' })).toHaveAttribute(
      'href',
      expect.stringContaining('/entities/maintenance_record?'),
    );
    expect(screen.getByRole('link', { name: 'Open contract' })).toHaveAttribute(
      'href',
      expect.stringContaining('/rental/contracts?'),
    );
  });

  // ── 3. Date validation ─────────────────────────────────────────────────────

  it('shows validation error and does not call RPC when startDate > endDate', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    // Wait for the initial mount call to complete
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    rpcMock.mockClear();

    // Set start after end
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-09-20' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-09-10' },
    });

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(
      screen.getByText('Start date must be on or before end date.'),
    ).toBeInTheDocument();

    // RPC must NOT have been called after the initial load
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('clears the date validation error when a subsequent Apply with valid dates succeeds', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    // Trigger the validation error
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-09-20' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-09-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(
      screen.getByText('Start date must be on or before end date.'),
    ).toBeInTheDocument();

    // Fix the dates and re-apply
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-09-10' },
    });
    rpcMock.mockClear();
    mockRpcSuccess([]);
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(
        screen.queryByText('Start date must be on or before end date.'),
      ).not.toBeInTheDocument();
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('shows validation error and does not call RPC when start date is cleared', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    rpcMock.mockClear();

    // Clear the start date so the field is empty
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(
      screen.getByText('Both start and end dates are required.'),
    ).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('shows validation error and does not call RPC when end date is cleared', async () => {
    mockRpcSuccess([]);
    render(<InventoryCalendarScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    rpcMock.mockClear();

    // Clear the end date so the field is empty
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    expect(
      screen.getByText('Both start and end dates are required.'),
    ).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
