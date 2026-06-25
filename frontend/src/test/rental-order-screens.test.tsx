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
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    },
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a {...props}>{children}</a>
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
import { RentalOrderListPage, RentalOrderListScreen, Route } from '@/routes/rental/orders/index';
import { RentalOrderDetailScreen } from '@/routes/rental/orders/$id';
import rentalOrderListPage from '@/pages/rental-order-list.json';

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

describe('rental order list screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    };

    rpcMock.mockResolvedValue({ error: null });
  });

  it('renders the rental orders heading and empty state', () => {
    useDataSourcesMock.mockReturnValue({
      data: { orders: [], availability: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderListScreen />);

    expect(screen.getByRole('heading', { name: 'Rental Orders' })).toBeInTheDocument();
    expect(screen.getByText('Order')).toBeInTheDocument();
    expect(screen.getByText('Status / Requester')).toBeInTheDocument();
    expect(screen.getByText('No orders yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Rental Order' })).toBeInTheDocument();
  });

  it('keeps New Rental Order visible for read-only users and surfaces write-permission errors', async () => {
    authState.value = {
      profile: { id: 'user-readonly', displayName: 'Read Only User', role: 'read_only' },
      session: { access_token: 'token' },
    };
    rpcMock.mockResolvedValueOnce({ error: { message: 'permission denied' } });
    useDataSourcesMock.mockReturnValue({
      data: { orders: [], availability: [], requesters: [], asset_categories: [], job_sites: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderListScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));
    await userEvent.type(screen.getByLabelText('Storefront Customer Email'), 'readonly@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create Order' }));

    await waitFor(() => {
      expect(screen.getByText('Order creation blocked')).toBeInTheDocument();
    });
    expect(screen.getByText(/unable to create storefront customer record/i)).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(
      'rental_upsert_entity_current_state',
      expect.objectContaining({
        p_entity_type: 'customer',
        p_source_record_id: 'readonly@example.com',
      })
    );
    expect(screen.getByRole('button', { name: 'Create Order' })).toBeInTheDocument();
  });

  it('does not create a rental order when storefront customer upsert fails', async () => {
    rpcMock.mockResolvedValueOnce({ error: { message: 'permission denied' } });
    useDataSourcesMock.mockReturnValue({
      data: { orders: [], availability: [], requesters: [], asset_categories: [], job_sites: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderListScreen />);
    await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));
    await userEvent.type(screen.getByLabelText('Storefront Customer Email'), 'storefront.failure@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create Order' }));

    await waitFor(() => {
      expect(screen.getByText(/unable to create storefront customer record/i)).toBeInTheDocument();
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).not.toHaveBeenCalledWith('create_entity_with_version', expect.anything());
    expect(screen.getByRole('button', { name: 'Create Order' })).toBeInTheDocument();
  });

  it('consumes branch/category search handoff and opens the workflow with scoped context', async () => {
    const availabilityRows = [
      {
        branch_id: 'branch-2',
        branch_name: 'South Depot',
        asset_category_id: 'cat-7',
        asset_category_name: 'Skid Steers',
        total_assets: 4,
        available_assets: 2,
      },
      {
        branch_id: 'branch-9',
        branch_name: 'West Yard',
        asset_category_id: 'cat-3',
        asset_category_name: 'Boom Lifts',
        total_assets: 8,
        available_assets: 6,
      },
    ];

    useDataSourcesMock.mockImplementation((sourceConfig: { availability?: { filters?: { field: string; op: string; value: string }[] } }) => {
      const filters = sourceConfig?.availability?.filters || [];
      const branchFilter = filters.find((filter) => filter.field === 'branch_id')?.value;
      const categoryFilter = filters.find((filter) => filter.field === 'asset_category_id')?.value;
      const filteredAvailability = availabilityRows.filter((row) => {
        const branchMatches = branchFilter ? row.branch_id === branchFilter : true;
        const categoryMatches = categoryFilter ? row.asset_category_id === categoryFilter : true;
        return branchMatches && categoryMatches;
      });

      return {
        data: {
          orders: [],
          availability: filteredAvailability,
          requesters: [],
          asset_categories: [
            {
              source_record_id: 'cat-7',
              entity_versions: [{ data: { name: 'Skid Steers' } }],
            },
          ],
          job_sites: [],
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: vi.fn(),
        refetchAll: vi.fn(),
      };
    });

    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({
      branch_id: 'branch-2',
      category_id: 'cat-7',
    });

    try {
      renderWithQueryClient(<RentalOrderListPage />);

      expect(screen.getByText('South Depot — Skid Steers')).toBeInTheDocument();
      expect(screen.queryByText('West Yard — Boom Lifts')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));
      expect(
        screen.getByText('Scoped from availability: Branch South Depot · Category Skid Steers')
      ).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Asset Category' })).toHaveTextContent('Skid Steers');
    } finally {
      useSearchSpy.mockRestore();
    }
  });

  it('shows Any for missing scope dimensions in the downstream workflow context', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        orders: [],
        availability: [
          {
            branch_id: 'branch-2',
            branch_name: 'South Depot',
            asset_category_id: 'cat-7',
            asset_category_name: 'Skid Steers',
            total_assets: 4,
            available_assets: 2,
          },
        ],
        requesters: [],
        asset_categories: [],
        job_sites: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({
      branch_id: 'branch-2',
      category_id: undefined,
    });

    try {
      renderWithQueryClient(<RentalOrderListPage />);
      await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));

      expect(
        screen.getByText('Scoped from availability: Branch South Depot · Category Any')
      ).toBeInTheDocument();
    } finally {
      useSearchSpy.mockRestore();
    }
  });

  it('lists existing rental orders with operator-readable requester, job site, and rental window context', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        orders: [
          {
            id: 'order-1',
            entity_versions: [
              {
                version_number: 1,
                data: {
                  status: 'draft',
                  rental_type: 'external',
                  requester_id: 'user-42',
                  order_number: 'RO-001',
                  lines: [
                    {
                      job_site_id: 'site-downtown',
                      planned_start: '2026-07-01',
                      planned_end: '2026-07-14',
                    },
                  ],
                },
              },
            ],
          },
          {
            id: 'order-2',
            entity_versions: [
              {
                version_number: 2,
                data: {
                  status: 'approved',
                  rental_type: 'internal',
                  requester_id: 'user-99',
                  lines: [
                    {
                      job_site_id: 'site-midtown',
                      planned_start: '2026-07-15',
                      planned_end: '2026-07-31',
                    },
                  ],
                },
              },
            ],
          },
        ],
        requesters: [
          { source_record_id: 'user-42', entity_versions: [{ data: { name: 'Acme Construction' } }] },
          { source_record_id: 'user-99', entity_versions: [{ data: { name: 'BuildRight Partners' } }] },
        ],
        job_sites: [
          { source_record_id: 'site-downtown', entity_versions: [{ data: { name: 'Downtown Tower' } }] },
          { source_record_id: 'site-midtown', entity_versions: [{ data: { name: 'Midtown Station' } }] },
        ],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderListScreen />);

    expect(screen.getByText('RO-001')).toBeInTheDocument();
    expect(screen.getByText('Draft Order')).toBeInTheDocument();
    expect(screen.getByText('Requester: Acme Construction')).toBeInTheDocument();
    expect(screen.getByText('Requester: BuildRight Partners')).toBeInTheDocument();
    expect(screen.getByText('Job Site: Downtown Tower · Rental Window: 2026-07-01 → 2026-07-14')).toBeInTheDocument();
    expect(screen.getByText('Job Site: Midtown Station · Rental Window: 2026-07-15 → 2026-07-31')).toBeInTheDocument();
    expect(screen.queryByText(/Requester: user-/)).not.toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('external')).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it('renders distinct loading and error states for rental orders', () => {
    useDataSourcesMock.mockReturnValue({
      data: { orders: [], availability: [] },
      isLoading: { orders: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    const { unmount } = renderWithQueryClient(<RentalOrderListScreen />);
    expect(screen.getByText('Loading rental orders...')).toBeInTheDocument();
    expect(screen.queryByText('No orders yet')).not.toBeInTheDocument();
    unmount();

    useDataSourcesMock.mockReturnValue({
      data: { orders: [], availability: [] },
      isLoading: { orders: false },
      errors: { orders: new Error('backend unavailable') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderListScreen />);
    expect(screen.getByText('Unable to load rental orders')).toBeInTheDocument();
    expect(screen.getByText('backend unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No orders yet')).not.toBeInTheDocument();
  });

  it('shows availability panel with branch and category data', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        orders: [],
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'North Yard',
            asset_category_id: 'cat-1',
            asset_category_name: 'Excavators',
            total_assets: 10,
            available_assets: 7,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderListScreen />);

    expect(screen.getByText('North Yard — Excavators')).toBeInTheDocument();
    expect(screen.getByText('7 available')).toBeInTheDocument();
    expect(screen.getByText('of 10 total')).toBeInTheDocument();
  });

  it('creates a rental order with one line via the create modal', async () => {
    const refetchMock = vi.fn();
    const originalState = { ...(rentalOrderListPage.state as Record<string, unknown>) };

    Object.assign(rentalOrderListPage.state, {
      newOrder_scope_branch_id: 'branch-1',
      newOrder_requester_id: 'user-42',
      newOrder_line_category_id: 'cat-excavator',
      newOrder_line_job_site_id: 'site-downtown',
    });

    try {
      useDataSourcesMock.mockReturnValue({
        data: {
          orders: [],
          availability: [],
          requesters: [
            {
              source_record_id: 'user-42',
              entity_versions: [{ data: { name: 'Acme Construction' } }],
            },
          ],
          asset_categories: [
            {
              source_record_id: 'cat-excavator',
              entity_versions: [{ data: { name: 'Excavators' } }],
            },
          ],
          job_sites: [
            {
              source_record_id: 'site-downtown',
              entity_versions: [{ data: { name: 'Downtown Tower' } }],
            },
          ],
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: refetchMock,
        refetchAll: vi.fn(),
      });

      renderWithQueryClient(<RentalOrderListScreen />);

      await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));

      expect(screen.getByLabelText('Requester / Customer')).toBeInTheDocument();
      expect(screen.getByLabelText('Asset Category')).toBeInTheDocument();
      expect(screen.getByLabelText('Job Site')).toBeInTheDocument();
      expect(screen.getByLabelText('Dispatch Contact')).toBeInTheDocument();
      expect(screen.getByLabelText('Dispatch Phone')).toBeInTheDocument();
      expect(screen.getByLabelText('Dispatch Notes')).toBeInTheDocument();
      expect(screen.queryByLabelText('Requester ID')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Asset Category ID')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Job Site ID')).not.toBeInTheDocument();

      await userEvent.type(screen.getByLabelText('Notes'), 'Urgent order for downtown project');
      await userEvent.type(screen.getByLabelText('Quantity'), '2');
      await userEvent.type(screen.getByLabelText('Planned Start'), '2026-07-01');
      await userEvent.type(screen.getByLabelText('Planned End'), '2026-07-14');
      await userEvent.type(screen.getByLabelText('Dispatch Contact'), 'Jordan Foreman');
      await userEvent.type(screen.getByLabelText('Dispatch Phone'), '555-0100');
      await userEvent.type(screen.getByLabelText('Dispatch Notes'), 'Use gate 2, call 30 minutes before arrival.');

      await userEvent.click(screen.getByRole('button', { name: 'Create Order' }));

      await waitFor(() => {
        expect(rpcMock).toHaveBeenCalledWith(
          'create_entity_with_version',
          expect.objectContaining({
            p_entity_type: 'rental_order',
            p_data: expect.objectContaining({
              branch_id: 'branch-1',
              status: 'draft',
              requester_id: 'user-42',
              notes: 'Urgent order for downtown project',
              lines: [
                expect.objectContaining({
                  branch_id: 'branch-1',
                  category_id: 'cat-excavator',
                  job_site_id: 'site-downtown',
                  dispatch_contact: 'Jordan Foreman',
                  dispatch_phone: '555-0100',
                  dispatch_notes: 'Use gate 2, call 30 minutes before arrival.',
                }),
              ],
            }),
          })
        );
      });

      await waitFor(() => {
        expect(refetchMock).toHaveBeenCalledWith('orders');
      });
    } finally {
      Object.assign(rentalOrderListPage.state, originalState);
    }
  });

  it('creates a storefront customer and quoted order when checkout uses customer email', async () => {
    const refetchMock = vi.fn();
    const originalState = { ...(rentalOrderListPage.state as Record<string, unknown>) };

    Object.assign(rentalOrderListPage.state, {
      newOrder_requester_id: '',
      newOrder_customer_name: 'Storefront Customer',
      newOrder_customer_email: 'storefront.customer@example.com',
      newOrder_line_category_id: 'cat-excavator',
      newOrder_line_job_site_id: 'site-downtown',
    });

    try {
      useDataSourcesMock.mockReturnValue({
        data: {
          orders: [],
          availability: [],
          requesters: [],
          asset_categories: [
            {
              source_record_id: 'cat-excavator',
              entity_versions: [{ data: { name: 'Excavators' } }],
            },
          ],
          job_sites: [
            {
              source_record_id: 'site-downtown',
              entity_versions: [{ data: { name: 'Downtown Tower' } }],
            },
          ],
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: refetchMock,
        refetchAll: vi.fn(),
      });

      renderWithQueryClient(<RentalOrderListScreen />);

      await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));
      await userEvent.type(screen.getByLabelText('Quantity'), '1');
      await userEvent.type(screen.getByLabelText('Planned Start'), '2026-07-01');
      await userEvent.type(screen.getByLabelText('Planned End'), '2026-07-14');
      await userEvent.click(screen.getByRole('button', { name: 'Create Order' }));

      await waitFor(() => {
        expect(rpcMock).toHaveBeenNthCalledWith(
          1,
          'rental_upsert_entity_current_state',
          expect.objectContaining({
            p_entity_type: 'customer',
            p_source_record_id: 'storefront.customer@example.com',
            p_data: expect.objectContaining({
              name: 'Storefront Customer',
              email: 'storefront.customer@example.com',
            }),
          })
        );
      });

      await waitFor(() => {
        expect(rpcMock).toHaveBeenNthCalledWith(
          2,
          'create_entity_with_version',
          expect.objectContaining({
            p_entity_type: 'rental_order',
            p_data: expect.objectContaining({
              status: 'quoted',
              requester_id: 'storefront.customer@example.com',
            }),
          })
        );
      });

      await waitFor(() => {
        expect(refetchMock).toHaveBeenCalledWith('orders');
      });
    } finally {
      Object.assign(rentalOrderListPage.state, originalState);
    }
  });

  it('falls back to storefront customer email when name is omitted', async () => {
    const originalState = { ...(rentalOrderListPage.state as Record<string, unknown>) };

    Object.assign(rentalOrderListPage.state, {
      newOrder_requester_id: '',
      newOrder_customer_name: '',
      newOrder_customer_email: 'fallback@example.com',
      newOrder_line_category_id: 'cat-excavator',
      newOrder_line_job_site_id: 'site-downtown',
    });

    try {
      useDataSourcesMock.mockReturnValue({
        data: {
          orders: [],
          availability: [],
          requesters: [],
          asset_categories: [
            {
              source_record_id: 'cat-excavator',
              entity_versions: [{ data: { name: 'Excavators' } }],
            },
          ],
          job_sites: [
            {
              source_record_id: 'site-downtown',
              entity_versions: [{ data: { name: 'Downtown Tower' } }],
            },
          ],
        },
        isLoading: {},
        errors: {},
        isPageLoading: false,
        refetch: vi.fn(),
        refetchAll: vi.fn(),
      });

      renderWithQueryClient(<RentalOrderListScreen />);

      await userEvent.click(screen.getByRole('button', { name: 'New Rental Order' }));
      await userEvent.type(screen.getByLabelText('Quantity'), '1');
      await userEvent.type(screen.getByLabelText('Planned Start'), '2026-07-01');
      await userEvent.type(screen.getByLabelText('Planned End'), '2026-07-14');
      await userEvent.click(screen.getByRole('button', { name: 'Create Order' }));

      await waitFor(() => {
        expect(rpcMock).toHaveBeenNthCalledWith(
          1,
          'rental_upsert_entity_current_state',
          expect.objectContaining({
            p_data: expect.objectContaining({
              name: 'fallback@example.com',
              email: 'fallback@example.com',
            }),
          })
        );
      });
    } finally {
      Object.assign(rentalOrderListPage.state, originalState);
    }
  });
});

describe('rental order detail screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    useDataSourcesMock.mockReset();
    authState.value = {
      profile: { id: 'user-1', displayName: 'Admin User', role: 'admin' },
      session: { access_token: 'token' },
    };

    rpcMock.mockResolvedValue({ error: null });
  });

  it('renders order header with status lifecycle', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'approved',
                rental_type: 'external',
                requester_id: 'user-42',
                notes: 'Equipment for downtown project',
                lines: [],
              },
            },
          ],
        },
        lines: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('← Back to Rental Orders')).toBeInTheDocument();
    expect(screen.getByText('user-42')).toBeInTheDocument();
    expect(screen.getAllByText('approved').length).toBeGreaterThan(0);
    expect(screen.getAllByText('external').length).toBeGreaterThan(0);
    expect(screen.getByText('Equipment for downtown project')).toBeInTheDocument();

    // Lifecycle steps
    expect(screen.getByText('1. Draft')).toBeInTheDocument();
    expect(screen.getByText('2. Quoted')).toBeInTheDocument();
    expect(screen.getByText('3. Approved')).toBeInTheDocument();
    expect(screen.getByText('4. Converted')).toBeInTheDocument();
  });

  it('shows order lines embedded in entity data', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                branch_id: 'branch-1',
                status: 'draft',
                rental_type: 'external',
                requester_id: 'user-42',
                notes: '',
                lines: [
                  {
                    branch_id: 'branch-1',
                    category_id: 'cat-excavator',
                    quantity: 2,
                    planned_start: '2026-07-01',
                    planned_end: '2026-07-14',
                    job_site_id: 'site-downtown',
                    rate_type: 'weekly',
                    status: 'pending',
                  },
                ],
              },
            },
          ],
        },
        lines: [],
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'South Depot',
            asset_category_id: 'cat-excavator',
            asset_category_name: 'Excavators',
            total_assets: 5,
            available_assets: 3,
            unavailable_assets: 2,
            maintenance_due_assets: 0,
            maintenance_overdue_assets: 0,
          },
        ],
        job_sites: [
          { source_record_id: 'site-downtown', entity_versions: [{ data: { name: 'Downtown Tower' } }] },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('Qty: 2 · 2026-07-01 to 2026-07-14')).toBeInTheDocument();
    expect(screen.getByText('Scope: Branch South Depot · Category Excavators')).toBeInTheDocument();
    expect(screen.getByText('Job Site: Downtown Tower · Rate: weekly')).toBeInTheDocument();
    expect(screen.queryByText(/^cat-excavator$/)).not.toBeInTheDocument();
  });

  it('keeps requester and shortage line context human-readable instead of leading with raw ids', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'quoted',
                rental_type: 'external',
                requester_id: 'user-42',
                lines: [
                  {
                    category_id: 'cat-excavator',
                    quantity: 2,
                    planned_start: '2026-07-01',
                    planned_end: '2026-07-14',
                    job_site_id: 'site-downtown',
                    rate_type: 'weekly',
                    status: 'pending',
                  },
                ],
              },
            },
          ],
        },
        requesters: [
          { source_record_id: 'user-42', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        ],
        job_sites: [
          { source_record_id: 'site-downtown', entity_versions: [{ data: { name: 'Downtown Tower' } }] },
          { source_record_id: 'site-warehouse', entity_versions: [{ data: { name: 'Warehouse District' } }] },
        ],
        asset_categories: [
          { source_record_id: 'cat-excavator', entity_versions: [{ data: { name: 'Excavators' } }] },
          { source_record_id: 'cat-forklift', entity_versions: [{ data: { name: 'Forklifts' } }] },
        ],
        lines: [
          {
            id: 'line-1',
            entity_versions: [
              {
                data: {
                  order_id: 'order-1',
                  status: 'pending',
                  category_id: 'cat-forklift',
                  quantity: 3,
                  planned_start: '2026-08-01',
                  planned_end: '2026-08-31',
                  job_site_id: 'site-warehouse',
                  rate_type: 'weekly',
                },
              },
            ],
          },
        ],
        availability: [],
        quote_availability: [
          {
            line_entity_id: 'line-1',
            order_id: 'order-1',
            branch_id: 'branch-1',
            asset_category_id: 'cat-forklift',
            requested_quantity: 3,
            planned_start: '2026-08-01',
            planned_end: '2026-08-31',
            available_quantity: 1,
            is_available: false,
            shortage_quantity: 2,
            shortage_reason: 'fully_committed_for_requested_window',
            alternatives: [],
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('Acme Construction')).toBeInTheDocument();
    expect(screen.queryByText('user-42')).not.toBeInTheDocument();
    expect(screen.getByText('Job Site: Downtown Tower · Rate: weekly')).toBeInTheDocument();
    expect(screen.getByText('Job Site: Warehouse District · Line ID: line-1')).toBeInTheDocument();
    expect(screen.queryByText('Line line-1 · cat-forklift')).not.toBeInTheDocument();
    expect(screen.queryByText(/^cat-excavator$/)).not.toBeInTheDocument();
  });

  it('falls back to persisted ids or Any when scope-name lookups are unavailable', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'draft',
                rental_type: 'external',
                requester_id: 'user-42',
                lines: [
                  {
                    branch_id: 'branch-9',
                    category_id: 'cat-generator',
                    quantity: 1,
                    planned_start: '2026-07-20',
                    planned_end: '2026-07-21',
                    job_site_id: 'site-yard',
                    rate_type: 'daily',
                    status: 'pending',
                  },
                  {
                    quantity: 1,
                    planned_start: '2026-07-22',
                    planned_end: '2026-07-23',
                    job_site_id: 'site-yard',
                    rate_type: 'daily',
                    status: 'pending',
                  },
                ],
              },
            },
          ],
        },
        lines: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('Scope: Branch branch-9 · Category cat-generator')).toBeInTheDocument();
    expect(screen.getByText('Scope: Branch Any · Category Any')).toBeInTheDocument();
  });

  it('preserves preferred-vendor rerent context and duplicate-routing suppression after reload', async () => {
    const refetchMock = vi.fn();
    const order = {
      id: 'order-1',
      created_at: '2026-06-01T00:00:00Z',
      entity_type: 'rental_order',
      entity_versions: [
        {
          id: 'ver-1',
          version_number: 1,
          is_current: true,
          data: {
            status: 'approved',
            rental_type: 'internal',
            requester_id: 'user-1',
            branch_id: 'branch-1',
            lines: [],
          },
        },
      ],
    };
    const availability = [
      {
        branch_id: 'branch-1',
        branch_name: 'South Depot',
        asset_category_id: 'cat-forklift',
        asset_category_name: 'Forklifts',
        total_assets: 6,
        available_assets: 1,
        unavailable_assets: 5,
        maintenance_due_assets: 0,
        maintenance_overdue_assets: 0,
      },
    ];
    let lines: Array<{ id: string; entity_versions: Array<{ data: Record<string, unknown> }> }> = [
      {
        id: 'line-1',
        entity_versions: [
          {
            data: {
              order_id: 'order-1',
              status: 'pending',
              category_id: 'cat-forklift',
              quantity: 3,
              planned_start: '2026-08-01',
              planned_end: '2026-08-31',
              job_site_id: 'site-warehouse',
              rate_type: 'weekly',
            },
          },
        ],
      },
      {
        id: 'line-2',
        entity_versions: [
          {
            data: {
              order_id: 'order-1',
              status: 'pending',
              category_id: 'cat-generator',
              quantity: 2,
              planned_start: '2026-08-15',
              planned_end: '2026-08-20',
              job_site_id: 'site-yard',
              rate_type: 'daily',
            },
          },
        ],
      },
    ];

    useDataSourcesMock.mockImplementation(() => ({
      data: {
        order,
        lines,
        availability,
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    }));

    rpcMock.mockImplementation(async (_fn, payload) => {
      const rerentPayload = payload as {
        p_data: Record<string, unknown>;
      };
      lines = lines.map((line) =>
        line.id === 'line-1'
          ? {
              ...line,
              entity_versions: [
                {
                  data: {
                    ...rerentPayload.p_data,
                    rerent_vendor_path: 'manual_override',
                    rerent_fulfillment_status: 'vendor_confirmed',
                    manual_override_reason: 'Primary vendor could not fulfill on time',
                    manual_override_role: 'admin',
                  },
                },
              ],
            }
          : line
      );
      return { error: null };
    });

    const view = renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getAllByRole('button', { name: 'Mark Preferred Vendor Re-rent' })).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark Preferred Vendor Re-rent' })[0]);
    expect(screen.getByText('Internal shortage detected')).toBeInTheDocument();
    const rerentDialog = screen.getByRole('dialog');
    expect(within(rerentDialog).getByText('line-1')).toBeInTheDocument();
    expect(within(rerentDialog).getByText('cat-forklift')).toBeInTheDocument();
    expect(within(rerentDialog).queryByText('line-2')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save Re-rent Routing' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_upsert_entity_current_state', expect.any(Object));
    });
    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('lines');
    });
    expect(refetchMock).toHaveBeenCalledWith('quote_availability');
    expect(refetchMock).toHaveBeenCalledWith('rerent_unit_status');
    expect(refetchMock).toHaveBeenCalledWith('order');

    const rerentPayload = rpcMock.mock.calls[0][1];
    expect(rerentPayload).toEqual(
      expect.objectContaining({
        p_entity_type: 'rental_order_line',
        p_entity_id: 'line-1',
        p_data: expect.objectContaining({
          order_id: 'order-1',
          fulfillment_source: 'external_rerent',
          status: 'rerent_pending',
          category_id: 'cat-forklift',
          quantity: 3,
          internal_available_quantity: 1,
          shortage_route: 'preferred_vendor',
          rerent_vendor_path: 'primary_preferred',
          rerent_fulfillment_status: 'pending_vendor_confirmation',
        }),
      })
    );

    view.unmount();
    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('Qty: 3 · 2026-08-01 to 2026-08-31')).toBeInTheDocument();
    expect(screen.getByText('Job Site: site-warehouse · Rate: weekly')).toBeInTheDocument();
    expect(screen.queryByText(/^cat-forklift$/)).not.toBeInTheDocument();
    expect(screen.getByText('cat-generator')).toBeInTheDocument();
    expect(screen.getByText('Qty: 2 · 2026-08-15 to 2026-08-20')).toBeInTheDocument();
    expect(screen.getByText('Job Site: site-yard · Rate: daily')).toBeInTheDocument();
    expect(screen.getByText('external rerent')).toBeInTheDocument();
    expect(screen.getByText('vendor confirmed')).toBeInTheDocument();
    expect(screen.getByText('route: manual override path')).toBeInTheDocument();
    expect(screen.getByText('override: Primary vendor could not fulfill on time')).toBeInTheDocument();
    expect(screen.getByText('requested: 3 · internal available: 1')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark Preferred Vendor Re-rent' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Mark Preferred Vendor Re-rent' }));
    const secondDialog = screen.getByRole('dialog');
    expect(within(secondDialog).getByText('line-2')).toBeInTheDocument();
    expect(within(secondDialog).getByText('cat-generator')).toBeInTheDocument();
  });

  it('hides preferred-vendor rerent action when internal availability is sufficient', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'approved',
                rental_type: 'internal',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-1',
            entity_versions: [
              {
                data: {
                  category_id: 'cat-boom',
                  quantity: 1,
                  planned_start: '2026-08-03',
                  planned_end: '2026-08-05',
                  job_site_id: 'site-b',
                  rate_type: 'weekly',
                  status: 'pending',
                },
              },
            ],
          },
        ],
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'South Depot',
            asset_category_id: 'cat-boom',
            asset_category_name: 'Boom Lifts',
            total_assets: 6,
            available_assets: 2,
            unavailable_assets: 4,
            maintenance_due_assets: 0,
            maintenance_overdue_assets: 0,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.queryByRole('button', { name: 'Mark Preferred Vendor Re-rent' })).not.toBeInTheDocument();
  });

  it('surfaces internal and external fulfillment channels with rerent status on line cards', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'approved',
                rental_type: 'internal',
                requester_id: 'user-1',
                lines: [
                  {
                    category_id: 'cat-compact',
                    quantity: 1,
                    planned_start: '2026-08-01',
                    planned_end: '2026-08-02',
                    job_site_id: 'site-a',
                    rate_type: 'daily',
                    status: 'pending',
                  },
                ],
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-2',
            entity_versions: [
              {
                data: {
                  category_id: 'cat-boom',
                  quantity: 2,
                  planned_start: '2026-08-03',
                  planned_end: '2026-08-05',
                  job_site_id: 'site-b',
                  rate_type: 'weekly',
                  status: 'pending',
                  fulfillment_source: 'external_rerent',
                  rerent_vendor_path: 'manual_override',
                  rerent_fulfillment_status: 'pending_vendor_confirmation',
                  internal_available_quantity: 1,
                  manual_override_reason: 'Vendor authorization missing for preferred route',
                },
              },
            ],
          },
        ],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('internal stock')).toBeInTheDocument();
    expect(screen.getByText('external rerent')).toBeInTheDocument();
    expect(screen.getByText('pending vendor confirmation')).toBeInTheDocument();
    expect(screen.getByText('route: manual override path')).toBeInTheDocument();
    expect(screen.getByText('override: Vendor authorization missing for preferred route')).toBeInTheDocument();
    expect(screen.getByText('requested: 2 · internal available: 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Preferred Vendor Re-rent' })).not.toBeInTheDocument();
  });

  it('shows shared re-rent unit lifecycle status badge when a status log entry exists', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'approved',
                rental_type: 'internal',
                requester_id: 'user-1',
                lines: [],
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-rerent-1',
            entity_versions: [
              {
                data: {
                  category_id: 'cat-crane',
                  quantity: 1,
                  planned_start: '2026-09-01',
                  planned_end: '2026-09-10',
                  job_site_id: 'site-east',
                  rate_type: 'weekly',
                  status: 'rerent_pending',
                  fulfillment_source: 'external_rerent',
                  rerent_vendor_path: 'primary_preferred',
                  rerent_fulfillment_status: 'vendor_confirmed',
                  internal_available_quantity: 0,
                },
              },
            ],
          },
        ],
        availability: [],
        rerent_unit_status: [
          {
            order_line_id: 'line-rerent-1',
            status_key: 'dispatched',
            status_label: 'Dispatched',
            changed_at: '2026-09-01T08:00:00Z',
            changed_by: 'vendor_api',
            notes: 'Unit en route from vendor yard',
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('external rerent')).toBeInTheDocument();
    expect(screen.getByText('vendor confirmed')).toBeInTheDocument();
    expect(screen.getByText('unit: Dispatched')).toBeInTheDocument();
  });

  it('hides unit status badge when no status log entry exists for the line', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'approved',
                rental_type: 'internal',
                requester_id: 'user-1',
                lines: [],
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-no-status',
            entity_versions: [
              {
                data: {
                  category_id: 'cat-lift',
                  quantity: 2,
                  planned_start: '2026-10-01',
                  planned_end: '2026-10-15',
                  job_site_id: 'site-west',
                  rate_type: 'daily',
                  status: 'rerent_pending',
                  fulfillment_source: 'external_rerent',
                  rerent_vendor_path: 'secondary_preferred',
                  rerent_fulfillment_status: 'pending_vendor_confirmation',
                  internal_available_quantity: 0,
                },
              },
            ],
          },
        ],
        availability: [],
        rerent_unit_status: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('external rerent')).toBeInTheDocument();
    expect(screen.queryByText(/unit:/)).not.toBeInTheDocument();
  });

  it('suppresses duplicate re-rent routing when persisted preferred-vendor context exists without fulfillment_source', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'approved',
                rental_type: 'internal',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-2',
            entity_versions: [
              {
                data: {
                  category_id: 'cat-boom',
                  quantity: 2,
                  planned_start: '2026-08-03',
                  planned_end: '2026-08-05',
                  job_site_id: 'site-b',
                  rate_type: 'weekly',
                  status: 'rerent_pending',
                  shortage_route: 'preferred_vendor',
                  rerent_vendor_path: 'secondary_preferred',
                  rerent_fulfillment_status: 'pending_vendor_confirmation',
                  internal_available_quantity: 1,
                },
              },
            ],
          },
        ],
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'South Depot',
            asset_category_id: 'cat-boom',
            asset_category_name: 'Boom Lifts',
            total_assets: 6,
            available_assets: 0,
            unavailable_assets: 6,
            maintenance_due_assets: 0,
            maintenance_overdue_assets: 0,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('external rerent')).toBeInTheDocument();
    expect(screen.getByText('pending vendor confirmation')).toBeInTheDocument();
    expect(screen.getByText('route: secondary preferred vendor')).toBeInTheDocument();
    expect(screen.getByText('requested: 2 · internal available: 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Preferred Vendor Re-rent' })).not.toBeInTheDocument();
  });

  it('shows availability panel in the detail view and applies select-item filters', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'draft',
                rental_type: 'external',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [],
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'South Depot',
            asset_category_id: 'cat-2',
            asset_category_name: 'Forklifts',
            total_assets: 8,
            available_assets: 5,
            unavailable_assets: 3,
            maintenance_due_assets: 1,
            maintenance_overdue_assets: 0,
          },
          {
            branch_id: 'branch-2',
            branch_name: 'North Yard',
            asset_category_id: 'cat-7',
            asset_category_name: 'Skid Steers',
            total_assets: 4,
            available_assets: 0,
            unavailable_assets: 4,
            maintenance_due_assets: 1,
            maintenance_overdue_assets: 1,
          },
          {
            branch_id: 'branch-2',
            branch_name: 'North Yard',
            asset_category_id: 'cat-9',
            asset_category_name: 'Boom Lift Slots',
            total_assets: 2,
            available_assets: 2,
            unavailable_assets: 0,
            maintenance_due_assets: 0,
            maintenance_overdue_assets: 0,
          },
          {
            branch_id: 'branch-2',
            branch_name: 'North Yard',
            asset_category_id: 'cat-10',
            asset_category_name: 'Scaffold Slots',
            total_assets: 3,
            available_assets: 3,
            unavailable_assets: 0,
            maintenance_due_assets: 0,
            maintenance_overdue_assets: 0,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('Select Items')).toBeInTheDocument();
    expect(screen.getByText('Current Location')).toBeInTheDocument();
    expect(screen.getByText('All Locations')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search items...')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Slots' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Parts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Missed Rental' })).not.toBeInTheDocument();

    expect(screen.getByText('Forklifts')).toBeInTheDocument();
    expect(screen.getByText('South Depot')).toBeInTheDocument();
    expect(screen.queryByText('Skid Steers')).not.toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('5 available of 8 total')).toBeInTheDocument();
    expect(screen.getByText('3 unavailable · due: 1 · overdue: 0')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All Locations' }));
    expect(screen.getByText('Skid Steers')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    const skidSteersRow = screen.getByText('Skid Steers').closest('[class*="rounded-lg"]');
    expect(skidSteersRow).not.toBeNull();
    expect(within(skidSteersRow as HTMLElement).getByRole('button', { name: '+ Add Item' })).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('Search items...'), 'skid');
    expect(screen.getByText('Skid Steers')).toBeInTheDocument();
    expect(screen.queryByText('Forklifts')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByPlaceholderText('Search items...'));
    expect(screen.getByText('Forklifts')).toBeInTheDocument();
    expect(screen.getByText('Skid Steers')).toBeInTheDocument();
  });

  it('shows advisory quote availability and blocks conversion with structured conflicts', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{
        success: false,
        reservation_id: null,
        message: 'Reservation conversion blocked due to availability conflicts.',
        conflicts: [
          {
            line_entity_id: 'line-1',
            requested_quantity: 3,
            available_quantity: 1,
            shortage_reason: 'fully_committed_for_requested_window',
          },
        ],
      }],
      error: null,
    });

    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'quoted',
                rental_type: 'external',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [],
        availability: [],
        quote_availability: [
          {
            line_entity_id: 'line-1',
            order_id: 'order-1',
            branch_id: 'branch-1',
            asset_category_id: 'cat-forklift',
            requested_quantity: 3,
            planned_start: '2026-08-01',
            planned_end: '2026-08-31',
            available_quantity: 1,
            is_available: false,
            shortage_quantity: 2,
            shortage_reason: 'fully_committed_for_requested_window',
            alternatives: [
              {
                recommendation_rank: 1,
                branch_id: 'branch-2',
                branch_name: 'North Yard',
                asset_category_id: 'cat-forklift',
                asset_category_name: 'Forklifts',
                available_quantity: 4,
                fit_type: 'same_category_other_location',
                recommendation_reason_code: 'cross_branch_same_category',
                transfer_cost_band: 'intra_state',
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

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText('Quote Availability (Advisory)')).toBeInTheDocument();
    expect(screen.getByText(/Suggested alternatives/i)).toBeInTheDocument();
    expect(screen.getByText(/cross_branch_same_category/i)).toBeInTheDocument();
    expect(screen.getByText(/Transfer-cost context: intra_state/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Convert to Reservation' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_convert_quote_to_reservation', { p_order_id: 'order-1' });
    });

    expect(screen.getByText('Conversion blocked to prevent overbooking')).toBeInTheDocument();
    expect(screen.getByText(/line line-1 shortage: requested 3 \/ available 1/i)).toBeInTheDocument();
  });

  it('renders the booking conflict assistant with operating-model tags and source-backed follow-up', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'quoted',
                rental_type: 'external',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [],
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'South Depot',
            asset_category_id: 'cat-forklift',
            asset_category_name: 'Forklifts',
            total_assets: 8,
            available_assets: 1,
            unavailable_assets: 7,
            maintenance_due_assets: 1,
            maintenance_overdue_assets: 0,
          },
        ],
        quote_availability: [
          {
            line_entity_id: 'line-1',
            order_id: 'order-1',
            branch_id: 'branch-1',
            asset_category_id: 'cat-forklift',
            requested_quantity: 3,
            planned_start: '2026-08-01',
            planned_end: '2026-08-31',
            available_quantity: 1,
            is_available: false,
            shortage_quantity: 2,
            shortage_reason: 'fully_committed_for_requested_window',
            alternatives: [
              {
                recommendation_rank: 1,
                branch_id: 'branch-2',
                branch_name: 'North Yard',
                asset_category_id: 'cat-forklift',
                asset_category_name: 'Forklifts',
                available_quantity: 4,
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

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByRole('heading', { name: 'Booking & extension conflict assistant' })).toBeInTheDocument();
    expect(screen.getByText('rental-counter-coordinator:t1')).toBeInTheDocument();
    expect(screen.getByText('Availability conflict for cat-forklift')).toBeInTheDocument();
    expect(screen.getByText(/Line line-1 requests 3 from 2026-08-01 to 2026-08-31; only 1 are currently free/i)).toBeInTheDocument();
    expect(screen.getByText(/South Depot · Forklifts reports 1 due and 0 overdue units/i)).toBeInTheDocument();
    expect(screen.getByText(/North Yard shows 4 available/i)).toBeInTheDocument();
    expect(screen.getByText('Human approval required')).toBeInTheDocument();
  });

  it('allows planners to accept a substitute recommendation before conversion', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: { entity_id: 'line-1' }, error: null })
      .mockResolvedValueOnce({
        data: [{
          success: true,
          reservation_id: 'contract-1',
          message: 'Converted order RO-TEST-001 to reservation contract RC-TEST-001.',
          conflicts: [],
        }],
        error: null,
      });

    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'quoted',
                rental_type: 'external',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-1',
            entity_versions: [
              {
                data: {
                  order_id: 'order-1',
                  status: 'pending',
                  quantity: 3,
                  category_id: 'cat-forklift',
                  planned_start: '2026-08-01',
                  planned_end: '2026-08-31',
                },
              },
            ],
          },
        ],
        availability: [],
        quote_availability: [
          {
            line_entity_id: 'line-1',
            order_id: 'order-1',
            branch_id: 'branch-1',
            asset_category_id: 'cat-forklift',
            requested_quantity: 3,
            planned_start: '2026-08-01',
            planned_end: '2026-08-31',
            available_quantity: 1,
            is_available: false,
            shortage_quantity: 2,
            shortage_reason: 'fully_committed_for_requested_window',
            alternatives: [
              {
                branch_id: 'branch-2',
                branch_name: 'North Yard',
                asset_category_id: 'cat-forklift',
                asset_category_name: 'Forklifts',
                available_quantity: 4,
                fit_type: 'same_category_other_location',
                explanation: 'Same category at a different location',
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

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Use this recommendation' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'rental_upsert_entity_current_state',
        expect.objectContaining({
          p_entity_type: 'rental_order_line',
          p_entity_id: 'line-1',
          p_data: expect.objectContaining({
            branch_id: 'branch-2',
            category_id: 'cat-forklift',
            fulfillment_source: 'internal_substitute',
            shortage_route: 'same_category_other_location',
          }),
        })
      );
    });

    await userEvent.click(screen.getByRole('button', { name: 'Convert to Reservation' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_convert_quote_to_reservation', { p_order_id: 'order-1' });
    });
  });

  it('shows direct-book action for draft quotes and converts without re-entry', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{
        success: true,
        reservation_id: 'contract-1',
        message: 'Converted order RO-TEST-001 to reservation contract RC-TEST-001.',
        conflicts: [],
      }],
      error: null,
    });

    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: {
                status: 'draft',
                rental_type: 'external',
                requester_id: 'user-1',
                branch_id: 'branch-1',
                lines: [],
              },
            },
          ],
        },
        lines: [],
        availability: [],
        quote_availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByRole('button', { name: 'Direct Book' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Convert to Reservation' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Direct Book' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('rental_convert_quote_to_reservation', { p_order_id: 'order-1' });
    });

    expect(screen.getByText('Reservation created')).toBeInTheDocument();
  });

  it('adds a line entity via the Add Line modal', async () => {
    const refetchMock = vi.fn();

    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'draft', rental_type: 'external', requester_id: 'user-1', lines: [] },
            },
          ],
        },
        lines: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: refetchMock,
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Add Line' }));

    await userEvent.type(screen.getByLabelText('Asset Category ID'), 'cat-forklift');
    await userEvent.type(screen.getByLabelText('Quantity'), '3');
    await userEvent.type(screen.getByLabelText('Planned Start'), '2026-08-01');
    await userEvent.type(screen.getByLabelText('Planned End'), '2026-08-31');
    await userEvent.type(screen.getByLabelText('Job Site ID'), 'site-warehouse');

    await userEvent.click(screen.getByRole('button', { name: 'Add Line' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'create_entity_with_version',
        expect.objectContaining({
          p_entity_type: 'rental_order_line',
          p_data: expect.objectContaining({
            order_id: 'order-1',
            status: 'pending',
            category_id: 'cat-forklift',
            quantity: '3',
            planned_start: '2026-08-01',
            planned_end: '2026-08-31',
            job_site_id: 'site-warehouse',
          }),
        })
      );
    });

    await waitFor(() => {
      expect(refetchMock).toHaveBeenCalledWith('lines');
    });
  });

  it('shows empty-state message when no lines exist', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-1',
              version_number: 1,
              is_current: true,
              data: { status: 'draft', rental_type: 'external', requester_id: 'user-1', lines: [] },
            },
          ],
        },
        lines: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-1" />);

    expect(screen.getByText("No order lines yet. Use 'Add Line' to capture equipment requirements.")).toBeInTheDocument();
  });

  it('launches a quote document preview from the approved order commercial snapshot', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-quote-1',
          created_at: '2026-06-01T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-quote-1',
              version_number: 2,
              is_current: true,
              data: {
                status: 'approved',
                order_number: 'RO-2001',
                requester_id: 'taylor@example.com',
                notes: 'Customer needs delivery before 7am.',
                lines: [],
                document_branding: {
                  company_name: 'Skyline Rentals',
                  eyebrow: 'Commercial Equipment',
                  support_email: 'quotes@skyline.example',
                },
                commercial_snapshot: {
                  document_number: 'Q-2001',
                  customer_name: 'Taylor Morgan',
                  customer_company: 'Skyline Build Co.',
                  customer_email: 'taylor@example.com',
                  job_site_name: 'Downtown Tower',
                  job_site_address: '100 Main St, Austin, TX',
                  rental_period: 'June 12, 2026 – June 19, 2026',
                  line_items: [
                    {
                      title: 'Excavator XL',
                      quantity: 1,
                      rental_period: 'June 12, 2026 – June 19, 2026',
                      rate_label: '1.0 weeks × $2,800.00/wk',
                      amount: 2800,
                    },
                  ],
                  fees: [{ label: 'Environmental fee', amount: 140 }],
                  taxes: [{ label: 'Tax', amount: 249.9 }],
                  subtotal: 2800,
                  total: 3189.9,
                },
              },
            },
          ],
        },
        lines: [],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-quote-1" />);

    await userEvent.click(screen.getByTestId('toggle-order-document'));

    expect(screen.getByRole('heading', { name: 'Approved Quote' })).toBeInTheDocument();
    expect(screen.getByText('Skyline Rentals')).toBeInTheDocument();
    expect(screen.getByText('Taylor Morgan')).toBeInTheDocument();
    expect(screen.getByText('Downtown Tower')).toBeInTheDocument();
    expect(screen.getByTestId('commercial-document-total')).toHaveTextContent('$3,189.90');
  });

  it('launches a reservation confirmation preview from the converted order snapshot without recomputing totals', async () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        order: {
          id: 'order-converted-1',
          created_at: '2026-06-02T00:00:00Z',
          entity_type: 'rental_order',
          entity_versions: [
            {
              id: 'ver-converted-1',
              version_number: 3,
              is_current: true,
              data: {
                status: 'converted',
                order_number: 'RO-3001',
                notes: 'Use loading dock B.',
                lines: [],
                commercial_snapshot: {
                  reservation_number: 'RC-3001',
                  customer_name: 'Jordan Lee',
                  customer_company: 'Prairie Line Utility',
                  job_site_name: 'Airport Expansion',
                  job_site_reference: 'Lot C',
                  line_items: [
                    {
                      title: 'Boom Lift',
                      quantity: 1,
                      rental_period: 'July 1, 2026 – July 14, 2026',
                      rate_label: '2.0 weeks × $1,100.00/wk',
                      amount: 2200,
                    },
                  ],
                  fees: [{ label: 'Damage waiver', amount: 125 }],
                  taxes: [{ label: 'Tax', amount: 255 }],
                  subtotal: 3000,
                  total: 3380,
                },
              },
            },
          ],
        },
        lines: [
          {
            id: 'line-1',
            entity_versions: [
              {
                data: {
                  category_id: 'cat-boom',
                  quantity: 1,
                  planned_start: '2026-07-01',
                  planned_end: '2026-07-14',
                  rate_type: 'weekly',
                  amount: 2200,
                },
              },
            ],
          },
        ],
        availability: [],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalOrderDetailScreen id="order-converted-1" />);

    await userEvent.click(screen.getByTestId('toggle-order-document'));

    expect(screen.getByRole('heading', { name: 'Reservation Confirmation' })).toBeInTheDocument();
    expect(screen.getByText('Jordan Lee')).toBeInTheDocument();
    expect(screen.getByText('Airport Expansion')).toBeInTheDocument();
    expect(screen.getByText('Damage waiver')).toBeInTheDocument();
    expect(screen.getByTestId('commercial-document-total')).toHaveTextContent('$3,380.00');
    expect(screen.getByText('$2,200.00')).toBeInTheDocument();
  });
});
