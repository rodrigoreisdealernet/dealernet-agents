import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const { fromMock, getSessionMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    from: fromMock,
    auth: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    profile: {
      role: 'admin',
    },
  }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
    redirect: (args: unknown) => ({ redirect: args }),
  };
});

import { AccountingExportConfigPage } from '@/routes/accounting/export-config';

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeChainableQuery(resolvedValue: { data: unknown; error: null | { message: string } }) {
  const q: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'order', 'limit', 'maybeSingle'];
  methods.forEach((m) => {
    if (m === 'maybeSingle' || m === 'limit') {
      q[m] = vi.fn(async () => resolvedValue);
    } else {
      q[m] = vi.fn(() => q);
    }
  });
  return q;
}

describe('AccountingExportConfigPage', () => {
  beforeEach(() => {
    fromMock.mockReset();
    getSessionMock.mockReset();

    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'test-token-admin' } },
    });

    fromMock.mockImplementation((table: string) => {
      if (table === 'accounting_export_config') {
        return makeChainableQuery({ data: null, error: null });
      }
      if (table === 'accounting_export_runs') {
        return makeChainableQuery({ data: [], error: null });
      }
      return makeChainableQuery({ data: null, error: null });
    });
  });

  it('renders the mode selector and save button', async () => {
    renderWithQueryClient(<AccountingExportConfigPage />);

    expect(await screen.findByLabelText('Export mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save export mode' })).toBeInTheDocument();
  });

  it('shows "No export mode configured yet" when no active config exists', async () => {
    renderWithQueryClient(<AccountingExportConfigPage />);

    expect(await screen.findByText('No export mode configured yet.')).toBeInTheDocument();
  });

  it('shows the active export mode when a config row is returned', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'accounting_export_config') {
        return makeChainableQuery({
          data: {
            id: 'cfg-1',
            export_mode: 'xero',
            format_version: 'xero_csv_v1',
            account_code_map: {},
            tax_code_map: {},
            notes: 'Used by finance team',
            enabled: true,
            created_by: 'admin@example.com',
            created_at: '2026-06-01T10:00:00Z',
            updated_at: '2026-06-01T10:00:00Z',
          },
          error: null,
        });
      }
      if (table === 'accounting_export_runs') {
        return makeChainableQuery({ data: [], error: null });
      }
      return makeChainableQuery({ data: null, error: null });
    });

    renderWithQueryClient(<AccountingExportConfigPage />);

    expect(await screen.findByText('Xero (CSV import)')).toBeInTheDocument();
    expect(screen.getAllByText('xero_csv_v1').length).toBeGreaterThan(0);
    expect(screen.getByText('Used by finance team')).toBeInTheDocument();
  });

  it('calls the configure endpoint and shows a success message when saving the export mode', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', export_mode: 'sage' }), { status: 200 })
    );

    renderWithQueryClient(<AccountingExportConfigPage />);

    await screen.findByLabelText('Export mode');

    await user.selectOptions(screen.getByLabelText('Export mode'), 'sage');
    await user.click(screen.getByRole('button', { name: 'Save export mode' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/ops/accounting/export/configure'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"export_mode":"sage"'),
        })
      )
    );

    await screen.findByText(/Export mode saved: Sage Intacct/);

    fetchMock.mockRestore();
  });

  it('shows an error message when the configure endpoint fails', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal server error', { status: 500 })
    );

    renderWithQueryClient(<AccountingExportConfigPage />);

    await screen.findByLabelText('Export mode');
    await user.click(screen.getByRole('button', { name: 'Save export mode' }));

    await screen.findByText(/Save failed \(500\)/);

    fetchMock.mockRestore();
  });

  it('shows the recent export runs audit log when runs exist', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'accounting_export_config') {
        return makeChainableQuery({ data: null, error: null });
      }
      if (table === 'accounting_export_runs') {
        return makeChainableQuery({
          data: [
            {
              id: 'run-1',
              export_mode: 'xero',
              format_version: 'xero_csv_v1',
              period_start: '2026-06-01',
              period_end: '2026-06-30',
              basis: 'accrual',
              triggered_by: 'admin@example.com',
              row_count: 42,
              artifact_status: 'complete',
              error_detail: null,
              created_at: '2026-06-30T16:00:00Z',
            },
          ],
          error: null,
        });
      }
      return makeChainableQuery({ data: null, error: null });
    });

    renderWithQueryClient(<AccountingExportConfigPage />);

    expect(await screen.findByText('complete')).toBeInTheDocument();
    expect(screen.getByText('42 rows')).toBeInTheDocument();
    expect(screen.getByText('by admin@example.com')).toBeInTheDocument();
  });
});
