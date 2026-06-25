import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));
type PortalAuthProfile = {
  id: string;
  role: 'admin' | 'branch_manager' | 'field_operator' | 'read_only';
  email?: string;
  displayName?: string;
  tenant?: string;
  customerId?: string;
  billingAccountIds?: string[];
  jobSiteIds?: string[];
};

const { authState } = vi.hoisted(() => ({
  authState: {
    profile: { id: 'user-1', role: 'branch_manager' as PortalAuthProfile['role'] } as PortalAuthProfile,
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
    rpc: rpcMock,
  },
}));

import { PortalFinancialsScreen } from '@/routes/rental/portal-financials';

interface EntityRow {
  id: string;
  created_at: string;
  entity_versions: Array<{ data: Record<string, unknown> }>;
}

type MockEntityData = Record<string, EntityRow[]>;

interface PortalFinancialRpcRow {
  entity_type: string;
  id: string;
  created_at: string;
  data: Record<string, unknown>;
}

const FIXED_AR_AGING_TODAY_UTC_TIMESTAMP = Date.UTC(2026, 5, 9);

function formatDateOffset(daysOffset: number): string {
  const date = new Date(FIXED_AR_AGING_TODAY_UTC_TIMESTAMP);
  date.setUTCDate(date.getUTCDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function renderPortalFinancialsScreen() {
  return renderWithQueryClient(<PortalFinancialsScreen todayUtcTimestampOverride={FIXED_AR_AGING_TODAY_UTC_TIMESTAMP} />);
}

function flattenPortalFinancialEntityData(entityData: MockEntityData): PortalFinancialRpcRow[] {
  return Object.entries(entityData).flatMap(([entityType, rows]) =>
    rows.map((row) => ({
      entity_type: entityType,
      id: row.id,
      created_at: row.created_at,
      data: row.entity_versions[0]?.data || {},
    }))
  );
}

function mockPortalEntityData(entityData: MockEntityData) {
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
      limit: vi.fn(async () => ({ data: entityData[entityType] || [], error: null })),
    };
    return query;
  });
  rpcMock.mockImplementation(async (fn: string, params?: { p_entity_type?: string; p_data?: Record<string, unknown> }) => {
    if (fn === 'portal_get_financial_entities') {
      return { data: flattenPortalFinancialEntityData(entityData), error: null };
    }
    if (fn === 'create_entity_with_version' && params?.p_entity_type === 'payment' && params.p_data) {
      const paymentRows = entityData.payment || [];
      paymentRows.unshift({
        id: `payment-${paymentRows.length + 1}`,
        created_at: typeof params.p_data.paid_at === 'string' ? params.p_data.paid_at : '2026-06-09T00:00:00Z',
        entity_versions: [{ data: params.p_data }],
      });
      entityData.payment = paymentRows;
      return { data: { entity_id: paymentRows[0].id }, error: null };
    }
    return { data: null, error: null };
  });
}

describe('portal financials screen', () => {
  beforeEach(() => {
    authState.profile = { id: 'user-1', role: 'branch_manager' };
    fromMock.mockReset();
    rpcMock.mockReset();
    window.sessionStorage.clear();
  });

  it('renders invoice balances with customer and billing-account context', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-00001',
                status: 'sent',
                invoice_date: '2026-06-01',
                total: 1000,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                transaction_currency_code: 'CAD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 0.74,
                fx_rate_effective_at: '2026-06-01T00:00:00Z',
              },
            },
          ],
        },
        {
          id: 'invoice-2',
          created_at: '2026-06-07T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-00002',
                status: 'sent',
                invoice_date: '2026-06-02',
                total: 500,
                customer_id: 'customer-2',
                billing_account_id: 'billing-2',
                transaction_currency_code: 'USD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1,
                fx_rate_effective_at: '2026-06-01T00:00:00Z',
              },
            },
          ],
        },
      ],
      customer: [
        {
          id: 'customer-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Construction' } }],
        },
        {
          id: 'customer-2',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Metro Builders' } }],
        },
      ],
      billing_account: [
        {
          id: 'billing-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Main Billing' } }],
        },
        {
          id: 'billing-2',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Metro AP' } }],
        },
      ],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/CA\$\s*1,000\.00/i)
    );
    expect(screen.getByText(/Reporting \(USD\):\s*\$740\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/Customer: Acme Construction · Billing Account: Acme Main Billing/i)).toBeInTheDocument();
    expect(screen.getByText(/Customer: Metro Builders · Billing Account: Metro AP/i)).toBeInTheDocument();
  });

  it('renders en-GB locale formatting from branch scope config', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-00001',
                status: 'sent',
                invoice_date: '2026-06-01',
                total: 1000,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
              },
            },
          ],
        },
      ],
      customer: [
        {
          id: 'customer-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Construction' } }],
        },
      ],
      billing_account: [
        {
          id: 'billing-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Main Billing' } }],
        },
      ],
      branch: [
        {
          id: 'branch-london',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [
            {
              data: {
                locale_code: 'en-GB',
                tax_region_code: 'GB-VAT',
                timezone: 'Europe/London',
                currency_code: 'GBP',
              },
            },
          ],
        },
      ],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await waitFor(() => expect(screen.getByText('£1,000.00')).toBeInTheDocument());
    expect(screen.getByText(/VAT: GB-VAT/i)).toBeInTheDocument();
    expect(screen.getByText(/Invoice Date: 01\/06\/2026/i)).toBeInTheDocument();
  });

  it('records ACH payments and updates outstanding totals', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-00001',
                status: 'sent',
                invoice_date: '2026-06-01',
                total: 750,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                transaction_currency_code: 'EUR',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1.09,
                fx_rate_effective_at: '2026-06-01T00:00:00Z',
              },
            },
          ],
        },
      ],
      customer: [
        {
          id: 'customer-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Construction' } }],
        },
      ],
      billing_account: [
        {
          id: 'billing-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Main Billing' } }],
        },
      ],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/€\s*750\.00/i)
    );

    await userEvent.selectOptions(screen.getByLabelText('Payment Method'), 'ach');
    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.type(screen.getByLabelText('Amount'), '300');
    await userEvent.click(screen.getByRole('button', { name: 'Pay Invoice' }));

    await screen.findByText(/Payment recorded via/i);
    expect(rpcMock).toHaveBeenCalledWith('create_entity_with_version', expect.objectContaining({
      p_entity_type: 'payment',
      p_data: expect.objectContaining({
        invoice_id: 'invoice-1',
        invoice_number: 'INV-00001',
        amount: 300,
        status: 'posted',
        method: 'ach',
        currency_code: 'EUR',
      }),
    }));
    expect(screen.getByText(/Payment recorded via ACH for .*300\.00/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/€\s*450\.00/i)
    );
  });

  it('restores persisted open-balance reductions after remount', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-00001',
                status: 'sent',
                invoice_date: '2026-06-01',
                total: 750,
                open_balance: 500,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                transaction_currency_code: 'USD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1,
              },
            },
          ],
        },
      ],
      customer: [
        {
          id: 'customer-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Construction' } }],
        },
      ],
      billing_account: [
        {
          id: 'billing-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Acme Main Billing' } }],
        },
      ],
      payment: [],
    });

    const firstRender = renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/\$\s*500\.00/i)
    );

    await userEvent.selectOptions(screen.getByLabelText('Invoice'), 'invoice-1');
    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.type(screen.getByLabelText('Amount'), '125');
    await userEvent.click(screen.getByRole('button', { name: 'Pay Invoice' }));

    await screen.findByText(/Payment recorded via/i);
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/\$\s*375\.00/i)
    );

    firstRender.unmount();
    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/\$\s*375\.00/i)
    );
  });

  it('hides fully paid invoices from aging buckets', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-paid',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-PAID',
                status: 'paid',
                invoice_date: '2026-06-01',
                total: 250,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                transaction_currency_code: 'USD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1,
              },
            },
          ],
        },
      ],
      customer: [{ id: 'customer-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Construction' } }] }],
      billing_account: [{ id: 'billing-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Main Billing' } }] }],
      payment: [],
      rental_contract_line: [],
      job_site: [],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    expect(await screen.findByText(/No invoices found for portal payment\./i)).toBeInTheDocument();
    expect(screen.getByTestId('aging-bucket-current')).toHaveTextContent('No balance');
  });

  it('supports AR aging drill-down with filters and currency-separated bucket totals', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-current',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-CURRENT',
                status: 'sent',
                invoice_date: '2026-06-01',
                due_date: formatDateOffset(10),
                total: 100,
                open_balance: 100,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                branch_id: 'branch-1',
                branch_name: 'North Yard',
                transaction_currency_code: 'USD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1,
              },
            },
          ],
        },
        {
          id: 'invoice-overdue',
          created_at: '2026-06-07T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-OVERDUE',
                status: 'sent',
                invoice_date: '2026-06-01',
                due_date: formatDateOffset(-3),
                total: 200,
                open_balance: 200,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                branch_id: 'branch-1',
                branch_name: 'North Yard',
                transaction_currency_code: 'USD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1,
              },
            },
          ],
        },
        {
          id: 'invoice-120',
          created_at: '2026-06-06T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-120',
                status: 'sent',
                invoice_date: '2026-06-01',
                due_date: formatDateOffset(-130),
                total: 300,
                open_balance: 300,
                customer_id: 'customer-2',
                billing_account_id: 'billing-2',
                branch_id: 'branch-2',
                branch_name: 'South Yard',
                transaction_currency_code: 'EUR',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1.09,
              },
            },
          ],
        },
      ],
      customer: [
        { id: 'customer-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        { id: 'customer-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Metro Builders' } }] },
      ],
      billing_account: [
        { id: 'billing-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Main Billing' } }] },
        { id: 'billing-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Metro AP' } }] },
      ],
      payment: [],
      rental_contract_line: [],
      job_site: [],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await waitFor(() => expect(screen.getByTestId('aging-bucket-current')).toHaveTextContent('USD: $100.00'));
    expect(screen.getByTestId('aging-bucket-overdue')).toHaveTextContent('USD: $200.00');
    expect(screen.getByTestId('aging-bucket-120+')).toHaveTextContent('EUR: €300.00');

    await userEvent.selectOptions(screen.getByLabelText('Branch / Location'), 'branch-1');
    const oneTwentyBucket = screen.getByTestId('aging-bucket-120+');
    await userEvent.click(within(oneTwentyBucket).getByRole('button', { name: 'View invoices' }));
    expect(await screen.findByText(/No overdue balance in this bucket for the selected filters\./i)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Branch / Location'), '');
    await userEvent.click(within(oneTwentyBucket).getByRole('button', { name: 'View invoices' }));
    await screen.findByTestId('portal-invoice-invoice-120');
    expect(screen.getByText(/Branch\/Location: South Yard/i)).toBeInTheDocument();
  });

  it('re-buckets overdue invoices when payment closes outstanding balance', async () => {
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                invoice_number: 'INV-00001',
                status: 'sent',
                due_date: formatDateOffset(-2),
                total: 500,
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                transaction_currency_code: 'USD',
                reporting_currency_code: 'USD',
                fx_rate_applied: 1,
              },
            },
          ],
        },
      ],
      payment: [
        {
          id: 'payment-1',
          created_at: '2026-06-09T00:00:00Z',
          entity_versions: [{ data: { invoice_id: 'invoice-1', amount: 200, status: 'posted' } }],
        },
      ],
      customer: [{ id: 'customer-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Construction' } }] }],
      billing_account: [{ id: 'billing-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Main Billing' } }] }],
      rental_contract_line: [],
      job_site: [],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    await userEvent.click(within(screen.getByTestId('aging-bucket-overdue')).getByRole('button', { name: 'View invoices' }));
    await waitFor(() =>
      expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/\$\s*300\.00/i)
    );

    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.type(screen.getByLabelText('Amount'), '300');
    await userEvent.click(screen.getByRole('button', { name: 'Pay Invoice' }));

    await screen.findByText(/Payment recorded via/i);
    await waitFor(() => {
      expect(screen.queryByTestId('portal-invoice-invoice-1')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/No invoices found for portal payment\./i)).toBeInTheDocument();
  });

  it('restores session payment history after remount', async () => {
    window.sessionStorage.setItem('portal-financials-payment-history', JSON.stringify([
      {
        id: 'invoice-77-2026-06-09T12:34:56.000Z',
        invoiceId: 'invoice-77',
        invoiceNumber: 'INV-00077',
        method: 'ach',
        amount: 42.5,
        createdAt: '2026-06-09T12:34:56.000Z',
        currencyCode: 'USD',
      },
    ]));

    mockPortalEntityData({
      invoice: [],
      customer: [],
      billing_account: [],
      payment: [],
      rental_contract_line: [],
      job_site: [],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Invoices & Payments' });
    expect(screen.getByText(/INV-00077 · ACH · \$42\.50/i)).toBeInTheDocument();
  });

  it('shows blocked state when billing data access is denied', async () => {
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
          if (entityType === 'invoice') {
            return { data: null, error: { message: 'permission denied for entities' } };
          }
          return { data: [], error: null };
        }),
      };
      return query;
    });

    renderPortalFinancialsScreen();

    await screen.findByText('Access blocked for billing data');
    expect(screen.getByText(/cannot read one or more billing sources/i)).toBeInTheDocument();
  });

  it('shows project-level equipment allocation and operational status', async () => {
    mockPortalEntityData({
      invoice: [],
      customer: [],
      billing_account: [],
      job_site: [
        {
          id: 'site-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Riverfront Jobsite' } }],
        },
      ],
      rental_contract: [
        {
          id: 'contract-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { contract_number: 'RC-00101', status: 'active' } }],
        },
      ],
      asset: [
        {
          id: 'asset-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Excavator XL-200' } }],
        },
      ],
      rental_contract_line: [
        {
          id: 'line-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [
            {
              data: {
                status: 'checked_out',
                job_site_id: 'site-1',
                cost_code: 'CC-101',
                allocated_equipment_cost: 1200,
                asset_id: 'asset-1',
                contract_id: 'contract-1',
                actual_start: '2026-06-05',
                field_evidence: {
                  signature: 'Pat Approver',
                  approval_event_type: 'delivery',
                },
                transaction_currency_code: 'EUR',
              },
            },
          ],
        },
        {
          id: 'line-2',
          created_at: '2026-06-09T00:00:00Z',
          entity_versions: [
            {
              data: {
                status: 'pending',
                job_site_id: 'site-1',
                cost_code: 'CC-202',
                allocated_equipment_cost: 800,
                planned_start: '2026-06-10',
                field_evidence: {
                  approval_event_type: 'requisition',
                },
                transaction_currency_code: 'CAD',
              },
            },
          ],
        },
      ],
    });

    renderPortalFinancialsScreen();

    await screen.findByText('Project Equipment Cost Allocation');
    await waitFor(() => expect(screen.getAllByText('€1,200.00').length).toBeGreaterThan(0));
    expect(screen.getByText('Riverfront Jobsite · EUR')).toBeInTheDocument();
    expect(screen.getByText('Riverfront Jobsite · CAD')).toBeInTheDocument();
    expect(screen.getByText(/Cost code: CC-101/i)).toBeInTheDocument();
    // Scope assertions to the specific identity <p> for each line using data-testid.
    // All three fields (asset name, contract ref, date) must be present in that element;
    // moving the date to the secondary row or elsewhere will break these assertions.
    const line1Identity = screen.getByTestId('allocation-line-line-1-identity');
    expect(line1Identity).toHaveTextContent('Excavator XL-200');
    expect(line1Identity).toHaveTextContent('RC-00101');
    expect(line1Identity).toHaveTextContent('06/05/2026');
    const line2Identity = screen.getByTestId('allocation-line-line-2-identity');
    // Line 2 has no asset and no category: shows generic fallback
    expect(line2Identity).toHaveTextContent('Equipment');
    expect(line2Identity).toHaveTextContent('06/10/2026');
    // Status phrases remain visible but as secondary metadata after the identifying context
    expect(screen.getByText('Delivered/on rent · signed')).toBeInTheDocument();
    expect(screen.getByText('Requisition pending signature')).toBeInTheDocument();
  });

  it('shows category name for unassigned lines and ensures adjacent rows are distinguishable', async () => {
    mockPortalEntityData({
      invoice: [],
      customer: [],
      billing_account: [],
      job_site: [
        {
          id: 'site-2',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Downtown Site' } }],
        },
      ],
      rental_contract: [
        {
          id: 'contract-2',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { contract_number: 'RC-00202', status: 'active' } }],
        },
      ],
      asset: [],
      asset_category: [
        {
          id: 'cat-excavator',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Excavators' } }],
        },
        {
          id: 'cat-pump',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'Pumps & Dewatering' } }],
        },
      ],
      rental_contract_line: [
        {
          id: 'unassigned-a',
          created_at: '2026-06-10T00:00:00Z',
          entity_versions: [
            {
              data: {
                status: 'returned',
                job_site_id: 'site-2',
                cost_code: 'Unassigned',
                allocated_equipment_cost: 2650,
                category_id: 'cat-excavator',
                contract_id: 'contract-2',
                actual_end: '2026-06-08',
                transaction_currency_code: 'USD',
              },
            },
          ],
        },
        {
          id: 'unassigned-b',
          created_at: '2026-06-10T00:00:00Z',
          entity_versions: [
            {
              data: {
                status: 'returned',
                job_site_id: 'site-2',
                cost_code: 'Unassigned',
                allocated_equipment_cost: 1800,
                category_id: 'cat-pump',
                contract_id: 'contract-2',
                actual_end: '2026-06-09',
                transaction_currency_code: 'USD',
              },
            },
          ],
        },
        {
          id: 'unassigned-c',
          created_at: '2026-06-11T00:00:00Z',
          entity_versions: [
            {
              data: {
                status: 'returned',
                job_site_id: 'site-2',
                cost_code: 'Unassigned',
                allocated_equipment_cost: 3500,
                category_id: 'cat-excavator',
                contract_id: 'contract-2',
                actual_end: '2026-06-10',
                transaction_currency_code: 'USD',
              },
            },
          ],
        },
      ],
    });

    renderPortalFinancialsScreen();

    await screen.findByText('Project Equipment Cost Allocation');

    // Each unassigned line must show its category name instead of a generic label.
    const lineAIdentity = await screen.findByTestId('allocation-line-unassigned-a-identity');
    expect(lineAIdentity).toHaveTextContent('Excavators');
    expect(lineAIdentity).toHaveTextContent('RC-00202');
    expect(lineAIdentity).toHaveTextContent('06/08/2026');

    const lineBIdentity = screen.getByTestId('allocation-line-unassigned-b-identity');
    expect(lineBIdentity).toHaveTextContent('Pumps & Dewatering');
    expect(lineBIdentity).toHaveTextContent('RC-00202');
    expect(lineBIdentity).toHaveTextContent('06/09/2026');

    const lineCIdentity = screen.getByTestId('allocation-line-unassigned-c-identity');
    expect(lineCIdentity).toHaveTextContent('Excavators');
    expect(lineCIdentity).toHaveTextContent('RC-00202');
    expect(lineCIdentity).toHaveTextContent('06/10/2026');

    // QA assertion: no two adjacent cost-allocation rows have identical visible text —
    // at least one field (category, contract ref, or date) must differentiate each row.
    const identityEls = [lineAIdentity, lineBIdentity, lineCIdentity];
    for (let i = 0; i < identityEls.length - 1; i++) {
      expect(
        identityEls[i].textContent,
        `allocation row ${i} and row ${i + 1} must not have identical visible identity text`
      ).not.toBe(identityEls[i + 1].textContent);
    }
  });

  it('disables payment actions for read-only portal roles', async () => {
    authState.profile = { id: 'viewer-1', role: 'read_only' };
    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [{ data: { invoice_number: 'INV-00001', status: 'sent', total: 100 } }],
        },
      ],
      customer: [],
      billing_account: [],
      rental_contract_line: [],
      job_site: [],
    });

    renderPortalFinancialsScreen();

    await screen.findByText('Payment actions disabled');
    expect(screen.getByRole('button', { name: 'Pay Invoice' })).toBeDisabled();
    expect(screen.getByLabelText('Invoice')).toBeDisabled();
  });

  it('shows a portal-scoped self-service view with authorized rentals, invoices, and downloads only', async () => {
    authState.profile = {
      id: 'portal-user-1',
      email: 'customer@example.com',
      displayName: 'Portal Customer',
      role: 'read_only',
      tenant: 'wynne-demo',
      customerId: 'customer-1',
      billingAccountIds: ['billing-1'],
      jobSiteIds: ['job-site-1'],
    };

    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [{
            data: {
              invoice_number: 'INV-PORTAL-001',
              status: 'sent',
              invoice_date: '2026-06-03',
              due_date: '2026-06-20',
              open_balance: 1200,
              total: 1200,
              customer_id: 'customer-1',
              billing_account_id: 'billing-1',
              contract_id: 'contract-1',
              job_site_id: 'job-site-1',
              branch_id: 'branch-1',
              billing_source_synced_at: '2026-06-08T09:00:00Z',
              ar_source_synced_at: '2026-06-08T09:00:00Z',
            },
          }],
        },
        {
          id: 'invoice-2',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [{
            data: {
              invoice_number: 'INV-PORTAL-999',
              status: 'sent',
              invoice_date: '2026-06-03',
              due_date: '2026-06-20',
              open_balance: 400,
              total: 400,
              customer_id: 'customer-2',
              billing_account_id: 'billing-2',
              contract_id: 'contract-2',
              job_site_id: 'job-site-2',
            },
          }],
        },
      ],
      customer: [
        { id: 'customer-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        { id: 'customer-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Cross Account LLC' } }] },
      ],
      billing_account: [
        { id: 'billing-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Main Billing' } }] },
        { id: 'billing-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Unauthorized Billing' } }] },
      ],
      rental_contract: [
        {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              contract_number: 'RC-PORTAL-001',
              status: 'active',
              customer_id: 'customer-1',
              billing_account_id: 'billing-1',
              job_site_id: 'job-site-1',
              branch_id: 'branch-1',
              rental_source_synced_at: '2026-06-08T09:00:00Z',
            },
          }],
        },
        {
          id: 'contract-2',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              contract_number: 'RC-PORTAL-999',
              status: 'active',
              customer_id: 'customer-2',
              billing_account_id: 'billing-2',
              job_site_id: 'job-site-2',
              branch_id: 'branch-2',
              rental_source_synced_at: '2026-06-08T09:00:00Z',
            },
          }],
        },
      ],
      rental_contract_line: [
        {
          id: 'line-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              contract_id: 'contract-1',
              asset_id: 'asset-1',
              status: 'checked_out',
              rate_type: 'daily',
              rate_amount: 375,
              planned_start: '2026-06-01T00:00:00Z',
              planned_end: '2026-06-15T00:00:00Z',
              actual_start: '2026-06-01T00:00:00Z',
            },
          }],
        },
        {
          id: 'line-2',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              contract_id: 'contract-2',
              asset_id: 'asset-2',
              status: 'checked_out',
              rate_type: 'daily',
              rate_amount: 200,
              planned_start: '2026-06-01',
              planned_end: '2026-06-15',
            },
          }],
        },
      ],
      asset: [
        { id: 'asset-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Excavator XL' } }] },
        { id: 'asset-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Unauthorized Lift' } }] },
      ],
      job_site: [
        { id: 'job-site-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'West Plant Expansion' } }] },
      ],
      branch: [
        {
          id: 'branch-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'North Yard', locale_code: 'en-US', tax_region_code: 'US-TX', timezone: 'America/Chicago', currency_code: 'USD' } }],
        },
      ],
      document: [
        {
          id: 'doc-1',
          created_at: '2026-06-08T00:00:00Z',
          entity_versions: [{
            data: {
              invoice_id: 'invoice-1',
              contract_id: 'contract-1',
              title: 'Invoice PDF',
              download_url: 'https://cdn.example.com/invoices/invoice-1.pdf',
              mime_type: 'application/pdf',
            },
          }],
        },
      ],
    });

    renderPortalFinancialsScreen();

    await screen.findByRole('heading', { name: 'Customer Portal · Rentals & Invoices' });
    await waitFor(() => expect(screen.getByTestId('portal-contract-contract-1')).toBeInTheDocument());
    expect(screen.getByText('rental-customer-portal-user:t1')).toBeInTheDocument();
    expect(screen.getByText('rental-customer-portal-user:t4')).toBeInTheDocument();
    expect(screen.getByTestId('portal-contract-contract-1')).toHaveTextContent('RC-PORTAL-001');
    expect(screen.getByTestId('portal-contract-line-line-1')).toHaveTextContent('Excavator XL');
    expect(screen.getByTestId('portal-contract-line-line-1')).toHaveTextContent(/Rate: \$375\.00 \/ daily/i);
    expect(screen.getByTestId('portal-contract-line-line-1')).toHaveTextContent(/Due back: 06\/15\/2026/i);
    expect(screen.getByTestId('portal-invoice-invoice-1')).toHaveTextContent(/Outstanding: \$1,200\.00/i);
    expect(screen.getByRole('link', { name: 'Download Invoice PDF' })).toHaveAttribute('href', 'https://cdn.example.com/invoices/invoice-1.pdf');
    expect(screen.getByRole('link', { name: 'Open contract detail' })).toHaveAttribute('href', '/portal/schedule/contract-1');
    expect(screen.queryByText('Unauthorized Lift')).not.toBeInTheDocument();
    expect(screen.queryByText('INV-PORTAL-999')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay Invoice' })).not.toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('portal_get_financial_entities');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('surfaces missing or stale source gaps instead of implying complete portal data', async () => {
    authState.profile = {
      id: 'portal-user-1',
      email: 'customer@example.com',
      displayName: 'Portal Customer',
      role: 'read_only',
      tenant: 'wynne-demo',
      customerId: 'customer-1',
      billingAccountIds: ['billing-1'],
      jobSiteIds: ['job-site-1'],
    };

    mockPortalEntityData({
      invoice: [
        {
          id: 'invoice-stale',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              invoice_number: 'INV-STALE-001',
              status: 'sent',
              invoice_date: '2026-06-01',
              total: 500,
              customer_id: 'customer-1',
              billing_account_id: 'billing-1',
              contract_id: 'contract-stale',
              job_site_id: 'job-site-1',
              billing_source_synced_at: '2026-05-20T00:00:00Z',
            },
          }],
        },
      ],
      customer: [
        { id: 'customer-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Construction' } }] },
      ],
      billing_account: [
        { id: 'billing-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Acme Main Billing' } }] },
      ],
      rental_contract: [
        {
          id: 'contract-stale',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              contract_number: 'RC-STALE-001',
              status: 'active',
              customer_id: 'customer-1',
              billing_account_id: 'billing-1',
              job_site_id: 'job-site-1',
              branch_id: 'branch-1',
              rental_source_synced_at: '2026-05-20T00:00:00Z',
            },
          }],
        },
      ],
      rental_contract_line: [
        {
          id: 'line-stale',
          created_at: '2026-06-01T00:00:00Z',
          entity_versions: [{
            data: {
              contract_id: 'contract-stale',
              asset_id: 'asset-stale',
              status: 'checked_out',
              rate_type: 'daily',
              rate_amount: 0,
              planned_start: '2026-06-01',
            },
          }],
        },
      ],
      asset: [
        { id: 'asset-stale', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Pump Trailer' } }] },
      ],
      branch: [
        {
          id: 'branch-1',
          created_at: '2026-01-01T00:00:00Z',
          entity_versions: [{ data: { name: 'North Yard', locale_code: 'en-US', tax_region_code: 'US-TX', timezone: 'America/Chicago', currency_code: 'USD' } }],
        },
      ],
    });

    renderPortalFinancialsScreen();

    const exceptions = await screen.findByTestId('portal-source-exceptions');
    expect(exceptions).toHaveTextContent(/RC-STALE-001: rental source stale since 2026-05-20T00:00:00Z/i);
    expect(exceptions).toHaveTextContent(/RC-STALE-001: rate unavailable for Pump Trailer/i);
    expect(exceptions).toHaveTextContent(/RC-STALE-001: due-back date unavailable for Pump Trailer/i);
    expect(exceptions).toHaveTextContent(/INV-STALE-001: missing open balance from AR source/i);
    expect(exceptions).toHaveTextContent(/INV-STALE-001: missing AR source freshness timestamp/i);
    expect(exceptions).toHaveTextContent(/INV-STALE-001: invoice document unavailable/i);
    expect(screen.getByTestId('portal-invoice-invoice-stale')).toHaveTextContent(/Outstanding: Source delayed/i);
    expect(screen.getByText('Document unavailable')).toBeInTheDocument();
  });
});
