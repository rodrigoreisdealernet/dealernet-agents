/**
 * Tests for AuthContext provider and useAuth hook.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { Session, User, AuthChangeEvent } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted so mock functions are available when vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockOnAuthStateChange,
  mockSignInWithPassword,
  mockSignOut,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockOnAuthStateChange: vi.fn(),
  mockSignInWithPassword: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
      signInWithPassword: mockSignInWithPassword,
      signOut: mockSignOut,
    },
  },
}));

// Import after mocking
import { AuthProvider, useAuth } from '@/auth/AuthContext';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'admin@wynne-rental.dev',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role: 'admin', tenant: 'wynne-demo' },
    user_metadata: { display_name: 'Demo Admin' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as User;
}

function makeSession(user: User): Session {
  return {
    user,
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    token_type: 'bearer',
    expires_at: Date.now() / 1000 + 3600,
    expires_in: 3600,
  } as Session;
}

/** A test component that renders auth state. */
function AuthDisplay() {
  const { profile, isLoading } = useAuth();
  if (isLoading) return <div data-testid="loading">Loading…</div>;
  if (!profile) return <div data-testid="unauthenticated">Not signed in</div>;
  return (
    <div>
      <span data-testid="user-email">{profile.email}</span>
      <span data-testid="user-role">{profile.role}</span>
      <span data-testid="user-tenant">{profile.tenant}</span>
      <span data-testid="user-display-name">{profile.displayName}</span>
    </div>
  );
}

function SignInButton() {
  const { signIn } = useAuth();
  return (
    <button
      type="button"
      onClick={() => {
        void signIn('admin@wynne-rental.dev', 'secret');
      }}
    >
      Trigger sign in
    </button>
  );
}

function renderWithAuth(ui: ReactElement) {
  return render(<AuthProvider>{ui}</AuthProvider>);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockOnAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProvider — unauthenticated state', () => {
  it('renders unauthenticated when there is no session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    renderWithAuth(<AuthDisplay />);
    expect(screen.getByTestId('loading')).toBeInTheDocument();

    await screen.findByTestId('unauthenticated');
    expect(screen.getByTestId('unauthenticated')).toBeInTheDocument();
  });
});

describe('AuthProvider — authenticated state', () => {
  it('surfaces profile email, role, tenant from app_metadata', async () => {
    const user = makeUser();
    const session = makeSession(user);
    mockGetSession.mockResolvedValue({ data: { session } });

    renderWithAuth(<AuthDisplay />);
    await screen.findByTestId('user-email');

    expect(screen.getByTestId('user-email')).toHaveTextContent('admin@wynne-rental.dev');
    expect(screen.getByTestId('user-role')).toHaveTextContent('admin');
    expect(screen.getByTestId('user-tenant')).toHaveTextContent('wynne-demo');
    expect(screen.getByTestId('user-display-name')).toHaveTextContent('Demo Admin');
  });

  it('falls back to email prefix for displayName when user_metadata is empty', async () => {
    const user = makeUser({ user_metadata: {} });
    const session = makeSession(user);
    mockGetSession.mockResolvedValue({ data: { session } });

    renderWithAuth(<AuthDisplay />);
    await screen.findByTestId('user-display-name');
    expect(screen.getByTestId('user-display-name')).toHaveTextContent('admin');
  });

  it('defaults role to read_only when app_metadata.role is absent', async () => {
    const user = makeUser({ app_metadata: {} });
    const session = makeSession(user);
    mockGetSession.mockResolvedValue({ data: { session } });

    renderWithAuth(<AuthDisplay />);
    await screen.findByTestId('user-role');
    expect(screen.getByTestId('user-role')).toHaveTextContent('read_only');
  });
});

describe('AuthProvider — auth state change', () => {
  it('updates profile when onAuthStateChange fires with a new session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    let capturedCallback: ((event: AuthChangeEvent, session: Session | null) => void) | undefined;
    mockOnAuthStateChange.mockImplementation(
      (cb: (event: AuthChangeEvent, session: Session | null) => void) => {
        capturedCallback = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }
    );

    renderWithAuth(<AuthDisplay />);
    await screen.findByTestId('unauthenticated');

    const user = makeUser({ app_metadata: { role: 'field_operator', tenant: 'demo' } });
    const session = makeSession(user);

    act(() => {
      capturedCallback?.('SIGNED_IN', session);
    });

    await screen.findByTestId('user-role');
    expect(screen.getByTestId('user-role')).toHaveTextContent('field_operator');
  });
});

describe('AuthProvider — signIn', () => {
  it('updates profile immediately from signIn response session', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const user = makeUser({ app_metadata: { role: 'branch_manager', tenant: 'demo' } });
    const session = makeSession(user);
    mockSignInWithPassword.mockResolvedValue({ data: { session }, error: null });

    renderWithAuth(
      <>
        <SignInButton />
        <AuthDisplay />
      </>
    );

    await screen.findByTestId('unauthenticated');
    fireEvent.click(screen.getByRole('button', { name: 'Trigger sign in' }));

    await screen.findByTestId('user-role');
    expect(screen.getByTestId('user-role')).toHaveTextContent('branch_manager');
    expect(screen.getByTestId('user-tenant')).toHaveTextContent('demo');
  });
});

describe('useAuth — throws outside provider', () => {
  it('throws when used outside <AuthProvider>', () => {
    const BrokenComponent = () => {
      useAuth();
      return null;
    };
    // Suppress expected error output in test console
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<BrokenComponent />)).toThrow(
      'useAuth must be used within an <AuthProvider>'
    );
    consoleError.mockRestore();
  });
});
