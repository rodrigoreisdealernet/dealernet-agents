import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  navigateSpy,
  useDataSourcesMock,
  rpcMock,
  insertMock,
  fromMock,
  authState,
} = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  useDataSourcesMock: vi.fn(),
  rpcMock: vi.fn(),
  insertMock: vi.fn(),
  fromMock: vi.fn(),
  authState: {
    value: {
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
      <a href={to as string} {...props}>{children}</a>
    ),
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

vi.mock('@/auth/AuthContext', async () => {
  const types = await vi.importActual<typeof import('@/auth/types')>('@/auth/types');
  return {
    useAuth: () => authState.value,
    useAuthCapabilities: () => ({
      canWrite: types.canWrite(authState.value.profile?.role as import('@/auth/types').AppRole | undefined),
      canOperate: types.canOperate(authState.value.profile?.role as import('@/auth/types').AppRole | undefined),
      role: authState.value.profile?.role,
    }),
  };
});

import { initializeRegistry } from '@/registry';
import { EntityListScreen } from '@/routes/entities/$entityType/index';
import { EntityDetailScreen } from '@/routes/entities/$entityType/$id';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
}

function getExpectedCreateLabel(entityType: string): string {
  const labels: Record<string, string> = {
    billing_account: 'Billing Account',
    job_site: 'Job Site',
    asset_category: 'Asset Category',
  };

  return `New ${labels[entityType] || entityType.charAt(0).toUpperCase() + entityType.slice(1)}`;
}

describe('rental entity screens', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    insertMock.mockReset();
    fromMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    };

    rpcMock.mockResolvedValue({ error: null });
    insertMock.mockResolvedValue({ error: null });
    fromMock.mockReturnValue({
      insert: insertMock,
    });
  });

  it('creates a branch through the generic create RPC from the entity list screen', async () => {
    const refetchMock = vi.fn();

    useDataSourcesMock.mockReturnValue({
      data: {
        entities: [
          {
            id: 'branch-1',
            entity_versions: [
              {
                version_number: 1,
                data: { name: 'North Yard' },
              },
            ],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="branch" />);

    expect(screen.getByRole('heading', { name: 'Branches' })).toBeInTheDocument();
    expect(screen.getByText('North Yard')).toBeInTheDocument();
    expect(screen.getByText('Manage your branches')).toBeInTheDocument();
    expect(screen.getByText('Record: Not assigned')).toHaveClass('text-foreground');

    await userEvent.click(screen.getByRole('button', { name: 'New Branch' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Downtown Branch');
    await userEvent.type(screen.getByLabelText('Description'), 'Primary city branch');
    await userEvent.type(screen.getByLabelText('Status'), 'draft');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('create_entity_with_version', {
        p_entity_type: 'branch',
        p_data: {
          name: 'Downtown Branch',
          description: 'Primary city branch',
          status: 'draft',
        },
      });
    });
    expect(refetchMock).toHaveBeenCalledWith('entities');
  });

  it('scopes invoice list rows to contractId handoff context', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entities: [
          {
            id: 'invoice-1',
            source_record_id: 'INV-001',
            entity_versions: [
              {
                id: 'inv-ver-1',
                version_number: 1,
                is_current: true,
                data: {
                  name: 'Invoice 001',
                  contract_id: 'contract-1',
                  customer_id: 'customer-1',
                  billing_account_id: 'billing-1',
                  job_site_id: 'job-1',
                },
              },
            ],
          },
          {
            id: 'invoice-2',
            source_record_id: 'INV-002',
            entity_versions: [
              {
                id: 'inv-ver-2',
                version_number: 1,
                is_current: true,
                data: {
                  name: 'Invoice 002',
                  contract_id: 'contract-2',
                  customer_id: 'customer-1',
                  billing_account_id: 'billing-1',
                  job_site_id: 'job-1',
                },
              },
            ],
          },
        ],
        invoiceCustomers: [],
        invoiceBillingAccounts: [],
        invoiceContracts: [],
        invoiceJobSites: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="invoice" contractId="contract-1" />);

    expect(screen.getByText('Filtered to contract contract-1')).toBeInTheDocument();
    expect(screen.getByText('Invoice 001')).toBeInTheDocument();
    expect(screen.queryByText('Invoice 002')).not.toBeInTheDocument();
  });

  it('appends a new entity version from the asset detail edit flow', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-1',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'asset-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Excavator 100',
                description: 'Legacy description',
                operational_status: 'available',
              },
            },
          ],
        },
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                data: {},
              },
            ],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-1" />);

    expect(screen.getByRole('heading', { name: 'Excavator 100' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Excavator 100X');
    await userEvent.clear(screen.getByLabelText('Description'));
    await userEvent.type(screen.getByLabelText('Description'), 'Updated rental asset');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(fromMock).toHaveBeenCalledWith('entity_versions');
      expect(insertMock).toHaveBeenCalledWith({
        entity_id: 'asset-1',
        version_number: 2,
        data: {
          name: 'Excavator 100X',
          description: 'Updated rental asset',
          status: 'available',
        },
        is_current: true,
      });
    });
  });

  it('renders asset service history and downtime analytics on the entity detail screen', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-1',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          source_record_id: 'ASSET-001',
          entity_versions: [
            {
              id: 'asset-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Excavator 100',
                description: 'Primary digger',
                status: 'available',
                asset_category_id: 'cat-1',
                branch_id: 'branch-1',
              },
            },
          ],
        },
        contracts: [],
        assetCategories: [
          { id: 'cat-1', entity_versions: [{ data: { name: 'Excavators' }, is_current: true }] },
        ],
        branches: [
          { id: 'branch-1', entity_versions: [{ data: { name: 'North Yard' }, is_current: true }] },
        ],
        assetServiceHistory: [
          {
            asset_id: 'asset-1',
            service_record_id: 'maint-1',
            service_record_type: 'maintenance',
            service_name: 'Hydraulic Hose Replacement',
            service_type: 'corrective',
            opened_at: '2026-06-01T08:00:00Z',
            completed_at: '2026-06-01T10:30:00Z',
            outcome: 'returned_to_service',
            status: 'completed',
            cost_summary: 'Labor $180 · Parts $95 · Total $275',
            downtime_minutes: 150,
            service_sort_at: '2026-06-01T10:30:00Z',
          },
          {
            asset_id: 'asset-1',
            service_record_id: 'inspection-1',
            service_record_type: 'inspection',
            service_name: 'Return Inspection 001',
            service_type: 'return',
            opened_at: '2026-05-28T11:00:00Z',
            completed_at: '2026-05-28T11:00:00Z',
            outcome: 'pass',
            status: 'pass',
            cost_summary: null,
            downtime_minutes: null,
            service_sort_at: '2026-05-28T11:00:00Z',
          },
        ],
        assetDowntimeAnalytics: {
          asset_id: 'asset-1',
          asset_name: 'Excavator 100',
          asset_category_id: 'cat-1',
          asset_category_name: 'Excavators',
          downtime_intervals: 3,
          total_downtime_minutes: 420,
          inspection_downtime_minutes: 60,
          maintenance_downtime_minutes: 360,
          last_downtime_recorded_at: '2026-06-01T10:30:00Z',
        },
        assetAnalytics: {
          asset_id: 'asset-1',
          asset_name: 'Excavator 100',
          asset_category_id: 'cat-1',
          asset_category_name: 'Excavators',
          branch_id: 'branch-1',
          branch_name: 'North Yard',
          ownership_type: 'owned',
          cost_basis: null,
          lifetime_revenue: 11800,
          utilization_pct: 58.4,
          downtime_pct: 3.6,
          total_downtime_minutes: 420,
          rental_frequency: 7,
          roi_pct: null,
          roi_status: 'unavailable',
          last_order_at: '2026-06-01T08:00:00Z',
          calendar_minutes: 120000,
          rental_minutes: 70080,
          analytics_updated_at: '2026-06-01T11:00:00Z',
          formula_reference: 'utilization_pct = rental_minutes / calendar_minutes * 100',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-1" />);

    expect(screen.getByText('420 total downtime minutes')).toBeInTheDocument();
    expect(screen.getByText('3 completed downtime intervals')).toBeInTheDocument();
    expect(screen.getByText('Maintenance: 360 min · Inspection: 60 min')).toBeInTheDocument();
    expect(screen.getByText('Lifetime revenue: $11800')).toBeInTheDocument();
    expect(screen.getByText('Utilization: 58.4% · Downtime: 3.6%')).toBeInTheDocument();
    expect(screen.getByText('ROI: Unavailable (missing cost basis)')).toBeInTheDocument();
    expect(screen.getByText('Hydraulic Hose Replacement')).toBeInTheDocument();
    expect(screen.getByText('Type: corrective · Outcome: returned_to_service')).toBeInTheDocument();
    expect(screen.getByText('Labor $180 · Parts $95 · Total $275')).toBeInTheDocument();
    expect(screen.getByText('Downtime: 150 minutes')).toBeInTheDocument();
    expect(screen.getByText('Return Inspection 001')).toBeInTheDocument();
  });

  it('shows asset maintenance empty and error states independently', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-2',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'asset-version-2',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Boom Lift 200',
                description: 'No active service records',
                status: 'available',
                asset_category_id: 'cat-2',
                branch_id: 'branch-2',
              },
            },
          ],
        },
        contracts: [],
        assetCategories: [],
        branches: [],
        assetServiceHistory: [],
        assetDowntimeAnalytics: null,
        assetAnalytics: null,
      },
      isLoading: {},
      errors: {
        assetDowntimeAnalytics: new Error('analytics timeout'),
        assetAnalytics: new Error('asset analytics timeout'),
      },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-2" />);

    expect(screen.getByText('No service history recorded for this asset yet.')).toBeInTheDocument();
    expect(screen.getByText('Unable to load downtime analytics')).toBeInTheDocument();
    expect(screen.getByText('analytics timeout')).toBeInTheDocument();
    expect(screen.getByText('Unable to load asset analytics')).toBeInTheDocument();
    expect(screen.getByText('asset analytics timeout')).toBeInTheDocument();
  });

  it('renders project equipment budget variance and owned-vs-rented rollups on job-site detail', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'job-site-1',
          entity_type: 'job_site',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'job-site-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Riverfront Expansion',
                customer_id: 'customer-1',
              },
            },
          ],
        },
        customers: [
          { id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' }, is_current: true }] },
        ],
        projectEquipmentCostRollup: {
          job_site_id: 'job-site-1',
          project_name: 'Riverfront Expansion',
          project_equipment_budget: 150000,
          actual_equipment_cost: 134500,
          budget_variance: 15500,
          owned_equipment_cost: 92000,
          external_rental_equipment_cost: 42500,
          on_rent_line_count: 3,
          off_rent_line_count: 4,
          allocation_line_count: 9,
          latest_lifecycle_at: '2026-06-12T15:30:00Z',
          reporting_currency_code: 'USD',
          formula_reference: 'budget_variance = project_equipment_budget - actual_equipment_cost',
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="job_site" id="job-site-1" />);

    expect(screen.getByText('Project Equipment Cost Rollup')).toBeInTheDocument();
    expect(screen.getByText('Budget: $150,000 · Actual: $134,500')).toBeInTheDocument();
    expect(screen.getByText('Variance (budget - actual): $15,500')).toBeInTheDocument();
    expect(screen.getByText('Owned cost: $92,000 · External-rental cost: $42,500')).toBeInTheDocument();
    expect(screen.getByText('Lifecycle activity: 3 on-rent · 4 off-rent · 9 total allocations')).toBeInTheDocument();
    expect(screen.getByText('budget_variance = project_equipment_budget - actual_equipment_cost')).toBeInTheDocument();
  });

  it('renders distinct loading, error, and empty states for entity lists', () => {
    useDataSourcesMock.mockReturnValue({
      data: { entities: [] },
      isLoading: { entities: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const { unmount } = renderWithQueryClient(<EntityListScreen entityType="asset" />);
    expect(screen.getByText('Assets')).toBeInTheDocument();
    expect(screen.getByText('Loading assets...')).toBeInTheDocument();
    expect(screen.queryByText('No assets yet')).not.toBeInTheDocument();
    unmount();

    useDataSourcesMock.mockReturnValue({
      data: { entities: [] },
      isLoading: { entities: false },
      errors: { entities: new Error('network timeout') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const rendered = renderWithQueryClient(<EntityListScreen entityType="asset" />);
    expect(screen.getByText('Unable to load assets')).toBeInTheDocument();
    expect(screen.getByText('network timeout')).toBeInTheDocument();
    expect(screen.queryByText('No assets yet')).not.toBeInTheDocument();
    rendered.unmount();

    useDataSourcesMock.mockReturnValue({
      data: { entities: [] },
      isLoading: { entities: false },
      errors: { entities: null },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="asset" />);
    expect(screen.getByText('No assets yet')).toBeInTheDocument();
  });

  it('targets entity detail pages from the View action across core entity types', async () => {
    const cases = [
      { entityType: 'branch', entityData: { name: 'Houston Central' }, id: 'branch-1' },
      { entityType: 'customer', entityData: { name: 'Acme Construction' }, id: 'customer-1' },
      { entityType: 'asset', entityData: { name: 'Excavator 100' }, id: 'asset-1' },
      { entityType: 'asset_category', entityData: { name: 'Excavators' }, id: 'asset-category-1' },
      { entityType: 'job_site', entityData: { name: 'Riverfront Expansion' }, id: 'job-site-1' },
      { entityType: 'invoice', entityData: { name: 'Invoice INV-001' }, id: 'invoice-1' },
    ];

    for (const { entityType, entityData, id } of cases) {
      useDataSourcesMock.mockReturnValue({
        data: {
          entities: [
            {
              id,
              entity_versions: [
                {
                  version_number: 1,
                  data: entityData,
                },
              ],
            },
          ],
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: vi.fn(),
        refetchAll: vi.fn(),
      });

      const { unmount } = renderWithQueryClient(<EntityListScreen entityType={entityType} />);
      const viewButton = screen.getByRole('button', { name: 'View' });
      await userEvent.click(viewButton);
      expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({ to: `/entities/${entityType}/${id}` }));
      navigateSpy.mockReset();

      unmount();
    }
  });

  it('shows blocked availability messaging for assets on transfer', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entities: [
          {
            id: 'asset-1',
            entity_versions: [
              {
                version_number: 1,
                data: { name: 'Excavator 100', operational_status: 'on_transfer' },
              },
            ],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="asset" />);

    expect(screen.getByText('Checkout blocked: on transfer')).toBeInTheDocument();
  });

  it('shows invoice billing exceptions and context on the generic list screen', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entities: [
          {
            id: 'invoice-1',
            source_record_id: '3f9a8f4c-2ce0-4eb0-9c74-4e2904f4a7d4',
            entity_versions: [
              {
                version_number: 3,
                data: {
                  invoice_number: 'INV-001',
                  status: 'draft',
                  customer_id: 'customer-1',
                  billing_account_id: 'billing-1',
                  contract_id: 'contract-1',
                  job_site_id: 'job-1',
                  billing_exception_reason: 'Billing hold present: credit_review',
                },
              },
            ],
          },
        ],
        invoiceCustomers: [
          { id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        ],
        invoiceBillingAccounts: [
          { id: 'billing-1', entity_versions: [{ data: { name: 'Acme Main Billing', account_number: 'BA-1001' } }] },
        ],
        invoiceContracts: [
          { id: 'contract-1', entity_versions: [{ data: { contract_number: 'RC-1001' } }] },
        ],
        invoiceJobSites: [
          { id: 'job-1', entity_versions: [{ data: { name: 'Riverfront Expansion' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="invoice" />);

    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('Document: INV-001')).toHaveClass('text-foreground');
    // The billing exception text appears in both the row context line and the
    // inline alert that the expression evaluator now correctly renders.
    expect(screen.getAllByText(/Billing hold present: credit_review/).length).toBeGreaterThan(0);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Customer: Acme Construction · Billing Account: Acme Main Billing · Contract: RC-1001 · Job Site: Riverfront Expansion/)).toHaveClass('text-foreground');
    expect(screen.queryByText(/Record:/)).not.toBeInTheDocument();
    expect(screen.queryByText('3f9a8f4c-2ce0-4eb0-9c74-4e2904f4a7d4')).not.toBeInTheDocument();
  });

  it('shows transfer coordination context and exceptions on the generic list screen', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entities: [
          {
            id: 'transfer-1',
            entity_versions: [
              {
                version_number: 2,
                data: {
                  name: 'North to South Rebalance',
                  status: 'requested',
                  origin_branch_id: 'branch-1',
                  destination_branch_id: 'branch-2',
                  requested_ship_date: '2026-06-20',
                  expected_receive_date: '2026-06-21',
                  asset_scope: 'Excavator 100',
                  internal_cost: '425.00',
                  sourcing_decision_id: 'finding-1',
                  transfer_exception_reason: 'Awaiting trailer slot confirmation',
                },
              },
            ],
          },
        ],
        transferBranches: [
          { id: 'branch-1', entity_versions: [{ data: { name: 'North Yard' } }] },
          { id: 'branch-2', entity_versions: [{ data: { name: 'South Depot' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="transfer" />);

    expect(screen.getByText('North to South Rebalance')).toBeInTheDocument();
    expect(screen.getByText(/Origin: North Yard · Destination: South Depot · Scope: Excavator 100 · Internal Cost: 425.00/)).toBeInTheDocument();
    expect(screen.getByText(/Requested Ship: 2026-06-20 · Expected Receive: 2026-06-21 · Sourcing Decision: finding-1 · Exception: Awaiting trailer slot confirmation/)).toBeInTheDocument();
  });

  it('shows customer, billing account, contact, job site, asset category, and asset glossary fields on list screens', () => {
    const cases = [
      {
        entityType: 'customer',
        entityData: { name: 'Acme Construction', customer_type: 'enterprise' },
        expectedText: 'Customer Type: enterprise',
      },
      {
        entityType: 'billing_account',
        entityData: { name: 'Acme Main Billing', payment_terms: 'net_30', credit_limit: '50000' },
        expectedText: 'Terms: net_30 · Credit Limit: 50000',
      },
      {
        entityType: 'contact',
        entityData: { name: 'Jane Doe', role: 'project_manager', customer_id: 'customer-1', job_site_id: 'job-site-1' },
        expectedText: 'Role: project_manager · Customer: customer-1 · Job Site: job-site-1',
      },
      {
        entityType: 'job_site',
        entityData: { name: 'Riverfront Expansion', address: '123 Industrial Way', customer_id: 'customer-1' },
        expectedText: 'Address: 123 Industrial Way · Customer: customer-1',
      },
      {
        entityType: 'asset_category',
        entityData: { name: 'Excavators', default_rate_type: 'daily', default_rate_amount: '250', utilization_group: 'earthmoving' },
        expectedText: 'Rate: daily 250 · Utilization Group: earthmoving',
      },
      {
        entityType: 'asset',
        entityData: {
          identifier: 'EQ-1001',
          category_id: 'asset-category-1',
          branch_id: 'branch-1',
          status: 'available',
        },
        extraData: {
          assetCategories: [
            { id: 'asset-category-1', entity_versions: [{ data: { name: 'Excavators' }, is_current: true }] },
          ],
          assetBranches: [
            { id: 'branch-1', entity_versions: [{ data: { name: 'North Yard' }, is_current: true }] },
          ],
        },
        expectedText: 'Identifier: EQ-1001 · Category: Excavators · Branch: North Yard · Availability: available',
      },
    ];

    for (const { entityType, entityData, expectedText, extraData } of cases as Array<{
      entityType: string;
      entityData: Record<string, unknown>;
      expectedText: string;
      extraData?: Record<string, unknown>;
    }>) {
      useDataSourcesMock.mockReturnValue({
        data: {
          entities: [
            {
              id: `${entityType}-1`,
              entity_versions: [
                {
                  version_number: 1,
                  data: entityData,
                },
              ],
            },
          ],
          ...(extraData ?? {}),
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: vi.fn(),
        refetchAll: vi.fn(),
      });

      const { unmount } = renderWithQueryClient(<EntityListScreen entityType={entityType} />);
      expect(screen.getByText(expectedText)).toBeInTheDocument();
      unmount();
    }
  });

  it('uses operator-facing asset identifiers in list rows and hides raw record ids', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entities: [
          {
            id: 'asset-1',
            source_record_id: '3f9a8f4c-2ce0-4eb0-9c74-4e2904f4a7d4',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  identifier: 'EQ-1001',
                  category_id: 'asset-category-1',
                  branch_id: 'branch-1',
                  status: 'available',
                },
              },
            ],
          },
        ],
        assetCategories: [
          { id: 'asset-category-1', entity_versions: [{ data: { name: 'Excavators' }, is_current: true }] },
        ],
        assetBranches: [
          { id: 'branch-1', entity_versions: [{ data: { name: 'North Yard' }, is_current: true }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="asset" />);

    expect(screen.getByText('EQ-1001')).toBeInTheDocument();
    expect(screen.getByText('Identifier: EQ-1001 · Category: Excavators · Branch: North Yard · Availability: available')).toBeInTheDocument();
    expect(screen.queryByText('Record: 3f9a8f4c-2ce0-4eb0-9c74-4e2904f4a7d4')).not.toBeInTheDocument();
    expect(screen.queryByText('3f9a8f4c-2ce0-4eb0-9c74-4e2904f4a7d4')).not.toBeInTheDocument();
  });

  it('creates customer, billing account, contact, job site, asset category, and asset entities through entity-specific RPC payloads', async () => {
    const cases = [
      {
        entityType: 'customer',
        fields: [{ label: 'Customer Type', value: 'enterprise' }],
        expectedData: { name: 'Entity Name', customer_type: 'enterprise' },
      },
      {
        entityType: 'billing_account',
        fields: [
          { label: 'Payment Terms', value: 'net_30' },
          { label: 'Credit Limit', value: '50000' },
        ],
        expectedData: { name: 'Entity Name', payment_terms: 'net_30', credit_limit: '50000' },
      },
      {
        entityType: 'contact',
        fields: [
          { label: 'Role', value: 'project_manager' },
          { label: 'Linked Customer ID', value: 'customer-1' },
          { label: 'Linked Job Site ID', value: 'job-site-1' },
        ],
        expectedData: {
          name: 'Entity Name',
          role: 'project_manager',
          customer_id: 'customer-1',
          job_site_id: 'job-site-1',
        },
      },
      {
        entityType: 'job_site',
        fields: [
          { label: 'Address', value: '123 Industrial Way' },
          { label: 'Linked Customer ID', value: 'customer-1' },
        ],
        expectedData: { name: 'Entity Name', address: '123 Industrial Way', customer_id: 'customer-1' },
      },
      {
        entityType: 'asset_category',
        fields: [
          { label: 'Default Rate Type', value: 'daily' },
          { label: 'Default Rate Amount', value: '250' },
          { label: 'Utilization Group', value: 'earthmoving' },
        ],
        expectedData: {
          name: 'Entity Name',
          default_rate_type: 'daily',
          default_rate_amount: '250',
          utilization_group: 'earthmoving',
        },
      },
      {
        entityType: 'asset',
        fields: [
          { label: 'Identifier', value: 'EQ-1001' },
          { label: 'Linked Asset Category ID', value: 'asset-category-1' },
          { label: 'Linked Branch ID', value: 'branch-1' },
          { label: 'Availability Status', value: 'available' },
        ],
        expectedData: {
          name: 'Entity Name',
          identifier: 'EQ-1001',
          asset_category_id: 'asset-category-1',
          branch_id: 'branch-1',
          status: 'available',
        },
      },
      {
        entityType: 'transfer',
        fields: [
          { label: 'Description', value: 'Rebalance idle excavator to demand branch' },
          { label: 'Status', value: 'requested' },
          { label: 'Sourcing Decision ID', value: 'finding-1' },
          { label: 'Origin Branch ID', value: 'branch-1' },
          { label: 'Destination Branch ID', value: 'branch-2' },
          { label: 'Requested Ship Date', value: '2026-06-20' },
          { label: 'Expected Receive Date', value: '2026-06-21' },
          { label: 'Asset Scope', value: 'Excavator 100' },
          { label: 'Internal Cost', value: '425.00' },
          { label: 'Transfer Exception', value: 'Awaiting trailer slot confirmation' },
        ],
        expectedData: {
          name: 'Entity Name',
          description: 'Rebalance idle excavator to demand branch',
          status: 'requested',
          sourcing_decision_id: 'finding-1',
          origin_branch_id: 'branch-1',
          destination_branch_id: 'branch-2',
          requested_ship_date: '2026-06-20',
          expected_receive_date: '2026-06-21',
          asset_scope: 'Excavator 100',
          internal_cost: '425.00',
          transfer_exception_reason: 'Awaiting trailer slot confirmation',
        },
      },
    ];

    for (const { entityType, fields, expectedData } of cases) {
      rpcMock.mockClear();
      const refetchMock = vi.fn();
      useDataSourcesMock.mockReturnValue({
        data: { entities: [] },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: refetchMock,
        refetchAll: vi.fn(),
      });

      const { unmount } = renderWithQueryClient(<EntityListScreen entityType={entityType} />);
      await userEvent.click(screen.getByRole('button', { name: getExpectedCreateLabel(entityType) }));
      await userEvent.type(screen.getByLabelText('Name'), 'Entity Name');

      for (const field of fields) {
        await userEvent.type(screen.getByLabelText(field.label), field.value);
      }

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => {
        expect(rpcMock).toHaveBeenCalledWith('create_entity_with_version', {
          p_entity_type: entityType,
          p_data: expectedData,
        });
      });
      expect(refetchMock).toHaveBeenCalledWith('entities');
      unmount();
    }
  });

  it('shows glossary field values on detail screens for customer and asset catalog entities', () => {
    const cases = [
      {
        entityType: 'customer',
        entityData: { name: 'Acme Construction', customer_type: 'enterprise' },
        expectedText: 'enterprise',
      },
      {
        entityType: 'billing_account',
        entityData: { name: 'Acme Main Billing', payment_terms: 'net_30', credit_limit: '50000' },
        expectedText: 'net_30',
      },
      {
        entityType: 'contact',
        entityData: { name: 'Jane Doe', role: 'project_manager', customer_id: 'customer-1', job_site_id: 'job-site-1' },
        expectedText: 'project_manager',
      },
      {
        entityType: 'job_site',
        entityData: { name: 'Riverfront Expansion', address: '123 Industrial Way', customer_id: 'customer-1' },
        expectedText: '123 Industrial Way',
      },
      {
        entityType: 'asset_category',
        entityData: { name: 'Excavators', default_rate_type: 'daily', default_rate_amount: '250', utilization_group: 'earthmoving' },
        expectedText: 'daily',
      },
      {
        entityType: 'asset',
        entityData: {
          name: 'Excavator 100',
          identifier: 'EQ-1001',
          asset_category_id: 'asset-category-1',
          branch_id: 'branch-1',
          status: 'available',
        },
        expectedText: 'EQ-1001',
      },
    ];

    for (const { entityType, entityData, expectedText } of cases) {
      useDataSourcesMock.mockReturnValue({
        data: {
          entity: {
            id: `${entityType}-1`,
            entity_type: entityType,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            entity_versions: [
              {
                id: `${entityType}-version-1`,
                version_number: 1,
                is_current: true,
                valid_from: '2026-01-01T00:00:00Z',
                data: entityData,
              },
            ],
          },
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: vi.fn(),
        refetchAll: vi.fn(),
      });

      const { unmount } = renderWithQueryClient(<EntityDetailScreen entityType={entityType} id={`${entityType}-1`} />);
      expect(screen.getByText(expectedText)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders distinct loading, error, and not-found states for entity detail pages', () => {
    useDataSourcesMock.mockReturnValue({
      data: { entity: null },
      isLoading: { entity: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const { unmount } = renderWithQueryClient(<EntityDetailScreen entityType="branch" id="branch-1" />);
    expect(screen.getByText('Loading branch details...')).toBeInTheDocument();
    expect(screen.queryByText('Branch not found')).not.toBeInTheDocument();
    unmount();

    useDataSourcesMock.mockReturnValue({
      data: { entity: null },
      isLoading: { entity: false },
      errors: { entity: new Error('request failed') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const rendered = renderWithQueryClient(<EntityDetailScreen entityType="branch" id="branch-1" />);
    expect(screen.getByText('Unable to load branch details')).toBeInTheDocument();
    expect(screen.getByText('request failed')).toBeInTheDocument();
    rendered.unmount();

    useDataSourcesMock.mockReturnValue({
      data: { entity: null },
      isLoading: { entity: false },
      errors: { entity: null },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="branch" id="branch-1" />);
    expect(screen.getByText('Branch not found')).toBeInTheDocument();
    expect(screen.getByText('The requested branch could not be located or may no longer exist.')).toBeInTheDocument();
  });

  it('shows portal dispatch context on requisition detail when handoff query params are present', () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, '', '/entities/requisition/req-1?source=portal_catalog&assetName=CAT%20320%20Excavator&jobSiteId=site-abc-123&startDate=2026-06-20&endDate=2026-06-22');
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'req-1',
          entity_type: 'requisition',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'req-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Portal requisition',
                asset_id: 'asset-1',
                job_site_id: 'site-abc-123',
              },
            },
          ],
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="requisition" id="req-1" />);
    expect(screen.getByTestId('portal-dispatch-context')).toBeInTheDocument();
    expect(screen.getByText(/CAT 320 Excavator/i)).toBeInTheDocument();
    expect(screen.getByText(/site-abc-123/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-06-20/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-06-22/i)).toBeInTheDocument();

    window.history.replaceState({}, '', originalUrl);
  });

  it('renders related context lookups for job sites and assets on detail screens', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'job-site-1',
          entity_type: 'job_site',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'job-site-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Riverfront Expansion',
                address: '123 Industrial Way',
                customer_id: 'customer-1',
              },
            },
          ],
        },
        customers: [
          { id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const { unmount } = renderWithQueryClient(<EntityDetailScreen entityType="job_site" id="job-site-1" />);
    expect(screen.getByText('Related Context')).toBeInTheDocument();
    expect(screen.getAllByText('Acme Construction')[0]).toBeInTheDocument();
    unmount();

    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-1',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'asset-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Excavator 100',
                identifier: 'EQ-1001',
                category_id: 'asset-category-1',
                branch_id: 'branch-1',
                status: 'available',
              },
            },
          ],
        },
        assetCategories: [
          { id: 'asset-category-1', entity_versions: [{ data: { name: 'Excavators' } }] },
        ],
        branches: [
          { id: 'branch-1', entity_versions: [{ data: { name: 'Houston Central' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-1" />);
    expect(screen.getByText('Excavators')).toBeInTheDocument();
    expect(screen.getByText('Houston Central')).toBeInTheDocument();
  });

  it('shows invoice billing context and warning on detail screen when billing exception is present', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'invoice-1',
          entity_type: 'invoice',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'invoice-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Invoice INV-001',
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                contract_id: 'contract-1',
                job_site_id: 'job-1',
                billing_exception_reason: 'Billing hold present: credit_review',
              },
            },
          ],
        },
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                data: {
                  contract_number: 'RC-001',
                },
              },
            ],
          },
        ],
        customers: [
          { id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        ],
        billingAccounts: [
          { id: 'billing-1', entity_versions: [{ data: { name: 'Acme Main Billing', account_number: 'BA-1001' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="invoice" id="invoice-1" />);

    expect(screen.getByText('Billing Context')).toBeInTheDocument();
    expect(screen.getByText(/Customer Acme Construction · Billing Account Acme Main Billing/)).toBeInTheDocument();
    expect(screen.getByText(/Contract RC-001/)).toBeInTheDocument();
    expect(screen.getByText(/Job Site job-1 · Exception Billing hold present: credit_review/)).toBeInTheDocument();
    expect(screen.getByText('Billing exception')).toBeInTheDocument();
    expect(screen.getByText('Billing hold present: credit_review')).toBeInTheDocument();
  });

  it('shows transfer coordination context and warning on detail screen when a transfer exception is present', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'transfer-1',
          entity_type: 'transfer',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'transfer-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'North to South Rebalance',
                status: 'approved',
                origin_branch_id: 'branch-1',
                destination_branch_id: 'branch-2',
                requested_ship_date: '2026-06-20',
                expected_receive_date: '2026-06-21',
                asset_scope: 'Excavator 100',
                internal_cost: '425.00',
                sourcing_decision_id: 'finding-1',
                transfer_exception_reason: 'Awaiting trailer slot confirmation',
              },
            },
          ],
        },
        branches: [
          { id: 'branch-1', entity_versions: [{ data: { name: 'North Yard' } }] },
          { id: 'branch-2', entity_versions: [{ data: { name: 'South Depot' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="transfer" id="transfer-1" />);

    expect(screen.getByText('Transfer Coordination')).toBeInTheDocument();
    expect(screen.getByText(/Origin North Yard · Destination South Depot · Scope Excavator 100 · Sourcing Decision finding-1/)).toBeInTheDocument();
    expect(screen.getByText(/Requested Ship 2026-06-20 · Expected Receive 2026-06-21 · Internal Cost 425.00 · Exception Awaiting trailer slot confirmation/)).toBeInTheDocument();
    expect(screen.getByText('Transfer exception')).toBeInTheDocument();
    expect(screen.getByText('Awaiting trailer slot confirmation')).toBeInTheDocument();
  });

  it('shows invoice billing context without warning when billing exception is absent', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'invoice-1',
          entity_type: 'invoice',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'invoice-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Invoice INV-001',
                customer_id: 'customer-1',
                billing_account_id: 'billing-1',
                contract_id: 'contract-1',
                job_site_id: 'job-1',
              },
            },
          ],
        },
        customers: [
          { id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        ],
        billingAccounts: [
          { id: 'billing-1', entity_versions: [{ data: { name: 'Acme Main Billing', account_number: 'BA-1001' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="invoice" id="invoice-1" />);

    expect(screen.getByText('Billing Context')).toBeInTheDocument();
    expect(screen.getByText(/Customer Acme Construction · Billing Account Acme Main Billing/)).toBeInTheDocument();
    expect(screen.getByText(/Job Site job-1 · Exception none/)).toBeInTheDocument();
    expect(screen.queryByText('Billing exception')).not.toBeInTheDocument();
  });

  it('does not show invoice-only billing exception UI on non-invoice detail screens', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-1',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'asset-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Excavator 100',
                identifier: 'EQ-1001',
                asset_category_id: 'asset-category-1',
                branch_id: 'branch-1',
                status: 'available',
                billing_exception_reason: 'should not render for non-invoice entities',
              },
            },
          ],
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-1" />);

    expect(screen.queryByText('Billing Context')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing exception')).not.toBeInTheDocument();
    expect(screen.queryByText('should not render for non-invoice entities')).not.toBeInTheDocument();
  });

  it('hides Edit and Delete buttons for read_only users', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Read Only User', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-1',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'asset-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: { name: 'Excavator 100', operational_status: 'available' },
            },
          ],
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-1" />);

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('hides New Entity button for read_only users', () => {
    authState.value = {
      profile: { id: 'user-ro', displayName: 'Read Only User', role: 'read_only' },
      session: { access_token: 'token' },
    };

    useDataSourcesMock.mockReturnValue({
      data: { entities: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityListScreen entityType="branch" />);

    expect(screen.queryByRole('button', { name: 'New Branch' })).not.toBeInTheDocument();
  });

  it('exits edit mode when the SCD2 version insert fails (onError guard)', async () => {
    // Force the insert to return a DB error so the onError path is exercised.
    insertMock.mockResolvedValueOnce({ error: new Error('unique constraint violation') });

    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'asset-1',
          entity_type: 'asset',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'asset-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: {
                name: 'Excavator 100',
                description: 'Legacy description',
                operational_status: 'available',
              },
            },
          ],
        },
        contracts: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<EntityDetailScreen entityType="asset" id="asset-1" />);

    // Enter edit mode.
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    // Trigger the save — the insert will fail.
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    // The onError handler in entity-detail.json must reset isEditing to false,
    // restoring the Edit button so the operator is not stranded.
    await waitFor(() => {
      expect(fromMock).toHaveBeenCalledWith('entity_versions');
      expect(insertMock).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument();
  });

  it('delete button on entity detail calls delete_entity RPC and navigates back to the list', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        entity: {
          id: 'branch-1',
          entity_type: 'branch',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          entity_versions: [
            {
              id: 'branch-version-1',
              version_number: 1,
              is_current: true,
              valid_from: '2026-01-01T00:00:00Z',
              data: { name: 'North Yard' },
            },
          ],
        },
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    rpcMock.mockResolvedValue({ data: null, error: null });

    renderWithQueryClient(<EntityDetailScreen entityType="branch" id="branch-1" />);

    // Open the confirmation dialog
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete Entity' })).toBeInTheDocument();

    // Confirm the deletion
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      // Must call the RPC — never the old direct table delete
      expect(rpcMock).toHaveBeenCalledWith('delete_entity', { p_entity_id: 'branch-1' });
      // Must not attempt a direct table-level delete
      expect(fromMock).not.toHaveBeenCalledWith('entities');
      // Must navigate back to the entity list
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/entities/branch', replace: true })
      );
    });
  });
});
