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

import { EnterpriseFinancialReportingScreen } from '@/routes/analytics/enterprise-financials';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function reportingRows() {
  return [
    {
      source_entity_id: 'invoice-1',
      source_record_id: 'demo-baseline-invoice-001',
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
      company_scope_name: 'Wynne Industrial Rentals',
      transaction_currency_code: 'CAD',
      reporting_currency_code: 'USD',
      transaction_total_amount: 1000,
      reporting_total_amount: 740,
      fx_rate_used: 0.74,
      fx_rate_source: 'snapshot',
      fx_rate_effective_at: '2026-06-01T00:00:00Z',
    },
    {
      source_entity_id: 'invoice-2',
      source_record_id: 'demo-baseline-invoice-002',
      source_entity_type: 'invoice',
      document_number: 'INV-00002',
      document_status: 'sent',
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
      company_scope_name: 'Wynne Industrial Rentals',
      transaction_currency_code: 'EUR',
      reporting_currency_code: 'USD',
      transaction_total_amount: 1200,
      reporting_total_amount: 1308,
      fx_rate_used: 1.09,
      fx_rate_source: 'snapshot',
      fx_rate_effective_at: '2026-06-01T00:00:00Z',
    },
    {
      source_entity_id: 'invoice-3',
      source_record_id: 'demo-baseline-invoice-003',
      source_entity_type: 'invoice',
      document_number: 'INV-00003',
      document_status: 'paid',
      document_date: '2026-05-15',
      period_start: '2026-04-01',
      period_end: '2026-04-30',
      originating_scope_id: 'branch-houston',
      originating_scope_name: 'Houston Central',
      branch_scope_id: 'branch-houston',
      branch_scope_name: 'Houston Central',
      region_scope_id: 'region-gulf',
      region_scope_name: 'Gulf Coast',
      company_scope_id: 'company-1',
      company_scope_name: 'Wynne Industrial Rentals',
      transaction_currency_code: 'USD',
      reporting_currency_code: 'USD',
      transaction_total_amount: 900,
      reporting_total_amount: 900,
      fx_rate_used: 1,
      fx_rate_source: 'identity',
      fx_rate_effective_at: '2026-05-15T00:00:00Z',
    },
  ];
}

function externalRentalRows() {
  return [
    {
      reporting_line_id: 'contract-line-owned',
      contract_line_id: 'contract-line-owned',
      contract_id: 'contract-1',
      order_line_id: 'order-line-owned',
      asset_id: 'asset-owned',
      asset_name: 'Owned Boom Lift',
      branch_id: 'branch-houston',
      branch_name: 'Houston Central',
      reporting_date: '2026-06-02',
      invoice_count: 1,
      invoice_reference: 'INV-00001',
      contract_line_status: 'checked_out',
      rental_type: 'external',
      asset_ownership_type: 'owned',
      fulfillment_model: 'owned_fleet_external_rental',
      customer_revenue_reporting_amount: 740,
      vendor_obligation_reporting_amount: 0,
      gross_margin_reporting_amount: 740,
      utilization_uplift_minutes: 4320,
      asset_calendar_minutes: 43200,
      utilization_uplift_pct: 10,
      rerent_status_key: null,
      rerent_status_label: null,
      vendor_ref: null,
      vendor_reference_updated_at: null,
      obligation_reference_status: 'not_applicable',
      reporting_currency_code: 'USD',
      formula_reference: 'canonical external rental formula',
    },
    {
      reporting_line_id: 'contract-line-rerent',
      contract_line_id: 'contract-line-rerent',
      contract_id: 'contract-2',
      order_line_id: 'order-line-rerent',
      asset_id: 'asset-rerent',
      asset_name: 'Vendor Telehandler',
      branch_id: 'branch-dallas',
      branch_name: 'Dallas North Yard',
      reporting_date: '2026-06-05',
      invoice_count: 1,
      invoice_reference: 'INV-00002',
      contract_line_status: 'checked_out',
      rental_type: 'external',
      asset_ownership_type: 'external_rental',
      fulfillment_model: 'third_party_rerental',
      customer_revenue_reporting_amount: 1308,
      vendor_obligation_reporting_amount: 900,
      gross_margin_reporting_amount: 408,
      utilization_uplift_minutes: 0,
      asset_calendar_minutes: 0,
      utilization_uplift_pct: 0,
      rerent_status_key: 'on_rent',
      rerent_status_label: 'On Rent',
      vendor_ref: 'PO-44521',
      vendor_reference_updated_at: '2026-06-04T12:00:00Z',
      obligation_reference_status: 'captured',
      reporting_currency_code: 'USD',
      formula_reference: 'canonical external rental formula',
    },
  ];
}

function entityRowsByType() {
  return {
    invoice: [
      {
        id: 'invoice-1',
        created_at: '2026-06-10T00:00:00Z',
        entity_versions: [
          {
            data: {
              invoice_number: 'INV-00001',
              status: 'draft',
              invoice_date: '2026-06-02',
              due_date: '2026-06-20',
              total: 1000,
              open_balance: 1000,
              customer_id: 'customer-1',
              billing_account_id: 'billing-1',
              contract_id: 'contract-1',
              job_site_id: 'job-site-1',
              branch_name: 'Houston Central',
              billing_exception_type: 'rate_anomaly',
              billing_exception_reason: 'Expected daily rate did not match contracted rate card.',
              billing_source_synced_at: new Date().toISOString(),
              ar_source_synced_at: new Date().toISOString(),
              transaction_currency_code: 'CAD',
              reporting_currency_code: 'USD',
            },
          },
        ],
      },
      {
        id: 'invoice-2',
        created_at: '2026-06-09T00:00:00Z',
        entity_versions: [
          {
            data: {
              invoice_number: 'INV-00002',
              status: 'sent',
              invoice_date: '2026-06-05',
              due_date: '2026-06-07',
              total: 1200,
              open_balance: 1200,
              customer_id: 'customer-2',
              billing_account_id: 'billing-2',
              contract_id: 'contract-2',
              job_site_id: 'job-site-2',
              branch_name: 'Dallas North Yard',
              dispute_status: 'needs_review',
              dispute_reason: 'Customer disputes overtime fuel surcharge on final invoice.',
              dispute_recommendation: 'Review branch delivery logs before approving any credit memo.',
              branch_clarification_status: 'requested',
              branch_clarification_note: 'Waiting on signed pickup ticket from Dallas branch.',
              billing_source_synced_at: new Date().toISOString(),
              ar_source_synced_at: '2026-05-20T00:00:00Z',
              transaction_currency_code: 'EUR',
              reporting_currency_code: 'USD',
            },
          },
        ],
      },
      {
        id: 'invoice-3',
        created_at: '2026-06-08T00:00:00Z',
        entity_versions: [
          {
            data: {
              invoice_number: 'INV-00003',
              status: 'sent',
              invoice_date: '2026-05-15',
              due_date: '2026-01-01',
              total: 900,
              open_balance: 900,
              customer_id: 'customer-1',
              billing_account_id: 'billing-1',
              contract_id: 'contract-1',
              job_site_id: 'job-site-1',
              branch_name: 'Houston Central',
              billing_source_synced_at: new Date().toISOString(),
              ar_source_synced_at: '',
              transaction_currency_code: 'USD',
              reporting_currency_code: 'USD',
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
    rental_contract: [
      { id: 'contract-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { contract_number: 'RC-1001' } }] },
      { id: 'contract-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { contract_number: 'RC-1002' } }] },
    ],
    job_site: [
      { id: 'job-site-1', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Riverfront Expansion' } }] },
      { id: 'job-site-2', created_at: '2026-01-01T00:00:00Z', entity_versions: [{ data: { name: 'Airport Ramp' } }] },
    ],
  };
}

function mockReportingRows(
  rows = reportingRows(),
  externalRows = externalRentalRows(),
  entities = entityRowsByType()
) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'v_enterprise_financial_reporting_lines') {
      const query = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn(async () => ({ data: rows, error: null })),
      };
      return query;
    }

    if (table === 'v_external_rental_reporting_lines') {
      const query = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn(async () => ({ data: externalRows, error: null })),
      };
      return query;
    }

    expect(table).toBe('entities');
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
      limit: vi.fn(async () => ({
        data: entities[entityType as keyof typeof entities] ?? [],
        error: null,
      })),
    };
    return query;
  });
}

describe('EnterpriseFinancialReportingScreen', () => {
  beforeEach(() => {
    fromMock.mockReset();
    mockReportingRows();
  });

  it('renders consolidated company and region reporting summaries', async () => {
    renderWithQueryClient(<EnterpriseFinancialReportingScreen />);

    await screen.findByRole('heading', { name: 'Enterprise Financial Reporting' });
    await waitFor(() => expect(screen.getAllByText('$2,948.00').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Wynne Industrial Rentals').length).toBeGreaterThan(0);
    expect(screen.getByText('Gulf Coast')).toBeInTheDocument();
    expect(screen.getByText('North Texas')).toBeInTheDocument();
    expect(screen.getAllByText('CAD').length).toBeGreaterThan(0);
    expect(screen.getAllByText('EUR').length).toBeGreaterThan(0);
  });

  it('drills from a consolidated region to branch and per-entity detail', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EnterpriseFinancialReportingScreen />);

    await screen.findByRole('heading', { name: 'Enterprise Financial Reporting' });
    await user.click(screen.getByRole('button', { name: /Gulf Coast/i }));

    await waitFor(() => expect(screen.getByTestId('enterprise-report-row-invoice-1')).toBeInTheDocument());
    expect(screen.getByTestId('enterprise-report-row-invoice-3')).toBeInTheDocument();
    expect(screen.queryByTestId('enterprise-report-row-invoice-2')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Wynne Industrial Rentals · Gulf Coast · Houston Central/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/CA\$1,000.00 \(CAD\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\$740.00 \(USD\)/i)).toBeInTheDocument();
  });

  it('filters the shared dataset by branch scope', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<EnterpriseFinancialReportingScreen />);

    await screen.findByRole('heading', { name: 'Enterprise Financial Reporting' });
    await user.selectOptions(screen.getByLabelText('Scope Level'), 'branch');
    await user.selectOptions(screen.getByLabelText('Org Scope'), 'branch-dallas');

    await waitFor(() => expect(screen.getByTestId('enterprise-report-row-invoice-2')).toBeInTheDocument());
    expect(screen.getAllByText('Dallas North Yard').length).toBeGreaterThan(0);
    expect(screen.getByTestId('enterprise-report-row-invoice-2')).toBeInTheDocument();
    expect(screen.queryByTestId('enterprise-report-row-invoice-1')).not.toBeInTheDocument();
  });

  it('assembles billing anomalies, dispute context, DSO buckets, and source exceptions from shared invoice rows', async () => {
    renderWithQueryClient(<EnterpriseFinancialReportingScreen />);

    await screen.findByTestId('billing-control-pack');
    expect(screen.getByText('credit-billing-analyst:t3')).toBeInTheDocument();
    expect(screen.getByText('credit-billing-analyst:t6')).toBeInTheDocument();
    expect(screen.getByText('credit-billing-analyst:t7')).toBeInTheDocument();
    expect(screen.getByTestId('billing-anomaly-invoice-1')).toHaveTextContent(/Expected daily rate did not match contracted rate card/i);
    expect(screen.getByTestId('billing-anomaly-invoice-1')).toHaveTextContent(/Acme Construction/i);
    expect(screen.getByTestId('billing-dispute-invoice-2')).toHaveTextContent(/Customer disputes overtime fuel surcharge/i);
    expect(screen.getByTestId('billing-dispute-invoice-2')).toHaveTextContent(/Waiting on signed pickup ticket from Dallas branch/i);
    expect(screen.getByTestId('billing-control-bucket-current')).toHaveTextContent('USD: $1,000.00');
    expect(screen.getByTestId('billing-control-bucket-overdue')).toHaveTextContent('USD: $1,200.00');
    expect(screen.getByTestId('billing-control-bucket-120+')).toHaveTextContent('USD: $900.00');
    expect(screen.getByTestId('dso-control-pack')).toHaveTextContent(/AR source stale since 2026-05-20T00:00:00Z/i);
    expect(screen.getByTestId('dso-control-pack')).toHaveTextContent(/missing AR source freshness timestamp/i);
  });

  it('exports the weekly DSO control pack as CSV', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:billing-control-pack');
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;

    renderWithQueryClient(<EnterpriseFinancialReportingScreen />);

    await screen.findByRole('button', { name: 'Export Weekly DSO Pack' });
    await user.click(screen.getByRole('button', { name: 'Export Weekly DSO Pack' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const firstCreateObjectUrlCall = createObjectURL.mock.calls[0] as unknown[] | undefined;
    const blobArg = firstCreateObjectUrlCall?.[0];
    expect(blobArg).toBeInstanceOf(Blob);
    await expect((blobArg as unknown as Blob).text()).resolves.toContain('dso_days');
    expect(screen.getByText('Weekly DSO control pack CSV download started.')).toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:billing-control-pack');
    anchorClick.mockRestore();
  });

  it('reports owned external-rental revenue, utilization uplift, and rerental obligations separately', async () => {
    renderWithQueryClient(<EnterpriseFinancialReportingScreen />);

    await screen.findByTestId('external-rental-report');
    expect(screen.getByTestId('external-rental-owned-revenue')).toHaveTextContent('$740.00');
    expect(screen.getByTestId('external-rental-owned-utilization')).toHaveTextContent('10.0%');
    expect(screen.getByTestId('external-rental-vendor-obligations')).toHaveTextContent('$900.00');
    expect(screen.getByTestId('external-rental-margin')).toHaveTextContent('$408.00');
    expect(screen.getByTestId('external-rental-row-contract-line-rerent')).toHaveTextContent('PO-44521');
    expect(screen.getByTestId('external-rental-row-contract-line-owned')).toHaveTextContent('Owned-fleet external rental');
  });
});
