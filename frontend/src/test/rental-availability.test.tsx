import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
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
    Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a {...props}>{children}</a>
    ),
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { RentalAvailabilityScreen } from '@/routes/rental/availability';

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

function mockEmptyData() {
  useDataSourcesMock.mockReturnValue({
    data: { availability: [] },
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  });
}

describe('rental availability screen', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders branch/category availability totals', () => {
    useDataSourcesMock.mockReturnValue({
      data: {
        availability: [
          {
            branch_id: 'branch-1',
            branch_name: 'North Yard',
            asset_category_id: 'cat-1',
            asset_category_name: 'Excavators',
            total_assets: 12,
            available_assets: 9,
            unavailable_assets: 3,
            maintenance_due_assets: 2,
            maintenance_overdue_assets: 1,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalAvailabilityScreen />);

    expect(screen.getByRole('heading', { name: 'Branch Availability Lookup' })).toBeInTheDocument();
    expect(screen.getByText('North Yard • Excavators')).toBeInTheDocument();
    expect(screen.getByText('9 available')).toBeInTheDocument();
    expect(screen.getByText('3 unavailable / 12 total')).toBeInTheDocument();
    expect(screen.getByText('Maintenance due: 2')).toBeInTheDocument();
    expect(screen.getByText('Maintenance overdue: 1')).toBeInTheDocument();
    const createOrderLink = screen.getByText('Create Rental Order').closest('a');
    expect(createOrderLink).toHaveAttribute('to', '/rental/orders?branch_id=branch-1&category_id=cat-1');
  });

  function getCapturedAvailabilitySource() {
    type CapturedSources = Record<string, { filters?: { field: string; op: string; value: string }[] }>;
    return (useDataSourcesMock.mock.calls[0][0] as CapturedSources).availability;
  }

  it('passes no filters to availability data source when no context params provided', () => {
    mockEmptyData();
    renderWithQueryClient(<RentalAvailabilityScreen />);
    expect(getCapturedAvailabilitySource().filters).toBeUndefined();
  });

  it('shows a next-step action when no availability rows are returned', () => {
    mockEmptyData();
    renderWithQueryClient(<RentalAvailabilityScreen />);

    expect(screen.getByText('No branch availability data found.')).toBeInTheDocument();
    expect(screen.getByText('Create Rental Order').closest('a')).toHaveAttribute('to', '/rental/orders');
  });

  it('keeps scoped context and next action when scoped query returns no rows', () => {
    mockEmptyData();
    renderWithQueryClient(<RentalAvailabilityScreen branchId="branch-5" categoryId="cat-7" />);

    expect(screen.getByText('branch scope')).toBeInTheDocument();
    expect(screen.getByText('category scope')).toBeInTheDocument();
    expect(screen.getByText('No branch availability data found.')).toBeInTheDocument();
    expect(screen.getByText('Create Rental Order').closest('a')).toHaveAttribute(
      'to',
      '/rental/orders?branch_id=branch-5&category_id=cat-7'
    );
  });

  it('shows explicit loading state for scoped availability', () => {
    useDataSourcesMock.mockReturnValue({
      data: { availability: [] },
      isLoading: { availability: true },
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalAvailabilityScreen branchId="branch-5" categoryId="cat-7" />);
    expect(screen.getByText('Loading scoped availability...')).toBeInTheDocument();
  });

  it('shows explicit error state for scoped availability', () => {
    useDataSourcesMock.mockReturnValue({
      data: { availability: [] },
      isLoading: {},
      errors: { availability: { message: 'boom' } },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<RentalAvailabilityScreen branchId="branch-5" categoryId="cat-7" />);
    expect(screen.getByText('Unable to load scoped availability. Please refresh and try again.')).toBeInTheDocument();
  });

  it('narrows availability data source with branch_id filter when branchId is provided', () => {
    mockEmptyData();
    renderWithQueryClient(<RentalAvailabilityScreen branchId="branch-5" />);
    expect(getCapturedAvailabilitySource().filters).toContainEqual({
      field: 'branch_id',
      op: 'eq',
      value: 'branch-5',
    });
  });

  it('further narrows data source with category_id filter when both params are provided', () => {
    mockEmptyData();
    renderWithQueryClient(<RentalAvailabilityScreen branchId="branch-5" categoryId="cat-7" />);
    const filters = getCapturedAvailabilitySource().filters;
    expect(filters).toContainEqual({
      field: 'branch_id',
      op: 'eq',
      value: 'branch-5',
    });
    expect(filters).toContainEqual({
      field: 'asset_category_id',
      op: 'eq',
      value: 'cat-7',
    });
  });
});
