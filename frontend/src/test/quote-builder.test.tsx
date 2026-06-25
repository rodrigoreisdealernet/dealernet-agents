/**
 * Tests for /rental/quoting — Staff Quote Builder
 *
 * Tests cover:
 *  - Role-gated access (admin / branch_manager vs read-only roles)
 *  - Renders all key form fields (order details, expiration, notes)
 *  - Multi-line item add and remove
 *  - Price/rate display toggle
 *  - Per-line availability check (available and unavailable states)
 *  - Unavailability warning banner
 *  - Save draft calls staff_save_quote_order RPC and shows success
 *  - Save error handling
 *  - Happy-path: saved draft can be re-opened (initialOrderId prop)
 *  - Pricing-preview panel (fee/tax engine, stale badge)
 *  - offsetDaysStr and normalizeQty utilities
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppRole } from '@/auth/types';

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

const { rpcMock, fromMock, capabilitiesState } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  capabilitiesState: { canWrite: true, canOperate: true, role: 'admin' as AppRole },
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuthCapabilities: () => capabilitiesState,
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({
      useSearch: () => ({ order_id: undefined }),
    }),
  };
});

import {
  QuoteBuilderPage,
  QuoteBuilderScreen,
  offsetDaysStr,
  normalizeQty,
  lineBaseAmount,
} from '@/routes/rental/quoting';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPricingBreakdown(override: {
  base_amount?: number;
  fees_total?: number;
  subtotal?: number;
  tax_total?: number;
  grand_total?: number;
  fee_lines?: unknown[];
  tax_lines?: unknown[];
} = {}) {
  const base = override.base_amount ?? 1000;
  const feesTotal = override.fees_total ?? 50;
  const subtotal = override.subtotal ?? base + feesTotal;
  const taxTotal = override.tax_total ?? 89.25;
  const grandTotal = override.grand_total ?? subtotal + taxTotal;

  return {
    base_amount: base,
    fee_lines: override.fee_lines ?? [
      { preset_id: 'fee-preset-001', name: 'Environmental Fee', fee_type: 'percent', rate: 0.05, amount: feesTotal, scope: 'global' },
    ],
    fees_total: feesTotal,
    subtotal,
    tax_lines: override.tax_lines ?? [
      { preset_id: 'tax-preset-001', name: 'State Sales Tax', rate: 0.085, amount: taxTotal, scope: 'global' },
    ],
    tax_total: taxTotal,
    grand_total: grandTotal,
    preset_snapshot: { base_amount: base, grand_total: grandTotal },
  };
}

function mockPricingSuccess(override: Parameters<typeof buildPricingBreakdown>[0] = {}) {
  const row = buildPricingBreakdown(override);
  rpcMock.mockImplementation((rpc: string) => {
    if (rpc === 'staff_quote_pricing_preview') {
      return Promise.resolve({ data: [row], error: null });
    }
    if (rpc === 'staff_save_quote_order') {
      return Promise.resolve({
        data: [{ order_id: 'order-abc-001', order_number: 'Q-20260611-a1b2c3d4', saved_lines: [] }],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc: ' + rpc } });
  });
}

function mockSaveOrderSuccess() {
  rpcMock.mockImplementation((rpc: string) => {
    if (rpc === 'staff_save_quote_order') {
      return Promise.resolve({
        data: [{ order_id: 'order-abc-001', order_number: 'Q-20260611-a1b2c3d4', saved_lines: [{ line_id: 'line-001', category_id: null }] }],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc: ' + rpc } });
  });
}

function mockAvailabilityResult(available: boolean) {
  rpcMock.mockImplementation((rpc: string) => {
    if (rpc === 'rental_quote_availability') {
      return Promise.resolve({
        data: available
          ? [{ is_available: true, available_quantity: 5, shortage_quantity: 0, shortage_reason: null }]
          : [{ is_available: false, available_quantity: 1, shortage_quantity: 2, shortage_reason: 'fully_committed_for_requested_window' }],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
  });
}

const LOOKUP_ROWS_BY_ENTITY_TYPE: Record<string, Array<{ id: string; entity_versions: Array<{ data: Record<string, unknown> }> }>> = {
  customer: [{ id: 'cust-uuid-001', entity_versions: [{ data: { name: 'Acme Aggregates' } }] }],
  billing_account: [{ id: 'billing-uuid-001', entity_versions: [{ data: { name: 'Acme Billing HQ' } }] }],
  job_site: [{ id: 'site-uuid-001', entity_versions: [{ data: { name: 'Route 77 Corridor Phase B' } }] }],
  asset_category: [
    { id: 'cat-uuid-001', entity_versions: [{ data: { name: 'Earthmoving' } }] },
    { id: 'cat-001', entity_versions: [{ data: { name: 'Category 1' } }] },
    { id: 'cat-002', entity_versions: [{ data: { name: 'Category 2' } }] },
  ],
  branch: [{ id: 'branch-uuid-001', entity_versions: [{ data: { name: 'Dallas Yard' } }] }],
  asset: [{ id: 'asset-uuid-001', entity_versions: [{ data: { name: 'CAT 320-8' } }] }],
  inventory_kit: [{ id: 'kit-uuid-001', entity_versions: [{ data: { name: 'Earthmoving Starter Bundle' } }] }],
};

function mockDefaultEntitiesFrom() {
  fromMock.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        return query;
      }),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        if (table === 'entities') {
          const entityType = filters.entity_type;
          if (typeof entityType === 'string') {
            return Promise.resolve({
              data: LOOKUP_ROWS_BY_ENTITY_TYPE[entityType] ?? [],
              error: null,
            });
          }
        }
        return Promise.resolve({ data: [], error: null });
      }),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
      filter: vi.fn().mockResolvedValue({ data: [], error: null }),
    };

    return query;
  });
}

// ---------------------------------------------------------------------------
// Tests — basic rendering
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — rendering', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('renders the quote builder screen with all key sections', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('quote-builder-screen')).toBeInTheDocument();
  });

  it('renders order detail fields: customer, billing, job-site, expiration, notes', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('input-customer-id')).toBeInTheDocument();
    expect(screen.getByTestId('input-billing-account-id')).toBeInTheDocument();
    expect(screen.getByTestId('input-job-site-id')).toBeInTheDocument();
    expect(screen.getByTestId('input-expiration-date')).toBeInTheDocument();
    expect(screen.getByTestId('input-internal-notes')).toBeInTheDocument();
    expect(screen.getByTestId('input-external-notes')).toBeInTheDocument();
  });

  it('uses human-readable commercial context labels instead of UUID-first labels', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByLabelText('Customer')).toBeInTheDocument();
    expect(screen.getByLabelText('Billing Account')).toBeInTheDocument();
    expect(screen.getByLabelText('Job Site')).toBeInTheDocument();
    expect(screen.queryByText('Customer ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing Account ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Job Site ID')).not.toBeInTheDocument();
  });

  it('renders the first line item row on mount', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('line-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('input-line-0-kit')).toBeInTheDocument();
    expect(screen.getByTestId('input-line-0-category')).toBeInTheDocument();
    expect(screen.getByTestId('input-line-0-rate')).toBeInTheDocument();
    expect(screen.getByTestId('input-line-0-start')).toBeInTheDocument();
    expect(screen.getByTestId('input-line-0-end')).toBeInTheDocument();
    expect(screen.getByTestId('input-line-0-quantity')).toBeInTheDocument();
  });

  it('renders the save draft button', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('btn-save-draft')).toBeInTheDocument();
  });

  it('renders the pricing preview button', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('btn-preview-pricing')).toBeInTheDocument();
  });

  it('renders the price/rate toggle button', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('btn-toggle-rate-mode')).toBeInTheDocument();
    expect(screen.getByTestId('rate-mode-label')).toHaveTextContent('Show Rate');
  });
});

// ---------------------------------------------------------------------------
// Tests — multi-line management
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — line item management', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('adds a second line item when Add Line Item is clicked', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    expect(screen.queryByTestId('line-row-1')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('btn-add-line'));
    expect(screen.getByTestId('line-row-1')).toBeInTheDocument();
    expect(screen.getAllByText('Category').length).toBe(2);
    expect(screen.getAllByText('Branch').length).toBe(2);
    expect(screen.getAllByText('Asset').length).toBe(2);
  });

  it('adds multiple line items', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-add-line'));
    await user.click(screen.getByTestId('btn-add-line'));
    expect(screen.getByTestId('line-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('line-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('line-row-2')).toBeInTheDocument();
  });

  it('removes a line when the remove button is clicked', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-add-line'));
    expect(screen.getByTestId('line-row-1')).toBeInTheDocument();

    await user.click(screen.getByTestId('btn-remove-line-1'));
    expect(screen.queryByTestId('line-row-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('line-row-0')).toBeInTheDocument();
  });

  it('ensures at least one line remains after removing the only line', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-remove-line-0'));
    // A fresh empty line is auto-inserted so the form is never lineless.
    expect(screen.getByTestId('line-row-0')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — price/rate toggle
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — price/rate toggle', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('starts in rate mode — label shows "Show Rate"', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.getByTestId('rate-mode-label')).toHaveTextContent('Show Rate');
  });

  it('switches to price mode on toggle click and updates label', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-toggle-rate-mode'));
    expect(screen.getByTestId('rate-mode-label')).toHaveTextContent('Show Price');
  });

  it('shows rate breakdown display when in rate mode and line has valid rate+dates', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-line-0-rate'), '500');
    // dates are pre-filled by the component

    await waitFor(() => {
      expect(screen.getByTestId('line-0-rate-display')).toBeInTheDocument();
    });
  });

  it('shows price total display when switched to price mode', async () => {
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-line-0-rate'), '500');

    await user.click(screen.getByTestId('btn-toggle-rate-mode'));

    await waitFor(() => {
      expect(screen.getByTestId('line-0-price-display')).toBeInTheDocument();
    });

    expect(screen.getByTestId('line-0-price-display')).toHaveTextContent('Total:');
  });

  it('does not show rate/price display when daily rate is empty', () => {
    render(<QuoteBuilderScreen />);
    // No rate entered — neither display element should appear
    expect(screen.queryByTestId('line-0-rate-display')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-0-price-display')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — availability check
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — availability check', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('shows availability-available badge when inventory is sufficient', async () => {
    mockAvailabilityResult(true);
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    // Fill required availability fields on line 0
    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-category')).toHaveTextContent('Earthmoving');
      expect(screen.getByTestId('input-line-0-branch')).toHaveTextContent('Dallas Yard');
    });
    await user.selectOptions(screen.getByTestId('input-line-0-category'), 'cat-uuid-001');
    await user.selectOptions(screen.getByTestId('input-line-0-branch'), 'branch-uuid-001');
    expect(screen.getByTestId('input-line-0-category')).toHaveValue('cat-uuid-001');
    expect(screen.getByTestId('input-line-0-branch')).toHaveValue('branch-uuid-001');
    // dates are pre-filled

    await user.click(screen.getByTestId('btn-check-availability-0'));

    await waitFor(() => {
      expect(screen.getByTestId('availability-available-0')).toBeInTheDocument();
    });

    expect(screen.getByTestId('availability-available-0')).toHaveTextContent('Available');
  });

  it('shows availability-unavailable badge with shortage reason when inventory is short', async () => {
    mockAvailabilityResult(false);
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-category')).toHaveTextContent('Earthmoving');
      expect(screen.getByTestId('input-line-0-branch')).toHaveTextContent('Dallas Yard');
    });
    await user.selectOptions(screen.getByTestId('input-line-0-category'), 'cat-uuid-001');
    await user.selectOptions(screen.getByTestId('input-line-0-branch'), 'branch-uuid-001');

    await user.click(screen.getByTestId('btn-check-availability-0'));

    await waitFor(() => {
      expect(screen.getByTestId('availability-unavailable-0')).toBeInTheDocument();
    });

    expect(screen.getByTestId('availability-unavailable-0')).toHaveTextContent('Unavailable');
  });

  it('shows unavailability banner when at least one line is unavailable', async () => {
    mockAvailabilityResult(false);
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-category')).toHaveTextContent('Earthmoving');
      expect(screen.getByTestId('input-line-0-branch')).toHaveTextContent('Dallas Yard');
    });
    await user.selectOptions(screen.getByTestId('input-line-0-category'), 'cat-uuid-001');
    await user.selectOptions(screen.getByTestId('input-line-0-branch'), 'branch-uuid-001');

    await user.click(screen.getByTestId('btn-check-availability-0'));

    await waitFor(() => {
      expect(screen.getByTestId('unavailable-lines-warning')).toBeInTheDocument();
    });
  });

  it('checks kit availability via rental_kit_availability when a kit is selected', async () => {
    rpcMock.mockImplementation((rpc: string) => {
      if (rpc === 'rental_kit_availability') {
        return Promise.resolve({
          data: [{ is_available: true, available_quantity: 3, shortage_quantity: 0, blocking_components: [] }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
    });

    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-kit')).toHaveTextContent('Earthmoving Starter Bundle');
      expect(screen.getByTestId('input-line-0-branch')).toHaveTextContent('Dallas Yard');
    });
    await user.selectOptions(screen.getByTestId('input-line-0-kit'), 'kit-uuid-001');
    await user.selectOptions(screen.getByTestId('input-line-0-branch'), 'branch-uuid-001');
    await user.click(screen.getByTestId('btn-check-availability-0'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_kit_availability',
        expect.objectContaining({
          p_kit_id: 'kit-uuid-001',
          p_branch_id: 'branch-uuid-001',
        }),
      );
    });
  });

  it('check availability button is disabled when category or branch are empty', () => {
    render(<QuoteBuilderScreen />);
    // No category or branch filled — button should be disabled
    expect(screen.getByTestId('btn-check-availability-0')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Tests — save draft
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — save draft', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('calls staff_save_quote_order RPC and shows success on save', async () => {
    mockSaveOrderSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });

    expect(rpcMock).toHaveBeenCalledWith('staff_save_quote_order', expect.any(Object));
    expect(screen.getByTestId('saved-order-number')).toHaveTextContent('Q-20260611-a1b2c3d4');
    expect(screen.getByTestId('saved-order-id')).toHaveTextContent('order-abc-001');
  });

  it('shows save error when staff_save_quote_order RPC fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'rpc failed: permission denied' } });
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('save-error')).toHaveTextContent('rpc failed: permission denied');
  });

  it('passes expiration date and notes to the save RPC', async () => {
    mockSaveOrderSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-expiration-date'), '2026-07-01');
    await user.type(screen.getByTestId('input-internal-notes'), 'Check fleet status before confirming');
    await user.type(screen.getByTestId('input-external-notes'), 'Equipment will arrive by 8am');

    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });

    expect(rpcMock).toHaveBeenCalledWith(
      'staff_save_quote_order',
      expect.objectContaining({
        p_expiration_date: '2026-07-01',
        p_internal_notes: 'Check fleet status before confirming',
        p_external_notes: 'Equipment will arrive by 8am',
      }),
    );
  });

  it('passes customer and job-site IDs to the save RPC', async () => {
    mockSaveOrderSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('input-customer-id')).toHaveTextContent('Acme Aggregates');
      expect(screen.getByTestId('input-job-site-id')).toHaveTextContent('Route 77 Corridor Phase B');
    });
    await user.selectOptions(screen.getByTestId('input-customer-id'), 'cust-uuid-001');
    await user.selectOptions(screen.getByTestId('input-job-site-id'), 'site-uuid-001');
    expect(screen.getByTestId('input-customer-id')).toHaveValue('cust-uuid-001');
    expect(screen.getByTestId('input-job-site-id')).toHaveValue('site-uuid-001');

    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });

    expect(rpcMock).toHaveBeenCalledWith(
      'staff_save_quote_order',
      expect.objectContaining({
        p_customer_id: 'cust-uuid-001',
        p_job_site_id: 'site-uuid-001',
      }),
    );
  });

  it('passes display_rate_mode to the save RPC', async () => {
    mockSaveOrderSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    // Toggle to price mode before saving
    await user.click(screen.getByTestId('btn-toggle-rate-mode'));

    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });

    expect(rpcMock).toHaveBeenCalledWith(
      'staff_save_quote_order',
      expect.objectContaining({ p_display_rate_mode: 'price' }),
    );
  });

  it('passes multiple line items to the RPC when more than one line is added', async () => {
    mockSaveOrderSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-add-line'));
    await user.selectOptions(screen.getByTestId('input-line-0-category'), 'cat-001');
    await user.selectOptions(screen.getByTestId('input-line-1-category'), 'cat-002');

    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });

    const call = rpcMock.mock.calls.find((c: unknown[]) => c[0] === 'staff_save_quote_order');
    expect(call).toBeDefined();
    const args = call![1] as { p_lines: Array<{ category_id: string }> };
    expect(args.p_lines.length).toBe(2);
    expect(args.p_lines[0].category_id).toBe('cat-001');
    expect(args.p_lines[1].category_id).toBe('cat-002');
  });

  it('passes kit_id on kit-backed quote lines', async () => {
    mockSaveOrderSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-kit')).toHaveTextContent('Earthmoving Starter Bundle');
    });
    await user.selectOptions(screen.getByTestId('input-line-0-kit'), 'kit-uuid-001');
    await user.click(screen.getByTestId('btn-save-draft'));

    await waitFor(() => {
      expect(screen.getByTestId('save-success')).toBeInTheDocument();
    });

    expect(rpcMock).toHaveBeenCalledWith(
      'staff_save_quote_order',
      expect.objectContaining({
        p_lines: [expect.objectContaining({ kit_id: 'kit-uuid-001' })],
      }),
    );
  });

  it('shows loading state while save is in flight', async () => {
    let resolve: (v: unknown) => void = () => {};
    rpcMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.click(screen.getByTestId('btn-save-draft'));

    expect(screen.getByText('Saving…')).toBeInTheDocument();

    await act(async () => {
      resolve({
        data: [{ order_id: 'order-123', order_number: 'Q-test', saved_lines: [] }],
        error: null,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — happy-path edit existing order
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — re-open existing draft', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('pre-populates fields from initialOrderId when the order loads successfully', async () => {
    // Mock the supabase.from().select().eq().eq().single() chain for the order
    const mockSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'order-abc-001',
        entity_type: 'rental_order',
        entity_versions: [
          {
            is_current: true,
            data: {
              order_number: 'Q-20260611-a1b2c3d4',
              status: 'draft',
              customer_id: 'cust-pre-001',
              billing_account_id: 'billing-pre-001',
              job_site_id: 'site-pre-001',
              expiration_date: '2026-07-15',
              display_rate_mode: 'price',
              internal_notes: 'internal pre-loaded note',
              external_notes: 'external pre-loaded note',
            },
          },
        ],
      },
      error: null,
    });

    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          return query;
        }),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          if (table !== 'entities') return Promise.resolve({ data: [], error: null });
          const entityType = filters.entity_type;
          if (typeof entityType === 'string') {
            return Promise.resolve({
              data: LOOKUP_ROWS_BY_ENTITY_TYPE[entityType] ?? [],
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        }),
        single: vi.fn().mockImplementation(() => {
          if (table === 'entities' && filters.id === 'order-abc-001' && filters.entity_type === 'rental_order') {
            return mockSingle();
          }
          return Promise.resolve({ data: null, error: { message: 'not found' } });
        }),
        filter: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
      return query;
    });

    render(<QuoteBuilderScreen initialOrderId="order-abc-001" />);

    await waitFor(() => {
      expect(screen.getByTestId('input-customer-id')).toHaveValue('cust-pre-001');
    });

    expect(screen.getByTestId('input-billing-account-id')).toHaveValue('billing-pre-001');
    expect(screen.getByTestId('input-job-site-id')).toHaveValue('site-pre-001');
    expect(screen.getByTestId('input-internal-notes')).toHaveValue('internal pre-loaded note');
    expect(screen.getByTestId('input-external-notes')).toHaveValue('external pre-loaded note');
    // Display rate mode should be restored to 'price'
    expect(screen.getByTestId('rate-mode-label')).toHaveTextContent('Show Price');
  });
});

// ---------------------------------------------------------------------------
// Tests — calendar handoff prefill
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — calendar handoff prefill', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('pre-populates first line from prefillLine prop when no initialOrderId is given', async () => {
    render(<QuoteBuilderScreen prefillLine={{
      assetId: 'asset-uuid-001',
      branchId: 'branch-uuid-001',
      categoryId: 'cat-uuid-001',
      startDate: '2026-08-01',
      endDate: '2026-08-07',
    }} />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-start')).toHaveValue('2026-08-01');
    });

    expect(screen.getByTestId('input-line-0-end')).toHaveValue('2026-08-07');
    expect(screen.getByTestId('input-line-0-branch')).toHaveValue('branch-uuid-001');
    expect(screen.getByTestId('input-line-0-category')).toHaveValue('cat-uuid-001');
    expect(screen.getByTestId('input-line-0-asset')).toHaveValue('asset-uuid-001');
  });

  it('ignores prefillLine when initialOrderId is also provided', async () => {
    render(<QuoteBuilderScreen prefillLine={{
      assetId: 'asset-uuid-001',
      branchId: 'branch-uuid-001',
      categoryId: 'cat-uuid-001',
      startDate: '2026-08-01',
      endDate: '2026-08-07',
    }} initialOrderId="order-abc-001" />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-start')).not.toHaveValue('2026-08-01');
    });
    expect(screen.getByTestId('input-line-0-branch')).not.toHaveValue('branch-uuid-001');
  });

  it('applies only the provided prefillLine fields and leaves others at default', async () => {
    render(<QuoteBuilderScreen prefillLine={{ startDate: '2026-09-10', endDate: '2026-09-17' }} />);

    await waitFor(() => {
      expect(screen.getByTestId('input-line-0-start')).toHaveValue('2026-09-10');
    });
    expect(screen.getByTestId('input-line-0-end')).toHaveValue('2026-09-17');
    expect(screen.getByTestId('input-line-0-branch')).toHaveValue('');
    expect(screen.getByTestId('input-line-0-category')).toHaveValue('');
    expect(screen.getByTestId('input-line-0-asset')).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------
// Tests — pricing preview panel
// ---------------------------------------------------------------------------

describe('QuoteBuilderScreen — pricing preview panel', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
  });

  it('does not show pricing breakdown before preview is triggered', () => {
    render(<QuoteBuilderScreen />);
    expect(screen.queryByTestId('pricing-breakdown')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pricing-error')).not.toBeInTheDocument();
  });

  it('shows pricing breakdown with fee/tax lines after preview', async () => {
    mockPricingSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-line-0-rate'), '500');
    // start/end dates are pre-filled

    await user.click(screen.getByTestId('btn-preview-pricing'));

    await waitFor(() => {
      expect(screen.getByTestId('pricing-breakdown')).toBeInTheDocument();
    });

    expect(screen.getByTestId('line-base-amount')).toHaveTextContent('$1,000.00');
    expect(screen.getByTestId('line-subtotal')).toHaveTextContent('$1,050.00');
    expect(screen.getByTestId('line-grand-total')).toHaveTextContent('$1,139.25');
    expect(screen.getByTestId('fee-line-fee-preset-001')).toBeInTheDocument();
    expect(screen.getByTestId('tax-line-tax-preset-001')).toBeInTheDocument();
  });

  it('shows error alert when pricing preview RPC returns an error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'access denied' } });
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-line-0-rate'), '500');
    await user.click(screen.getByTestId('btn-preview-pricing'));

    await waitFor(() => {
      expect(screen.getByTestId('pricing-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('pricing-error')).toHaveTextContent('access denied');
  });

  it('shows loading state while pricing RPC is in flight', async () => {
    let resolve: (v: unknown) => void = () => {};
    rpcMock.mockImplementation(() => new Promise((r) => { resolve = r; }));

    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-line-0-rate'), '500');
    await user.click(screen.getByTestId('btn-preview-pricing'));

    expect(screen.getByText('Calculating…')).toBeInTheDocument();

    await act(async () => {
      resolve({ data: [buildPricingBreakdown()], error: null });
    });
  });

  it('shows stale badge when first-line inputs change after a successful preview', async () => {
    mockPricingSuccess();
    const user = userEvent.setup();
    render(<QuoteBuilderScreen />);

    await user.type(screen.getByTestId('input-line-0-rate'), '500');
    await user.click(screen.getByTestId('btn-preview-pricing'));

    await waitFor(() => {
      expect(screen.getByTestId('pricing-breakdown')).toBeInTheDocument();
    });

    // Change the daily rate → breakdown becomes stale
    await user.clear(screen.getByTestId('input-line-0-rate'));
    await user.type(screen.getByTestId('input-line-0-rate'), '600');

    await waitFor(() => {
      expect(screen.getByTestId('stale-badge')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — role gating
// ---------------------------------------------------------------------------

describe('QuoteBuilderPage — role gating', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockDefaultEntitiesFrom();
    capabilitiesState.canWrite = true;
    capabilitiesState.canOperate = true;
    capabilitiesState.role = 'admin';
  });

  it('renders quote builder for admin', () => {
    render(<QuoteBuilderPage />);
    expect(screen.getByTestId('quote-builder-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-builder-access-denied')).not.toBeInTheDocument();
  });

  it('renders quote builder for branch_manager', () => {
    capabilitiesState.canWrite = true;
    capabilitiesState.role = 'branch_manager';
    render(<QuoteBuilderPage />);
    expect(screen.getByTestId('quote-builder-screen')).toBeInTheDocument();
  });

  it('renders access-denied for field_operator', () => {
    capabilitiesState.canWrite = false;
    capabilitiesState.canOperate = true;
    capabilitiesState.role = 'field_operator';
    render(<QuoteBuilderPage />);
    expect(screen.getByTestId('quote-builder-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-builder-screen')).not.toBeInTheDocument();
  });

  it('renders access-denied for read_only', () => {
    capabilitiesState.canWrite = false;
    capabilitiesState.canOperate = false;
    capabilitiesState.role = 'read_only';
    render(<QuoteBuilderPage />);
    expect(screen.getByTestId('quote-builder-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-builder-screen')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — offsetDaysStr utility
// ---------------------------------------------------------------------------

describe('offsetDaysStr — local calendar date generation', () => {
  it('uses local calendar parts, not UTC truncation (timezone-boundary regression)', () => {
    const mockDateInstance = {
      getFullYear: () => 2026,
      getMonth: () => 5,   // June
      getDate: () => 10,
      setDate: vi.fn(),
      toISOString: () => '2026-06-09T23:30:00.000Z',
    };

    const DateSpy = vi.spyOn(global, 'Date').mockImplementationOnce(
      function MockDate() {
        return mockDateInstance as unknown as Date;
      } as unknown as DateConstructor,
    );

    const result = offsetDaysStr(0);

    expect(result).toBe('2026-06-10');

    DateSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests — normalizeQty utility
// ---------------------------------------------------------------------------

describe('normalizeQty', () => {
  it('returns 1 for zero input', () => expect(normalizeQty('0')).toBe(1));
  it('returns 1 for negative input', () => expect(normalizeQty('-3')).toBe(1));
  it('returns 1 for NaN input', () => expect(normalizeQty('abc')).toBe(1));
  it('returns 1 for empty string', () => expect(normalizeQty('')).toBe(1));
  it('returns 5 for valid positive input', () => expect(normalizeQty('5')).toBe(5));
});

// ---------------------------------------------------------------------------
// Tests — lineBaseAmount utility
// ---------------------------------------------------------------------------

describe('lineBaseAmount', () => {
  const baseLine = {
    clientId: 'test',
    lineId: null,
    kitId: '',
    categoryId: '',
    assetId: '',
    branchId: '',
    startDate: '2026-06-10',
    endDate: '2026-06-17',
    quantity: '1',
    dailyRate: '500',
    rateType: 'daily',
    name: '',
  };

  it('computes rate × days × qty correctly', () => {
    expect(lineBaseAmount(baseLine)).toBe(3500); // 500 × 7 days × 1
  });

  it('returns null when daily rate is empty', () => {
    expect(lineBaseAmount({ ...baseLine, dailyRate: '' })).toBeNull();
  });

  it('returns null when dates are missing or equal', () => {
    expect(lineBaseAmount({ ...baseLine, startDate: '2026-06-10', endDate: '2026-06-10' })).toBeNull();
  });

  it('applies quantity multiplier', () => {
    expect(lineBaseAmount({ ...baseLine, quantity: '3' })).toBe(10500); // 500 × 7 × 3
  });

  it('clamps invalid quantity to 1', () => {
    expect(lineBaseAmount({ ...baseLine, quantity: '-5' })).toBe(3500); // qty clamped to 1
  });
});
