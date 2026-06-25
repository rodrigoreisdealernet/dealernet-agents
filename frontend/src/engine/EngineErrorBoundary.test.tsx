import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineErrorBoundary } from './EngineErrorBoundary';
import { UIEngine } from './UIEngine';
import { EngineCard } from '@/components/engine/layout/EngineCard';
import { createRegistry, setGlobalRegistry } from '@/registry/createRegistry';

// ---------------------------------------------------------------------------
// Module-level mocks (must be at the top via vi.hoisted / vi.mock)
// ---------------------------------------------------------------------------

const { navigateSpy, useDataSourcesMock } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  useDataSourcesMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router'
  );
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock('./useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Component that always throws during render. */
function Bomb(props: import('@/engine/types').EngineComponentProps): ReactElement {
  const message = typeof props.message === 'string' ? props.message : 'boom';
  throw new Error(message);
}

/** Wraps a UI element in the providers required by UIEngine. */
function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const noopDataSources = () => ({
  data: {},
  isLoading: {},
  errors: {},
  isPageLoading: false,
  refetch: vi.fn(),
  refetchAll: vi.fn(),
});

// ---------------------------------------------------------------------------
// EngineErrorBoundary — unit tests
// ---------------------------------------------------------------------------

describe('EngineErrorBoundary', () => {
  beforeEach(() => {
    // Suppress the console.error that React emits when an error boundary catches
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('shows the default fallback alert when a child throws during render', () => {
    render(
      <EngineErrorBoundary>
        <Bomb />
      </EngineErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Unable to display this content.')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('renders the custom fallback prop when provided', () => {
    render(
      <EngineErrorBoundary fallback={<p>Custom fallback</p>}>
        <Bomb />
      </EngineErrorBoundary>
    );

    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders children normally when no error is thrown', () => {
    render(
      <EngineErrorBoundary>
        <p>Safe content</p>
      </EngineErrorBoundary>
    );

    expect(screen.getByText('Safe content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('resets error state and re-renders children after clicking Try again', async () => {
    const user = userEvent.setup();
    let shouldThrow = true;

    function MaybeThrow() {
      if (shouldThrow) throw new Error('transient error');
      return <p>Recovered content</p>;
    }

    render(
      <EngineErrorBoundary>
        <MaybeThrow />
      </EngineErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Stop throwing before retry
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Retry loading content' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// UIEngine — error boundary wiring
// ---------------------------------------------------------------------------

describe('UIEngine error boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
    setGlobalRegistry(createRegistry({ Bomb }));
  });

  it('shows the error-boundary fallback instead of a blank page when a component throws', () => {
    useDataSourcesMock.mockReturnValue(noopDataSources());

    renderWithClient(
      <UIEngine
        page={{
          id: 'crash-page',
          title: 'Crash page',
          layout: {
            type: 'Bomb',
            props: { message: 'UIEngine render crash' },
          },
        }}
      />
    );

    // The error boundary must surface a visible alert — not a blank screen.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('UIEngine render crash')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// EngineCard — error boundary wiring
// ---------------------------------------------------------------------------

describe('EngineCard error boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('keeps the card title visible in the DOM when the card content throws', () => {
    render(
      <EngineCard title="Fleet Summary">
        <Bomb message="card content crash" />
      </EngineCard>
    );

    // Title must remain in the DOM — this is the Playwright anchor the e2e test uses.
    expect(screen.getByText('Fleet Summary')).toBeInTheDocument();

    // The error fallback must appear inside the card body.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('card content crash')).toBeInTheDocument();
  });

  it('renders card content normally when no child throws', () => {
    render(
      <EngineCard title="Fleet Summary">
        <p>Normal content</p>
      </EngineCard>
    );

    expect(screen.getByText('Fleet Summary')).toBeInTheDocument();
    expect(screen.getByText('Normal content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
