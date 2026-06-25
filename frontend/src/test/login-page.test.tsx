/**
 * Unit tests for the branded login page (routes/login.tsx).
 * Covers: split-brand layout, brand panel content, form a11y, error alert, pending state.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures mock functions are available in vi.mock factories
// ---------------------------------------------------------------------------

const { mockSignIn, mockGetSession, navigateSpy } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockGetSession: vi.fn(),
  navigateSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ signIn: mockSignIn }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => (opts: { component: unknown }) => opts,
    useNavigate: () => navigateSpy,
    redirect: (opts: unknown) => ({ isRedirect: true, opts }),
  };
});

// Import after mocks are registered
import { LoginPage } from '@/routes/login';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null } });
  navigateSpy.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoginPage — split-brand layout', () => {
  it('renders the outer login card container', () => {
    render(<LoginPage />);
    expect(screen.getByTestId('login-card')).toBeInTheDocument();
  });

  it('renders the brand panel', () => {
    render(<LoginPage />);
    expect(screen.getByTestId('login-brand-panel')).toBeInTheDocument();
  });

  it('renders "Dealernet" wordmark in brand panel', () => {
    render(<LoginPage />);
    expect(screen.getByText('Dealernet')).toBeInTheDocument();
  });

  it('renders the value proposition headline', () => {
    render(<LoginPage />);
    expect(screen.getByText(/equipment rental operations/i)).toBeInTheDocument();
  });

  it('renders the three feature bullets', () => {
    render(<LoginPage />);
    const featureList = screen.getByRole('list', { name: /platform features/i });
    expect(featureList).toBeInTheDocument();
    const items = featureList.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(featureList).toHaveTextContent('Fleet & availability');
    expect(featureList).toHaveTextContent('Agentic operations');
    expect(featureList).toHaveTextContent('Finance & compliance');
  });
});

describe('LoginPage — form a11y', () => {
  it('email input has correct id, type, autocomplete, and label association', () => {
    render(<LoginPage />);
    const emailInput = screen.getByTestId('login-email');
    expect(emailInput).toHaveAttribute('id', 'login-email');
    expect(emailInput).toHaveAttribute('type', 'email');
    expect(emailInput).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Email')).toBe(emailInput);
  });

  it('password input has correct id, type, autocomplete, and label association', () => {
    render(<LoginPage />);
    const passwordInput = screen.getByTestId('login-password');
    expect(passwordInput).toHaveAttribute('id', 'login-password');
    expect(passwordInput).toHaveAttribute('type', 'password');
    expect(passwordInput).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Password')).toBe(passwordInput);
  });

  it('submit button has data-testid and default label', () => {
    render(<LoginPage />);
    const button = screen.getByTestId('login-submit');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('Sign In');
  });
});

describe('LoginPage — error state', () => {
  it('does not show error alert initially', () => {
    render(<LoginPage />);
    expect(screen.queryByTestId('login-error')).not.toBeInTheDocument();
  });

  it('shows a tinted danger alert on sign-in failure', async () => {
    mockSignIn.mockRejectedValue(new Error('Invalid login credentials'));

    render(<LoginPage />);

    fireEvent.change(screen.getByTestId('login-email'), { target: { value: 'bad@example.com' } });
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByTestId('login-submit'));

    const errorEl = await screen.findByTestId('login-error');
    expect(errorEl).toHaveAttribute('role', 'alert');
    expect(errorEl).toHaveTextContent('Invalid login credentials');
  });
});

describe('LoginPage — pending state', () => {
  it('shows "Signing in…" text and disables form controls while submitting', async () => {
    mockSignIn.mockImplementation(() => new Promise(() => {}));

    render(<LoginPage />);

    fireEvent.change(screen.getByTestId('login-email'), { target: { value: 'admin@dia-rental.dev' } });
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'secret' } });
    fireEvent.submit(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-submit')).toHaveTextContent('Signing in…');
    });
    expect(screen.getByTestId('login-email')).toBeDisabled();
    expect(screen.getByTestId('login-password')).toBeDisabled();
    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });
});

describe('LoginPage — successful sign-in', () => {
  it('navigates to / after successful sign-in with active session', async () => {
    mockSignIn.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } });

    render(<LoginPage />);

    fireEvent.change(screen.getByTestId('login-email'), { target: { value: 'admin@dia-rental.dev' } });
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'secret' } });
    fireEvent.submit(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith({ to: '/' });
    });
  });
});
