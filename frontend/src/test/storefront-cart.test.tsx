import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { useDataSourcesMock, navigateSpy, rpcMock, fromMock } = vi.hoisted(() => ({
  useDataSourcesMock: vi.fn(),
  navigateSpy: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      search,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & {
      to?: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
    }) => {
      let href = to as string;
      if (params) {
        href = Object.entries(params).reduce(
          (path, [key, value]) => path.replace(`$${key}`, value),
          href
        );
      }
      if (search) {
        const qs = new URLSearchParams(search).toString();
        if (qs) href = `${href}?${qs}`;
      }
      return <a href={href} {...props}>{children}</a>;
    },
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
    useAuth: () => ({ profile: { id: 'user-1', role: 'branch_manager' } }),
    useAuthCapabilities: () => ({
      canWrite: types.canWrite('branch_manager'),
      canOperate: types.canOperate('branch_manager'),
      role: 'branch_manager',
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mock setup
// ---------------------------------------------------------------------------

import { initializeRegistry } from '@/registry';
import { StorefrontCartScreen } from '@/routes/storefront/cart';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const excavatorCategoryId = 'cat-uuid-earthmoving';
const liftCategoryId = 'cat-uuid-lifts';

const mockAsset = {
  id: 'asset-001',
  entity_type: 'asset',
  created_at: '2024-01-01T00:00:00Z',
  entity_versions: [
    {
      id: 'ev-asset-1',
      is_current: true,
      data: {
        name: 'CAT 320 Excavator',
        make: 'Caterpillar',
        year: 2021,
        identifier: 'EX-001',
        status: 'available',
        branch_id: 'branch-north',
        asset_category_id: excavatorCategoryId,
        category_id: excavatorCategoryId,
        daily_rate: 800,
        weekly_rate: 4200,
        monthly_rate: 14000,
        image_url: '/equipment-images/earthmoving.svg',
      },
    },
  ],
};

const mockRelatedAssets = [
  {
    id: 'asset-002',
    entity_type: 'asset',
    created_at: '2024-01-02T00:00:00Z',
    entity_versions: [
      {
        id: 'ev-asset-2',
        is_current: true,
        data: {
          name: 'Komatsu PC360',
          make: 'Komatsu',
          year: 2022,
          identifier: 'EX-002',
          status: 'available',
          asset_category_id: excavatorCategoryId,
          category_id: excavatorCategoryId,
          daily_rate: 950,
          weekly_rate: 5000,
          monthly_rate: 16500,
          image_url: '/equipment-images/earthmoving.svg',
        },
      },
    ],
  },
  {
    id: 'asset-003',
    entity_type: 'asset',
    created_at: '2024-01-03T00:00:00Z',
    entity_versions: [
      {
        id: 'ev-asset-3',
        is_current: true,
        data: {
          name: 'JLG 600S Boom Lift',
          make: 'JLG',
          year: 2022,
          identifier: 'BL-001',
          status: 'available',
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

function mockDataSources() {
  useDataSourcesMock.mockReturnValue({
    data: { asset: mockAsset, relatedAssets: mockRelatedAssets },
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('storefront cart screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders cart heading and back link', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" startDate="2026-07-01" endDate="2026-07-07" rentalDays="7" />
    );

    expect(screen.getByRole('heading', { name: 'Your Rental Cart' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to Catalog' })).toHaveAttribute('href', '/rental/catalog');
  });

  it('displays the selected asset name and metadata', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" startDate="2026-07-01" endDate="2026-07-07" rentalDays="7" />
    );

    expect(screen.queryAllByText('CAT 320 Excavator')).not.toHaveLength(0);
    expect(screen.queryAllByText(/Caterpillar/)).not.toHaveLength(0);
  });

  it('shows the rental period and days from params', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" startDate="2026-07-01" endDate="2026-07-07" rentalDays="7" />
    );

    expect(screen.getByText('2026-07-01')).toBeInTheDocument();
    expect(screen.getByText('2026-07-07')).toBeInTheDocument();
    expect(screen.getByText('7 days')).toBeInTheDocument();
  });

  it('shows the damage waiver add-on card', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    expect(screen.getByText('Damage Waiver Protection')).toBeInTheDocument();
    expect(screen.getByText(/Covers accidental damage/)).toBeInTheDocument();
  });

  it('shows the delivery add-on card', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    expect(screen.getByText('Delivery & Pickup')).toBeInTheDocument();
    expect(screen.getByText('$150.00 flat')).toBeInTheDocument();
  });

  it('renders the order summary section', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    expect(screen.getByRole('heading', { name: 'Order Summary' })).toBeInTheDocument();
    expect(screen.queryAllByText('Total')).not.toHaveLength(0);
  });

  it('shows the correct weekly subtotal (7 days × weekly rate)', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    // $4,200 (weekly rate for 7-day rental)
    expect(screen.queryAllByText('$4,200')).not.toHaveLength(0);
  });

  it('adds damage waiver line item when enabled', async () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    const waiverButton = addButtons[0];
    await userEvent.click(waiverButton);

    expect(screen.getByText('Damage Waiver')).toBeInTheDocument();
    // 12% of $4,200 = $504 — appears in the summary
    expect(screen.queryAllByText('$504')).not.toHaveLength(0);
  });

  it('adds delivery fee line item when delivery is enabled', async () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    const deliveryButton = addButtons[1];
    await userEvent.click(deliveryButton);

    // Both the add-on card and the summary now show the delivery label
    expect(screen.queryAllByText('Delivery & Pickup')).not.toHaveLength(0);
    // The $150.00 delivery fee appears in the order summary
    expect(screen.queryAllByText('$150.00')).not.toHaveLength(0);
  });

  it('toggles damage waiver button label from Add to Added ✓', async () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    await userEvent.click(addButtons[0]);

    expect(screen.getByRole('button', { name: 'Added ✓' })).toBeInTheDocument();
  });

  it('shows cross-sell section with related asset in same category', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    expect(screen.getByRole('heading', { name: 'You Might Also Need' })).toBeInTheDocument();
    expect(screen.queryAllByText('Komatsu PC360')).not.toHaveLength(0);
  });

  it('excludes current asset from cross-sell and excludes different-category assets', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    // Cross-sell section heading must be present
    expect(screen.getByRole('heading', { name: 'You Might Also Need' })).toBeInTheDocument();

    // Current asset (asset-001 / CAT 320 Excavator) must not appear in cross-sell links
    const crossSellLinks = screen.getAllByRole('link', { name: 'Add to Cart →' });
    const hrefs = crossSellLinks.map((l) => l.getAttribute('href') ?? '');
    expect(hrefs.every((h) => !h.includes('asset-001'))).toBe(true);

    // Different-category asset (JLG boom lift) must not appear in cross-sell links
    expect(hrefs.every((h) => !h.includes('asset-003'))).toBe(true);
  });

  it('cross-sell links point to the cart with the related asset id', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    const crossSellLinks = screen.getAllByRole('link', { name: 'Add to Cart →' });
    const href = crossSellLinks[0].getAttribute('href') ?? '';
    expect(href).toContain('/storefront/cart');
    expect(href).toContain('asset-002');
  });

  it('renders the Request Booking button', () => {
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" />
    );

    expect(screen.getByRole('button', { name: 'Request Booking' })).toBeInTheDocument();
  });

  it('submits a rental order with add-ons when Request Booking is clicked', async () => {
    rpcMock.mockResolvedValue({ data: { entity_id: 'new-order-uuid' }, error: null });
    mockDataSources();

    renderWithQueryClient(
      <StorefrontCartScreen assetId="asset-001" rentalDays="7" startDate="2026-07-01" endDate="2026-07-07" />
    );

    // Enable delivery add-on
    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    await userEvent.click(addButtons[1]);

    await userEvent.click(screen.getByRole('button', { name: 'Request Booking' }));

    expect(rpcMock).toHaveBeenCalledWith(
      'create_entity_with_version',
      expect.objectContaining({
        p_entity_type: 'rental_order',
        p_data: expect.objectContaining({
          status: 'draft',
          rental_type: 'external',
        }),
      })
    );
  });
});
