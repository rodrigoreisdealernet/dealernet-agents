import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock, fromMock, getSessionMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
    auth: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    profile: {
      role: 'admin',
    },
  }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import { buildGeneralLedgerCsv, GeneralLedgerScreen } from '@/routes/accounting/general-ledger';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

type LedgerRow = Record<string, unknown>;

const customerOne = '00000000-0000-0000-0000-000000000101';
const customerTwo = '00000000-0000-0000-0000-000000000102';
const billingOne = '00000000-0000-0000-0000-000000000201';
const branchOne = '00000000-0000-0000-0000-000000000301';

const allRows: LedgerRow[] = [
  {
    id: 'row-1',
    posted_at: '2026-06-02T10:00:00Z',
    basis: 'accrual',
    customer_id: customerOne,
    billing_account_id: billingOne,
    branch_id: branchOne,
    gl_account_code: '4000-RENT',
    gl_account_name: 'Rental Revenue',
    counter_account_code: '1200-AR',
    counter_account_name: 'Accounts Receivable',
    source_document_type: 'invoice',
    source_document_id: '00000000-0000-0000-0000-000000000401',
    source_document_number: 'INV-1001',
    source_amount: 1200,
    debit_amount: 1200,
    credit_amount: 0,
    currency_code: 'USD',
    sync_status: 'synced',
    export_status: 'queued',
    source_document_path: '/entities/invoice/00000000-0000-0000-0000-000000000401',
  },
  {
    id: 'row-2',
    posted_at: '2026-06-03T10:00:00Z',
    basis: 'cash',
    customer_id: customerTwo,
    billing_account_id: '00000000-0000-0000-0000-000000000202',
    branch_id: '00000000-0000-0000-0000-000000000302',
    gl_account_code: '1000-CASH',
    gl_account_name: 'Cash',
    counter_account_code: '1200-AR',
    counter_account_name: 'Accounts Receivable',
    source_document_type: 'payment',
    source_document_id: '00000000-0000-0000-0000-000000000402',
    source_document_number: 'PAY-2201',
    source_amount: 800,
    debit_amount: 0,
    credit_amount: 800,
    currency_code: 'USD',
    sync_status: 'pending',
    export_status: 'not_exported',
    source_document_path: '/entities/payment/00000000-0000-0000-0000-000000000402',
  },
];

function applyRpcFilters(params: Record<string, unknown>) {
  return allRows.filter((row) => {
    if (params.p_basis && row.basis !== params.p_basis) {
      return false;
    }
    if (params.p_customer_id && row.customer_id !== params.p_customer_id) {
      return false;
    }
    if (params.p_billing_account_id && row.billing_account_id !== params.p_billing_account_id) {
      return false;
    }
    if (params.p_branch_id && row.branch_id !== params.p_branch_id) {
      return false;
    }
    if (params.p_gl_account_code && row.gl_account_code !== params.p_gl_account_code) {
      return false;
    }
    return true;
  });
}

function mockEntityLookups() {
  fromMock.mockImplementation(() => {
    let entityType = '';
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((field: string, value: unknown) => {
        if (field === 'entity_type' && typeof value === 'string') {
          entityType = value;
        }
        return query;
      }),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => {
        if (entityType === 'customer') {
          return {
            data: [
              { id: customerOne, entity_versions: [{ data: { name: 'Acme Construction' } }] },
              { id: customerTwo, entity_versions: [{ data: { name: 'Metro Builders' } }] },
            ],
            error: null,
          };
        }
        if (entityType === 'billing_account') {
          return {
            data: [
              { id: billingOne, entity_versions: [{ data: { name: 'Acme Main Billing' } }] },
            ],
            error: null,
          };
        }
        if (entityType === 'branch') {
          return {
            data: [
              { id: branchOne, entity_versions: [{ data: { name: 'London Branch' } }] },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
    };
    return query;
  });
}

describe('GeneralLedgerScreen', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    getSessionMock.mockReset();

    mockEntityLookups();

    rpcMock.mockImplementation(async (_name: string, params: Record<string, unknown>) => ({
      data: applyRpcFilters(params),
      error: null,
    }));

    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-token-admin' } },
    });
  });

  it('renders itemized ledger rows and drill-down links', async () => {
    renderWithQueryClient(<GeneralLedgerScreen />);

    await screen.findByRole('heading', { name: 'Accounting · General Ledger' });
    await waitFor(() => expect(screen.getByTestId('ledger-row-row-1')).toBeInTheDocument());

    expect(screen.getByTestId('ledger-row-row-2')).toBeInTheDocument();
    const drillDownLinks = screen.getAllByRole('link', { name: 'Open source' });
    expect(drillDownLinks[0]).toHaveAttribute(
      'href',
      '/entities/invoice/00000000-0000-0000-0000-000000000401'
    );
  });

  it('shows resolved human-readable labels for customer, billing account, and location in rows', async () => {
    renderWithQueryClient(<GeneralLedgerScreen />);

    await waitFor(() => expect(screen.getByTestId('ledger-row-row-1')).toBeInTheDocument());

    const row1 = screen.getByTestId('ledger-row-row-1');
    expect(row1.textContent).toContain('Acme Construction');
    expect(row1.textContent).toContain('Acme Main Billing');
    expect(row1.textContent).toContain('London Branch');
    // raw UUIDs must not be surfaced as operator-facing text content
    expect(row1.textContent).not.toContain(customerOne);
    expect(row1.textContent).not.toContain(billingOne);
    expect(row1.textContent).not.toContain(branchOne);
  });

  it('shows — instead of a raw UUID when a label cannot be resolved', async () => {
    renderWithQueryClient(<GeneralLedgerScreen />);

    await waitFor(() => expect(screen.getByTestId('ledger-row-row-2')).toBeInTheDocument());

    // row-2: customerTwo is resolved ('Metro Builders'); billing and branch IDs have no mock label
    const row2 = screen.getByTestId('ledger-row-row-2');
    // resolved customer must appear as a readable label, not as a UUID
    expect(row2.textContent).toContain('Metro Builders');
    expect(row2.textContent).not.toContain(customerTwo);
    // unresolved billing account and branch must render '—', not raw UUIDs
    expect(row2.textContent).not.toContain('00000000-0000-0000-0000-000000000202');
    expect(row2.textContent).not.toContain('00000000-0000-0000-0000-000000000302');
    expect(row2.textContent).toContain('—');
  });

  it('filters by customer and basis via the backend RPC parameters', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<GeneralLedgerScreen />);

    await waitFor(() => expect(screen.getByTestId('ledger-row-row-1')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Customer'), customerOne);
    await user.selectOptions(screen.getByLabelText('Basis'), 'accrual');

    await waitFor(() => {
      expect(screen.getByTestId('ledger-row-row-1')).toBeInTheDocument();
      expect(screen.queryByTestId('ledger-row-row-2')).not.toBeInTheDocument();
    });

    const lastRpcCall = rpcMock.mock.calls[rpcMock.mock.calls.length - 1];
    expect(lastRpcCall?.[0]).toBe('accounting_get_general_ledger');
    expect(lastRpcCall?.[1]).toMatchObject({
      p_customer_id: customerOne,
      p_basis: 'accrual',
    });
  });

  it('exports the active filtered dataset', async () => {
    const user = userEvent.setup();
    let zeroOffsetCallCount = 0;

    rpcMock.mockImplementation(async (_name: string, params: Record<string, unknown>) => {
      if (params.p_offset === 0) {
        zeroOffsetCallCount += 1;
        if (zeroOffsetCallCount === 1) {
          return { data: [allRows[0]], error: null };
        }

        const pageRows = Array.from({ length: 100 }, (_, index) => ({
          ...allRows[0],
          id: `export-${index + 1}`,
        }));
        return { data: pageRows, error: null };
      }
      if (params.p_offset === 100) {
        return {
          data: [
            {
              ...allRows[1],
              id: 'export-101',
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    renderWithQueryClient(<GeneralLedgerScreen />);

    await waitFor(() => expect(screen.getByTestId('ledger-row-row-1')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    await screen.findByText('Download initiated for 101 ledger rows from the active filtered result set.');
    expect(rpcMock).toHaveBeenCalledWith(
      'accounting_get_general_ledger',
      expect.objectContaining({
        p_limit: 100,
        p_offset: 100,
      })
    );
  });

  it('neutralizes formula-like ledger fields in CSV export output', () => {
    const maliciousRow: Parameters<typeof buildGeneralLedgerCsv>[0][number] = {
      id: 'row-malicious',
      posted_at: '2026-06-02T10:00:00Z',
      basis: 'accrual',
      customer_id: customerOne,
      billing_account_id: billingOne,
      branch_id: branchOne,
      gl_account_code: '',
      gl_account_name: '@SUM(1,2)',
      counter_account_code: '1200-AR',
      counter_account_name: 'Accounts Receivable',
      source_document_type: 'invoice',
      source_document_id: '00000000-0000-0000-0000-000000000499',
      source_document_number: '=cmd|calc',
      source_amount: 1200,
      debit_amount: 1200,
      credit_amount: 0,
      currency_code: 'USD',
      sync_status: 'synced',
      export_status: 'queued',
      source_document_path: '/entities/invoice/00000000-0000-0000-0000-000000000499',
    };

    const csv = buildGeneralLedgerCsv([
      maliciousRow,
    ]);

    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("' @SUM(1,2)");
  });

  it('CSV export uses human-readable column headers instead of ID-centric names', () => {
    const row: Parameters<typeof buildGeneralLedgerCsv>[0][number] = {
      id: 'row-csv',
      posted_at: '2026-06-01T10:00:00Z',
      basis: 'accrual',
      customer_id: customerOne,
      billing_account_id: billingOne,
      branch_id: branchOne,
      gl_account_code: '4000-RENT',
      gl_account_name: 'Rental Revenue',
      counter_account_code: '1200-AR',
      counter_account_name: 'Accounts Receivable',
      source_document_type: 'invoice',
      source_document_id: '00000000-0000-0000-0000-000000000501',
      source_document_number: 'INV-9999',
      source_amount: 500,
      debit_amount: 500,
      credit_amount: 0,
      currency_code: 'USD',
      sync_status: 'synced',
      export_status: 'queued',
      source_document_path: '/entities/invoice/00000000-0000-0000-0000-000000000501',
    };

    const csv = buildGeneralLedgerCsv([row]);
    const headerLine = csv.split('\n')[0];

    // Headers must use readable names, not ID-centric names
    expect(headerLine).toContain('Customer');
    expect(headerLine).toContain('Billing Account');
    expect(headerLine).toContain('Location');
    expect(headerLine).not.toContain('Customer ID');
    expect(headerLine).not.toContain('Billing Account ID');
    expect(headerLine).not.toContain('Branch ID');
  });

  it('CSV export resolves labels via labelMaps and falls back to — when no label is available', () => {
    const rowWithKnownIds: Parameters<typeof buildGeneralLedgerCsv>[0][number] = {
      id: 'row-label',
      posted_at: '2026-06-01T10:00:00Z',
      basis: 'accrual',
      customer_id: customerOne,
      billing_account_id: billingOne,
      branch_id: branchOne,
      gl_account_code: '4000-RENT',
      gl_account_name: 'Rental Revenue',
      counter_account_code: null,
      counter_account_name: null,
      source_document_type: 'invoice',
      source_document_id: '00000000-0000-0000-0000-000000000502',
      source_document_number: 'INV-5000',
      source_amount: 300,
      debit_amount: 300,
      credit_amount: 0,
      currency_code: 'USD',
      sync_status: 'synced',
      export_status: 'queued',
      source_document_path: '/entities/invoice/00000000-0000-0000-0000-000000000502',
    };

    const labelMaps = {
      customer: new Map([[customerOne, 'Acme Construction']]),
      billingAccount: new Map([[billingOne, 'Acme Main Billing']]),
      branch: new Map([[branchOne, 'London Branch']]),
    };

    const csvWithLabels = buildGeneralLedgerCsv([rowWithKnownIds], labelMaps);
    const dataLine = csvWithLabels.split('\n')[1];
    expect(dataLine).toContain('Acme Construction');
    expect(dataLine).toContain('Acme Main Billing');
    expect(dataLine).toContain('London Branch');
    // raw UUID must not appear in the label column values
    expect(dataLine).not.toContain(customerOne);

    // Without labelMaps, a non-null ID is returned as-is (audit trail preserved in the export).
    // A null ID would produce '—', but these test rows all have explicit IDs.
    const csvNoLabels = buildGeneralLedgerCsv([rowWithKnownIds]);
    const dataLineNoLabels = csvNoLabels.split('\n')[1];
    expect(dataLineNoLabels).toContain(customerOne);
  });

  describe('Provider export button', () => {
    it('calls the trigger endpoint with period dates and shows download success message', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('col1,col2\nval1,val2', {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename="dia-export-2026-06-01-2026-06-30.csv"',
            'X-Export-Mode': 'xero',
            'X-Export-Row-Count': '42',
          },
        })
      );

      renderWithQueryClient(<GeneralLedgerScreen />);

      await screen.findByRole('heading', { name: 'Accounting · General Ledger' });

      await user.type(screen.getByLabelText('Start date'), '2026-06-01');
      await user.type(screen.getByLabelText('End date'), '2026-06-30');

      const providerBtn = screen.getByRole('button', { name: 'Provider export' });
      expect(providerBtn).not.toBeDisabled();
      await user.click(providerBtn);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/api/ops/accounting/export/trigger'),
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('"period_start":"2026-06-01"'),
          })
        )
      );

      await screen.findByText(/Provider export \(xero\) downloaded: 42 rows for 2026-06-01/);

      fetchMock.mockRestore();
    });

    it('shows no-config guidance when the trigger endpoint returns 404', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Not found', { status: 404 })
      );

      renderWithQueryClient(<GeneralLedgerScreen />);

      await screen.findByRole('heading', { name: 'Accounting · General Ledger' });

      await user.type(screen.getByLabelText('Start date'), '2026-06-01');
      await user.type(screen.getByLabelText('End date'), '2026-06-30');

      await user.click(screen.getByRole('button', { name: 'Provider export' }));

      await screen.findByText(/No export mode configured/);

      fetchMock.mockRestore();
    });

    it('is disabled when either date is missing', async () => {
      renderWithQueryClient(<GeneralLedgerScreen />);

      await screen.findByRole('heading', { name: 'Accounting · General Ledger' });

      expect(screen.getByRole('button', { name: 'Provider export' })).toBeDisabled();
    });
  });
});
