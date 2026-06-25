import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  navigateSpy,
  useDataSourcesMock,
  rpcMock,
  fromMock,
  authState,
} = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  useDataSourcesMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  authState: {
    value: {
      profile: { id: 'user-1', displayName: 'Branch Manager', role: 'branch_manager' },
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
import { RentalContractListScreen } from '@/routes/rental/contracts/index';
import { RentalContractDetailScreen } from '@/routes/rental/contracts/$id';

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

describe('rental contract list screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Branch Manager', role: 'branch_manager' },
      session: { access_token: 'token' },
    };

    rpcMock.mockResolvedValue({ error: null });
  });

  it('renders the rental contracts heading and empty state', () => {
    useDataSourcesMock.mockReturnValue({
      data: { contracts: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractListScreen />);

    expect(screen.getByRole('heading', { name: 'Rental Contracts' })).toBeInTheDocument();
    expect(screen.getByText('No contracts yet')).toBeInTheDocument();
  });

  it('lists existing contracts with contract number, status, rental type and order reference', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  status: 'active',
                  rental_type: 'external',
                  contract_number: 'RC-001',
                  order_id: 'order-1',
                },
              },
            ],
          },
          {
            id: 'contract-2',
            entity_versions: [
              {
                version_number: 2,
                data: {
                  status: 'pending_execution',
                  rental_type: 'internal',
                  order_id: 'order-2',
                },
              },
            ],
          },
        ],
        orders: [
          {
            id: 'order-1',
            entity_versions: [{ data: { order_number: 'ORD-2024-001', is_current: true }, is_current: true }],
          },
          {
            id: 'order-2',
            entity_versions: [{ data: { order_number: 'ORD-2024-002', is_current: true }, is_current: true }],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractListScreen />);

    expect(screen.getByText('RC-001')).toBeInTheDocument();
    expect(screen.getByText('Order: ORD-2024-001')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('external')).toBeInTheDocument();
    expect(screen.getByText('pending_execution')).toBeInTheDocument();
    expect(screen.getByText('internal')).toBeInTheDocument();
    expect(screen.getByText('Order: ORD-2024-002')).toBeInTheDocument();
  });

  it('shows "Draft Order" for contracts linked to an order with no order number', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  status: 'active',
                  rental_type: 'external',
                  contract_number: 'RC-001',
                  order_id: 'order-1',
                },
              },
            ],
          },
        ],
        orders: [
          {
            id: 'order-1',
            entity_versions: [{ data: { is_current: true }, is_current: true }],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractListScreen />);

    expect(screen.getByText('Order: Draft Order')).toBeInTheDocument();
  });

  it('shows "No linked order" for contracts with no order_id', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  status: 'active',
                  rental_type: 'external',
                  contract_number: 'RC-001',
                },
              },
            ],
          },
        ],
        orders: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractListScreen />);

    expect(screen.getByText('Order: No linked order')).toBeInTheDocument();
  });

  it('shows View action for each contract that navigates to the detail page', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                version_number: 1,
                data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
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

    renderWithQueryClient(<RentalContractListScreen />);

    const viewLink = screen.getByRole('link', { name: 'View' });
    expect(viewLink).toHaveAttribute('href', '/rental/contracts/contract-1');
  });

  it('surfaces the canonical open-contract conflict queue with drill-down links', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contracts: [
          {
            id: 'contract-1',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  status: 'active',
                  rental_type: 'external',
                  contract_number: 'RC-001',
                  order_id: 'order-1',
                  branch_id: 'branch-1',
                },
              },
            ],
          },
        ],
        orders: [
          {
            id: 'order-1',
            entity_versions: [{ data: { order_number: 'ORD-2024-001', is_current: true }, is_current: true }],
          },
        ],
        lines: [
          {
            entity_id: 'line-1',
            contract_id: 'contract-1',
            status: 'checked_out',
            category_id: 'cat-excavator',
            asset_id: 'asset-456',
            actual_end: null,
            data: { planned_end: '2026-06-11' },
          },
        ],
        availability: [],
        customerRequests: [
          {
            id: 'request-1',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  source: 'portal_schedule',
                  contract_id: 'contract-1',
                  contract_line_id: 'line-1',
                  request_type: 'contract_extension',
                  urgency: 'high',
                  reason: 'Need 5 more days',
                  recommended_disposition: 'Validate extension terms and branch availability, then approve or follow up manually with the customer.',
                  requested_at: '2026-06-10T08:00:00.000Z',
                },
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

    renderWithQueryClient(<RentalContractListScreen />);

    expect(screen.getByRole('heading', { name: 'Branch open-contract conflict queue' })).toBeInTheDocument();
    expect(screen.getAllByText('Extension review for RC-001').length).toBeGreaterThan(0);
    expect(screen.getByText(/verify branch availability manually before discussing any extension/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Order order-1' })).toHaveAttribute('href', '/rental/orders/order-1');
    expect(screen.getAllByRole('link', { name: 'Contract contract-1' })[0]).toHaveAttribute('href', '/rental/contracts/contract-1');
    expect(screen.getByRole('heading', { name: 'Customer request assist queue' })).toBeInTheDocument();
    expect(screen.getAllByText('Extension review for RC-001').length).toBeGreaterThan(0);
    expect(screen.getByText(/customer portal request requires branch review/i)).toBeInTheDocument();
  });
});

describe('rental contract detail screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    useDataSourcesMock.mockReset();
    sessionStorage.clear();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Branch Manager', role: 'branch_manager' },
      session: { access_token: 'token' },
    };

    rpcMock.mockResolvedValue({ error: null });
  });

  it('renders contract header with back link, contract number and lifecycle status', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-1',
              },
            },
          ],
        },
        lines: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByText('← Back to Contracts')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'RC-001' })).toBeInTheDocument();
    expect(screen.getAllByText('active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('external').length).toBeGreaterThan(0);
  });

  it('shows the contract lifecycle breadcrumb with all stages', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'pending_execution', rental_type: 'external', contract_number: 'RC-002', order_id: 'order-2' },
            },
          ],
        },
        lines: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByText('1. Pending Execution')).toBeInTheDocument();
    expect(screen.getByText('2. Active')).toBeInTheDocument();
    expect(screen.getByText('3. Closed')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('shows contract information fields', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-abc',
              },
            },
          ],
        },
        lines: [],
        orders: [
          {
            id: 'order-abc',
            entity_versions: [{ data: { order_number: 'ORD-2026-0001' }, is_current: true }],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getAllByText('RC-001').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'ORD-2026-0001' })).toHaveAttribute('href', '/rental/orders/order-abc');
  });

  it('lists contract lines with status, asset, category, and checkout dates', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_id: 'ver-line-1',
            version_number: 2,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-excavator',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'weekly',
            rate_amount: 50000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: { planned_end: '2026-07-10' },
          },
          {
            entity_id: 'line-2',
            version_id: 'ver-line-2',
            version_number: 3,
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-forklift',
            category_id: 'cat-forklift',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-05',
            actual_end: '2026-06-20',
            data: {},
          },
        ],
        contractInvoices: [
          {
            id: 'invoice-1',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByText(/asset-excavator/)).toBeInTheDocument();
    expect(screen.getByText('checked_out')).toBeInTheDocument();
    expect(screen.getByText('Checked out: 2026-06-10')).toBeInTheDocument();
    expect(screen.getByText('Planned return: 2026-07-10')).toBeInTheDocument();
    expect(screen.getByText(/asset-forklift/)).toBeInTheDocument();
    expect(screen.getByText('returned')).toBeInTheDocument();
    expect(screen.getByText('Returned: 2026-06-20')).toBeInTheDocument();
    expect(screen.getByText(/Invoice status:/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View invoices for this contract' }));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/entities/invoice/invoice-1' })
      );
    });
  });

  it('falls back to invoice list CTA when no contract-scoped invoice exists yet', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-2',
            version_id: 'ver-line-2',
            version_number: 3,
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-forklift',
            category_id: 'cat-forklift',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-05',
            actual_end: '2026-06-20',
            data: {},
          },
        ],
        contractInvoices: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'View invoices for this contract' }));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/entities/invoice?contractId=contract-1' })
      );
    });
  });

  it('uses relationship-backed invoice CTA when invoice entities are not contract-linked yet', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-2',
            version_id: 'ver-line-2',
            version_number: 3,
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-forklift',
            category_id: 'cat-forklift',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-05',
            actual_end: '2026-06-20',
            data: {},
          },
        ],
        contractInvoices: [],
        contractInvoiceRelationships: [
          {
            parent_id: 'invoice-rel-1',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'View invoices for this contract' }));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/entities/invoice/invoice-rel-1' })
      );
    });
  });

  it('falls back to the contract-scoped invoice list when invoice ids are missing', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-2',
            version_id: 'ver-line-2',
            version_number: 3,
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-forklift',
            category_id: 'cat-forklift',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-05',
            actual_end: '2026-06-20',
            data: {},
          },
        ],
        contractInvoices: [{ id: null }],
        contractInvoiceRelationships: [{ parent_id: null }],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'View invoices for this contract' }));
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/entities/invoice?contractId=contract-1' })
      );
    });
  });

  it('shows empty state when no contract lines exist', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'pending_execution', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByText('No contract lines found for this contract.')).toBeInTheDocument();
  });

  it('checks out a contract line via the checkout modal', async () => {
    const refetchMock = vi.fn();

    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Check Out Line' }));

    await userEvent.type(screen.getByLabelText('Contract Line ID'), 'line-1');
    await userEvent.type(screen.getByLabelText('Asset ID'), 'asset-123');
    await userEvent.type(screen.getByLabelText('Actual Start Date'), '2026-06-15');

    await userEvent.click(screen.getByRole('button', { name: 'Confirm Checkout' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'checked_out',
            asset_id: 'asset-123',
            actual_start: '2026-06-15',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('lines');
    });
  });

  it('returns a contract line via the return modal', async () => {
    const refetchMock = vi.fn();

    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-15',
            actual_end: null,
            data: { planned_end: '2026-07-01' },
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Return Line' }));

    await userEvent.type(screen.getByLabelText('Contract Line ID'), 'line-1');
    await userEvent.type(screen.getByLabelText('Actual End Date'), '2026-06-30');

    await userEvent.click(screen.getByRole('button', { name: 'Confirm Return' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'returned',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-15',
            actual_end: '2026-06-30',
            data: { planned_end: '2026-07-01' },
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('lines');
    });
    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('contractInvoices');
    });
    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('contractInvoiceRelationships');
    });
  });

  it('exposes a row-level Check Out button on a pending line and prefills the modal', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'pending_execution', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'pending_execution',
            contract_id: 'contract-1',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: null,
            actual_end: null,
            data: { planned_end: '2026-07-15' },
          },
        ],
        contractInvoices: [],
        contractInvoiceRelationships: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    // Row-level "Check Out" button should be visible on the pending line
    const checkOutButton = screen.getByRole('button', { name: 'Check Out' });
    expect(checkOutButton).toBeInTheDocument();

    await userEvent.click(checkOutButton);

    // Modal opens with line ID and asset ID already populated
    await waitFor(() => {
      expect(screen.getByLabelText('Contract Line ID')).toHaveValue('line-1');
    });
    expect(screen.getByLabelText('Asset ID')).toHaveValue('asset-123');

    // Modal shows human-readable context (scoped inside the dialog to avoid
    // matching the same text already present in the line card)
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Contract:\s*RC-001/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Status:\s*pending_execution/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Planned return:\s*2026-07-15/)).toBeInTheDocument();
  });

  it('restores selected checkout handoff context after a reload', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'pending_execution', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'pending_execution',
            contract_id: 'contract-1',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: null,
            actual_end: null,
            data: { planned_end: '2026-07-15' },
          },
        ],
        contractInvoices: [],
        contractInvoiceRelationships: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const firstRender = renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Check Out' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contract Line ID')).toHaveValue('line-1');
    });
    await userEvent.type(screen.getByLabelText('Actual Start Date'), '2026-07-05');

    firstRender.unmount();
    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const reloadedWorkflow = await screen.findByRole('dialog');
    expect(within(reloadedWorkflow).getByLabelText('Contract Line ID')).toHaveValue('line-1');
    expect(within(reloadedWorkflow).getByLabelText('Asset ID')).toHaveValue('asset-123');
    expect(within(reloadedWorkflow).getByLabelText('Actual Start Date')).toHaveValue('2026-07-05');
    expect(within(reloadedWorkflow).getByText(/Contract:\s*RC-001/)).toBeInTheDocument();
  });

  it('shows an explicit no-op assistant state when no materially new contract conflict exists', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1', branch_id: 'branch-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: { planned_end: '2099-07-15' },
          },
        ],
        availability: [],
        contractInvoices: [],
        contractInvoiceRelationships: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByRole('heading', { name: 'Booking & extension conflict assistant' })).toBeInTheDocument();
    expect(screen.getByText('No materially new branch conflict')).toBeInTheDocument();
    expect(screen.getByText(/does not currently show a materially new delivery-window, return, or extension conflict/i)).toBeInTheDocument();
  });

  it('exposes a row-level Return button on a checked-out line and prefills the modal', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-456',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: {},
          },
        ],
        contractInvoices: [],
        contractInvoiceRelationships: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    // Row-level "Return" button should be visible on the checked-out line
    const returnButton = screen.getByRole('button', { name: 'Return' });
    expect(returnButton).toBeInTheDocument();

    await userEvent.click(returnButton);

    // Modal opens with line ID already populated
    await waitFor(() => {
      expect(screen.getByLabelText('Contract Line ID')).toHaveValue('line-1');
    });

    // Modal shows human-readable context (scoped inside the dialog)
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Contract:\s*RC-001/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Asset:\s*asset-456/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Status:\s*checked_out/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Checked out:\s*2026-06-10/)).toBeInTheDocument();
  });

  it('restores selected return handoff context after a reload', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-456',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: {},
          },
        ],
        contractInvoices: [],
        contractInvoiceRelationships: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const firstRender = renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Return' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contract Line ID')).toHaveValue('line-1');
    });
    await userEvent.type(screen.getByLabelText('Actual End Date'), '2026-07-07');

    firstRender.unmount();
    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const reloadedWorkflow = await screen.findByRole('dialog');
    expect(within(reloadedWorkflow).getByLabelText('Contract Line ID')).toHaveValue('line-1');
    expect(within(reloadedWorkflow).getByLabelText('Actual End Date')).toHaveValue('2026-07-07');
    expect(within(reloadedWorkflow).getByText(/Contract:\s*RC-001/)).toBeInTheDocument();
    expect(within(reloadedWorkflow).getByText(/Asset:\s*asset-456/)).toBeInTheDocument();
  });

  it('persists return -> returned-state invoice handoff after a reload', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-456',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: { planned_end: '2026-06-11' },
          },
        ],
        contractInvoices: [{ id: null }],
        contractInvoiceRelationships: [{ parent_id: null }],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const firstRender = renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Return' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contract Line ID')).toHaveValue('line-1');
    });
    await userEvent.type(screen.getByLabelText('Actual End Date'), '2026-06-11');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Return' }));
    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_contract_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            status: 'returned',
            actual_end: '2026-06-11',
          }),
        })
      );
    });

    firstRender.unmount();
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 2,
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-456',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-10',
            actual_end: '2026-06-11',
            data: { planned_end: '2026-06-11' },
          },
        ],
        contractInvoices: [{ id: null }],
        contractInvoiceRelationships: [{ parent_id: null }],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });
    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const reloadedInvoiceButton = await screen.findByRole('button', { name: 'View invoices for this contract' });
    expect(reloadedInvoiceButton).toBeEnabled();
    await userEvent.click(reloadedInvoiceButton);
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/entities/invoice?contractId=contract-1' })
      );
    });
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('returned')).toBeInTheDocument();
  });

  it('uses the same human-readable contract fallback in handoff modals as the detail heading', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-456',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: {},
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Rental Contract');

    await userEvent.click(screen.getByRole('button', { name: 'Return' }));
    expect(within(screen.getByRole('dialog')).getByText(/Contract:\s*Rental Contract/)).toBeInTheDocument();
  });

  it('does not show a Check Out button on already checked-out or returned lines', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'active', rental_type: 'external', contract_number: 'RC-001', order_id: 'order-1' },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-111',
            category_id: 'cat-1',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 1000,
            actual_start: '2026-06-01',
            actual_end: null,
            data: {},
          },
          {
            entity_id: 'line-2',
            version_number: 1,
            status: 'returned',
            contract_id: 'contract-1',
            asset_id: 'asset-222',
            category_id: 'cat-2',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 1000,
            actual_start: '2026-06-01',
            actual_end: '2026-06-20',
            data: {},
          },
        ],
        contractInvoices: [],
        contractInvoiceRelationships: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    // No "Check Out" row button should appear for checked-out or returned lines
    expect(screen.queryByRole('button', { name: 'Check Out' })).not.toBeInTheDocument();
    // The Return button should appear only for the checked-out line, not the returned one
    expect(screen.getAllByRole('button', { name: 'Return' })).toHaveLength(1);
  });

  it('shows customer name and job site name instead of raw IDs in contract information', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-1',
                customer_id: 'cust-abc',
                job_site_id: 'site-xyz',
              },
            },
          ],
        },
        lines: [],
        customers: [
          { entity_id: 'cust-abc', name: 'Acme Construction' },
        ],
        job_sites: [
          {
            id: 'site-xyz',
            source_record_id: 'JS-001',
            entity_versions: [{ data: { name: 'Riverside Project' }, is_current: true }],
          },
        ],
        asset_categories: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    expect(screen.getByText('Riverside Project')).toBeInTheDocument();
    expect(screen.queryByText('cust-abc')).not.toBeInTheDocument();
    expect(screen.queryByText('site-xyz')).not.toBeInTheDocument();
  });

  it('shows category name instead of raw category ID in contract line rows', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-1',
              },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'pending_execution',
            contract_id: 'contract-1',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: null,
            actual_end: null,
            data: {},
          },
        ],
        customers: [],
        job_sites: [],
        asset_categories: [
          { asset_category_id: 'cat-excavator', asset_category_name: 'Excavator' },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    expect(screen.getByText('Excavator')).toBeInTheDocument();
    expect(screen.getByText(/Asset:\s*asset-123/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /cat-excavator/ })).not.toBeInTheDocument();
  });

  it('keeps line-id targeting scoped to a single detail card and omits asset text for unassigned lines', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-1',
              },
            },
          ],
        },
        lines: [
          {
            entity_id: 'line-1',
            version_number: 1,
            status: 'pending_execution',
            contract_id: 'contract-1',
            asset_id: null,
            category_id: 'cat-excavator',
            rental_type: 'external',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: null,
            actual_end: null,
            data: {},
          },
          {
            entity_id: 'line-2',
            version_number: 1,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-456',
            category_id: 'cat-bulldozer',
            rental_type: 'external',
            rate_type: 'weekly',
            rate_amount: 12000,
            actual_start: '2026-06-10',
            actual_end: null,
            data: {},
          },
        ],
        customers: [],
        job_sites: [],
        asset_categories: [
          { asset_category_id: 'cat-excavator', asset_category_name: 'Excavator' },
          { asset_category_id: 'cat-bulldozer', asset_category_name: 'Bulldozer' },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const firstLineLabel = screen.getByText('Line ID: line-1');
    const firstLineCard = firstLineLabel.parentElement?.parentElement as HTMLElement | null;

    expect(firstLineCard).not.toBeNull();
    expect(firstLineCard).toHaveTextContent('Line ID: line-1');
    expect(firstLineCard).not.toHaveTextContent('Line ID: line-2');
    expect(within(firstLineCard as HTMLElement).getByRole('button', { name: 'Check Out' })).toBeInTheDocument();
    expect(within(firstLineCard as HTMLElement).queryByText(/Asset:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Asset:\s*asset-456/)).toBeInTheDocument();
  });

  it('source order uses order number text while linking to the order detail page', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-abc',
              },
            },
          ],
        },
        lines: [],
        orders: [
          {
            id: 'order-abc',
            entity_versions: [{ data: { order_number: 'ORD-2026-0042' }, is_current: true }],
          },
        ],
        customers: [],
        job_sites: [],
        asset_categories: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const orderLink = screen.getByRole('link', { name: 'ORD-2026-0042' });
    expect(orderLink).toBeInTheDocument();
    expect(orderLink).toHaveAttribute('href', '/rental/orders/order-abc');
  });

  it('source order uses requester fallback text when order number is unavailable', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-abc',
              },
            },
          ],
        },
        lines: [],
        orders: [
          {
            id: 'order-abc',
            entity_versions: [{ data: { requester_name: 'Dana Ops' }, is_current: true }],
          },
        ],
        customers: [],
        job_sites: [],
        asset_categories: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const orderLink = screen.getByRole('link', { name: 'Dana Ops' });
    expect(orderLink).toBeInTheDocument();
    expect(orderLink).toHaveAttribute('href', '/rental/orders/order-abc');
  });

  it('source order falls back to Draft Order instead of a raw order ID', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        contract: {
          id: 'contract-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_contract',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'active',
                rental_type: 'external',
                contract_number: 'RC-001',
                order_id: 'order-abc',
              },
            },
          ],
        },
        lines: [],
        orders: [
          {
            id: 'order-abc',
            entity_versions: [{ data: {}, is_current: true }],
          },
        ],
        customers: [],
        job_sites: [],
        asset_categories: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalContractDetailScreen id="contract-1" />);

    const orderLink = screen.getByRole('link', { name: 'Draft Order' });
    expect(orderLink).toBeInTheDocument();
    expect(orderLink).toHaveAttribute('href', '/rental/orders/order-abc');
    expect(screen.queryByRole('link', { name: 'order-abc' })).not.toBeInTheDocument();
  });
});
