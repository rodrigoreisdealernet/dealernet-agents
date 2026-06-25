import type { AnchorHTMLAttributes, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AppRole } from '@/auth/types';

const { locationState, authState, navigateSpy, getSessionMock } = vi.hoisted(() => ({
  locationState: { pathname: '/', search: '' },
  navigateSpy: vi.fn(),
  getSessionMock: vi.fn(),
  authState: {
    profile: null as null | {
      id: string;
      email: string;
      displayName: string;
      role: 'admin' | 'branch_manager' | 'field_operator' | 'read_only';
      tenant: string;
    },
    isLoading: false,
    signOut: vi.fn(),
    signIn: vi.fn(),
    session: null,
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    createRootRoute: (options: { component: React.ComponentType; beforeLoad?: (opts: unknown) => unknown }) => ({ options }),
    Outlet: () => <div data-testid="route-outlet" />,
    Link: ({ children, className, to, params, search, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; params?: { entityType?: string }; search?: Record<string, string> }) => {
      const hrefBase = params?.entityType ? `/entities/${params.entityType}` : (to ?? '#');
      const searchString = search ? new URLSearchParams(search).toString() : '';
      const href = searchString ? `${hrefBase}?${searchString}` : hrefBase;
      return (
        <a href={href} className={className} {...props}>
          {children}
        </a>
      );
    },
    useLocation: () => locationState,
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/data/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock('@tanstack/router-devtools', () => ({
  TanStackRouterDevtools: () => null,
}));

// Mock auth so the root shell tests are not coupled to Supabase.
vi.mock('@/auth/AuthContext', async () => {
  const types = await vi.importActual<typeof import('@/auth/types')>('@/auth/types');
  return {
    useAuth: () => authState,
    useAuthCapabilities: () => ({
      canWrite: types.canWrite(authState.profile?.role as AppRole | undefined),
      canOperate: types.canOperate(authState.profile?.role as AppRole | undefined),
      role: authState.profile?.role,
    }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('@/auth/LoginDialog', () => ({
  LoginDialog: () => <button data-testid="sign-in-button">Sign In</button>,
}));

import { Route } from '@/routes/__root';

const RootComponent = Route.options.component as () => ReactElement;

describe('root app shell branding', () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  it('renders "Dealernet" as the header wordmark', () => {
    render(<RootComponent />);
    expect(screen.getByText('Dealernet')).toBeInTheDocument();
  });

  it('does not render the old internal framework name "JSON UI Engine"', () => {
    render(<RootComponent />);
    expect(screen.queryByText(/JSON UI Engine/i)).not.toBeInTheDocument();
  });
});

describe('root app shell navigation', () => {
  beforeEach(() => {
    locationState.pathname = '/';
    locationState.search = '';
    authState.profile = {
      id: 'u-nav',
      email: 'manager@dia-rental.dev',
      displayName: 'Demo Manager',
      role: 'branch_manager',
      tenant: 'dia-demo',
    };
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  it('renders dashboard and entity sidebar links', () => {
    render(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Equipment Catalog' })).toHaveAttribute('href', '/rental/catalog');
    expect(screen.getByRole('link', { name: 'Field Workflows' })).toHaveAttribute('href', '/field/mobile');
    expect(screen.getByRole('link', { name: 'Branches' })).toHaveAttribute('href', '/entities/branch');
    expect(screen.getByRole('link', { name: 'Customers' })).toHaveAttribute('href', '/entities/customer');
    expect(screen.getByRole('link', { name: 'Billing Accounts' })).toHaveAttribute('href', '/entities/billing_account');
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute('href', '/entities/contact');
    expect(screen.getByRole('link', { name: 'Job Sites' })).toHaveAttribute('href', '/entities/job_site');
    expect(screen.getByRole('link', { name: 'Asset Categories' })).toHaveAttribute('href', '/entities/asset_category');
    expect(screen.getByRole('link', { name: 'Assets' })).toHaveAttribute('href', '/entities/asset');
    expect(screen.getByRole('link', { name: 'Rental Orders' })).toHaveAttribute('href', '/entities/rental_order');
    expect(screen.getByRole('link', { name: 'Contracts' })).toHaveAttribute('href', '/entities/rental_contract');
    expect(screen.getByRole('link', { name: 'Checkouts & Returns' })).toHaveAttribute('href', '/entities/rental_contract_line');
    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/entities/invoice');
    expect(screen.getByRole('link', { name: 'Transfers' })).toHaveAttribute('href', '/entities/transfer');
    expect(screen.getByRole('link', { name: 'Inspections' })).toHaveAttribute('href', '/entities/inspection');
    expect(screen.getByRole('link', { name: 'Maintenance' })).toHaveAttribute('href', '/entities/maintenance_record');
    expect(screen.getByRole('link', { name: 'Portal Billing' })).toHaveAttribute('href', '/rental/portal-financials');
    expect(screen.getByRole('link', { name: 'General Ledger' })).toHaveAttribute('href', '/accounting/general-ledger');
    expect(screen.getByRole('link', { name: 'Returns / Check-In' })).toHaveAttribute('href', '/rental/returns');
    expect(screen.getByRole('link', { name: 'Branch Availability' })).toHaveAttribute('href', '/rental/availability');
    expect(screen.getByRole('link', { name: 'Branch Operations' })).toHaveAttribute('href', '/branch/ops');
    expect(screen.getByRole('link', { name: 'Live Yard View' })).toHaveAttribute('href', '/dispatch/yard');
    expect(screen.getByRole('link', { name: 'Fleet Reporting' })).toHaveAttribute('href', '/analytics/fleet');
    expect(screen.getByRole('link', { name: 'Enterprise Financials' })).toHaveAttribute('href', '/analytics/enterprise-financials');
    expect(screen.getByRole('link', { name: 'Sales Tax Filing' })).toHaveAttribute('href', '/analytics/tax-filings');
    expect(screen.getByRole('link', { name: 'Operations Dashboard' })).toHaveAttribute('href', '/ops');
    expect(screen.getByRole('link', { name: 'Revenue Recognition' })).toHaveAttribute('href', '/ops/revenue-recognition');
    expect(screen.getByRole('link', { name: 'Quote Drafts' })).toHaveAttribute('href', '/ops/findings?workflow=quote-to-order-copilot');
    expect(screen.getByRole('link', { name: 'Damage Charge Review' })).toHaveAttribute('href', '/ops/findings?workflow=damage-returns-charge-assistant');
    expect(screen.getByRole('link', { name: 'Fleet Audits' })).toHaveAttribute('href', '/ops/fleet-audits');
    expect(screen.getByRole('link', { name: 'Incident Compliance Queue' })).toHaveAttribute('href', '/ops/incident-compliance-queue');
    expect(screen.getByRole('link', { name: 'Audit History' })).toHaveAttribute('href', '/ops/findings');
    expect(screen.getByRole('link', { name: 'Org Hierarchy' })).toHaveAttribute('href', '/enterprise/org-hierarchy');
  });

  it('marks dashboard active on root route and marks entity link active on entity routes', () => {
    const { rerender } = render(<RootComponent />);

    const dashboardLink = screen.getByRole('link', { name: 'Dashboard' });
    const fieldWorkflowsLink = screen.getByRole('link', { name: 'Field Workflows' });
    const branchesLink = screen.getByRole('link', { name: 'Branches' });

    expect(dashboardLink).toHaveClass('bg-sidebar-active');
    expect(fieldWorkflowsLink).not.toHaveClass('bg-sidebar-active');
    expect(branchesLink).not.toHaveClass('bg-sidebar-active');

    locationState.pathname = '/field/mobile';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveClass('bg-sidebar-active');
    expect(screen.getByRole('link', { name: 'Field Workflows' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/entities/branch/branch-1';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveClass('bg-sidebar-active');
    expect(screen.getByRole('link', { name: 'Field Workflows' })).not.toHaveClass('bg-sidebar-active');
    expect(screen.getByRole('link', { name: 'Branches' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/rental/availability';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Branch Availability' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/rental/returns';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Returns / Check-In' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/rental/counter-review';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Counter Review' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/rental/portal-financials';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Portal Billing' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/accounting/general-ledger';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'General Ledger' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/branch/ops';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Branch Operations' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/dispatch/yard';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Live Yard View' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/analytics/fleet';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Fleet Reporting' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/analytics/enterprise-financials';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Enterprise Financials' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/analytics/tax-filings';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Sales Tax Filing' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/ops/revenue-recognition';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Revenue Recognition' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/ops/fleet-audits';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Fleet Audits' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/ops/incident-compliance-queue';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Incident Compliance Queue' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/ops/findings';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Audit History' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/ops/findings';
    locationState.search = '?workflow=quote-to-order-copilot';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Quote Drafts' })).toHaveClass('bg-sidebar-active');
    expect(screen.getByRole('link', { name: 'Audit History' })).not.toHaveClass('bg-sidebar-active');

    locationState.search = '?workflow=damage-returns-charge-assistant';
    rerender(<RootComponent />);

    expect(screen.getByRole('link', { name: 'Damage Charge Review' })).toHaveClass('bg-sidebar-active');

    locationState.pathname = '/enterprise/org-hierarchy';
    rerender(<RootComponent />);

    locationState.search = '';
    expect(screen.getByRole('link', { name: 'Org Hierarchy' })).toHaveClass('bg-sidebar-active');
  });

  it('hides General Ledger link for read-only users', () => {
    authState.profile = {
      id: 'u-ro',
      email: 'readonly@dia-rental.dev',
      displayName: 'Read Only User',
      role: 'read_only',
      tenant: 'dia-demo',
    };

    render(<RootComponent />);

    expect(screen.queryByRole('link', { name: 'General Ledger' })).not.toBeInTheDocument();
  });
});

describe('build footer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders dev/local placeholder when build args are not set', () => {
    vi.stubEnv('VITE_COMMIT_SHA', '');
    vi.stubEnv('VITE_BUILD_TIME', '');
    render(<RootComponent />);

    const footer = screen.getByTestId('build-footer');
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveTextContent('build: dev / local');
    expect(screen.queryByTestId('build-sha')).not.toBeInTheDocument();
    expect(screen.queryByTestId('build-time')).not.toBeInTheDocument();
  });

  it('renders commit SHA link and build time when build args are injected', () => {
    const sha = 'c5bc0a0f1e2d3b4a5c6d7e8f';
    const buildTime = '2024-06-07T00:00:00Z';
    vi.stubEnv('VITE_COMMIT_SHA', sha);
    vi.stubEnv('VITE_BUILD_TIME', buildTime);
    render(<RootComponent />);

    const shaLink = screen.getByTestId('build-sha');
    expect(shaLink).toBeInTheDocument();
    expect(shaLink).toHaveTextContent(sha.slice(0, 7));
    expect(shaLink).toHaveAttribute(
      'href',
      `https://github.com/Volaris-AI/dia/commit/${sha}`,
    );
    expect(shaLink).toHaveAttribute('target', '_blank');

    const timeEl = screen.getByTestId('build-time');
    expect(timeEl).toHaveTextContent(buildTime);
  });
});

describe('header — auth state', () => {
  beforeEach(() => {
    // Reset to unauthenticated state
    authState.profile = null;
    authState.isLoading = false;
    navigateSpy.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  it('shows Sign In button when no user is logged in', () => {
    render(<RootComponent />);
    expect(screen.getByTestId('sign-in-button')).toBeInTheDocument();
    expect(screen.queryByTestId('header-user-email')).not.toBeInTheDocument();
    expect(screen.queryByTestId('header-user-role')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sign-out-button')).not.toBeInTheDocument();
  });

  it('shows user display name, role badge, and sign-out button when authenticated', () => {
    authState.profile = {
      id: 'u1',
      email: 'admin@dia-rental.dev',
      displayName: 'Demo Admin',
      role: 'admin',
      tenant: 'dia-demo',
    };

    render(<RootComponent />);

    expect(screen.getByTestId('header-user-email')).toHaveTextContent('Demo Admin');
    expect(screen.getByTestId('header-user-role')).toHaveTextContent('Admin');
    expect(screen.getByTestId('sign-out-button')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-button')).not.toBeInTheDocument();
  });

  it('shows role badge for field_operator', () => {
    authState.profile = {
      id: 'u2',
      email: 'operator@dia-rental.dev',
      displayName: 'Demo Operator',
      role: 'field_operator',
      tenant: 'dia-demo',
    };

    render(<RootComponent />);

    expect(screen.getByTestId('header-user-role')).toHaveTextContent('Field Operator');
  });
});

describe('root route auth guard', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it('redirects protected routes to /login when unauthenticated', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    try {
      await Route.options.beforeLoad?.({
        location: { pathname: '/entities/billing_account' },
      } as never);
      throw new Error('Expected beforeLoad to redirect unauthenticated users');
    } catch (error) {
      expect(error).toMatchObject({ options: { to: '/login' } });
    }
  });

  it('allows /login without session lookup', async () => {
    await expect(
      Route.options.beforeLoad?.({
        location: { pathname: '/login' },
      } as never),
    ).resolves.toBeUndefined();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('allows protected routes when session exists', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'test-token' } } });

    await expect(
      Route.options.beforeLoad?.({
        location: { pathname: '/entities/billing_account' },
      } as never),
    ).resolves.toBeUndefined();
  });

  it('redirects protected routes to /login when session lookup fails', async () => {
    getSessionMock.mockRejectedValue(new Error('session lookup failed'));

    try {
      await Route.options.beforeLoad?.({
        location: { pathname: '/entities/billing_account' },
      } as never);
      throw new Error('Expected beforeLoad to redirect when session lookup fails');
    } catch (error) {
      expect(error).toMatchObject({ options: { to: '/login' } });
    }
  });
});

describe('sidebar — quote builder role gating', () => {
  beforeEach(() => {
    locationState.pathname = '/';
    authState.profile = null;
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  it('shows Quote Builder link for admin', () => {
    authState.profile = {
      id: 'u1', email: 'admin@dia-rental.dev', displayName: 'Admin', role: 'admin', tenant: 'test',
    };
    render(<RootComponent />);
    expect(screen.getByRole('link', { name: 'Quote Builder' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Quote Builder' })).toHaveAttribute('href', '/rental/quoting');
  });

  it('shows Quote Builder link for branch_manager', () => {
    authState.profile = {
      id: 'u2', email: 'mgr@dia-rental.dev', displayName: 'Manager', role: 'branch_manager', tenant: 'test',
    };
    render(<RootComponent />);
    expect(screen.getByRole('link', { name: 'Quote Builder' })).toBeInTheDocument();
  });

  it('hides Quote Builder link for field_operator', () => {
    authState.profile = {
      id: 'u3', email: 'op@dia-rental.dev', displayName: 'Operator', role: 'field_operator', tenant: 'test',
    };
    render(<RootComponent />);
    expect(screen.queryByRole('link', { name: 'Quote Builder' })).not.toBeInTheDocument();
  });

  it('hides Quote Builder link for read_only', () => {
    authState.profile = {
      id: 'u4', email: 'ro@dia-rental.dev', displayName: 'Read Only', role: 'read_only', tenant: 'test',
    };
    render(<RootComponent />);
    expect(screen.queryByRole('link', { name: 'Quote Builder' })).not.toBeInTheDocument();
  });

  it('hides Quote Builder link when no user is logged in', () => {
    authState.profile = null;
    render(<RootComponent />);
    expect(screen.queryByRole('link', { name: 'Quote Builder' })).not.toBeInTheDocument();
  });
});

describe('mobile nav drawer', () => {
  beforeEach(() => {
    locationState.pathname = '/';
    locationState.search = '';
    authState.profile = {
      id: 'u-mob',
      email: 'manager@dia-rental.dev',
      displayName: 'Demo Manager',
      role: 'branch_manager',
      tenant: 'dia-demo',
    };
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  it('renders a hamburger button with aria-label="Open navigation"', () => {
    render(<RootComponent />);
    expect(screen.getByTestId('mobile-menu-button')).toHaveAttribute('aria-label', 'Open navigation');
  });

  it('sidebar is collapsed by default (-translate-x-full)', () => {
    render(<RootComponent />);
    expect(screen.getByTestId('main-sidebar')).toHaveClass('-translate-x-full');
  });

  it('clicking the hamburger opens the drawer', () => {
    render(<RootComponent />);
    const aside = screen.getByTestId('main-sidebar');
    expect(aside).toHaveClass('-translate-x-full');

    fireEvent.click(screen.getByTestId('mobile-menu-button'));

    expect(aside).not.toHaveClass('-translate-x-full');
    expect(aside).toHaveClass('translate-x-0');
  });

  it('renders a backdrop when the drawer is open', () => {
    render(<RootComponent />);
    expect(screen.queryByTestId('mobile-nav-backdrop')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mobile-menu-button'));

    expect(screen.getByTestId('mobile-nav-backdrop')).toBeInTheDocument();
  });

  it('clicking the close button collapses the drawer', () => {
    render(<RootComponent />);
    fireEvent.click(screen.getByTestId('mobile-menu-button'));
    expect(screen.getByTestId('main-sidebar')).not.toHaveClass('-translate-x-full');

    fireEvent.click(screen.getByTestId('mobile-menu-close'));

    expect(screen.getByTestId('main-sidebar')).toHaveClass('-translate-x-full');
  });

  it('clicking the backdrop closes the drawer', () => {
    render(<RootComponent />);
    fireEvent.click(screen.getByTestId('mobile-menu-button'));
    expect(screen.getByTestId('main-sidebar')).not.toHaveClass('-translate-x-full');

    fireEvent.click(screen.getByTestId('mobile-nav-backdrop'));

    expect(screen.getByTestId('main-sidebar')).toHaveClass('-translate-x-full');
    expect(screen.queryByTestId('mobile-nav-backdrop')).not.toBeInTheDocument();
  });

  it('clicking a nav link closes the drawer', () => {
    render(<RootComponent />);
    fireEvent.click(screen.getByTestId('mobile-menu-button'));
    expect(screen.getByTestId('main-sidebar')).not.toHaveClass('-translate-x-full');

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));

    expect(screen.getByTestId('main-sidebar')).toHaveClass('-translate-x-full');
  });

  it('route change closes the drawer', () => {
    const { rerender } = render(<RootComponent />);
    fireEvent.click(screen.getByTestId('mobile-menu-button'));
    expect(screen.getByTestId('main-sidebar')).not.toHaveClass('-translate-x-full');

    locationState.pathname = '/rental/catalog';
    rerender(<RootComponent />);

    expect(screen.getByTestId('main-sidebar')).toHaveClass('-translate-x-full');
  });
});

describe('accounting export config nav visibility', () => {
  beforeEach(() => {
    locationState.pathname = '/';
    locationState.search = '';
    getSessionMock.mockResolvedValue({ data: { session: null } });
  });

  it('shows Export Configuration nav link for admin', () => {
    authState.profile = {
      id: 'u-admin',
      email: 'admin@dia-rental.dev',
      displayName: 'Admin User',
      role: 'admin',
      tenant: 'dia-demo',
    };
    render(<RootComponent />);
    expect(screen.getByRole('link', { name: 'Export Configuration' })).toHaveAttribute(
      'href',
      '/accounting/export-config',
    );
  });

  it('hides Export Configuration nav link for branch_manager', () => {
    authState.profile = {
      id: 'u-mgr',
      email: 'manager@dia-rental.dev',
      displayName: 'Branch Manager',
      role: 'branch_manager',
      tenant: 'dia-demo',
    };
    render(<RootComponent />);
    expect(screen.queryByRole('link', { name: 'Export Configuration' })).not.toBeInTheDocument();
  });

  it('hides Export Configuration nav link for field_operator', () => {
    authState.profile = {
      id: 'u-op',
      email: 'op@dia-rental.dev',
      displayName: 'Field Op',
      role: 'field_operator',
      tenant: 'dia-demo',
    };
    render(<RootComponent />);
    expect(screen.queryByRole('link', { name: 'Export Configuration' })).not.toBeInTheDocument();
  });
});
