import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useDataSourcesMock, navigateSpy } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
  navigateSpy: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; params?: Record<string, string> }) => {
      const href = Object.entries(params || {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to as string
      );
      return <a href={href} {...props}>{children}</a>;
    },
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { EquipmentCatalogScreen } from '@/routes/rental/catalog';

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

const excavatorCategoryId = 'cat-uuid-earthmoving';
const liftCategoryId = 'cat-uuid-lifts';
const northBranchId = 'branch-uuid-north';
const southBranchId = 'branch-uuid-south';

const mockCategories = [
  {
    id: excavatorCategoryId,
    entity_versions: [{ id: 'ev-cat-1', data: { name: 'Earthmoving' }, is_current: true }],
  },
  {
    id: liftCategoryId,
    entity_versions: [{ id: 'ev-cat-2', data: { name: 'Lifts' }, is_current: true }],
  },
];

const mockBranches = [
  {
    id: northBranchId,
    entity_versions: [{ id: 'ev-branch-1', data: { name: 'North Yard' }, is_current: true }],
  },
  {
    id: southBranchId,
    entity_versions: [{ id: 'ev-branch-2', data: { name: 'South Yard' }, is_current: true }],
  },
];

const mockAssets = [
  {
    id: 'asset-1',
    entity_type: 'asset',
    created_at: '2024-01-01T00:00:00Z',
    entity_versions: [
      {
        id: 'ev-asset-1',
        is_current: true,
        data: {
          name: 'CAT 320 Excavator',
          make: 'Caterpillar',
          model: '320',
          fuel_type: 'diesel',
          meter_type: 'hours',
          condition: 'excellent',
          tags: ['earthmoving', 'tracked'],
          year: 2021,
          identifier: 'EX-001',
          status: 'available',
          branch_id: northBranchId,
          asset_category_id: excavatorCategoryId,
          category_id: excavatorCategoryId,
          daily_rate: 800,
          weekly_rate: 4200,
          monthly_rate: 14000,
          image_url: '/equipment-images/earthmoving.svg',
        },
      },
    ],
  },
  {
    id: 'asset-2',
    entity_type: 'asset',
    created_at: '2024-01-02T00:00:00Z',
    entity_versions: [
      {
        id: 'ev-asset-2',
        is_current: true,
        data: {
          name: 'JLG 600S Boom Lift',
          make: 'JLG',
          model: '600S',
          fuel_type: 'diesel',
          meter_type: 'hours',
          condition: 'good',
          tags: ['lift'],
          year: 2022,
          identifier: 'BL-001',
          status: 'available',
          branch_id: southBranchId,
          asset_category_id: liftCategoryId,
          category_id: liftCategoryId,
          daily_rate: 350,
          weekly_rate: 1800,
          monthly_rate: 6000,
          image_url: '/equipment-images/boom-scissor-lifts.svg',
        },
      },
    ],
  },
];

function mockData() {
  useDataSourcesMock.mockReturnValue({
    data: { assets: mockAssets, categories: mockCategories, branches: mockBranches },
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  });
}

describe('equipment catalog screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders page heading and all category buttons', () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    expect(screen.getByRole('heading', { name: 'Equipment Catalog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All Equipment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Earthmoving' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lifts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All Branches' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'North Yard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'South Yard' })).toBeInTheDocument();
  });

  it('shows all asset cards when no category is selected', () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    expect(screen.queryAllByText('CAT 320 Excavator')).not.toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).not.toHaveLength(0);
    expect(screen.getByRole('img', { name: 'CAT 320 Excavator' })).toHaveAttribute(
      'src',
      '/equipment-images/earthmoving.svg'
    );
    expect(screen.getByRole('img', { name: 'JLG 600S Boom Lift' })).toHaveAttribute(
      'src',
      '/equipment-images/boom-scissor-lifts.svg'
    );
  });

  it('shows only matching assets after selecting a category', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Earthmoving' }));

    expect(screen.queryAllByText('CAT 320 Excavator')).not.toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).toHaveLength(0);
  });

  it('shows the other category assets when that category is selected', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Lifts' }));

    expect(screen.queryAllByText('CAT 320 Excavator')).toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).not.toHaveLength(0);
  });

  it('restores all assets after re-selecting All Equipment', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'Earthmoving' }));
    await userEvent.click(screen.getByRole('button', { name: 'All Equipment' }));

    expect(screen.queryAllByText('CAT 320 Excavator')).not.toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).not.toHaveLength(0);
  });

  it('shows only matching assets after selecting a branch', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    await userEvent.click(screen.getByRole('button', { name: 'North Yard' }));

    expect(screen.queryAllByText('CAT 320 Excavator')).not.toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).toHaveLength(0);
  });

  it('filters visible assets by search text', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    await userEvent.type(
      screen.getByPlaceholderText('Search equipment by name, make, or identifier'),
      'boom'
    );

    expect(screen.queryAllByText('CAT 320 Excavator')).toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).not.toHaveLength(0);
  });

  it('filters visible assets by inventory attribute tags in search text', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    await userEvent.type(
      screen.getByPlaceholderText('Search equipment by name, make, or identifier'),
      'tracked'
    );

    expect(screen.queryAllByText('CAT 320 Excavator')).not.toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).toHaveLength(0);
  });

  it('applies URL-provided category, branch, and search filters on load', () => {
    mockData();

    renderWithQueryClient(
      <EquipmentCatalogScreen categoryId={liftCategoryId} branchId={southBranchId} search="jlg" />
    );

    expect(screen.queryAllByText('CAT 320 Excavator')).toHaveLength(0);
    expect(screen.queryAllByText('JLG 600S Boom Lift')).not.toHaveLength(0);
  });

  it('syncs category, branch, and search interactions back to route query params', async () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen categoryId={excavatorCategoryId} />);

    await userEvent.click(screen.getByRole('button', { name: 'South Yard' }));
    await userEvent.type(
      screen.getByPlaceholderText('Search equipment by name, make, or identifier'),
      'jlg'
    );

    expect(navigateSpy).toHaveBeenLastCalledWith({
      to: '/rental/catalog',
      replace: true,
      search: {
        category_id: excavatorCategoryId,
        branch_id: southBranchId,
        search: 'jlg',
      },
    });
  });

  it('links each asset card to the concrete asset detail route', () => {
    mockData();

    renderWithQueryClient(<EquipmentCatalogScreen />);

    expect(screen.getAllByRole('link', { name: 'Create Requisition' })[0]).toHaveAttribute(
      'href',
      '/rental/orders?branch_id=branch-uuid-north&category_id=cat-uuid-earthmoving'
    );
    expect(screen.getAllByRole('link', { name: 'Create Requisition' })[1]).toHaveAttribute(
      'href',
      '/rental/orders?branch_id=branch-uuid-south&category_id=cat-uuid-lifts'
    );
    expect(screen.getAllByRole('link', { name: 'View Details' })[0]).toHaveAttribute('href', '/entities/asset/asset-1');
    expect(screen.getAllByRole('link', { name: 'View Details' })[1]).toHaveAttribute('href', '/entities/asset/asset-2');
  });
});
