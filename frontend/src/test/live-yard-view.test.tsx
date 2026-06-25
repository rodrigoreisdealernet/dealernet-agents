import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fromMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
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

import { LiveYardViewScreen } from '@/routes/dispatch/yard';

type LiveYardActivityRow = {
  activity_id: string;
  lane_key: 'going_out' | 'coming_in' | 'needs_review' | 'maintenance';
  lane_sort_order: number;
  source_entity_type: string;
  source_entity_id: string;
  activity_status: string;
  branch_id: string | null;
  branch_name: string | null;
  location_id: string | null;
  location_name: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  due_at: string | null;
  sort_at: string | null;
  is_overdue: boolean;
  is_needs_review: boolean;
  needs_review_reason: string | null;
  order_id: string | null;
  order_line_id: string | null;
  order_number: string | null;
  contract_id: string | null;
  contract_line_id: string | null;
  contract_number: string | null;
  maintenance_record_id: string | null;
  maintenance_status: string | null;
  asset_id: string | null;
  asset_name: string | null;
  asset_category_id: string | null;
  asset_category_name: string | null;
  job_site_id: string | null;
  job_site_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  quantity: number | null;
  status_detail: string | null;
};

function createRow(overrides: Partial<LiveYardActivityRow>): LiveYardActivityRow {
  return {
    activity_id: 'activity-1',
    lane_key: 'going_out',
    lane_sort_order: 1,
    source_entity_type: 'rental_order_line',
    source_entity_id: 'source-1',
    activity_status: 'approved',
    branch_id: 'branch-1',
    branch_name: 'North Yard',
    location_id: 'branch-1',
    location_name: 'North Yard',
    scheduled_start_at: '2026-06-13T18:00:00Z',
    scheduled_end_at: '2026-06-20T18:00:00Z',
    due_at: '2026-06-13T18:00:00Z',
    sort_at: '2026-06-13T18:00:00Z',
    is_overdue: false,
    is_needs_review: false,
    needs_review_reason: null,
    order_id: 'order-1',
    order_line_id: 'order-line-1',
    order_number: 'RO-1001',
    contract_id: null,
    contract_line_id: null,
    contract_number: null,
    maintenance_record_id: null,
    maintenance_status: null,
    asset_id: null,
    asset_name: null,
    asset_category_id: 'category-1',
    asset_category_name: 'cat-excavator',
    job_site_id: 'site-1',
    job_site_name: 'Downtown Site',
    customer_id: 'customer-1',
    customer_name: 'Metro Builders',
    quantity: 1,
    status_detail: 'Approved order awaiting reservation fulfillment',
    ...overrides,
  };
}

function hoursFromNowIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

describe('LiveYardViewScreen', () => {
  let activityRows: LiveYardActivityRow[];
  let rpcErrorMessage: string | null;

  beforeEach(() => {
    vi.useRealTimers();
    rpcErrorMessage = null;
    activityRows = [
      createRow({}),
      createRow({
        activity_id: 'activity-2',
        source_entity_type: 'rental_contract_line',
        source_entity_id: 'contract-line-2',
        contract_id: 'contract-2',
        contract_line_id: 'contract-line-2',
        contract_number: 'RC-002',
        asset_id: 'asset-2',
        asset_name: 'Generator 88',
        branch_id: 'branch-2',
        branch_name: 'South Yard',
        location_id: 'branch-2',
        location_name: 'South Yard',
        scheduled_start_at: hoursFromNowIso(30),
        scheduled_end_at: hoursFromNowIso(78),
        due_at: hoursFromNowIso(30),
        sort_at: hoursFromNowIso(30),
        order_id: 'order-2',
        order_number: 'RO-1002',
        job_site_id: 'site-2',
        job_site_name: 'Airport Site',
        asset_category_name: 'cat-generator',
        status_detail: 'Reservation contract awaiting checkout',
      }),
      createRow({
        activity_id: 'activity-3',
        lane_key: 'coming_in',
        lane_sort_order: 2,
        source_entity_type: 'rental_contract_line',
        source_entity_id: 'contract-line-3',
        activity_status: 'checked_out',
        order_id: null,
        order_line_id: null,
        order_number: null,
        contract_id: 'contract-3',
        contract_line_id: 'contract-line-3',
        contract_number: 'RC-001',
        asset_id: 'asset-1',
        asset_name: 'Excavator 320',
        scheduled_start_at: '2026-06-11T08:00:00Z',
        scheduled_end_at: null,
        due_at: '2026-06-12T08:00:00Z',
        sort_at: '2026-06-12T08:00:00Z',
        is_overdue: true,
        asset_category_name: 'Excavators',
        status_detail: 'Checked-out contract line due back to yard',
      }),
      createRow({
        activity_id: 'activity-4',
        lane_key: 'needs_review',
        lane_sort_order: 3,
        source_entity_type: 'asset',
        source_entity_id: 'asset-review-1',
        activity_status: 'inspection_hold',
        order_id: null,
        order_line_id: null,
        order_number: null,
        contract_id: null,
        contract_line_id: null,
        contract_number: null,
        asset_id: 'asset-review-1',
        asset_name: 'Loader 10',
        scheduled_start_at: '2026-06-13T11:30:00Z',
        scheduled_end_at: null,
        due_at: null,
        sort_at: '2026-06-13T11:30:00Z',
        is_needs_review: true,
        asset_category_name: 'Loaders',
        status_detail: 'Asset is blocked on inspection review',
      }),
      createRow({
        activity_id: 'activity-5',
        lane_key: 'maintenance',
        lane_sort_order: 4,
        source_entity_type: 'maintenance_record',
        source_entity_id: 'maintenance-1',
        activity_status: 'open',
        order_id: null,
        order_line_id: null,
        order_number: null,
        contract_id: null,
        contract_line_id: null,
        contract_number: null,
        maintenance_record_id: 'maintenance-1',
        maintenance_status: 'open',
        asset_id: 'asset-maint-1',
        asset_name: 'Maintenance Asset',
        scheduled_start_at: '2026-06-12T08:00:00Z',
        scheduled_end_at: '2026-06-13T08:00:00Z',
        due_at: '2026-06-13T08:00:00Z',
        sort_at: '2026-06-13T08:00:00Z',
        is_overdue: true,
        asset_category_name: 'Compressors',
        status_detail: 'Open corrective work order (hard_down)',
      }),
    ];

    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === 'v_live_yard_activity_current') {
        return {
          select: vi.fn().mockResolvedValue({
            data: activityRows.map((row) => ({ ...row })),
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    rpcMock.mockReset();
    rpcMock.mockImplementation(async (_fn: string, args: Record<string, string>) => {
      if (rpcErrorMessage) {
        return { data: null, error: { message: rpcErrorMessage } };
      }

      if (args.p_action === 'mark_available') {
        activityRows = activityRows.filter((row) => row.source_entity_id !== args.p_source_entity_id);
      }

      if (args.p_action === 'open_maintenance') {
        const sourceRow = activityRows.find((row) => row.source_entity_id === args.p_source_entity_id);
        if (sourceRow) {
          activityRows = activityRows
            .filter((row) => row.source_entity_id !== args.p_source_entity_id)
            .concat([
              createRow({
                activity_id: 'activity-6',
                lane_key: 'maintenance',
                lane_sort_order: 4,
                source_entity_type: 'maintenance_record',
                source_entity_id: 'maintenance-2',
                activity_status: 'open',
                order_id: null,
                order_line_id: null,
                order_number: null,
                contract_id: null,
                contract_line_id: null,
                contract_number: null,
                branch_id: sourceRow.branch_id,
                branch_name: sourceRow.branch_name,
                location_id: sourceRow.location_id,
                location_name: sourceRow.location_name,
                maintenance_record_id: 'maintenance-2',
                maintenance_status: 'open',
                asset_id: sourceRow.asset_id,
                asset_name: sourceRow.asset_name,
                asset_category_name: sourceRow.asset_category_name,
                scheduled_start_at: '2026-06-13T12:00:00Z',
                scheduled_end_at: null,
                due_at: null,
                sort_at: '2026-06-13T12:00:00Z',
                is_overdue: false,
                is_needs_review: false,
                status_detail: 'Open corrective work order (hard_down)',
              }),
            ]);
        }
      }

      if (args.p_action === 'complete_maintenance') {
        activityRows = activityRows.filter((row) => row.source_entity_id !== args.p_source_entity_id);
      }

      return { data: null, error: null };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the four yard lanes with counts, badges, and inline actions from the canonical projection', async () => {
    render(<LiveYardViewScreen />);

    expect(await screen.findByRole('heading', { name: 'Live Yard View' })).toBeInTheDocument();
    expect(screen.getByText(/Auto-updates every 15 seconds/i)).toBeInTheDocument();

    expect(screen.getByTestId('yard-lane-going_out')).toHaveTextContent('Going Out');
    expect(screen.getByTestId('yard-lane-count-going_out')).toHaveTextContent('2');
    expect(screen.getByText('RO-1001 · cat-excavator')).toBeInTheDocument();

    expect(screen.getByTestId('yard-lane-coming_in')).toHaveTextContent('Coming In');
    expect(screen.getByTestId('yard-lane-count-coming_in')).toHaveTextContent('1');
    expect(screen.getByText('Excavator 320 · RC-001')).toBeInTheDocument();
    expect(screen.getAllByText('Overdue')).toHaveLength(2);

    expect(screen.getByTestId('yard-lane-needs_review')).toHaveTextContent('Needs Review');
    expect(screen.getByTestId('yard-lane-count-needs_review')).toHaveTextContent('1');
    expect(screen.getByText('Loader 10')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Release to Available' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Maintenance' })).toBeInTheDocument();

    expect(screen.getByTestId('yard-lane-maintenance')).toHaveTextContent('Maintenance');
    expect(screen.getByTestId('yard-lane-count-maintenance')).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Complete Maintenance' })).toBeInTheDocument();
  });

  it('keeps the same board content when switching display modes and filtering still preserves auto-refresh', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const intervalSpy = vi.spyOn(window, 'setInterval');

    render(<LiveYardViewScreen />);

    expect(await screen.findByText('RO-1001 · cat-excavator')).toBeInTheDocument();
    expect(screen.getByText('Generator 88 · RC-002')).toBeInTheDocument();
    const initialCalls = fromMock.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'TV' }));
    expect(screen.getByRole('button', { name: 'TV' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('RO-1001 · cat-excavator')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');

    await user.selectOptions(screen.getByLabelText('Location'), 'branch-2');
    expect(screen.queryByText('RO-1001 · cat-excavator')).not.toBeInTheDocument();
    expect(screen.getByText('Generator 88 · RC-002')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Time window'), '24h');
    expect(screen.queryByText('Generator 88 · RC-002')).not.toBeInTheDocument();
    expect(screen.getByTestId('yard-lane-going_out')).toHaveTextContent('No outbound yard work in the selected window.');

    const firstIntervalCall = intervalSpy.mock.calls[0];
    const refreshCallback = firstIntervalCall?.[0] as (() => void) | undefined;
    expect(firstIntervalCall?.[1]).toBe(15_000);
    expect(refreshCallback).toBeTypeOf('function');

    await act(async () => {
      refreshCallback?.();
    });

    await waitFor(() => {
      expect(fromMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
    expect(screen.getByTestId('yard-lane-going_out')).toHaveTextContent('No outbound yard work in the selected window.');
    intervalSpy.mockRestore();
  });

  it('applies a release-to-available action through the authoritative RPC and refreshes the board', async () => {
    const user = userEvent.setup();
    render(<LiveYardViewScreen />);

    expect(await screen.findByText('Loader 10')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Release to Available' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_apply_live_yard_action', {
        p_source_entity_type: 'asset',
        p_source_entity_id: 'asset-review-1',
        p_action: 'mark_available',
        p_expected_lane_key: 'needs_review',
        p_expected_activity_status: 'inspection_hold',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('yard-lane-count-needs_review')).toHaveTextContent('0');
    });
    expect(screen.queryByText('Loader 10')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Inspection review resolved and the asset returned to available inventory.');
  });

  it('applies maintenance completion through the authoritative RPC and removes the completed item from the board', async () => {
    const user = userEvent.setup();
    render(<LiveYardViewScreen />);

    expect(await screen.findByText('Maintenance Asset')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Complete Maintenance' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_apply_live_yard_action', {
        p_source_entity_type: 'maintenance_record',
        p_source_entity_id: 'maintenance-1',
        p_action: 'complete_maintenance',
        p_expected_lane_key: 'maintenance',
        p_expected_activity_status: 'open',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('yard-lane-count-maintenance')).toHaveTextContent('0');
    });
    expect(screen.queryByText('Maintenance Asset')).not.toBeInTheDocument();
  });

  it('applies a send-to-maintenance action through the authoritative RPC, moves the asset to the maintenance lane, and shows a success message', async () => {
    const user = userEvent.setup();
    render(<LiveYardViewScreen />);

    expect(await screen.findByText('Loader 10')).toBeInTheDocument();
    expect(screen.getByTestId('yard-lane-count-needs_review')).toHaveTextContent('1');
    expect(screen.getByTestId('yard-lane-count-maintenance')).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: 'Send to Maintenance' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_apply_live_yard_action', {
        p_source_entity_type: 'asset',
        p_source_entity_id: 'asset-review-1',
        p_action: 'open_maintenance',
        p_expected_lane_key: 'needs_review',
        p_expected_activity_status: 'inspection_hold',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('yard-lane-count-needs_review')).toHaveTextContent('0');
    });
    expect(screen.queryByRole('button', { name: 'Send to Maintenance' })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('yard-lane-count-maintenance')).toHaveTextContent('2');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Maintenance work order opened from the Live Yard review lane.');
  });

  it('shows explicit stale-transition errors from the authoritative RPC without mutating board state locally', async () => {
    const user = userEvent.setup();
    rpcErrorMessage = 'Live yard item is stale or already changed. Refresh the board and try again.';
    render(<LiveYardViewScreen />);

    expect(await screen.findByText('Loader 10')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send to Maintenance' }));

    expect(await screen.findByText('Live yard item is stale or already changed. Refresh the board and try again.')).toBeInTheDocument();
    expect(screen.getByText('Loader 10')).toBeInTheDocument();
    expect(screen.getByTestId('yard-lane-count-needs_review')).toHaveTextContent('1');
  });
});
