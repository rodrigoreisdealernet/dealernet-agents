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
    createFileRoute: () => (options: { component: unknown }) => ({ options }),
    Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
      <a href={to} {...props}>{children}</a>
    ),
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/engine/useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

import { initializeRegistry } from '@/registry';
import { OrgHierarchyPage } from '@/routes/enterprise/org-hierarchy';

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

describe('org hierarchy page route', () => {
  beforeEach(() => {
    initializeRegistry();
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
  });

  it('renders the page heading and subtitle', () => {
    useDataSourcesMock.mockReturnValue({
      data: { companies: [], hierarchy: [], scopeConfig: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    expect(screen.getByRole('heading', { name: 'Org Hierarchy' })).toBeInTheDocument();
    expect(
      screen.getByText('Company → region → branch structure with per-scope configuration.')
    ).toBeInTheDocument();
  });

  it('shows empty-state messages when no data is returned', () => {
    useDataSourcesMock.mockReturnValue({
      data: { companies: [], hierarchy: [], scopeConfig: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    expect(screen.getByText('No companies found.')).toBeInTheDocument();
    expect(screen.getByText('No hierarchy relationships found.')).toBeInTheDocument();
    expect(screen.getByText('No scope configuration found.')).toBeInTheDocument();
  });

  it('renders company → region → branch hierarchy rows with config labels', () => {
    const companyId = '11111111-0000-0000-0000-000000000001';
    const regionId = '22222222-0000-0000-0000-000000000001';
    const branchId = '33333333-0000-0000-0000-000000000001';

    useDataSourcesMock.mockReturnValue({
      data: {
        companies: [
          { entity_id: companyId, name: 'Apex Equipment Co.', data: {} },
        ],
        hierarchy: [
          {
            ancestor_id: companyId,
            ancestor_entity_type: 'company',
            ancestor_name: 'Apex Equipment Co.',
            descendant_id: regionId,
            descendant_entity_type: 'region',
            descendant_name: 'Gulf Region',
            depth: 1,
          },
          {
            ancestor_id: regionId,
            ancestor_entity_type: 'region',
            ancestor_name: 'Gulf Region',
            descendant_id: branchId,
            descendant_entity_type: 'branch',
            descendant_name: 'Houston Branch',
            depth: 1,
          },
        ],
        scopeConfig: [
          {
            scope_id: companyId,
            entity_type: 'company',
            name: 'Apex Equipment Co.',
            default_currency_code: 'USD',
            locale_code: 'en-US',
            tax_region_code: 'US-TX',
            timezone: 'America/Chicago',
          },
          {
            scope_id: branchId,
            entity_type: 'branch',
            name: 'Houston Branch',
            default_currency_code: null,
            locale_code: null,
            tax_region_code: null,
            timezone: null,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    // Company row — name appears in Companies card, hierarchy row, and config card
    expect(screen.getAllByText('Apex Equipment Co.').length).toBeGreaterThanOrEqual(1);

    // Hierarchy rows: ancestor/descendant names appear across multiple hierarchy rows
    expect(screen.getAllByText('Gulf Region').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Houston Branch').length).toBeGreaterThanOrEqual(1);

    // Depth labels from hierarchy rows
    expect(screen.getAllByText('(depth 1)').length).toBeGreaterThanOrEqual(2);

    // Per-scope config labels and values for the company scope
    expect(screen.getByText('Currency')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.getByText('America/Chicago')).toBeInTheDocument();
    expect(screen.getByText('Tax Region')).toBeInTheDocument();
    expect(screen.getByText('US-TX')).toBeInTheDocument();
    expect(screen.getByText('Locale')).toBeInTheDocument();
    expect(screen.getByText('en-US')).toBeInTheDocument();

    // Drill-down links: company row exposes "View Company" link scoped to that entity
    const companyLink = screen.getByRole('link', { name: 'View Company' });
    expect(companyLink).toBeInTheDocument();
    expect(companyLink).toHaveAttribute('href', `/entities/company/${companyId}`);

    // Hierarchy row for region descendant exposes "View Region" link
    const regionLink = screen.getByRole('link', { name: 'View Region' });
    expect(regionLink).toBeInTheDocument();
    expect(regionLink).toHaveAttribute('href', `/entities/region/${regionId}`);

    // Both the hierarchy row and the Per-Scope Configuration card expose "Check Availability"
    // for the branch — there will be at least one link with the correct href.
    const availLinks = screen.getAllByRole('link', { name: 'Check Availability' });
    expect(availLinks.length).toBeGreaterThanOrEqual(1);
    expect(
      availLinks.some(l => l.getAttribute('href') === `/rental/availability?branch_id=${branchId}`)
    ).toBe(true);
  });

  it('exposes View Region drill-down for region scope config rows', () => {
    const companyId = '11111111-0000-0000-0000-000000000002';
    const regionId = '22222222-0000-0000-0000-000000000002';

    useDataSourcesMock.mockReturnValue({
      data: {
        companies: [
          { entity_id: companyId, name: 'Apex Equipment Co.', data: {} },
        ],
        hierarchy: [],
        scopeConfig: [
          {
            scope_id: companyId,
            entity_type: 'company',
            name: 'Apex Equipment Co.',
            default_currency_code: null,
            locale_code: null,
            tax_region_code: null,
            timezone: null,
          },
          {
            scope_id: regionId,
            entity_type: 'region',
            name: 'Gulf Region',
            default_currency_code: null,
            locale_code: null,
            tax_region_code: null,
            timezone: null,
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    // Region row exposes "View Region" link scoped to that entity
    const regionLink = screen.getByRole('link', { name: 'View Region' });
    expect(regionLink).toBeInTheDocument();
    expect(regionLink).toHaveAttribute('href', `/entities/region/${regionId}`);

    // Company row exposes "View Company" link (not "View Region")
    const companyLink = screen.getByRole('link', { name: 'View Company' });
    expect(companyLink).toBeInTheDocument();
    expect(companyLink).toHaveAttribute('href', `/entities/company/${companyId}`);
  });

  it('Branch Availability card renders Check Availability links from the branches datasource', () => {
    const branchId = '33333333-0000-0000-0000-000000000099';

    useDataSourcesMock.mockReturnValue({
      data: {
        companies: [],
        hierarchy: [],
        scopeConfig: [],
        branches: [
          { entity_id: branchId, name: 'Austin Branch' },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    // Branch Availability card renders with the branch name
    expect(screen.getByText('Branch Availability')).toBeInTheDocument();
    expect(screen.getByText('Austin Branch')).toBeInTheDocument();

    // Check Availability link carries branch_id in the href so scope is preserved
    const availLink = screen.getByRole('link', { name: 'Check Availability' });
    expect(availLink).toBeInTheDocument();
    expect(availLink).toHaveAttribute(
      'href',
      `/rental/availability?branch_id=${branchId}`
    );
  });

  it('Per-Scope Configuration card always shows config label description text', () => {
    useDataSourcesMock.mockReturnValue({
      data: { companies: [], hierarchy: [], scopeConfig: [], branches: [] },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    // Description text must always be visible — satisfies the operator-facing config label requirement
    expect(
      screen.getByText(/currency.*timezone.*tax region.*locale/i)
    ).toBeInTheDocument();
  });

  it('still renders the page shell while data is loading', () => {
    useDataSourcesMock.mockReturnValue({
      data: { companies: null, hierarchy: null, scopeConfig: null },
      isLoading: { companies: true, hierarchy: true, scopeConfig: true },
      errors: {},
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    expect(screen.getByRole('heading', { name: 'Org Hierarchy' })).toBeInTheDocument();
  });

  it('renders configuration impact preview with grouped blast-radius sections', async () => {
    const user = userEvent.setup();

    useDataSourcesMock.mockReturnValue({
      data: {
        companies: [],
        hierarchy: [
          {
            ancestor_id: 'region-1',
            ancestor_entity_type: 'region',
            ancestor_name: 'Gulf Region',
            descendant_id: 'branch-1',
            descendant_entity_type: 'branch',
            descendant_name: 'Houston Branch',
            depth: 1,
          },
        ],
        scopeConfig: [
          {
            scope_id: 'branch-1',
            entity_type: 'branch',
            name: 'Houston Branch',
            default_currency_code: 'USD',
            locale_code: 'en-US',
            tax_region_code: 'US-TX',
            timezone: 'America/Chicago',
          },
        ],
        profiles: [
          { id: 'u-admin', display_name: 'Admin Casey', role: 'admin', tenant: 'default' },
        ],
        ratePlans: [
          {
            id: 'plan-1',
            name: 'Houston Prime',
            effective_from: '2026-06-01',
            branch_id: 'branch-1',
            is_active: true,
            daily_rate: 125,
          },
        ],
        contracts: [
          {
            entity_id: 'contract-1',
            data: {
              contract_number: 'RC-101',
              branch_id: 'branch-1',
              billing_account_id: 'billing-1',
            },
          },
        ],
      },
      isLoading: {},
      errors: {},
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithQueryClient(<OrgHierarchyPage />);

    expect(screen.getByText('Configuration change impact assistant')).toBeInTheDocument();
    expect(screen.getByText('rental-software-administrator:t1')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Target scope or record ID'));
    await user.type(screen.getByLabelText('Target scope or record ID'), 'branch-1');
    await user.click(screen.getByRole('button', { name: 'Preview impact' }));

    expect(screen.getByText('Canonical preview:')).toBeInTheDocument();
    expect(screen.getByText('Affected users')).toBeInTheDocument();
    expect(screen.getByText('Branches and regions')).toBeInTheDocument();
    expect(screen.getByText('Contracts and pricing surfaces')).toBeInTheDocument();
    expect(screen.getByText('Reporting audiences')).toBeInTheDocument();
    expect(
      screen.getByText(/never applies access, hierarchy, billing, pricing, or reporting changes automatically/i),
    ).toBeInTheDocument();
  });
});
