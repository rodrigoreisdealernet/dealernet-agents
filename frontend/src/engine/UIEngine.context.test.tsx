import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UIEngine } from './UIEngine';
import { useUIEngine } from './UIEngineContext';
import type { EngineComponentProps } from '@/engine/types';
import { createRegistry, setGlobalRegistry } from '@/registry/createRegistry';

const { navigateSpy, useDataSourcesMock } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  useDataSourcesMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');

  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

vi.mock('./useDataSources', () => ({
  useDataSources: useDataSourcesMock,
}));

function ShellProbe(props: EngineComponentProps) {
  const { isPageLoading, isLoading, errors } = useUIEngine();
  const title = typeof props.title === 'string' ? props.title : '';

  return (
    <section>
      <h2>{title}</h2>
      <p data-testid="page-loading">{String(isPageLoading)}</p>
      <p data-testid="source-loading">{String(isLoading.customers)}</p>
      <p data-testid="source-error">{errors.customers?.message ?? 'none'}</p>
    </section>
  );
}

function StateProbe() {
  const { state } = useUIEngine();
  return <div data-testid="state-probe">{JSON.stringify(state)}</div>;
}

function ImmediatePersistenceProbe() {
  const { openModal, params, setState } = useUIEngine();
  const [snapshot, setSnapshot] = useState('');

  return (
    <section>
      <button
        type="button"
        onClick={() => {
          openModal('workflow');
          setState('checkout_line_id', 'line-1');
          setState('checkout_actual_start', '2026-07-09');
          setSnapshot(sessionStorage.getItem(`uiengine:workflow-page:${JSON.stringify(params)}`) ?? '');
        }}
      >
        Begin workflow
      </button>
      <div data-testid="persisted-snapshot">{snapshot}</div>
    </section>
  );
}

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('UIEngine data-source context states', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
    setGlobalRegistry(createRegistry({ ShellProbe }));
  });

  it('exposes loading states in context while keeping the shell rendered', () => {
    useDataSourcesMock.mockReturnValue({
      data: { customers: null },
      isLoading: { customers: true },
      errors: { customers: null },
      isPageLoading: true,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithClient(
      <UIEngine
        page={{
          id: 'loading-page',
          title: 'Loading page',
          dataSources: {
            customers: { type: 'static', data: [] },
          },
          layout: {
            type: 'ShellProbe',
            props: { title: 'Engine Shell' },
          },
        }}
      />
    );

    expect(screen.getByRole('heading', { name: 'Engine Shell' })).toBeInTheDocument();
    expect(screen.getByTestId('page-loading')).toHaveTextContent('true');
    expect(screen.getByTestId('source-loading')).toHaveTextContent('true');
    expect(screen.getByTestId('source-error')).toHaveTextContent('none');
  });

  it('exposes source errors in context while keeping the shell rendered', () => {
    useDataSourcesMock.mockReturnValue({
      data: { customers: null },
      isLoading: { customers: false },
      errors: { customers: new Error('Customers failed to load') },
      isPageLoading: false,
      refetch: vi.fn(),
      refetchAll: vi.fn(),
    });

    renderWithClient(
      <UIEngine
        page={{
          id: 'error-page',
          title: 'Error page',
          dataSources: {
            customers: { type: 'static', data: [] },
          },
          layout: {
            type: 'ShellProbe',
            props: { title: 'Engine Shell' },
          },
        }}
      />
    );

    expect(screen.getByRole('heading', { name: 'Engine Shell' })).toBeInTheDocument();
    expect(screen.getByTestId('page-loading')).toHaveTextContent('false');
    expect(screen.getByTestId('source-loading')).toHaveTextContent('false');
    expect(screen.getByTestId('source-error')).toHaveTextContent('Customers failed to load');
  });
});

describe('UIEngine sessionStorage persistence scoping', () => {
  const noopDataSources = () => ({
    data: {},
    isLoading: {},
    errors: {},
    isPageLoading: false,
    refetch: vi.fn(),
    refetchAll: vi.fn(),
  });

  beforeEach(() => {
    navigateSpy.mockReset();
    useDataSourcesMock.mockReset();
    setGlobalRegistry(createRegistry({ StateProbe }));
  });

  it('removes the stale key and resets state when params change without a full reload', async () => {
    const staleKey = 'uiengine:scoped-page:{"id":"contract-1"}';
    sessionStorage.setItem(
      staleKey,
      JSON.stringify({ state: { checkout_line_id: 'stale-line' }, modals: {} })
    );

    useDataSourcesMock.mockReturnValue(noopDataSources());

    const page = {
      id: 'scoped-page',
      title: 'Scoped page',
      layout: { type: 'StateProbe', props: {} },
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <UIEngine page={page} params={{ id: 'contract-1' }} />
      </QueryClientProvider>
    );

    // Initial render restores the stale state from sessionStorage
    expect(screen.getByTestId('state-probe')).toHaveTextContent('stale-line');

    // Simulate SPA navigation to a different contract (same component mount, new params)
    rerender(
      <QueryClientProvider client={queryClient}>
        <UIEngine page={page} params={{ id: 'contract-2' }} />
      </QueryClientProvider>
    );

    // Old key must be cleaned up so it cannot leak into future mounts
    await waitFor(() => {
      expect(sessionStorage.getItem(staleKey)).toBeNull();
    });

    // State must be reset — the stale checkout_line_id must not survive the param change
    await waitFor(() => {
      expect(screen.getByTestId('state-probe')).not.toHaveTextContent('stale-line');
    });
  });

  it('restores persisted state from the new key when switching to a contract that already has an in-progress workflow', async () => {
    const contract2Key = 'uiengine:scoped-page:{"id":"contract-2"}';
    sessionStorage.setItem(
      contract2Key,
      JSON.stringify({ state: { checkout_line_id: 'line-99' }, modals: {} })
    );

    useDataSourcesMock.mockReturnValue(noopDataSources());

    const page = {
      id: 'scoped-page',
      title: 'Scoped page',
      layout: { type: 'StateProbe', props: {} },
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <UIEngine page={page} params={{ id: 'contract-1' }} />
      </QueryClientProvider>
    );

    // No persisted state for contract-1 — starts clean
    expect(screen.getByTestId('state-probe')).not.toHaveTextContent('line-99');

    // Navigate to contract-2 which has in-progress workflow state
    rerender(
      <QueryClientProvider client={queryClient}>
        <UIEngine page={page} params={{ id: 'contract-2' }} />
      </QueryClientProvider>
    );

    // State for contract-2 should be restored from sessionStorage
    await waitFor(() => {
      expect(screen.getByTestId('state-probe')).toHaveTextContent('line-99');
    });
  });

  it('persists modal workflow state synchronously on the same click that starts it', () => {
    useDataSourcesMock.mockReturnValue(noopDataSources());
    setGlobalRegistry(createRegistry({ ImmediatePersistenceProbe, StateProbe }));

    renderWithClient(
      <UIEngine
        page={{
          id: 'workflow-page',
          title: 'Workflow page',
          state: {
            checkout_line_id: '',
            checkout_actual_start: '',
          },
          layout: { type: 'ImmediatePersistenceProbe', props: {} },
          modals: {
            workflow: {
              title: 'Workflow',
              description: 'Immediate persistence test modal',
              content: { type: 'StateProbe', props: {} },
            },
          },
        }}
        params={{ id: 'contract-1' }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Begin workflow' }));

    expect(screen.getByTestId('persisted-snapshot')).toHaveTextContent('"checkout_line_id":"line-1"');
    expect(screen.getByTestId('persisted-snapshot')).toHaveTextContent('"checkout_actual_start":"2026-07-09"');
    expect(screen.getByTestId('persisted-snapshot')).toHaveTextContent('"workflow"');
  });
});
