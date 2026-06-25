/**
 * Tests for /portal/storefront – date-range availability + live quote calc
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
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

import { StorefrontScreen, calcQuote, calcDaysBetween } from '@/routes/portal/storefront';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRpcSuccess(rows: unknown[]) {
  rpcMock.mockResolvedValue({ data: rows, error: null });
}

function mockRpcError(message: string) {
  rpcMock.mockResolvedValue({ data: null, error: { message } });
}

function mockRpcSubmitSuccess(quoteId = 'quote-abc-123') {
  rpcMock.mockImplementation((rpc: string) => {
    if (rpc === 'portal_storefront_submit_quote') {
      return Promise.resolve({
        data: [{ quote_request_id: quoteId, created_at: '2026-06-09T12:00:00Z' }],
        error: null,
      });
    }
    // portal_storefront_get_availability – return ASSET_1 so the card appears
    return Promise.resolve({ data: [ASSET_1], error: null });
  });
}

const ASSET_1 = {
  entity_id: 'asset-001',
  name: 'Excavator XL',
  make: 'Caterpillar',
  year: '2022',
  identifier: 'EXC-001',
  image_url: null,
  description: 'Heavy-duty excavator',
  daily_rate: 500,
  weekly_rate: 2800,
  monthly_rate: 9500,
  asset_category_id: 'cat-earthmoving',
  asset_category_name: 'Earthmoving',
  branch_id: 'branch-north',
  branch_name: 'North Depot',
  is_available: true,
  conflict_reason: null,
};

const ASSET_2 = {
  entity_id: 'asset-002',
  name: 'Forklift 5T',
  make: 'Toyota',
  year: '2021',
  identifier: 'FLK-002',
  image_url: null,
  description: null,
  daily_rate: 200,
  weekly_rate: 1100,
  monthly_rate: 3800,
  asset_category_id: 'cat-material-handling',
  asset_category_name: 'Material Handling',
  branch_id: 'branch-south',
  branch_name: 'South Yard',
  is_available: false,
  conflict_reason: 'On rent during selected period',
};

// ---------------------------------------------------------------------------
// Unit tests: calcDaysBetween
// ---------------------------------------------------------------------------

describe('calcDaysBetween', () => {
  it('returns 1 for same-day range (minimum)', () => {
    expect(calcDaysBetween('2026-06-09', '2026-06-09')).toBe(1);
  });

  it('returns 7 for a 7-day range', () => {
    expect(calcDaysBetween('2026-06-09', '2026-06-16')).toBe(7);
  });

  it('returns 30 for a 30-day range', () => {
    expect(calcDaysBetween('2026-06-01', '2026-07-01')).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: calcQuote
// ---------------------------------------------------------------------------

describe('calcQuote', () => {
  const asset = {
    daily_rate: 500,
    weekly_rate: 2800,
    monthly_rate: 9500,
  };

  it('uses daily rate for 3-day rental', () => {
    const q = calcQuote(asset, '2026-06-09', '2026-06-12');
    expect(q).not.toBeNull();
    expect(q!.rateType).toBe('daily');
    expect(q!.days).toBe(3);
    // base = 3 × 500 = 1500
    expect(q!.baseAmount).toBe(1500);
    // env fee = 1500 × 0.05 = 75
    expect(q!.envFee).toBe(75);
    // tax = (1500 + 75) × 0.085 = 133.875 → rounds to 133.88
    expect(q!.taxAmount).toBeCloseTo(133.88, 1);
    // total = 1500 + 75 + 133.88 = 1708.88
    expect(q!.total).toBeCloseTo(1708.88, 1);
  });

  it('uses weekly rate for 14-day rental', () => {
    const q = calcQuote(asset, '2026-06-09', '2026-06-23');
    expect(q).not.toBeNull();
    expect(q!.rateType).toBe('weekly');
    expect(q!.days).toBe(14);
    // weeks = 14 / 7 = 2; base = 2 × 2800 = 5600
    expect(q!.baseAmount).toBe(5600);
  });

  it('uses monthly rate for 30-day rental', () => {
    const q = calcQuote(asset, '2026-06-01', '2026-07-01');
    expect(q).not.toBeNull();
    expect(q!.rateType).toBe('monthly');
    expect(q!.days).toBe(30);
    // months = 30 / 30 = 1; base = 1 × 9500 = 9500
    expect(q!.baseAmount).toBe(9500);
  });

  it('falls back to weekly when monthly_rate is null', () => {
    const assetNoMonthly = { ...asset, monthly_rate: null };
    const q = calcQuote(assetNoMonthly, '2026-06-01', '2026-07-01');
    expect(q).not.toBeNull();
    expect(q!.rateType).toBe('weekly');
  });

  it('falls back to daily when weekly_rate is null', () => {
    const assetNoWeekly = { ...asset, weekly_rate: null };
    const q = calcQuote(assetNoWeekly, '2026-06-09', '2026-06-16');
    expect(q).not.toBeNull();
    expect(q!.rateType).toBe('daily');
  });

  it('returns null when all rates are null', () => {
    const noRates = { daily_rate: null, weekly_rate: null, monthly_rate: null };
    expect(calcQuote(noRates, '2026-06-09', '2026-06-12')).toBeNull();
  });

  it('returns null when all rates are zero', () => {
    const zeroRates = { daily_rate: 0, weekly_rate: 0, monthly_rate: 0 };
    expect(calcQuote(zeroRates, '2026-06-09', '2026-06-12')).toBeNull();
  });

  it('includes correct periodsLabel for daily', () => {
    const q = calcQuote(asset, '2026-06-09', '2026-06-12');
    expect(q!.periodsLabel).toMatch(/3 days/);
    expect(q!.periodsLabel).toMatch(/\$500\.00\/day/);
  });

  it('includes correct periodsLabel for weekly', () => {
    const q = calcQuote(asset, '2026-06-09', '2026-06-16');
    expect(q!.periodsLabel).toMatch(/week/);
    expect(q!.periodsLabel).toMatch(/\$2,800\.00\/wk/);
  });
});

// ---------------------------------------------------------------------------
// Component integration tests
// ---------------------------------------------------------------------------

describe('StorefrontScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page heading and date inputs', async () => {
    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    expect(screen.getByText('Browse & Quote Equipment')).toBeInTheDocument();
    expect(screen.getByTestId('input-start-date')).toBeInTheDocument();
    expect(screen.getByTestId('input-end-date')).toBeInTheDocument();
  });

  it('shows loading state while fetching', async () => {
    let resolveRpc!: (v: unknown) => void;
    rpcMock.mockReturnValue(new Promise((r) => { resolveRpc = r; }));

    render(<StorefrontScreen />);
    expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();

    await act(async () => {
      resolveRpc({ data: [], error: null });
    });
  });

  it('shows equipment cards after load', async () => {
    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('asset-card-asset-001')).toBeInTheDocument();
    });
    expect(screen.getByTestId('asset-card-asset-002')).toBeInTheDocument();
  });

  it('marks available asset with "Available" badge', async () => {
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('availability-badge-asset-001')).toHaveTextContent('Available');
    });
  });

  it('marks unavailable asset with "Unavailable" badge', async () => {
    mockRpcSuccess([ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('availability-badge-asset-002')).toHaveTextContent('Unavailable');
    });
  });

  it('shows live quote breakdown for available asset', async () => {
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(screen.getByTestId(`quote-breakdown-asset-001`)).toBeInTheDocument();
    });
    const total = screen.getByTestId('quote-total-asset-001');
    expect(total.textContent).toMatch(/\$/);
  });

  it('disables "Request Quote" button for unavailable asset', async () => {
    mockRpcSuccess([ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      const btn = screen.getByTestId('request-quote-btn-asset-002');
      expect(btn).toBeDisabled();
    });
  });

  it('shows load error on RPC failure', async () => {
    mockRpcError('Supabase RPC unavailable');
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('load-error')).toBeInTheDocument();
    });
  });

  it('shows category filter options from catalog data', async () => {
    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      const sel = screen.getByTestId('select-category') as HTMLSelectElement;
      const options = Array.from(sel.options).map((o) => o.text);
      expect(options).toContain('Earthmoving');
      expect(options).toContain('Material Handling');
    });
  });

  it('shows branch filter options from catalog data', async () => {
    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      const sel = screen.getByTestId('select-branch') as HTMLSelectElement;
      const options = Array.from(sel.options).map((o) => o.text);
      expect(options).toContain('North Depot');
      expect(options).toContain('South Yard');
    });
  });

  it('opens quote request panel when clicking Request Quote', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    expect(screen.getByTestId('quote-request-panel')).toBeInTheDocument();
    expect(screen.getByTestId('quote-form')).toBeInTheDocument();
  });

  it('panel shows quote total matching card', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    const cardTotal = screen.getByTestId('quote-total-asset-001').textContent;
    const panelTotal = screen.getByTestId('panel-quote-total').textContent;
    expect(panelTotal).toBe(cardTotal);
  });

  it('closes quote request panel when close button clicked', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));
    expect(screen.getByTestId('quote-request-panel')).toBeInTheDocument();

    await user.click(screen.getByTestId('close-panel-btn'));
    expect(screen.queryByTestId('quote-request-panel')).not.toBeInTheDocument();
  });

  it('submits quote request with contact details and shows success', async () => {
    const user = userEvent.setup();
    mockRpcSubmitSuccess('quote-xyz-789');
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    await user.type(screen.getByTestId('input-contact-name'), 'Jane Smith');
    await user.type(screen.getByTestId('input-contact-email'), 'jane@example.com');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-success')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/quote-xyz-789/).length).toBeGreaterThan(0);
  });

  it('launches a branded quote document preview from the submitted quote snapshot', async () => {
    const user = userEvent.setup();
    mockRpcSubmitSuccess('quote-doc-123');
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    await user.type(screen.getByTestId('input-contact-name'), 'Jane Smith');
    await user.type(screen.getByTestId('input-contact-email'), 'jane@example.com');
    await user.type(screen.getByTestId('input-company-name'), 'Skyline Build Co.');
    await user.type(screen.getByTestId('input-notes'), 'Use the south gate on arrival.');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('quote-document-preview')).toBeInTheDocument();
    });

    const preview = screen.getByTestId('quote-document-preview');

    expect(within(preview).getByRole('heading', { name: 'Rental Quote' })).toBeInTheDocument();
    expect(within(preview).getAllByText('Dealernet').length).toBeGreaterThan(0);
    expect(within(preview).getByText('Jane Smith')).toBeInTheDocument();
    expect(within(preview).getByText('Skyline Build Co.')).toBeInTheDocument();
    expect(within(preview).getByText('Excavator XL')).toBeInTheDocument();
    expect(within(preview).getByText('Use the south gate on arrival.')).toBeInTheDocument();
    expect(within(preview).getByTestId('commercial-document-total')).toHaveTextContent(
      screen.getByTestId('panel-quote-total').textContent ?? '',
    );
  });

  it('quote document preview renders rental start/end dates in raw ISO form, not locale-formatted', async () => {
    const user = userEvent.setup();
    mockRpcSubmitSuccess('quote-iso-dates-999');
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));

    // Capture the ISO date values already in the inputs (e.g. "2026-06-17")
    const isoStart = (screen.getByTestId('input-start-date') as HTMLInputElement).value;
    const isoEnd = (screen.getByTestId('input-end-date') as HTMLInputElement).value;
    expect(isoStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isoEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await user.click(screen.getByTestId('request-quote-btn-asset-001'));
    await user.type(screen.getByTestId('input-contact-name'), 'Jane Smith');
    await user.type(screen.getByTestId('input-contact-email'), 'jane@example.com');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('quote-document-preview')).toBeInTheDocument();
    });

    const preview = screen.getByTestId('quote-document-preview');
    // The rental period must appear as raw ISO dates joined by an en-dash.
    // If formatDocumentDate() is reintroduced the period becomes "June 17, 2026 – June 24, 2026"
    // and this regex will no longer match, catching the regression.
    expect(preview).toHaveTextContent(new RegExp(`${isoStart}\\s*–\\s*${isoEnd}`));
  });

  it('shows submission error on RPC failure for submit', async () => {
    const user = userEvent.setup();
    rpcMock.mockImplementation((rpc: string) => {
      if (rpc === 'portal_storefront_submit_quote') {
        return Promise.resolve({ data: null, error: { message: 'Validation failed' } });
      }
      // portal_storefront_get_availability
      return Promise.resolve({ data: [ASSET_1], error: null });
    });

    render(<StorefrontScreen />);
    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    await user.type(screen.getByTestId('input-contact-name'), 'John');
    await user.type(screen.getByTestId('input-contact-email'), 'john@x.com');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
    });
  });

  it('passes date range to availability RPC', async () => {
    mockRpcSuccess([]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_storefront_get_availability',
        expect.objectContaining({
          p_start_date: expect.any(String),
          p_end_date: expect.any(String),
        }),
      );
    });
  });

  it('refetches when date range changes', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));

    const endInput = screen.getByTestId('input-end-date') as HTMLInputElement;
    await user.clear(endInput);
    await user.type(endInput, '2026-08-01');

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_storefront_get_availability',
        expect.objectContaining({ p_end_date: '2026-08-01' }),
      );
    });
  });

  it('shows empty state message when no equipment matches', async () => {
    mockRpcSuccess([]);
    render(<StorefrontScreen />);

    await waitFor(() => {
      expect(screen.getByText(/No equipment found for the selected filters/)).toBeInTheDocument();
    });
  });

  it('filters equipment by category', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('asset-card-asset-001'));

    const sel = screen.getByTestId('select-category') as HTMLSelectElement;
    await user.selectOptions(sel, 'cat-earthmoving');

    expect(screen.getByTestId('asset-card-asset-001')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-card-asset-002')).not.toBeInTheDocument();
  });

  it('filters equipment by branch', async () => {
    const user = userEvent.setup();
    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('asset-card-asset-001'));

    const sel = screen.getByTestId('select-branch') as HTMLSelectElement;
    await user.selectOptions(sel, 'branch-south');

    expect(screen.queryByTestId('asset-card-asset-001')).not.toBeInTheDocument();
    expect(screen.getByTestId('asset-card-asset-002')).toBeInTheDocument();
  });

  it('shows no confirmation banner on first load with empty sessionStorage', async () => {
    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('asset-card-asset-001'));
    expect(screen.queryByTestId('confirmation-banner')).not.toBeInTheDocument();
  });

  it('persists quote confirmation to sessionStorage after successful submission', async () => {
    const user = userEvent.setup();
    mockRpcSubmitSuccess('quote-persist-001');
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    await user.type(screen.getByTestId('input-contact-name'), 'Jane Smith');
    await user.type(screen.getByTestId('input-contact-email'), 'jane@example.com');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => screen.getByTestId('submit-success'));

    const stored = sessionStorage.getItem('storefront_quote_confirmation');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { quoteId: string; assetName: string; startDate: string; endDate: string };
    expect(parsed.quoteId).toBe('quote-persist-001');
    expect(parsed.assetName).toBe(ASSET_1.name);
  });

  it('shows confirmation banner after closing panel when a quote was just submitted', async () => {
    const user = userEvent.setup();
    mockRpcSubmitSuccess('quote-banner-002');
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    await user.type(screen.getByTestId('input-contact-name'), 'Bob');
    await user.type(screen.getByTestId('input-contact-email'), 'bob@example.com');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => screen.getByTestId('submit-success'));

    // Close the panel
    await user.click(screen.getByTestId('close-panel-btn'));

    // Banner with reference should remain visible on the grid
    await waitFor(() => {
      expect(screen.getByTestId('confirmation-banner')).toBeInTheDocument();
      expect(screen.getByTestId('confirmation-banner-quote-id')).toHaveTextContent('quote-banner-002');
    });
  });

  it('shows confirmation banner on remount when sessionStorage has a prior quote', async () => {
    // Simulate a prior session by pre-seeding sessionStorage
    sessionStorage.setItem(
      'storefront_quote_confirmation',
      JSON.stringify({
        quoteId: 'quote-reload-003',
        assetName: 'Excavator XL',
        startDate: '2026-07-01',
        endDate: '2026-07-08',
      }),
    );

    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    // The confirmation banner must be visible immediately (no async fetch needed)
    expect(screen.getByTestId('confirmation-banner')).toBeInTheDocument();
    expect(screen.getByTestId('confirmation-banner-quote-id')).toHaveTextContent('quote-reload-003');
  });

  it('confirmation banner shows the submitted asset name and date range', async () => {
    sessionStorage.setItem(
      'storefront_quote_confirmation',
      JSON.stringify({
        quoteId: 'quote-reload-004',
        assetName: 'Forklift 5T',
        startDate: '2026-08-01',
        endDate: '2026-08-15',
      }),
    );

    mockRpcSuccess([ASSET_2]);
    render(<StorefrontScreen />);

    const banner = screen.getByTestId('confirmation-banner');
    expect(banner).toHaveTextContent('Forklift 5T');
    expect(banner).toHaveTextContent('2026-08-01');
    expect(banner).toHaveTextContent('2026-08-15');
  });

  it('confirmation banner shows branch/category scope context when stored with quote', async () => {
    sessionStorage.setItem(
      'storefront_quote_confirmation',
      JSON.stringify({
        quoteId: 'quote-scope-006',
        assetName: 'Excavator XL',
        startDate: '2026-09-01',
        endDate: '2026-09-08',
        branchName: 'North Depot',
        categoryName: 'Earthmoving',
      }),
    );

    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    const banner = screen.getByTestId('confirmation-banner');
    expect(banner).toHaveTextContent('Excavator XL');
    expect(banner).toHaveTextContent('North Depot');
    expect(banner).toHaveTextContent('Earthmoving');
    expect(screen.getByTestId('confirmation-banner-scope')).toHaveTextContent('Earthmoving · North Depot');
  });

  it('persists branch/category context to sessionStorage on submit', async () => {
    const user = userEvent.setup();
    mockRpcSubmitSuccess('quote-scope-007');
    render(<StorefrontScreen />);

    await waitFor(() => screen.getByTestId('request-quote-btn-asset-001'));
    await user.click(screen.getByTestId('request-quote-btn-asset-001'));

    await user.type(screen.getByTestId('input-contact-name'), 'Alex Brown');
    await user.type(screen.getByTestId('input-contact-email'), 'alex@example.com');
    await user.click(screen.getByTestId('submit-quote-btn'));

    await waitFor(() => screen.getByTestId('submit-success'));

    const stored = sessionStorage.getItem('storefront_quote_confirmation');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as {
      quoteId: string;
      assetName: string;
      branchId?: string;
      branchName?: string;
      categoryId?: string;
      categoryName?: string;
    };
    expect(parsed.quoteId).toBe('quote-scope-007');
    expect(parsed.branchId).toBe(ASSET_1.branch_id);
    expect(parsed.branchName).toBe(ASSET_1.branch_name);
    expect(parsed.categoryId).toBe(ASSET_1.asset_category_id);
    expect(parsed.categoryName).toBe(ASSET_1.asset_category_name);
  });

  it('restores the submitted date and filter scope from sessionStorage on reload', async () => {
    sessionStorage.setItem(
      'storefront_quote_confirmation',
      JSON.stringify({
        quoteId: 'quote-scope-restore-009',
        assetName: 'Excavator XL',
        startDate: '2026-09-01',
        endDate: '2026-09-08',
        branchId: ASSET_1.branch_id,
        branchName: ASSET_1.branch_name,
        categoryId: ASSET_1.asset_category_id,
        categoryName: ASSET_1.asset_category_name,
      }),
    );

    mockRpcSuccess([ASSET_1, ASSET_2]);
    render(<StorefrontScreen />);

    expect(screen.getByTestId('input-start-date')).toHaveValue('2026-09-01');
    expect(screen.getByTestId('input-end-date')).toHaveValue('2026-09-08');

    await waitFor(() => screen.getByTestId('asset-card-asset-001'));

    expect(screen.getByTestId('select-category')).toHaveValue(ASSET_1.asset_category_id);
    expect(screen.getByTestId('select-branch')).toHaveValue(ASSET_1.branch_id);
    expect(screen.getByTestId('confirmation-banner-scope')).toHaveTextContent('Earthmoving · North Depot');
    expect(screen.queryByTestId('asset-card-asset-002')).not.toBeInTheDocument();
  });

  it('confirmation banner omits scope line when stored quote has no branch/category', async () => {
    sessionStorage.setItem(
      'storefront_quote_confirmation',
      JSON.stringify({
        quoteId: 'quote-noscope-008',
        assetName: 'Excavator XL',
        startDate: '2026-07-01',
        endDate: '2026-07-08',
      }),
    );

    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    const banner = screen.getByTestId('confirmation-banner');
    expect(banner).toHaveTextContent('Excavator XL');
    expect(screen.queryByTestId('confirmation-banner-scope')).not.toBeInTheDocument();
  });

  it('dismisses the confirmation banner and clears sessionStorage on "Start new quote"', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(
      'storefront_quote_confirmation',
      JSON.stringify({
        quoteId: 'quote-dismiss-005',
        assetName: 'Excavator XL',
        startDate: '2026-07-01',
        endDate: '2026-07-08',
      }),
    );

    mockRpcSuccess([ASSET_1]);
    render(<StorefrontScreen />);

    expect(screen.getByTestId('confirmation-banner')).toBeInTheDocument();

    await user.click(screen.getByTestId('dismiss-confirmation-btn'));

    expect(screen.queryByTestId('confirmation-banner')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('storefront_quote_confirmation')).toBeNull();
  });
});
