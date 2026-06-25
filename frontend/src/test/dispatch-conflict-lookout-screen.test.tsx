import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: { from: fromMock },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Link: ({ children, to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
      <a href={to as string} {...props}>{children}</a>
    ),
    createFileRoute: () => (opts: { component: unknown }) => opts,
  };
});

import { DispatchConflictLookoutSection } from '@/routes/dispatch/live';

function makeChain(result: { data: unknown[]; error: null | { message: string } }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (
    resolve: (v: typeof result) => unknown,
    reject?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function mockLookoutTables() {
  fromMock.mockImplementation((table: string) => {
    if (table === 'v_dispatch_route_live') {
      return makeChain({
        data: [
          {
            line_id: 'line-1',
            contract_id: 'contract-1',
            asset_name: 'Excavator 320',
            route_status: 'in_transit',
            exception_state: 'overdue',
            branch_id: 'branch-1',
            assigned_driver: 'Driver Smith',
            telemetry_position_status: 'fresh',
            telemetry_sync_status: 'applied',
            eld_compliance_status: 'compliant',
            driver_log_status: 'current',
          },
        ],
        error: null,
      });
    }

    if (table === 'v_rental_contract_line_current') {
      return makeChain({
        data: [
          {
            entity_id: 'line-1',
            contract_id: 'contract-1',
            status: 'checked_out',
            category_id: 'cat-1',
            actual_end: null,
            data: { planned_end: '2026-07-09' },
          },
          {
            entity_id: 'line-2',
            contract_id: 'contract-2',
            status: 'pending_execution',
            category_id: 'cat-1',
            actual_end: null,
            data: { planned_start: '2026-07-11' },
          },
        ],
        error: null,
      });
    }

    if (table === 'entities') {
      return makeChain({
        data: [
          {
            id: 'contract-1',
            entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
          },
          {
            id: 'contract-2',
            entity_versions: [{ data: { contract_number: 'RC-002', branch_id: 'branch-1', order_id: 'order-2' } }],
          },
        ],
        error: null,
      });
    }

    if (table === 'rental_asset_availability_current') {
      return makeChain({
        data: [
          {
            branch_id: 'branch-1',
            branch_name: 'South Depot',
            asset_category_id: 'cat-1',
            asset_category_name: 'Excavators',
            available_assets: 0,
            unavailable_assets: 2,
            maintenance_due_assets: 1,
            maintenance_overdue_assets: 0,
            soft_down_assets: 0,
            hard_down_assets: 1,
          },
        ],
        error: null,
      });
    }

    return makeChain({ data: [], error: null });
  });
}

describe('DispatchConflictLookoutSection', () => {
  beforeEach(() => {
    fromMock.mockReset();
    mockLookoutTables();
  });

  it('renders the lookout panel with drill-down links and approval control', async () => {
    const user = userEvent.setup();
    render(<DispatchConflictLookoutSection />);

    await screen.findByRole('heading', { name: 'Market Dispatch Recovery Brief' });

    expect(screen.getByText(/Route slippage watch for RC-001/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Order order-1' })).toHaveAttribute('href', '/rental/orders/order-1');
    expect(screen.getByRole('link', { name: 'Contract contract-1' })).toHaveAttribute('href', '/rental/contracts/contract-1');
    expect(screen.getAllByText('Human approval required').length).toBeGreaterThan(0);

    const approveButton = screen.getAllByRole('button', { name: 'Approve manual follow-up' })[0];
    await user.click(approveButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Follow-up path approved' })).toBeDisabled();
    });
  });

  it('renders an error alert when a live query fails', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'v_dispatch_route_live') {
        return makeChain({ data: [], error: { message: 'dispatch feed unavailable' } });
      }
      return makeChain({ data: [], error: null });
    });

    render(<DispatchConflictLookoutSection />);

    await screen.findByTestId('dispatch-lookout-error');
    expect(screen.getByText('dispatch feed unavailable')).toBeInTheDocument();
  });
});
