/**
 * Root Route - App Shell
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { createRootRoute, Outlet, Link, redirect, useLocation, useNavigate } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { cn } from '@/lib/utils';
import {
  Menu,
  Truck,
  LogOut,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth, useAuthCapabilities } from '@/auth/AuthContext';
import { LoginDialog } from '@/auth/LoginDialog';
import { canViewGeneralLedger, canConfigureAccountingExport, ROLE_LABELS } from '@/auth/types';
import { NAV_SECTIONS, type NavItemConfig } from '@/components/nav-config';
import { supabase } from '@/data/supabase';

interface SidebarContextValue {
  isOpen: boolean;
  close: () => void;
}

// The default value is safe because Sidebar is always rendered inside the
// SidebarContext.Provider in RootComponent. It is never used outside a provider.
const SidebarContext = createContext<SidebarContextValue>({ isOpen: false, close: () => {} });

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (location.pathname === '/login' || location.pathname.startsWith('/portal/')) {
      return;
    }

    let session: Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session'] = null;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        throw error;
      }
      session = data.session;
    } catch {
      throw redirect({ to: '/login' });
    }

    if (!session) {
      throw redirect({ to: '/login' });
    }
  },
  component: RootComponent,
});

function RootComponent() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // The login page and portal pages are standalone screens — no header, sidebar, or footer chrome.
  if (location.pathname === '/login' || location.pathname.startsWith('/portal/')) {
    return (
      <>
        <Outlet />
        {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
      </>
    );
  }

  return (
    <SidebarContext.Provider value={{ isOpen: sidebarOpen, close: () => setSidebarOpen(false) }}>
      <div className="min-h-screen bg-background flex flex-col">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <div className="flex flex-col md:flex-row flex-1">
          <Sidebar />
          <main className="flex-1 p-4 sm:p-6">
            <Outlet />
          </main>
        </div>
        <BuildFooter />
        {import.meta.env.DEV && (
          <TanStackRouterDevtools position="bottom-right" />
        )}
      </div>
    </SidebarContext.Provider>
  );
}

const GITHUB_REPO_URL = 'https://github.com/Volaris-AI/dia';

function BuildFooter() {
  const sha = import.meta.env.VITE_COMMIT_SHA || 'dev';
  const buildTime = import.meta.env.VITE_BUILD_TIME || 'local';
  const isDev = sha === 'dev';

  return (
    <footer
      data-testid="build-footer"
      className="border-t bg-card px-6 py-2 text-xs text-muted-foreground flex justify-end"
    >
      {isDev ? (
        <span>build: dev / local</span>
      ) : (
        <span>
          <a
            href={`${GITHUB_REPO_URL}/commit/${sha}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono hover:underline"
            data-testid="build-sha"
          >
            {sha.slice(0, 7)}
          </a>
          {' · '}
          <span data-testid="build-time">{buildTime}</span>
        </span>
      )}
    </footer>
  );
}

function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const { profile, isLoading, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    await navigate({ to: '/login' });
  }

  return (
    <div className="border-t-2 border-accent">
      <header className="h-14 border-b border-border bg-white flex items-center px-6 gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onMenuClick}
          aria-label="Open navigation"
          data-testid="mobile-menu-button"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
            <Truck className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
          </div>
          <span className="text-lg font-bold tracking-tight">Dealernet</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {!isLoading && profile && (
            <>
              <span
                className="text-sm text-muted-foreground hidden sm:block"
                data-testid="header-user-email"
              >
                {profile.displayName}
              </span>
              <Badge
                variant="outline"
                className="border-primary/25 bg-primary/10 text-primary"
                data-testid="header-user-role"
              >
                {ROLE_LABELS[profile.role]}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleSignOut()}
                aria-label="Sign out"
                title="Sign out"
                data-testid="sign-out-button"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
              </Button>
            </>
          )}
          {!isLoading && !profile && <LoginDialog />}
        </div>
      </header>
    </div>
  );
}

function NavItem({ item }: { item: NavItemConfig }) {
  const location = useLocation();
  const { close } = useContext(SidebarContext);
  const searchString = typeof location.search === 'string' ? location.search : '';
  const searchParams = new URLSearchParams(searchString.startsWith('?') ? searchString.slice(1) : searchString);
  const isActive = item.isActive
    ? item.isActive({ pathname: location.pathname, searchParams })
    : location.pathname === item.to;
  const Icon = item.icon;

  return (
    <Link
      to={item.to}
      search={item.search}
      onClick={close}
      className={cn(
        'flex items-center gap-2.5 rounded-lg border-l-2 border-transparent px-3 py-2 text-sm text-sidebar-foreground transition-colors duration-[150ms]',
        isActive
          ? 'border-sidebar-accent bg-sidebar-active text-sidebar-active-foreground font-medium'
          : 'hover:bg-sidebar-hover hover:text-sidebar-active-foreground'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  );
}

function Sidebar() {
  const { profile } = useAuth();
  const { canWrite } = useAuthCapabilities();
  const { isOpen, close } = useContext(SidebarContext);
  const showGeneralLedger = canViewGeneralLedger(profile?.role);
  const showAccountingExportConfig = canConfigureAccountingExport(profile?.role);

  const navContent = (
    <nav className="p-3 space-y-1">
      {NAV_SECTIONS.map((section) => (
        <div key={section.label ?? 'main'} className={cn(section.label ? 'pt-3' : 'space-y-1')}>
          {section.label && (
            <h3 className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-header">
              {section.label}
            </h3>
          )}
          <div className="space-y-0.5">
            {section.items
              .filter((item) => !item.show || item.show({ canWrite, showGeneralLedger, showAccountingExportConfig }))
              .map((item) => (
                <NavItem key={`${item.to}-${item.label}`} item={item} />
              ))}
          </div>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Mobile drawer overlay backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={close}
          aria-hidden="true"
          data-testid="mobile-nav-backdrop"
        />
      )}

      {/* Sidebar — drawer on mobile, static column on desktop */}
      <aside
        className={cn(
          'bg-gradient-to-b from-sidebar to-sidebar-end overflow-y-auto',
          // Desktop: always visible static column
          'md:w-60 md:border-r md:border-border md:min-h-[calc(100vh-3.5rem)] md:static md:translate-x-0',
          // Mobile: fixed drawer, hidden off-screen by default, slides in when open
          'fixed inset-y-0 left-0 z-40 w-60 md:relative md:inset-auto md:z-auto',
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          'transition-transform duration-300 ease-in-out',
        )}
        aria-label="Main navigation"
        data-testid="main-sidebar"
      >
        {/* Close button visible only on mobile */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border md:hidden">
          <span className="text-sm font-semibold">Navigation</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={close}
            aria-label="Close navigation"
            data-testid="mobile-menu-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
        {navContent}
      </aside>
    </>
  );
}
