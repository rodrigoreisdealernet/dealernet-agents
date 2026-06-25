import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import { TaxFilingsScreen } from '@/routes/analytics/tax-filings';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const summaryRows = [
  {
    filing_period_start: '2026-06-01',
    filing_period_end: '2026-06-30',
    jurisdiction_code: 'US-CA-SF',
    jurisdiction_name: 'San Francisco',
    taxable_amount: 1200,
    exempt_amount: 50,
    collected_tax_amount: 102,
    refunded_tax_amount: 4,
    tax_event_count: 2,
  },
  {
    filing_period_start: '2026-06-01',
    filing_period_end: '2026-06-30',
    jurisdiction_code: 'US-TX-DAL',
    jurisdiction_name: 'Dallas',
    taxable_amount: 900,
    exempt_amount: 0,
    collected_tax_amount: 74.25,
    refunded_tax_amount: 0,
    tax_event_count: 1,
  },
  {
    filing_period_start: '2026-05-01',
    filing_period_end: '2026-05-31',
    jurisdiction_code: 'US-TX-DAL',
    jurisdiction_name: 'Dallas',
    taxable_amount: 400,
    exempt_amount: 0,
    collected_tax_amount: 33,
    refunded_tax_amount: 33,
    tax_event_count: 1,
  },
];

const exportRows = [
  {
    export_row_key: '2026-06:US-CA-SF:evt-1:row-1',
    filing_period_start: '2026-06-01',
    filing_period_end: '2026-06-30',
    jurisdiction_code: 'US-CA-SF',
    jurisdiction_name: 'San Francisco',
    source_event_id: 'evt-1',
    event_type: 'invoice_finalized',
    snapshot_effective_at: '2026-06-13',
    taxable_amount: 1200,
    exempt_amount: 50,
    collected_tax_amount: 102,
    signed_collected_tax_amount: 102,
    refunded_tax_amount: 0,
  },
  {
    export_row_key: '2026-06:US-CA-SF:evt-2:row-2',
    filing_period_start: '2026-06-01',
    filing_period_end: '2026-06-30',
    jurisdiction_code: 'US-CA-SF',
    jurisdiction_name: 'San Francisco',
    source_event_id: 'evt-2',
    event_type: 'refund',
    snapshot_effective_at: '2026-06-20',
    taxable_amount: 0,
    exempt_amount: 0,
    collected_tax_amount: 4,
    signed_collected_tax_amount: -4,
    refunded_tax_amount: 4,
  },
  {
    export_row_key: '2026-06:US-TX-DAL:evt-3:row-3',
    filing_period_start: '2026-06-01',
    filing_period_end: '2026-06-30',
    jurisdiction_code: 'US-TX-DAL',
    jurisdiction_name: 'Dallas',
    source_event_id: 'evt-3',
    event_type: 'invoice_finalized',
    snapshot_effective_at: '2026-06-11',
    taxable_amount: 900,
    exempt_amount: 0,
    collected_tax_amount: 74.25,
    signed_collected_tax_amount: 74.25,
    refunded_tax_amount: 0,
  },
];

function mockTaxFilingViews({
  summaryData = summaryRows,
  exportData = exportRows,
}: {
  summaryData?: typeof summaryRows;
  exportData?: typeof exportRows;
} = {}) {
  fromMock.mockImplementation((table: string) => {
    const rows = table === 'v_invoice_tax_filing_period_jurisdiction_summary' ? summaryData : exportData;
    const query = {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn(async (start: number, end: number) => ({
        data: rows.slice(start, end + 1),
        error: null,
      })),
    };
    return query;
  });
}

describe('TaxFilingsScreen', () => {
  beforeEach(() => {
    fromMock.mockReset();
    mockTaxFilingViews();
  });

  it('renders filing summary and export preview from tax snapshot views', async () => {
    renderWithQueryClient(<TaxFilingsScreen />);

    await screen.findByRole('heading', { name: 'Sales Tax Filing' });
    expect(screen.getByTestId('tax-summary-row-2026-06-01-US-CA-SF')).toBeInTheDocument();
    expect(screen.getByTestId('tax-summary-row-2026-06-01-US-TX-DAL')).toBeInTheDocument();
    expect(screen.getByTestId('tax-summary-row-2026-05-01-US-TX-DAL')).toBeInTheDocument();
    expect(screen.getByText('$209.25')).toBeInTheDocument();
    expect(screen.getByText('$37.00')).toBeInTheDocument();
    expect(screen.getByTestId('tax-export-row-2026-06:US-CA-SF:evt-1:row-1')).toBeInTheDocument();
    expect(screen.getByTestId('tax-export-row-2026-06:US-CA-SF:evt-2:row-2')).toBeInTheDocument();
  });

  it('filters filing results by filing month, jurisdiction, and event type', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<TaxFilingsScreen />);
    await screen.findByRole('heading', { name: 'Sales Tax Filing' });

    await user.selectOptions(screen.getByLabelText('Filing Month'), '2026-06-01');
    await user.type(screen.getByLabelText('Jurisdiction'), 'ca');
    await user.selectOptions(screen.getByLabelText('Event Type'), 'refund');

    await waitFor(() => expect(screen.queryByTestId('tax-summary-row-2026-06-01-US-TX-DAL')).not.toBeInTheDocument());
    expect(screen.getByTestId('tax-summary-row-2026-06-01-US-CA-SF')).toBeInTheDocument();
    expect(screen.getByTestId('tax-export-row-2026-06:US-CA-SF:evt-2:row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('tax-export-row-2026-06:US-CA-SF:evt-1:row-1')).not.toBeInTheDocument();
  });

  it('exports filtered deterministic filing rows as CSV', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:tax-filing-export');
    const revokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;

    renderWithQueryClient(<TaxFilingsScreen />);
    await screen.findByRole('heading', { name: 'Sales Tax Filing' });

    await user.selectOptions(screen.getByLabelText('Filing Month'), '2026-06-01');
    await user.type(screen.getByLabelText('Jurisdiction'), 'ca');
    await user.selectOptions(screen.getByLabelText('Event Type'), 'refund');
    await user.click(screen.getByRole('button', { name: 'Export Filing CSV' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const firstCreateObjectUrlCall = createObjectURL.mock.calls[0] as unknown[] | undefined;
    const blobArg = firstCreateObjectUrlCall?.[0];
    expect(blobArg).toBeInstanceOf(Blob);
    const csv = await (blobArg as unknown as Blob).text();
    expect(csv).toContain('export_row_key,filing_period_start,filing_period_end,jurisdiction_code,jurisdiction_name,source_event_id,event_type,snapshot_effective_at,taxable_amount,exempt_amount,collected_tax_amount,signed_collected_tax_amount,refunded_tax_amount');
    expect(csv).toContain('2026-06:US-CA-SF:evt-2:row-2');
    expect(csv).not.toContain('2026-06:US-TX-DAL:evt-3:row-3');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tax-filing-export');
  });

  it('exports rows beyond the previous hard limit by paging all filing export rows', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:tax-filing-export-all-pages');
    const revokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;

    const pagedExportRows = Array.from({ length: 3001 }, (_, index) => ({
      export_row_key: `2026-06:US-CA-SF:evt-${index + 1}:row-${index + 1}`,
      filing_period_start: '2026-06-01',
      filing_period_end: '2026-06-30',
      jurisdiction_code: 'US-CA-SF',
      jurisdiction_name: 'San Francisco',
      source_event_id: `evt-${index + 1}`,
      event_type: 'invoice_finalized' as const,
      snapshot_effective_at: '2026-06-13',
      taxable_amount: 10,
      exempt_amount: 0,
      collected_tax_amount: 1,
      signed_collected_tax_amount: 1,
      refunded_tax_amount: 0,
    }));

    mockTaxFilingViews({
      summaryData: [summaryRows[0]],
      exportData: pagedExportRows,
    });

    renderWithQueryClient(<TaxFilingsScreen />);
    await screen.findByRole('heading', { name: 'Sales Tax Filing' });
    await user.selectOptions(screen.getByLabelText('Filing Month'), '2026-06-01');
    await user.click(screen.getByRole('button', { name: 'Export Filing CSV' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const firstCreateObjectUrlCall = createObjectURL.mock.calls[0] as unknown[] | undefined;
    const blobArg = firstCreateObjectUrlCall?.[0];
    expect(blobArg).toBeInstanceOf(Blob);
    const csv = await (blobArg as unknown as Blob).text();
    expect(csv).toContain('2026-06:US-CA-SF:evt-3001:row-3001');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tax-filing-export-all-pages');
  });
});
