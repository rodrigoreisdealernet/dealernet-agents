/**
 * Tests for inventory item-type model UI — stock_item guided creation form.
 *
 * Covers:
 *  1. Inventory Items page renders using the EntityListScreen for stock_item.
 *  2. Create modal shows inventory-kind–specific fields (Select + branch/category/quantity).
 *  3. Generic description/status fields are NOT shown for stock_item.
 *  4. Submitting the form calls the create_stock_item RPC with correct params.
 *  5. Resetting kind back to bulk works correctly.
 */

import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

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
    createFileRoute: () => () => ({}),
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

function emptyStockItemList() {
  return {
    data: { entities: [] },
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  initializeRegistry();
  rpcMock.mockReset();
  useDataSourcesMock.mockReset();
  navigateSpy.mockReset();
  rpcMock.mockResolvedValue({
    data: [{ entity_id: 'si-001', entity_version_id: 'ev-001', version_number: 1 }],
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InventoryItemsPage — stock_item entity list', () => {
  it('renders the Stock Items heading for entity type stock_item', () => {
    useDataSourcesMock.mockReturnValue(emptyStockItemList());
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);
    expect(screen.getByRole('heading', { name: 'Stock Items' })).toBeInTheDocument();
  });

  it('shows New Stock Item button', () => {
    useDataSourcesMock.mockReturnValue(emptyStockItemList());
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);
    expect(screen.getByRole('button', { name: 'New Stock Item' })).toBeInTheDocument();
  });
});

describe('stock_item create modal — guided field switching', () => {
  it('shows Inventory Kind selector in the create modal for stock_item', async () => {
    useDataSourcesMock.mockReturnValue(emptyStockItemList());
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);

    await userEvent.click(screen.getByRole('button', { name: 'New Stock Item' }));

    expect(screen.getByText('Create New Stock Item')).toBeInTheDocument();
    expect(screen.getByLabelText('Inventory Kind')).toBeInTheDocument();
  });

  it('shows stock_item-specific fields (branch, category, quantity) in create modal', async () => {
    useDataSourcesMock.mockReturnValue(emptyStockItemList());
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);

    await userEvent.click(screen.getByRole('button', { name: 'New Stock Item' }));

    expect(screen.getByLabelText('Branch ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Asset Category ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Opening Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
  });

  it('does NOT show generic Description and Status fields for stock_item', async () => {
    useDataSourcesMock.mockReturnValue(emptyStockItemList());
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);

    await userEvent.click(screen.getByRole('button', { name: 'New Stock Item' }));

    // The generic Description/Status block is shown only for non-specific entity types.
    // For stock_item it must not appear (only the stock_item-specific Description field).
    // The stock_item form has its own Description field so we check there is only one.
    const descriptionLabels = screen.queryAllByLabelText('Description');
    // There must be exactly one Description label — the stock_item-specific one.
    expect(descriptionLabels).toHaveLength(1);

    // There must be no generic Status field visible for stock_item.
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
  });

  it('calls create_stock_item RPC with correct params on submit', async () => {
    const refetchMock = vi.fn();
    useDataSourcesMock.mockReturnValue({
      ...emptyStockItemList(),
      refetch: refetchMock,
    });
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);

    await userEvent.click(screen.getByRole('button', { name: 'New Stock Item' }));

    await userEvent.type(screen.getByLabelText('Name'), 'Hydraulic Oil 20L');
    await userEvent.type(screen.getByLabelText('Description'), 'Premium hydraulic oil');
    await userEvent.type(screen.getByLabelText('Branch ID'), 'branch-north-uuid');
    await userEvent.type(screen.getByLabelText('Asset Category ID'), 'cat-fluids-uuid');
    await userEvent.type(screen.getByLabelText('Opening Quantity'), '50');

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'create_stock_item',
        expect.objectContaining({
          p_name: 'Hydraulic Oil 20L',
          p_description: 'Premium hydraulic oil',
          p_branch_id: 'branch-north-uuid',
          p_asset_category_id: 'cat-fluids-uuid',
          p_opening_quantity: '50',
        })
      );
    });
    expect(refetchMock).toHaveBeenCalledWith('entities');
  });

  it('sends inventory_kind default (bulk) when no kind is explicitly selected', async () => {
    useDataSourcesMock.mockReturnValue(emptyStockItemList());
    renderWithQueryClient(<EntityListScreen entityType="stock_item" />);

    await userEvent.click(screen.getByRole('button', { name: 'New Stock Item' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Default Bulk Item');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'create_stock_item',
        expect.objectContaining({
          p_name: 'Default Bulk Item',
          p_inventory_kind: 'bulk',
        })
      );
    });
  });
});
